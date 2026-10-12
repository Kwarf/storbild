// Viewer acceptance tests (DESIGN.md §9 M3) in a real Chromium. They need a browser, so they
// only run with STORBILD_E2E=1, after `bunx playwright install chromium`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShowState } from "@storbild/core";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { type Storbild, start } from "../src/main.ts";
import { adminHeaders, testConfig } from "../src/testing.ts";
import { enabled, TIMEOUT } from "./helpers.ts";

interface Screen {
  context: BrowserContext;
  page: Page;
}

describe.skipIf(!enabled)("viewer", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "storbild-e2e-"));
  let storbild: Storbild;
  let ports: { viewer: string; admin: string } = { viewer: "0", admin: "0" };
  let browser: Browser;
  let screens: Screen[] = [];
  let auth: Record<string, string>;

  async function boot() {
    storbild = await start(
      testConfig({
        STORBILD_VIEWER_PORT: ports.viewer,
        STORBILD_ADMIN_PORT: ports.admin,
        STORBILD_DATA_DIR: dataDir,
        STORBILD_PLUGIN_PATHS: join(import.meta.dir, "probe-plugin"),
      }),
      { stream: { heartbeatMs: 1_000 } },
    );
    ports = { viewer: String(storbild.viewer.port), admin: String(storbild.admin.port) };
    auth = await adminHeaders(storbild.admin.url);
  }

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

  const probe = async (label: string, extra: object = {}) =>
    (await command("instance.create", {
      plugin: "probe",
      type: "scene",
      name: label,
      config: { label, ...extra },
    })) as string;

  /**
   * Replaces the playlist with one item per instance, in order. Items last 10 minutes, so
   * nothing rotates during a test, unless a duration is given.
   */
  async function setPlaylist(...items: (string | { instanceId: string; durationMs: number })[]) {
    const existing = storbild.hub.state.playlist.items.map((item) => item.id);
    for (const item of items) {
      await command(
        "playlist.addItem",
        typeof item === "string" ? { instanceId: item, durationMs: 600_000 } : item,
      );
    }
    // Removing the item on air puts the first new one on air now.
    for (const id of existing) await command("playlist.removeItem", { id });
  }

  const forAll = (fn: (page: Page) => Promise<unknown>) =>
    Promise.all(screens.map(({ page }) => fn(page)));

  const bootId = (page: Page) => page.evaluate(() => window.__storbild.bootId);
  const probeEvents = (page: Page) => page.evaluate(() => window.__probe ?? []);
  const scene = (page: Page, layer: string, phase = "current") =>
    page.locator(`sb-compositor .${layer} > .scene[data-phase="${phase}"]`);

  beforeAll(async () => {
    await boot();
    browser = await chromium.launch();
    for (const viewport of [
      { width: 1920, height: 1080 },
      { width: 1000, height: 800 },
    ]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      page.on("pageerror", (error) => console.error("page error:", error));
      await page.goto(storbild.viewer.url.href);
      screens.push({ context, page });
    }
  }, TIMEOUT);

  afterAll(async () => {
    await browser?.close();
    await storbild?.stop();
    rmSync(dataDir, { recursive: true, force: true });
    screens = [];
  });

  let boots: string[];
  let markdown: string;

  test(
    "both screens show the same markdown instance on a letterboxed 16:9 stage",
    async () => {
      boots = await Promise.all(screens.map(({ page }) => bootId(page)));
      markdown = (await command("instance.create", {
        plugin: "markdown",
        type: "text",
        name: "Welcome",
        config: { content: "# Welcome\n\nHello, party" },
      })) as string;
      await setPlaylist(markdown);
      await forAll((page) =>
        scene(page, "main").locator("sb-markdown-scene h1", { hasText: "Welcome" }).waitFor(),
      );

      const small = screens[1]?.page as Page;
      const box = await small.locator("sb-stage .canvas").boundingBox();
      expect(box).not.toBeNull();
      if (!box) return;
      // 1000×800: scaled by 1000/1920 to 1000×562.5, centred vertically.
      expect(box.width).toBeCloseTo(1000, 0);
      expect(box.height).toBeCloseTo(562.5, 0);
      expect(box.x).toBeCloseTo(0, 0);
      expect(box.y).toBeCloseTo((800 - 562.5) / 2, 0);
    },
    TIMEOUT,
  );

  test(
    "changing the instance updates both screens in place",
    async () => {
      await command("instance.update", {
        id: markdown,
        config: { content: "# Welcome\n\nDoors open at 18:00" },
      });
      await forAll((page) =>
        scene(page, "main").locator("sb-markdown-scene p", { hasText: "Doors open" }).waitFor(),
      );
      expect(await Promise.all(screens.map(({ page }) => bootId(page)))).toEqual(boots);
    },
    TIMEOUT,
  );

  let a: string;
  let b: string;

  test(
    "a new main scene crossfades, with at most two mounted",
    async () => {
      a = await probe("A");
      b = await probe("B");
      await setPlaylist(a);
      await forAll((page) => scene(page, "main").locator(".probe", { hasText: "A" }).waitFor());

      // A long fade, so the outgoing scene can be seen even on a loaded machine.
      await command("settings.update", { transitionMs: 4_000 });
      await setPlaylist(b);
      await forAll(async (page) => {
        await scene(page, "main", "out").waitFor();
        expect(await page.locator("sb-compositor .main > .scene").count()).toBeLessThanOrEqual(2);
        await scene(page, "main", "out").waitFor({ state: "detached" });
        await scene(page, "main").locator(".probe", { hasText: "B" }).waitFor();
        expect(await page.locator("sb-compositor .main > .scene").count()).toBe(1);
        const events = await probeEvents(page);
        expect(events).toContain("prepare B");
        expect(events.indexOf("prepare B")).toBeLessThan(events.indexOf("enter B"));
        expect(events).toContain("exit A");
        expect(events).toContain("dispose A");
      });
      await command("settings.update", { transitionMs: 800 });
    },
    TIMEOUT,
  );

  test(
    "recovers from a server restart without reloading",
    async () => {
      await storbild.stop();
      await Bun.sleep(3_000);
      await boot();
      await command("instance.update", {
        id: b,
        config: { label: "B after restart" },
      });
      await forAll((page) =>
        scene(page, "main").locator(".probe", { hasText: "B after restart" }).waitFor(),
      );
      expect(await Promise.all(screens.map(({ page }) => bootId(page)))).toEqual(boots);
    },
    TIMEOUT,
  );

  test(
    "prefetches and prepares the next scene before it goes on air at its start",
    async () => {
      const c = await probe("C", { prepareMs: 300 });
      // B stays on air (same instance, kept in place) for 4 s, then C.
      await setPlaylist({ instanceId: b, durationMs: 4_000 }, c);
      const startsAt = storbild.hub.state.timeline.next?.startsAt as number;
      expect(storbild.hub.state.timeline.next?.instanceId).toBe(c);
      await forAll(async (page) => {
        await scene(page, "main", "ready").locator(".probe", { hasText: "C" }).waitFor({
          state: "attached",
        });
        // Still hidden behind B.
        await scene(page, "main").locator(".probe", { hasText: "B" }).waitFor();
      });

      await forAll(async (page) => {
        await scene(page, "main").locator(".probe", { hasText: "C" }).waitFor();
        const events = await probeEvents(page);
        expect(events.filter((event) => event === "prepare C")).toHaveLength(1);
      });
      // The switch happened at the scheduled start, not before it.
      expect(Date.now()).toBeGreaterThanOrEqual(startsAt - 200);
    },
    TIMEOUT,
  );

  test(
    "the rotation keeps switching on both screens while they are offline",
    async () => {
      const p = await probe("P");
      const q = await probe("Q");
      await setPlaylist({ instanceId: p, durationMs: 2_000 }, { instanceId: q, durationMs: 2_000 });
      await forAll((page) => scene(page, "main").locator(".probe", { hasText: "P" }).waitFor());

      // Stopping the server cuts the streams for certain; Chromium's offline emulation leaves
      // an open stream running (ADR 0019). No patches arrive: each screen switches on its own
      // clock.
      await storbild.stop();
      await forAll(async (page) => {
        await page.waitForFunction(
          () =>
            !(document.querySelector("sb-viewer") as unknown as { sync: { connected: boolean } })
              .sync.connected,
        );
        await scene(page, "main").locator(".probe", { hasText: "Q" }).waitFor();
        await scene(page, "main").locator(".probe", { hasText: "P" }).waitFor();
      });
      await boot();
      expect(await Promise.all(screens.map(({ page }) => bootId(page)))).toEqual(boots);
    },
    TIMEOUT,
  );

  test(
    "an interrupt shows above main and dims it; blackout covers everything",
    async () => {
      const d = await probe("D");
      await command("live.interrupt", { instanceId: d, below: "dim" });
      await forAll(async (page) => {
        await scene(page, "interrupt").locator(".probe", { hasText: "D" }).waitFor();
        await page.locator("sb-compositor .dim.on").waitFor({ state: "attached" });
      });

      await command("live.blackout", { on: true });
      await forAll(async (page) => {
        const blackout = page.locator("sb-compositor .blackout.on");
        await blackout.waitFor({ state: "attached" });
        await page.waitForFunction(
          (el) => el !== null && getComputedStyle(el).opacity === "1",
          await blackout.elementHandle(),
        );
      });

      await command("live.clearInterrupt", {});
      await command("live.blackout", { on: false });
      await forAll(async (page) => {
        await page.locator("sb-compositor .interrupt > .scene").waitFor({ state: "detached" });
        await page.locator("sb-compositor .dim.on").waitFor({ state: "detached" });
      });
    },
    TIMEOUT,
  );

  test(
    "a failing prepare() still shows the scene; a broken instance shows only the background",
    async () => {
      const e = await probe("E", { failPrepare: true });
      await setPlaylist(e);
      await forAll((page) => scene(page, "main").locator(".probe", { hasText: "E" }).waitFor());

      // Breaking the only item takes it off air.
      storbild.hub.update((state) => ({
        ...state,
        instances: {
          ...state.instances,
          [e]: { ...(state.instances[e] as ShowState["instances"][string]), error: "broken" },
        },
      }));
      await forAll(async (page) => {
        await page.locator("sb-compositor .main > .scene").waitFor({ state: "detached" });
        expect(await page.locator("sb-compositor .background").count()).toBe(1);
      });
      expect(await Promise.all(screens.map(({ page }) => bootId(page)))).toEqual(boots);
    },
    TIMEOUT,
  );

  test(
    "two widgets stack in bottom-right; a scene reserving the slot hides them until it ends",
    async () => {
      await setPlaylist(markdown);
      const widget = async (label: string, height: number) => {
        const id = (await command("instance.create", {
          plugin: "probe",
          type: "widget",
          name: label,
          config: { label, height },
        })) as string;
        await command("overlay.place", { instanceId: id, slot: "bottom-right" });
        return id;
      };
      const a = await widget("A", 80);
      const b = await widget("B", 120);
      const corner = (await command("instance.create", {
        plugin: "probe",
        type: "corner",
        name: "Corner",
        config: { label: "Corner" },
      })) as string;
      const box = (page: Page, id: string) =>
        page.locator(`sb-compositor .widget[data-widget="${id}"]`);
      const phase = (id: string, value: string) =>
        forAll((page) =>
          box(page, id)
            .and(page.locator(`[data-phase="${value}"]`))
            .waitFor({ state: "attached" }),
        );

      await phase(a, "shown");
      await phase(b, "shown");
      // On the full-size screen the canvas is unscaled: 96 px safe area, 24 px gap, order 0 in
      // the corner and the next one above it.
      const big = screens[0]?.page as Page;
      const boxA = await box(big, a).boundingBox();
      const boxB = await box(big, b).boundingBox();
      if (!boxA || !boxB) throw new Error("no boxes");
      expect(boxA.x + boxA.width).toBeCloseTo(1920 - 96, 0);
      expect(boxA.y + boxA.height).toBeCloseTo(1080 - 96, 0);
      expect(boxB.x + boxB.width).toBeCloseTo(1920 - 96, 0);
      expect(boxB.y + boxB.height).toBeCloseTo(boxA.y - 24, 0);
      expect(boxB.height).toBeCloseTo(120, 0);

      await command("live.take", { instanceId: corner });
      await forAll((page) => scene(page, "main").locator(".probe-corner").waitFor());
      await phase(a, "hidden");
      await phase(b, "hidden");

      await command("live.resume", {});
      await phase(a, "shown");
      await phase(b, "shown");

      // A stale widget leaves the stack and the next one closes the gap.
      await command("instance.update", {
        id: a,
        config: { label: "A", height: 80, staleAt: 1 },
      });
      await phase(a, "hidden");
      for (let i = 0; ; i++) {
        const moved = await box(big, b).boundingBox();
        if (moved && Math.round(moved.y + moved.height) === 1080 - 96) break;
        if (i > 50) throw new Error(`B did not close the gap: ${JSON.stringify(moved)}`);
        await big.waitForTimeout(100);
      }

      // Hidden in the admin: faded out and removed.
      await command("overlay.update", { instanceId: b, visible: false });
      await forAll((page) => box(page, b).waitFor({ state: "detached" }));
      expect(await Promise.all(screens.map(({ page }) => bootId(page)))).toEqual(boots);
    },
    TIMEOUT,
  );
});

declare global {
  interface Window {
    __storbild: { bootId: string };
    __probe?: string[];
  }
}
