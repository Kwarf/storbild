// Element visibility in a real Chromium (ADR 0030): the compositor sets `visible` on scenes and
// widgets, `false` while they are mounted but fully hidden. Runs only with STORBILD_E2E=1.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { type Storbild, start } from "../src/main.ts";
import { adminHeaders, testConfig } from "../src/testing.ts";
import { enabled, TIMEOUT } from "./helpers.ts";

describe.skipIf(!enabled)("element visibility", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "storbild-e2e-"));
  let storbild: Storbild;
  let browser: Browser;
  let screen: Page;
  let auth: Record<string, string>;

  async function command(type: string, payload: unknown): Promise<string | undefined> {
    const res = await fetch(new URL("/api/commands", storbild.admin.url), {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ type, payload }),
    });
    const body = (await res.json()) as { id?: string };
    if (!res.ok) throw new Error(`${type} failed: ${JSON.stringify(body)}`);
    return body.id;
  }

  const create = async (type: string, label: string, extra: object = {}) =>
    (await command("instance.create", {
      plugin: "probe",
      type,
      name: label,
      config: { label },
      ...extra,
    })) as string;

  /** Replaces the playlist with one item per instance, in order. */
  async function setPlaylist(...items: { instanceId: string; durationMs: number }[]) {
    const existing = storbild.hub.state.playlist.items.map((item) => item.id);
    for (const item of items) await command("playlist.addItem", item);
    for (const id of existing) await command("playlist.removeItem", { id });
  }

  /** Waits until the probe element labelled `label` has `visible === value`. */
  const visible = (label: string, value: boolean) =>
    screen.waitForFunction(
      ([label, value]) => {
        const root = document.querySelector("sb-compositor")?.shadowRoot;
        const element = [...(root?.querySelectorAll("probe-scene, probe-widget") ?? [])].find(
          (e) => (e as unknown as { config?: { label?: string } }).config?.label === label,
        );
        return (element as unknown as { visible?: boolean } | undefined)?.visible === value;
      },
      [label, value] as const,
    );
  const events = () => screen.evaluate(() => window.__probe ?? []);

  beforeAll(async () => {
    storbild = await start(
      testConfig({
        STORBILD_VIEWER_PORT: "0",
        STORBILD_ADMIN_PORT: "0",
        STORBILD_DATA_DIR: dataDir,
        STORBILD_PLUGIN_PATHS: join(import.meta.dir, "probe-plugin"),
      }),
    );
    auth = await adminHeaders(storbild.admin.url);
    await command("settings.update", { transitionMs: 300 });
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    screen = await context.newPage();
    screen.on("pageerror", (error) => console.error("page error:", error));
    await screen.goto(storbild.viewer.url.href);
  }, TIMEOUT);

  afterAll(async () => {
    await browser?.close();
    await storbild?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  let a: string;

  test(
    "a prefetched scene is hidden until it enters, and becomes visible before enter()",
    async () => {
      a = await create("scene", "A");
      const b = await create("scene", "B");
      await setPlaylist(
        { instanceId: a, durationMs: 3_000 },
        { instanceId: b, durationMs: 600_000 },
      );
      await visible("A", true);
      await screen
        .locator('sb-compositor .main > .scene[data-phase="ready"] probe-scene')
        .waitFor({ state: "attached" });
      await visible("B", false);

      await visible("B", true);
      const log = await events();
      expect(log).toContain("visible B false");
      expect(log).toContain("enter B");
      expect(log).not.toContain("enter B while hidden");
      // A fades out visible and is disposed without being hidden first. (The rotation then
      // prefetches a new A, which starts hidden.)
      await screen.locator('sb-compositor .main > .scene[data-phase="out"]').waitFor({
        state: "detached",
      });
      const after = await events();
      const leaving = after.slice(after.indexOf("exit A"), after.indexOf("dispose A"));
      expect(leaving).not.toContain("visible A false");
      await setPlaylist({ instanceId: a, durationMs: 600_000 });
      await visible("A", true);
    },
    TIMEOUT,
  );

  test(
    "a blackout hides the scene once it has faded in, and shows it again after",
    async () => {
      await command("live.blackout", { on: true });
      await visible("A", false);
      await command("live.blackout", { on: false });
      await visible("A", true);
    },
    TIMEOUT,
  );

  test(
    "an interrupt's hide cover hides the frozen scene but not the interrupt",
    async () => {
      const notice = await create("scene", "Notice");
      await command("live.interrupt", { instanceId: notice });
      await visible("Notice", true);
      await visible("A", false);
      await command("live.clearInterrupt", {});
      await visible("A", true);
    },
    TIMEOUT,
  );

  test(
    "a theme background scene is hidden behind a scene with its own background",
    async () => {
      const backdrop = await create("scene", "Backdrop");
      const theme = await command("theme.create", {
        name: "Scene background",
        background: { type: "scene", instanceId: backdrop },
      });
      await command("theme.activate", { id: theme });
      await visible("Backdrop", true);

      const full = await create("scene", "Full", { background: "none" });
      await setPlaylist({ instanceId: full, durationMs: 600_000 });
      await visible("Full", true);
      await visible("Backdrop", false);

      // The interrupt's cover brings the theme background back over the frozen scene.
      const notice = await create("scene", "Cover");
      await command("live.interrupt", { instanceId: notice });
      await visible("Backdrop", true);
      await visible("Full", false);
      await command("live.clearInterrupt", {});
      await visible("Full", true);
      await visible("Backdrop", false);

      await setPlaylist({ instanceId: a, durationMs: 600_000 });
      await visible("Backdrop", true);
    },
    TIMEOUT,
  );

  test(
    "a widget is hidden while its slot is reserved or it is stale",
    async () => {
      const widget = await create("widget", "W");
      await command("overlay.place", { instanceId: widget, slot: "bottom-right" });
      await visible("W", true);

      const corner = await create("corner", "Corner");
      await command("live.take", { instanceId: corner });
      await visible("W", false);
      await command("live.resume", {});
      await visible("W", true);

      await command("instance.update", { id: widget, config: { label: "W", staleAt: 1 } });
      await visible("W", false);
    },
    TIMEOUT,
  );
});
