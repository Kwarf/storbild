// Offline resilience (DESIGN.md §9 M10a, ADR 0019) in a real Chromium: a screen that reloads
// while the server is gone starts from its service worker and stored state, keeps rotating,
// says it is offline, and catches up when the server is back. Only runs with STORBILD_E2E=1.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { type Storbild, start } from "../src/main.ts";
import { adminHeaders, testConfig } from "../src/testing.ts";
import { enabled } from "./helpers.ts";

const TIMEOUT = 60_000;

/** A bold woff2 from the admin's own font package. */
const fontPath = Bun.resolveSync(
  "@fontsource/instrument-sans/files/instrument-sans-latin-700-normal.woff2",
  join(import.meta.dir, "../../admin"),
);

/** A real 1×1 PNG, and a second file of it: bytes after IEND are ignored, but change the hash. */
const png = Uint8Array.fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
);
const otherPng = new Uint8Array([...png, 0]);

describe.skipIf(!enabled)("offline", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "storbild-e2e-"));
  let storbild: Storbild | undefined;
  let ports = { viewer: "0", admin: "0" };
  let auth: Record<string, string>;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let alpha: string;

  async function boot() {
    storbild = await start(
      testConfig({
        STORBILD_VIEWER_PORT: ports.viewer,
        STORBILD_ADMIN_PORT: ports.admin,
        STORBILD_DATA_DIR: dataDir,
      }),
      { stream: { heartbeatMs: 1_000 } },
    );
    ports = { viewer: String(storbild.viewer.port), admin: String(storbild.admin.port) };
    auth = await adminHeaders(storbild.admin.url);
  }

  async function shutdown() {
    await storbild?.stop();
    storbild = undefined;
  }

  const server = () => {
    if (!storbild) throw new Error("the server is down");
    return storbild;
  };

  async function command(type: string, payload: unknown): Promise<string> {
    const res = await fetch(new URL("/api/commands", server().admin.url), {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ type, payload }),
    });
    const body = (await res.json()) as { id?: string };
    if (!res.ok) throw new Error(`${type} failed: ${JSON.stringify(body)}`);
    return body.id as string;
  }

  async function upload(body: Blob, name: string): Promise<string> {
    const res = await fetch(new URL(`/api/assets?name=${name}`, server().admin.url), {
      method: "POST",
      headers: auth,
      body,
    });
    const asset = (await res.json()) as { id: string };
    if (!res.ok) throw new Error(`upload failed: ${JSON.stringify(asset)}`);
    return asset.id;
  }

  const bootId = () => page.evaluate(() => window.__storbild.bootId);
  const markdown = (text: string) =>
    page.locator(`sb-compositor .main > .scene[data-phase="current"] sb-markdown-scene h1`, {
      hasText: text,
    });
  /** The slideshow on air, with an image that has loaded. */
  const slideshowLoaded = () =>
    page.waitForFunction(
      () => {
        const compositor = document.querySelector("sb-compositor");
        const scene = compositor?.shadowRoot?.querySelector(
          '.main > .scene[data-phase="current"] sb-slideshow',
        );
        const img = scene?.shadowRoot?.querySelector("img.shown") as HTMLImageElement | null;
        return img?.complete === true && img.naturalWidth > 0;
      },
      undefined,
      { timeout: 15_000 },
    );
  const offlinePill = () => page.locator("sb-compositor .offline.on .pill");
  /** Whether the uploaded theme font is loaded on the page. */
  const fontLoaded = () =>
    page.evaluate(() =>
      [...document.fonts].some((face) => face.family.includes("sbf-") && face.status === "loaded"),
    );

  /** Waits until the screen is ready to start without the server. */
  async function waitUntilCached(assets: number) {
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
      timeout: 15_000,
    });
    await page.waitForFunction(
      async (count) => {
        const cache = await caches.open("storbild-assets");
        return (await cache.keys()).length === count;
      },
      assets,
      { timeout: 15_000, polling: 250 },
    );
    await page.waitForFunction(() => localStorage.getItem("storbild:last") !== null);
  }

  beforeAll(async () => {
    await boot();
    const image = await upload(new Blob([png]), "one.png");
    const image2 = await upload(new Blob([otherPng]), "two.png");
    const font = await upload(Bun.file(fontPath), "Instrument Sans Bold.woff2");
    const theme = server().hub.state.activeThemeId;
    await command("theme.update", {
      id: theme,
      fonts: {
        heading: { family: "Instrument Sans", faces: [{ assetId: font, weight: 700 }] },
        body: { family: "sans-serif" },
      },
    });
    alpha = await command("instance.create", {
      plugin: "markdown",
      type: "text",
      name: "Alpha",
      config: { content: "# Alpha" },
    });
    const slides = await command("instance.create", {
      plugin: "slideshow",
      type: "images",
      name: "Slides",
      config: { images: [image, image2], perImageMs: 1_500, fit: "contain" },
    });
    await command("playlist.addItem", { instanceId: alpha, durationMs: 3_000 });
    await command("playlist.addItem", { instanceId: slides });

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 960, height: 540 } });
    page = await context.newPage();
    page.on("pageerror", (error) => console.error("page error:", error));
    await page.goto(server().viewer.url.href);
    await waitUntilCached(3);
  }, TIMEOUT);

  afterAll(async () => {
    await browser?.close();
    await shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test(
    "a screen reloaded while the server is down starts from its cache and keeps rotating",
    async () => {
      await shutdown();
      await page.reload();
      await markdown("Alpha").waitFor({ timeout: 15_000 });
      await slideshowLoaded();
      await markdown("Alpha").waitFor({ timeout: 15_000 });
      expect(await fontLoaded()).toBe(true);
      // It started from its stored state, so it says it is offline at once.
      await offlinePill().waitFor();
      expect(await offlinePill().textContent()).toMatch(/^Offline · last update \d\d:\d\d$/);
      await markdown("Alpha").waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1_000);
      await page.screenshot({ path: join(import.meta.dir, "screenshots", "screen-offline.png") });
    },
    TIMEOUT,
  );

  test(
    "when the server is back, the screen catches up without reloading and stops saying it is offline",
    async () => {
      const boot0 = await bootId();
      await boot();
      await command("instance.update", { id: alpha, config: { content: "# Alpha again" } });
      await markdown("Alpha again").waitFor({ timeout: 45_000 });
      await offlinePill().waitFor({ state: "detached" });
      expect(await page.locator("sb-compositor .offline.on").count()).toBe(0);
      expect(await bootId()).toBe(boot0);
    },
    TIMEOUT,
  );

  test(
    "a short server restart never shows the offline indicator",
    async () => {
      await page.evaluate(() => {
        const w = window as unknown as { __sawOffline: boolean };
        w.__sawOffline = false;
        setInterval(() => {
          const compositor = document.querySelector("sb-compositor");
          if (compositor?.shadowRoot?.querySelector(".offline.on")) w.__sawOffline = true;
        }, 100);
      });
      await shutdown();
      await Bun.sleep(3_000);
      await boot();
      await command("instance.update", { id: alpha, config: { content: "# Alpha third" } });
      await markdown("Alpha third").waitFor({ timeout: 20_000 });
      expect(
        await page.evaluate(() => (window as unknown as { __sawOffline: boolean }).__sawOffline),
      ).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "a screen reloaded during a network outage starts from its cache and catches up after",
    async () => {
      await markdown("Alpha third").waitFor({ timeout: 15_000 });
      // Chromium's offline emulation leaves an open stream running, so only the reload, whose
      // page, modules, assets and stream all go through the network, sees the outage.
      await context.setOffline(true);
      await page.reload();
      await markdown("Alpha third").waitFor({ timeout: 15_000 });
      await slideshowLoaded();
      await offlinePill().waitFor();
      await command("instance.update", { id: alpha, config: { content: "# Alpha fourth" } });
      await context.setOffline(false);
      await markdown("Alpha fourth").waitFor({ timeout: 45_000 });
      await offlinePill().waitFor({ state: "detached" });
    },
    TIMEOUT,
  );
});
