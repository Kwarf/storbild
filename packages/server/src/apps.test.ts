import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@storbild/core";
import { createAdminApp } from "./admin-app.ts";
import { type Storbild, start } from "./main.ts";
import { createTestHub } from "./testing.ts";
import { createViewerApp } from "./viewer-app.ts";
import { getViewerBundle } from "./viewer-page.ts";

const viewer = await getViewerBundle();

describe("viewer app", () => {
  const importMap = { imports: { lit: "/vendor/abc/lit/index.js" } };
  const app = createViewerApp({
    hub: createTestHub(),
    now: () => 1234,
    viewer,
    modules: {
      vendor: { hash: "abc", files: new Map(), specifiers: {} },
      plugins: new Map(),
      importMap,
    },
  });

  test("serves the viewer page uncached, with the import map inline", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toStartWith("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain(`<script type="importmap">${JSON.stringify(importMap)}</script>`);
    expect(html).toContain(`<script type="module" src="/app/${viewer.hash}/viewer.js">`);
    expect(html).toContain("<sb-viewer></sb-viewer>");
  });

  test("serves the viewer bundle immutably, with lit left to the import map", async () => {
    const res = await app.request(`/app/${viewer.hash}/viewer.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toStartWith("text/javascript");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    const code = await res.text();
    expect(code).toMatch(/from\s*"lit"/);
  });

  test("a stale bundle hash is a 404", async () => {
    expect((await app.request("/app/000000000000/viewer.js")).status).toBe(404);
    expect((await app.request(`/app/${viewer.hash}/missing.js`)).status).toBe(404);
  });

  test("serves the server time uncached", async () => {
    const res = await app.request("/time");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ now: 1234 });
  });

  test.each(["/api/commands", "/api/events", "/login"])(
    "does not expose admin route %s",
    async (path) => {
      expect((await app.request(path)).status).toBe(404);
      expect((await app.request(path, { method: "POST" })).status).toBe(404);
    },
  );
});

describe("admin app", () => {
  const hub = createTestHub();
  const app = createAdminApp({ hub });
  const post = (body: unknown) =>
    app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const create = {
    type: "instance.create",
    payload: { plugin: "markdown", type: "text", name: "Rules", config: { content: "#" } },
  };

  test("serves the admin root", async () => {
    expect((await app.request("/")).status).toBe(200);
  });

  test("applies a command and returns the revision and new ID", async () => {
    const res = await post(create);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revision: number; id: string };
    expect(body.revision).toBe(hub.state.revision);
    expect(hub.state.instances[body.id]?.name).toBe("Rules");
  });

  test.each([
    ["unknown type", { type: "nope", payload: {} }],
    ["bad payload", { type: "instance.create", payload: { name: "" } }],
    ["not JSON object", "hello"],
  ])("rejects an invalid command with 400: %s", async (_, body) => {
    const before = hub.state.revision;
    expect((await post(body)).status).toBe(400);
    expect(hub.state.revision).toBe(before);
  });

  test("rejects a stale expectedRevision with 409", async () => {
    const res = await post({ ...create, expectedRevision: hub.state.revision - 1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "revision_conflict", revision: hub.state.revision });
  });

  test("accepts a current expectedRevision", async () => {
    expect((await post({ ...create, expectedRevision: hub.state.revision })).status).toBe(200);
  });

  test("maps command errors to 404 and 422", async () => {
    const missing = await post({ type: "instance.delete", payload: { id: "nope" } });
    expect(missing.status).toBe(404);
    const invalid = await post({ type: "playlist.reorder", payload: { itemIds: ["x"] } });
    expect(invalid.status).toBe(422);
  });
});

describe("start", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "storbild-"));
  let storbild: Storbild;
  beforeAll(async () => {
    storbild = await start(
      parseConfig({
        STORBILD_VIEWER_PORT: "0",
        STORBILD_ADMIN_PORT: "0",
        STORBILD_DATA_DIR: dataDir,
      }),
    );
  });
  afterAll(async () => {
    await storbild.stop();
    rmSync(dataDir, { recursive: true });
  });

  test("serves both apps on separate ports", async () => {
    expect(storbild.viewer.port).not.toBe(storbild.admin.port);
    expect(await (await fetch(storbild.viewer.url)).text()).toContain("<sb-viewer>");
    expect(await (await fetch(storbild.admin.url)).text()).toBe("Storbild admin");
  });
});
