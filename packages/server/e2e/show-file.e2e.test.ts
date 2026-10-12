// Show portability (DESIGN.md §9 M10a, ADR 0019) in a real Chromium: a show downloaded from
// one Storbild's Settings page imports into a fresh one through its Settings page, and a screen
// on the new one plays the same. Only runs with STORBILD_E2E=1.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShowState } from "@storbild/core";
import { type Browser, chromium, type Page } from "playwright";
import { type Storbild, start } from "../src/main.ts";
import { adminHeaders, testConfig } from "../src/testing.ts";
import { enabled, logIn, screenshots } from "./helpers.ts";

const TIMEOUT = 60_000;

/** A real 1×1 PNG. */
const png = Uint8Array.fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
);

/** What an import keeps, which must match between the two installs. */
const content = (state: ShowState) => ({
  instances: state.instances,
  items: state.playlist.items.map(({ resolvedDurationMs: _, ...item }) => item),
  overlays: state.overlays,
  cues: state.cues,
  themes: state.themes,
  activeThemeId: state.activeThemeId,
  assets: state.assets,
  settings: state.settings,
  pluginSettings: Object.fromEntries(
    Object.entries(state.plugins).map(([id, plugin]) => [id, plugin.settings]),
  ),
});

describe.skipIf(!enabled)("show files", () => {
  const root = mkdtempSync(join(tmpdir(), "storbild-e2e-"));
  const showFile = join(root, "show.zip");
  let source: Storbild;
  let target: Storbild;
  let browser: Browser;

  const boot = (name: string) =>
    start(
      testConfig({
        STORBILD_VIEWER_PORT: "0",
        STORBILD_ADMIN_PORT: "0",
        STORBILD_DATA_DIR: join(root, name),
      }),
      { stream: { heartbeatMs: 1_000 } },
    );

  async function command(storbild: Storbild, type: string, payload: unknown) {
    const res = await fetch(new URL("/api/commands", storbild.admin.url), {
      method: "POST",
      headers: { ...(await adminHeaders(storbild.admin.url)), "Content-Type": "application/json" },
      body: JSON.stringify({ type, payload }),
    });
    const body = (await res.json()) as { id?: string };
    if (!res.ok) throw new Error(`${type} failed: ${JSON.stringify(body)}`);
    return body.id as string;
  }

  async function login(storbild: Storbild): Promise<Page> {
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
    ).newPage();
    page.on("pageerror", (error) => console.error("page error:", error));
    await logIn(page, storbild.admin.url);
    await page.getByRole("link", { name: "Settings" }).click();
    await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
    return page;
  }

  beforeAll(async () => {
    mkdirSync(screenshots, { recursive: true });
    [source, target] = await Promise.all([boot("source"), boot("target")]);

    const headers = await adminHeaders(source.admin.url);
    const res = await fetch(new URL("/api/assets?name=logo.png", source.admin.url), {
      method: "POST",
      headers,
      body: png,
    });
    const { id: image } = (await res.json()) as { id: string };
    const welcome = await command(source, "instance.create", {
      plugin: "markdown",
      type: "text",
      name: "Welcome",
      config: { content: "# Welcome to the party" },
    });
    const slides = await command(source, "instance.create", {
      plugin: "slideshow",
      type: "images",
      name: "Slides",
      config: { images: [image], fit: "contain" },
    });
    const clock = await command(source, "instance.create", {
      plugin: "info",
      type: "clock",
      name: "Clock",
      config: {},
    });
    await command(source, "playlist.addItem", { instanceId: welcome, durationMs: 4_000 });
    await command(source, "playlist.addItem", { instanceId: slides, durationMs: 4_000 });
    await command(source, "overlay.place", { instanceId: clock, slot: "top-right" });
    await command(source, "theme.update", {
      id: source.hub.state.activeThemeId,
      colors: { text: "#fff8e7", muted: "#b0a890", accent: "#ff5577", surface: "#221a2a" },
    });
    await command(source, "settings.update", { transitionMs: 400 });
    await command(source, "cue.create", {
      at: Date.now() + 3_600_000,
      action: { type: "take", instanceId: slides },
    });

    browser = await chromium.launch();
  }, TIMEOUT);

  afterAll(async () => {
    await browser?.close();
    await Promise.all([source?.stop(), target?.stop()]);
    rmSync(root, { recursive: true, force: true });
  });

  test(
    "the Settings page downloads the show as a show file",
    async () => {
      const admin = await login(source);
      const [download] = await Promise.all([
        admin.waitForEvent("download"),
        admin.getByRole("link", { name: "Download show file" }).click(),
      ]);
      expect(download.suggestedFilename()).toMatch(/^storbild-show-\d{4}-\d\d-\d\d\.zip$/);
      await download.saveAs(showFile);
      expect((await Bun.file(showFile).bytes()).length).toBeGreaterThan(png.length);
    },
    TIMEOUT,
  );

  test(
    "a fresh Storbild imports it on its Settings page and plays the same show",
    async () => {
      const admin = await login(target);
      await admin.locator('input[type="file"]').setInputFiles(showFile);
      const hold = admin
        .locator("sb-hold-button", { hasText: "Hold to replace the show" })
        .locator("button");
      await hold.hover();
      await admin.mouse.down();
      await Bun.sleep(1_800);
      await admin.mouse.up();
      await admin.getByRole("status").filter({ hasText: "The show was imported." }).waitFor();
      for (const colorScheme of ["light", "dark"] as const) {
        await admin.emulateMedia({ colorScheme });
        await Bun.sleep(300);
        await admin.screenshot({
          path: join(screenshots, `settings-show-file-${colorScheme}.png`),
          fullPage: true,
        });
      }

      expect(content(target.hub.state)).toEqual(content(source.hub.state));

      const screen = await (
        await browser.newContext({ viewport: { width: 960, height: 540 } })
      ).newPage();
      await screen.goto(target.viewer.url.href);
      const current = '.main > .scene[data-phase="current"]';
      await screen
        .locator(`sb-compositor ${current} sb-markdown-scene h1`, {
          hasText: "Welcome to the party",
        })
        .waitFor({ timeout: 15_000 });
      await screen.locator("sb-compositor .overlays sb-info-clock").waitFor({ timeout: 15_000 });
      const accent = await screen.evaluate(() =>
        document
          .querySelector<HTMLElement>("sb-compositor")
          ?.style.getPropertyValue("--sb-color-accent"),
      );
      expect(accent).toBe("#ff5577");
      await screen.waitForFunction(
        (selector) => {
          const scene = document
            .querySelector("sb-compositor")
            ?.shadowRoot?.querySelector(`${selector} sb-slideshow`);
          const img = scene?.shadowRoot?.querySelector("img.shown") as HTMLImageElement | null;
          return img?.complete === true && img.naturalWidth > 0;
        },
        current,
        { timeout: 15_000 },
      );
    },
    TIMEOUT,
  );
});
