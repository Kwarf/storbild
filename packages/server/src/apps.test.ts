import { afterAll, describe, expect, test } from "bun:test";
import { parseConfig } from "@storbild/core";
import { createAdminApp } from "./admin-app.ts";
import { start } from "./main.ts";
import { createViewerApp } from "./viewer-app.ts";

describe("viewer app", () => {
  const app = createViewerApp();

  test("serves the viewer root", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
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
  test("serves the admin root", async () => {
    const res = await createAdminApp().request("/");
    expect(res.status).toBe(200);
  });
});

describe("start", () => {
  const storbild = start(parseConfig({ STORBILD_VIEWER_PORT: "0", STORBILD_ADMIN_PORT: "0" }));
  afterAll(() => storbild.stop());

  test("serves both apps on separate ports", async () => {
    expect(storbild.viewer.port).not.toBe(storbild.admin.port);
    expect(await (await fetch(storbild.viewer.url)).text()).toBe("Storbild viewer");
    expect(await (await fetch(storbild.admin.url)).text()).toBe("Storbild admin");
  });
});
