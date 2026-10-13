import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Storbild, start } from "./main.ts";
import { adminHeaders, SseClient, testConfig } from "./testing.ts";

// Plugin reload (ADR 0025): a plugin on STORBILD_PLUGIN_PATHS is reloaded when its files change.

/** The definition of the `live` plugin; `build` ends up in its plugin state. */
const definition = ({ build = 1, config = "", broken = false } = {}) => `
  import { API_VERSION, definePlugin, z } from "@storbild/plugin-sdk";
  export default definePlugin({
    id: "live",
    version: "1.0.0",
    apiVersion: API_VERSION,
    types: {
      t: {
        kind: "scene",
        label: "T",
        viewer: "x-live",
        config: z.object({ text: z.string().default("hi")${config} }),
      },
    },
    server(ctx) { ctx.setPluginState({ build: ${build} }); },
  })${broken ? " +" : ";"}
`;

const viewer = (text: string) => `
  import { StorbildScene } from "@storbild/plugin-sdk/viewer";
  customElements.define("x-live", class extends StorbildScene { label = ${JSON.stringify(text)}; });
`;

function writePlugin(dir: string, files: Record<string, string>) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      type: "module",
      exports: { ".": "./plugin.ts" },
      storbild: { viewer: "./viewer.ts" },
    }),
  );
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
}

async function eventually<T>(check: () => T, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await Bun.sleep(20);
    }
  }
}

let root: string;
let dir: string;
let storbild: Storbild;
const clients: SseClient[] = [];

const live = () => storbild.hub.state.plugins.live;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "storbild-reload-"));
  dir = join(root, "live");
  writePlugin(dir, { "plugin.ts": definition(), "viewer.ts": viewer("one") });
  storbild = await start(
    testConfig({
      STORBILD_VIEWER_PORT: "0",
      STORBILD_ADMIN_PORT: "0",
      STORBILD_DATA_DIR: join(root, "data"),
      STORBILD_PLUGIN_PATHS: dir,
      STORBILD_PLUGIN_WATCH: "1",
    }),
    { stream: { heartbeatMs: 100 }, pluginWatchDebounceMs: 50 },
  );
  await eventually(() => expect(live()?.state).toEqual({ build: 1 }));
});

afterAll(async () => {
  for (const client of clients) client.close();
  await storbild?.stop();
  rmSync(root, { recursive: true });
});

describe("plugin reload", () => {
  test("a changed viewer module gets a new URL, sent to screens as a patch", async () => {
    const before = live()?.module as string;
    const client = await SseClient.connect(new URL("/events", storbild.viewer.url));
    clients.push(client);
    expect((await client.nextEvent()).event).toBe("snapshot");

    writeFileSync(join(dir, "viewer.ts"), viewer("two"));
    let patch = await client.nextEvent(5000);
    while (!patch.data.includes('"/plugins/live/module"')) patch = await client.nextEvent(5000);
    expect(patch.event).toBe("patch");
    const after = live()?.module as string;
    expect(after).not.toBe(before);
    expect(after).toMatch(/^\/plugins\/live\/1\.0\.0\/[0-9a-f]{12}\/viewer\.js$/);

    const res = await fetch(new URL(after, storbild.viewer.url));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"two"');
    expect((await fetch(new URL(before, storbild.viewer.url))).status).toBe(404);
    const sw = await (await fetch(new URL("/sw.js", storbild.viewer.url))).text();
    expect(sw).toContain(after);
    expect(sw).not.toContain(before);
  });

  test("a changed definition restarts the server part and updates schemas and instances", async () => {
    const headers = await adminHeaders(storbild.admin.url);
    const created = await fetch(new URL("/api/commands", storbild.admin.url), {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "instance.create",
        payload: { plugin: "live", type: "t", name: "Live", config: {} },
      }),
    });
    const { id } = (await created.json()) as { id: string };

    writeFileSync(
      join(dir, "plugin.ts"),
      definition({ build: 2, config: `, size: z.number().default(3)` }),
    );
    await eventually(() => expect(live()?.state).toEqual({ build: 2 }));
    expect(live()?.status).toBe("ok");
    expect(storbild.hub.state.instances[id]?.config).toEqual({ text: "hi", size: 3 });

    const schemas = (await (
      await fetch(new URL("/api/schemas", storbild.admin.url), { headers })
    ).json()) as Record<string, { types: Record<string, { properties: object }> }>;
    expect(Object.keys(schemas.live?.types.t?.properties ?? {})).toEqual(["text", "size"]);
  });

  test("a broken edit is reported without stopping the show, and a fix restores it", async () => {
    const revision = storbild.hub.state.revision;
    writeFileSync(join(dir, "plugin.ts"), definition({ build: 3, broken: true }));
    await eventually(() => expect(live()?.status).toBe("error"));
    expect(live()?.error).toBeString();
    expect(storbild.hub.state.plugins.markdown?.status).toBe("ok");
    expect(storbild.hub.state.revision).toBeGreaterThan(revision);
    expect((await fetch(new URL("/time", storbild.viewer.url))).status).toBe(200);

    writeFileSync(join(dir, "plugin.ts"), definition({ build: 4 }));
    await eventually(() => expect(live()).toMatchObject({ status: "ok", state: { build: 4 } }));
    expect(live()?.error).toBeUndefined();
  });

  test("changes below node_modules and dotfiles are ignored", async () => {
    const revision = storbild.hub.state.revision;
    mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "dep", "index.js"), "export {};");
    writeFileSync(join(dir, ".swap"), "x");
    await Bun.sleep(300);
    expect(storbild.hub.state.revision).toBe(revision);
  });
});

describe("without STORBILD_PLUGIN_WATCH", () => {
  test("plugin files are not watched", async () => {
    const quietRoot = mkdtempSync(join(tmpdir(), "storbild-noreload-"));
    const quiet = join(quietRoot, "live");
    writePlugin(quiet, { "plugin.ts": definition(), "viewer.ts": viewer("one") });
    const other = await start(
      testConfig({
        STORBILD_VIEWER_PORT: "0",
        STORBILD_ADMIN_PORT: "0",
        STORBILD_DATA_DIR: join(quietRoot, "data"),
        STORBILD_PLUGIN_PATHS: quiet,
      }),
      { builtinPluginsDir: null, pluginWatchDebounceMs: 50 },
    );
    try {
      const before = other.hub.state.plugins.live?.module;
      writeFileSync(join(quiet, "viewer.ts"), viewer("two"));
      await Bun.sleep(300);
      expect(other.hub.state.plugins.live?.module).toBe(before as string);
    } finally {
      await other.stop();
      rmSync(quietRoot, { recursive: true });
    }
  });
});
