import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type JsonPatchOp, parseConfig, type ShowState } from "@storbild/core";
import { type Storbild, start } from "./main.ts";
import { SseClient } from "./testing.ts";

const fixture = join(import.meta.dir, "../fixtures/external-plugin");
const repoRoot = join(import.meta.dir, "../../..");

/** Writes a throwaway plugin directory. `plugin.ts` is the definition. */
function writePlugin(dir: string, files: Record<string, string>, viewer?: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      type: "module",
      exports: { ".": "./plugin.ts" },
      ...(viewer && { storbild: { viewer } }),
    }),
  );
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
}

const definition = (fields: string, server = "") => `
  import { API_VERSION, definePlugin, z } from "@storbild/plugin-sdk";
  export default definePlugin({
    version: "1.0.0",
    apiVersion: API_VERSION,
    types: { t: { kind: "scene", label: "T", viewer: "x-t", config: z.object({}) } },
    ${fields}
    ${server}
  });
`;

let root: string;
let storbild: Storbild;
/** The crash plugin's entry right after boot, before its first restart. */
let crashAtBoot: unknown;
const clients: SseClient[] = [];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "storbild-plugins-"));
  // Outside the repository, so the plugin cannot reach anything but what the host provides.
  cpSync(fixture, join(root, "external"), { recursive: true });
  const fixtures = join(root, "fixtures");
  writePlugin(join(fixtures, "incompatible"), {
    "plugin.ts": `export default { id: "incompatible", version: "1.0.0", apiVersion: "0" };`,
  });
  writePlugin(join(fixtures, "throws"), { "plugin.ts": `throw new Error("boom at import");` });
  writePlugin(join(fixtures, "invalid"), {
    "plugin.ts": definition(`id: "invalid", settings: z.object({ at: z.date() }),`),
  });
  writePlugin(join(fixtures, "dup-a"), { "plugin.ts": definition(`id: "dup",`) });
  writePlugin(join(fixtures, "dup-b"), { "plugin.ts": definition(`id: "dup",`) });
  writePlugin(
    join(fixtures, "bad-viewer"),
    { "plugin.ts": definition(`id: "bad-viewer",`), "viewer.ts": `import "./missing.ts";` },
    "./viewer.ts",
  );
  writePlugin(join(fixtures, "crash"), {
    "plugin.ts": definition(
      `id: "crash",`,
      `server(ctx) {
        const g = globalThis as { crashes?: number };
        g.crashes = (g.crashes ?? 0) + 1;
        if (g.crashes <= 3) throw new Error("crash " + g.crashes);
        ctx.setPluginState({ runs: g.crashes });
      },`,
    ),
  });
  writePlugin(join(fixtures, "needs-settings"), {
    "plugin.ts": definition(
      `id: "needs-settings", settings: z.object({ token: z.string() }),`,
      `server(ctx) { ctx.setPluginState({ token: ctx.settings().token }); },`,
    ),
  });

  storbild = await start(
    parseConfig({
      STORBILD_VIEWER_PORT: "0",
      STORBILD_ADMIN_PORT: "0",
      STORBILD_DATA_DIR: join(root, "data"),
      STORBILD_PLUGIN_PATHS: [
        join(root, "external"),
        ...[
          "incompatible",
          "throws",
          "invalid",
          "dup-a",
          "dup-b",
          "bad-viewer",
          "crash",
          "needs-settings",
        ].map((name) => join(fixtures, name)),
      ].join(":"),
    }),
    { stream: { heartbeatMs: 100 }, pluginRestart: { baseMs: 50, maxMs: 100 } },
  );
  crashAtBoot = plugin("crash");
});

afterAll(async () => {
  for (const client of clients) client.close();
  await storbild?.stop();
  rmSync(root, { recursive: true });
});

async function command(type: string, payload: unknown) {
  const res = await fetch(new URL("/api/commands", storbild.admin.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, payload }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function eventually(check: () => void, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await Bun.sleep(10);
    }
  }
}

const plugin = (id: string) => storbild.hub.state.plugins[id];

