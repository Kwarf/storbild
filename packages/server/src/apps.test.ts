import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAdminBundle } from "./admin-page.ts";
import { type Storbild, start } from "./main.ts";
import {
  adminHeaders,
  createTestAdminApp,
  createTestHub,
  TEST_PASSWORD,
  testConfig,
} from "./testing.ts";
import { createViewerApp } from "./viewer-app.ts";
import {
  getServiceWorkerCode,
  getViewerBundle,
  precacheUrls,
  serviceWorkerScript,
} from "./viewer-page.ts";

const [viewer, adminBundle, serviceWorkerCode] = await Promise.all([
  getViewerBundle(),
  getAdminBundle(),
  getServiceWorkerCode(),
]);

describe("viewer app", () => {
  const importMap = { imports: { lit: "/vendor/abc/lit/index.js" } };
  const file = { body: new Blob(["//"]), type: "text/javascript" };
  const modules = {
    vendor: { hash: "abc", files: new Map([["lit/index.js", file]]), specifiers: {} },
    plugins: new Map([
      ["markdown", { version: "1.2.0", hash: "f00", files: new Map([["viewer.js", file]]) }],
    ]),
    importMap,
  };
  const serviceWorker = serviceWorkerScript(serviceWorkerCode, precacheUrls(viewer, modules));
  const app = createViewerApp({
    hub: createTestHub(),
    now: () => 1234,
    viewer,
    modules,
    serviceWorker,
  });

  test("serves the service worker with a manifest of everything a screen needs", async () => {
    const res = await app.request("/sw.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toStartWith("text/javascript");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    const code = await res.text();
    const manifest = JSON.parse(/^self\.__STORBILD__=(.*);$/m.exec(code)?.[1] ?? "null") as {
      version: string;
      precache: string[];
    };
    expect(manifest.precache).toEqual([
      "/",
      ...[...viewer.files.keys()].map((path) => `/app/${viewer.hash}/${path}`),
      "/vendor/abc/lit/index.js",
      "/plugins/markdown/1.2.0/f00/viewer.js",
    ]);
    // A classic script, which every browser registers.
    expect(code).not.toMatch(/^\s*(?:import|export)\s/m);
    // Any change to what is precached makes a new worker.
    const other = serviceWorkerScript(serviceWorkerCode, [...manifest.precache, "/x"]);
    expect(other).not.toContain(manifest.version);
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

  test.each(["/api/commands", "/api/events", "/api/time", "/login", "/logout", "/live"])(
    "does not expose admin route %s",
    async (path) => {
      expect((await app.request(path)).status).toBe(404);
      expect((await app.request(path, { method: "POST" })).status).toBe(404);
    },
  );
});

describe("admin app", () => {
  const schemas = { markdown: { types: { text: { type: "object" } } } };
  const { app, hub } = createTestAdminApp({ bundle: adminBundle, schemas });
  let cookie: string;
  beforeAll(async () => {
    const res = await app.request("/login", {
      method: "POST",
      headers: { Origin: "http://localhost" },
      body: new URLSearchParams({ username: "admin", password: TEST_PASSWORD }),
    });
    cookie = res.headers.get("Set-Cookie")?.split(";")[0] as string;
  });
  const post = (body: unknown) =>
    app.request("/api/commands", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "http://localhost", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const create = {
    type: "instance.create",
    payload: { plugin: "markdown", type: "text", name: "Rules", config: { content: "#" } },
  };

  test.each(["/", "/live", "/rotation", "/settings"])(
    "serves the shell at %s, uncached, with the import map and bundle",
    async (path) => {
      const res = await app.request(path, { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain('<script type="importmap">');
      expect(html).toContain(`<script type="module" src="/app/${adminBundle.hash}/admin.js">`);
      expect(html).toContain(
        `/app/${adminBundle.hash}/fonts/instrument-sans-latin-400-normal.woff2`,
      );
      expect(html).toContain("<sb-admin></sb-admin>");
    },
  );

  test("sends the shell to the login page without a session", async () => {
    const res = await app.request("/live");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });

  test("serves the bundle and fonts publicly and immutably, with lit left to the import map", async () => {
    const js = await app.request(`/app/${adminBundle.hash}/admin.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("Cache-Control")).toContain("immutable");
    expect(await js.text()).toMatch(/from\s*"lit"/);
    const font = await app.request(
      `/app/${adminBundle.hash}/fonts/instrument-sans-latin-600-normal.woff2`,
    );
    expect(font.status).toBe(200);
    expect(font.headers.get("Content-Type")).toBe("font/woff2");
  });

  test("serves the server time", async () => {
    const res = await app.request("/api/time", { headers: { Cookie: cookie } });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ now: 1_000_000 });
  });

  test("serves the plugins' JSON Schemas behind the session, uncached", async () => {
    expect((await app.request("/api/schemas")).status).toBe(401);
    const res = await app.request("/api/schemas", { headers: { Cookie: cookie } });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual(schemas);
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
      testConfig({
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
    const login = await fetch(storbild.admin.url);
    expect(login.url).toEndWith("/login");
    const page = await fetch(storbild.admin.url, {
      headers: await adminHeaders(storbild.admin.url),
    });
    expect(await page.text()).toContain("<sb-admin>");
  });
});