describe("plugin host", () => {
  test("loads built-in and external plugins", () => {
    expect(plugin("markdown")).toMatchObject({
      status: "ok",
      version: "0.1.0",
      module: "/plugins/markdown/0.1.0/viewer.js",
      settings: { fontScale: 1 },
      types: { text: { kind: "scene", label: "Markdown text", viewer: "sb-markdown-scene" } },
    });
    expect(plugin("external")).toMatchObject({
      status: "ok",
      version: "1.2.3",
      module: "/plugins/external/1.2.3/viewer.js",
      settings: { greeting: "hello" },
      state: { greeting: "hello", banners: [] },
    });
  });

  test.each([
    ["incompatible", "incompatible", /API version 0/],
    ["throws", "error", /boom at import/],
    ["invalid", "error", /JSON Schema/],
    ["bad-viewer", "error", /missing/],
  ])("reports %s as %s without stopping the others", (id, status, error) => {
    expect(plugin(id)?.status).toBe(status as "error");
    expect(plugin(id)?.error).toMatch(error);
  });

  test("keeps the first of two plugins with the same ID", () => {
    expect(plugin("dup")?.status).toBe("ok");
    expect(Object.keys(storbild.hub.state.plugins).filter((id) => id.startsWith("dup"))).toEqual([
      "dup",
    ]);
  });

  test("reports a failing server part and restarts it with backoff", async () => {
    expect(crashAtBoot).toMatchObject({ status: "error", error: "server part failed: crash 1" });
    // Fails at boot, after 50 ms and after 100 ms more, then runs.
    await eventually(() => {
      expect(plugin("crash")).toMatchObject({ status: "ok", state: { runs: 4 } });
      expect(plugin("crash")?.error).toBeUndefined();
    });
  });

  test("reports invalid settings and starts the server part once they are fixed", async () => {
    expect(plugin("needs-settings")).toMatchObject({
      status: "error",
      error: expect.stringMatching(/invalid settings/),
    });
    const res = await command("plugin.updateSettings", {
      plugin: "needs-settings",
      settings: { token: "abc" },
    });
    expect(res.status).toBe(200);
    await eventually(() => {
      expect(plugin("needs-settings")).toMatchObject({ status: "ok", state: { token: "abc" } });
      expect(plugin("needs-settings")?.error).toBeUndefined();
    });
  });
});

describe("external plugin (M2 acceptance)", () => {
  test("validates instance config and settings", async () => {
    const created = await command("instance.create", {
      plugin: "external",
      type: "banner",
      name: "Hi",
      config: { text: "hi" },
    });
    expect(created.status).toBe(200);
    expect(storbild.hub.state.instances[created.body.id as string]?.config).toEqual({
      text: "hi",
      repeat: 1,
    });

    const invalid = await command("instance.create", {
      plugin: "external",
      type: "banner",
      name: "Bad",
      config: { text: 5 },
    });
    expect(invalid.status).toBe(422);
    expect(invalid.body.issues).toEqual([{ path: ["text"], message: expect.any(String) }]);
    expect((await command("instance.create", { plugin: "external" })).status).toBe(400);
    const unknownType = await command("instance.create", {
      plugin: "external",
      type: "nope",
      name: "X",
      config: {},
    });
    expect(unknownType.status).toBe(404);

    const settings = await command("plugin.updateSettings", {
      plugin: "external",
      settings: { greeting: 5 },
    });
    expect(settings.status).toBe(422);
  });

  test("server part writes plugin state that arrives as a patch on /events", async () => {
    const client = await SseClient.connect(new URL("/events", storbild.viewer.url));
    clients.push(client);
    const snapshot = JSON.parse((await client.nextEvent()).data) as ShowState;
    expect(snapshot.plugins.external?.state).toEqual({ greeting: "hello", banners: ["hi"] });

    const stateOps = async () => {
      for (;;) {
        const frame = await client.nextEvent();
        const ops = JSON.parse(frame.data) as JsonPatchOp[];
        const state = ops.filter((op) => op.path.startsWith("/plugins/external/state"));
        if (state.length > 0) return { ops, state };
      }
    };

    expect(
      (
        await command("plugin.updateSettings", {
          plugin: "external",
          settings: { greeting: "hej" },
        })
      ).status,
    ).toBe(200);
    const first = await stateOps();
    expect(first.state).toEqual([
      { op: "replace", path: "/plugins/external/state/greeting", value: "hej" },
    ]);
    // Narrow patches: only the state changed, plus the revision.
    expect(first.ops.map((op) => op.path).sort()).toEqual([
      "/plugins/external/state/greeting",
      "/revision",
    ]);

    await command("instance.create", {
      plugin: "external",
      type: "banner",
      name: "Second",
      config: { text: "two" },
    });
    const second = await stateOps();
    expect(second.state).toEqual([
      { op: "replace", path: "/plugins/external/state/banners", value: ["hi", "two"] },
    ]);
  });

  test("serves the plugin's routes on the admin app only", async () => {
    const res = await fetch(new URL("/api/plugins/external/hello?x=1", storbild.admin.url));
    expect(await res.json()).toEqual({ path: "/hello", greeting: "hej" });
    expect((await fetch(new URL("/api/plugins/markdown/x", storbild.admin.url))).status).toBe(404);
    expect((await fetch(new URL("/api/plugins/external/hello", storbild.viewer.url))).status).toBe(
      404,
    );
  });

  test("type-checks outside the repository against the SDK alone", async () => {
    const dir = join(root, "typecheck");
    cpSync(fixture, dir, { recursive: true });
    const modules = join(dir, "node_modules");
    mkdirSync(join(modules, "@storbild"), { recursive: true });
    symlinkSync(join(repoRoot, "packages/plugin-sdk"), join(modules, "@storbild/plugin-sdk"));
    symlinkSync(
      dirname(Bun.resolveSync("lit/package.json", join(repoRoot, "packages/plugin-sdk"))),
      join(modules, "lit"),
    );
    const tsc = async () => {
      const proc = Bun.spawn([join(repoRoot, "node_modules/.bin/tsc"), "-p", dir], {
        stdout: "pipe",
        stderr: "pipe",
      });
      return { code: await proc.exited, output: await new Response(proc.stdout).text() };
    };

    expect(await tsc()).toEqual({ code: 0, output: "" });

    // Inference reaches the viewer element: a wrong config field fails to compile.
    writeFileSync(
      join(dir, "src/wrong.ts"),
      `import type { PluginConfig } from "@storbild/plugin-sdk";
       import type plugin from "./plugin.ts";
       export const wrong: PluginConfig<typeof plugin, "banner">["nope"] = 1;`,
    );
    const failed = await tsc();
    expect(failed.code).not.toBe(0);
    expect(failed.output).toContain("nope");
  }, 30_000);
});

describe("modules", () => {
  test("serve each plugin's viewer module with host modules left external", async () => {
    for (const app of [storbild.viewer, storbild.admin]) {
      const res = await fetch(new URL("/plugins/markdown/0.1.0/viewer.js", app.url));
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/javascript");
      expect(res.headers.get("Cache-Control")).toContain("immutable");
      const code = await res.text();
      expect(code).toContain('from "lit"');
      expect(code).toContain('from "@storbild/plugin-sdk/viewer"');
      expect(code).toContain('customElements.define("sb-markdown-scene"');
    }
    const external = await fetch(new URL("/plugins/external/1.2.3/viewer.js", storbild.viewer.url));
    expect(external.status).toBe(200);
    for (const path of ["/plugins/markdown/9.9.9/viewer.js", "/plugins/nope/1.0.0/viewer.js"]) {
      expect((await fetch(new URL(path, storbild.viewer.url))).status).toBe(404);
    }
  });

  test("serve an import map whose entries all resolve", async () => {
    const res = await fetch(new URL("/importmap.json", storbild.viewer.url));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const { imports } = (await res.json()) as { imports: Record<string, string> };
    for (const specifier of [
      "lit",
      "lit/decorators.js",
      "lit/directives/repeat.js",
      "zod",
      "@storbild/plugin-sdk",
      "@storbild/plugin-sdk/viewer",
    ]) {
      expect(imports[specifier]).toMatch(/^\/vendor\/[0-9a-f]{12}\//);
    }
    for (const url of Object.values(imports)) {
      const module = await fetch(new URL(url, storbild.viewer.url));
      expect([url, module.status]).toEqual([url, 200]);
    }
    const sdk = await (
      await fetch(new URL(imports["@storbild/plugin-sdk/viewer"] as string, storbild.viewer.url))
    ).text();
    expect(sdk).toMatch(/from\s*"lit"/);
  });
});

describe("restart", () => {
  test("marks instances of a removed plugin as broken and keeps its data", async () => {
    const before = storbild.hub.state;
    const config = parseConfig({
      STORBILD_VIEWER_PORT: "0",
      STORBILD_ADMIN_PORT: "0",
      STORBILD_DATA_DIR: join(root, "data"),
    });
    await storbild.stop();
    storbild = await start(config);
    const state = storbild.hub.state;
    expect(state.revision).toBe(before.revision + 1);
    expect(state.plugins.external).toEqual({
      status: "missing",
      settings: { greeting: "hej" },
      state: { greeting: "hej", banners: ["hi", "two"] },
      types: {},
    });
    const banners = Object.values(state.instances).filter((i) => i.plugin === "external");
    expect(banners).toHaveLength(2);
    for (const banner of banners) expect(banner.error).toMatch(/not installed/);

    // A restart with the same plugins is not a change.
    await storbild.stop();
    storbild = await start(config);
    expect(storbild.hub.state.revision).toBe(state.revision);
  });
});
