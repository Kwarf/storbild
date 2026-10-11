// M7 acceptance in a real Chromium (DESIGN.md §9, ADR 0014): a theme with an uploaded font, an
// image background and its own colours is made in the admin's Theme page and activated. The
// screen changes its background, fonts and colours without a reload, and never shows the
// theme's variables before its font has loaded. Scene backgrounds, the interrupt cover and a
// video background are checked too. Screenshots for the visual review (§8.3) go to
// e2e/screenshots/. Runs only with STORBILD_E2E=1.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetMeta } from "@storbild/core";
import { type Browser, chromium, type Page } from "playwright";
import { type Storbild, start } from "../src/main.ts";
import { adminHeaders, TEST_PASSWORD, testConfig } from "../src/testing.ts";

const enabled = process.env.STORBILD_E2E === "1";
const TIMEOUT = 30_000;
const screenshots = join(import.meta.dir, "screenshots");

/** A bold woff2 from the admin's own font package. */
const fontPath = Bun.resolveSync(
  "@fontsource/instrument-sans/files/instrument-sans-latin-700-normal.woff2",
  join(import.meta.dir, "../../admin"),
);

/** A real 1×1 PNG. */
const png = Uint8Array.fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
);

describe.skipIf(!enabled)("theming", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "storbild-e2e-"));
  let storbild: Storbild;
  let browser: Browser;
  let admin: Page;
  let screen: Page;
  let auth: Record<string, string>;
  let welcome: string;
  let image: AssetMeta;

  const state = () => storbild.hub.state;
  const until = async (check: () => boolean, timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("condition not met in time");
      await Bun.sleep(25);
    }
  };
  const shot = async (page: Page, name: string) => {
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await Bun.sleep(300);
      await page.screenshot({ path: join(screenshots, `${name}-${colorScheme}.png`) });
    }
    await page.emulateMedia({ colorScheme: "light" });
  };
  const go = async (section: string) => {
    await admin.getByRole("link", { name: section }).click();
    await admin.getByRole("heading", { name: section, level: 1 }).waitFor();
  };
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
  async function upload(file: Blob, name: string): Promise<AssetMeta> {
    const url = new URL("/api/assets", storbild.admin.url);
    url.searchParams.set("name", name);
    const res = await fetch(url, { method: "POST", headers: auth, body: file });
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
    return (await res.json()) as AssetMeta;
  }
  const bootId = (page: Page) =>
    page.evaluate(
      () => (window as unknown as { __storbild: { bootId: string } }).__storbild.bootId,
    );
  const heading = () => screen.locator("sb-compositor .main .scene[data-phase='current'] h1");
  const editor = () => admin.getByLabel("Theme editor");

  beforeAll(async () => {
    mkdirSync(screenshots, { recursive: true });
    storbild = await start(
      testConfig({
        STORBILD_VIEWER_PORT: "0",
        STORBILD_ADMIN_PORT: "0",
        STORBILD_DATA_DIR: join(dataDir, "data"),
      }),
      { stream: { heartbeatMs: 1_000 } },
    );
    auth = await adminHeaders(storbild.admin.url);
    welcome = (await command("instance.create", {
      plugin: "markdown",
      type: "text",
      name: "Welcome",
      config: { title: "Welcome", content: "Doors open at 18:00." },
    })) as string;
    await command("playlist.addItem", { instanceId: welcome });
    const clock = await command("instance.create", {
      plugin: "info",
      type: "clock",
      name: "Clock",
      config: {},
    });
    await command("overlay.place", { instanceId: clock, slot: "bottom-right" });
    image = await upload(new Blob([png]), "backdrop.png");
    await upload(Bun.file(fontPath), "Instrument Sans Bold.woff2");

    browser = await chromium.launch();
    screen = await (
      await browser.newContext({ viewport: { width: 1920, height: 1080 } })
    ).newPage();
    admin = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    for (const page of [screen, admin]) {
      page.on("pageerror", (error) => console.error("page error:", error));
    }
    await screen.goto(storbild.viewer.url.href);
    await admin.goto(storbild.admin.url.href);
    await admin.getByLabel("Username").fill("admin");
    await admin.getByLabel("Password").fill(TEST_PASSWORD);
    await admin.getByRole("button", { name: "Log in" }).click();
    await admin.waitForURL((url) => url.pathname === "/live");
  }, TIMEOUT);

  afterAll(async () => {
    await browser?.close();
    await storbild?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test(
    "a theme made in the admin changes the screen's background, fonts and colours live",
    async () => {
      await heading().waitFor();
      const boot = await bootId(screen);
      // Whenever the compositor switches to an uploaded font, that font must have loaded.
      await screen.evaluate(() => {
        const host = document.querySelector("sb-compositor") as HTMLElement;
        const seen: boolean[] = [];
        (window as unknown as { __fontsAtSwitch: boolean[] }).__fontsAtSwitch = seen;
        new MutationObserver(() => {
          const family = host.style.getPropertyValue("--sb-font-heading");
          if (!family.includes("sbf-")) return;
          const faces = [...document.fonts].filter((face) => family.includes(face.family));
          seen.push(faces.length > 0 && faces.every((face) => face.status === "loaded"));
        }).observe(host, { attributes: true, attributeFilter: ["style"] });
      });

      await go("Theme");
      await editor().getByRole("heading", { name: "Default" }).waitFor();
      await admin.getByRole("button", { name: "New theme" }).click();
      await editor().getByLabel("Name", { exact: true }).fill("Party");

      const background = editor().locator('[data-section="background"]');
      await background.getByLabel("Type").selectOption({ label: "Image" });
      await background.getByRole("button", { name: "Choose Image" }).click();
      await background.getByRole("button", { name: /backdrop\.png/ }).click();
      await background.getByLabel("Dim").fill("0.2");

      const colors = editor().locator('[data-section="colors"]');
      await colors.getByLabel("Text", { exact: true }).fill("#ffe08a");
      await colors.getByLabel("Surface", { exact: true }).fill("#203050");

      // Blank layout fields show the defaults they fall back to.
      const layout = editor().locator('[data-section="layout"]');
      expect(await layout.getByLabel("Safe area (px)").getAttribute("placeholder")).toBe("96");
      expect(await layout.getByLabel("Widget gap (px)").getAttribute("placeholder")).toBe("24");

      const headingFont = editor().locator('[data-section="fonts"] sb-field[data-key="heading"]');
      await headingFont.getByLabel("Family", { exact: true }).fill("Instrument Sans");
      await headingFont.getByRole("button", { name: "Add" }).click();
      await headingFont.getByRole("button", { name: "Choose File" }).click();
      await headingFont.getByRole("button", { name: /Instrument Sans Bold/ }).click();
      await headingFont.getByLabel("Weight").selectOption({ label: "700 Bold" });

      // The preview shows the draft before it is saved.
      await editor().locator('sb-compositor .backdrop[data-background="image"]').first().waitFor();
      await editor().getByRole("button", { name: "Create" }).click();
      await until(() => Object.values(state().themes).some((t) => t.name === "Party"));
      const party = Object.values(state().themes).find((t) => t.name === "Party");
      expect(party?.background).toEqual({
        type: "image",
        assetId: image.id,
        fit: "cover",
        dim: 0.2,
      });
      expect(party?.fonts.heading.faces).toEqual([
        { assetId: expect.any(String), weight: 700, style: "normal" },
      ]);
      await editor().getByRole("heading", { name: "Party" }).waitFor();
      await admin.getByRole("heading", { name: "Theme", level: 1 }).scrollIntoViewIfNeeded();
      await shot(admin, "theme");

      await editor().getByRole("button", { name: "Activate" }).click();
      await until(() => state().activeThemeId === party?.id);

      await screen.locator('sb-compositor .backdrop[data-background="image"]').first().waitFor();
      await screen.waitForFunction(() => {
        const h1 = document
          .querySelector("sb-compositor")
          ?.shadowRoot?.querySelector(".main .scene[data-phase='current'] sb-markdown-scene")
          ?.shadowRoot?.querySelector("h1");
        return h1 && getComputedStyle(h1).color === "rgb(255, 224, 138)";
      });
      const family = await heading().evaluate((h1) => getComputedStyle(h1).fontFamily);
      expect(family).toContain("sbf-");
      const rendered = await heading().evaluate((h1) =>
        document.fonts.check(`700 96px ${getComputedStyle(h1).fontFamily}`),
      );
      expect(rendered).toBe(true);
      const clock = screen.locator("sb-compositor sb-info-clock");
      await screen.waitForFunction(() => {
        const element = document
          .querySelector("sb-compositor")
          ?.shadowRoot?.querySelector("sb-info-clock");
        return element && getComputedStyle(element).backgroundColor === "rgb(32, 48, 80)";
      });
      expect(await clock.count()).toBe(1);
      const switches = await screen.evaluate(
        () => (window as unknown as { __fontsAtSwitch: boolean[] }).__fontsAtSwitch,
      );
      expect(switches.length).toBeGreaterThan(0);
      expect(switches.every(Boolean)).toBe(true);
      expect(await bootId(screen)).toBe(boot);
      await Bun.sleep(1_000);
      await screen.screenshot({ path: join(screenshots, "screen-theme.png") });
    },
    TIMEOUT,
  );

  test(
    "a scene's own background hides the theme's, and an interrupt's cover brings it back",
    async () => {
      const layer = (name: string) => screen.locator(`sb-compositor .layer.${name}`);
      await command("instance.update", {
        id: welcome,
        background: { assetId: image.id, fit: "contain" },
      });
      await screen.locator("sb-compositor .main .scene img.scene-background").waitFor();
      await screen.locator("sb-compositor .background.off").waitFor();

      const notice = await command("instance.create", {
        plugin: "markdown",
        type: "text",
        name: "Notice",
        config: { content: "Fire exit" },
      });
      await command("live.interrupt", { instanceId: notice });
      await screen.locator("sb-compositor .main.off").waitFor();
      await layer("overlays.off").waitFor();
      expect(await screen.locator("sb-compositor .background.off").count()).toBe(0);

      await command("live.clearInterrupt", {});
      await screen.locator("sb-compositor .background.off").waitFor();
      await command("instance.update", { id: welcome, background: null });
      await screen.locator("sb-compositor .main .scene img.scene-background").waitFor({
        state: "detached",
      });
      await screen.locator("sb-compositor .background.off").waitFor({ state: "detached" });
    },
    TIMEOUT,
  );

  test(
    "a colour background shows its colour, with nothing over it",
    async () => {
      await command("theme.update", {
        id: state().activeThemeId,
        background: { type: "color", color: "#336699" },
      });
      // What is drawn at the screen's centre, beneath the scene: the backdrop's own colour,
      // not a dim or anything else over it.
      await screen.waitForFunction(() => {
        const root = document.querySelector("sb-compositor")?.shadowRoot;
        const backdrop = root?.querySelector<HTMLElement>('.backdrop[data-background="color"]');
        if (!backdrop || getComputedStyle(backdrop).backgroundColor !== "rgb(51, 102, 153)") {
          return false;
        }
        return [...backdrop.querySelectorAll("*")].every(
          (child) =>
            getComputedStyle(child).opacity === "0" ||
            getComputedStyle(child).backgroundColor === "rgba(0, 0, 0, 0)",
        );
      });
    },
    TIMEOUT,
  );

  test(
    "a video background plays on the screen",
    async () => {
      // Record a short WebM in the browser, since there is no encoder here, and upload it.
      const video = await admin.evaluate(async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 36;
        const context = canvas.getContext("2d") as CanvasRenderingContext2D;
        const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: "video/webm" });
        const chunks: Blob[] = [];
        recorder.ondataavailable = (e) => chunks.push(e.data);
        const stopped = new Promise((resolve) => {
          recorder.onstop = resolve;
        });
        recorder.start();
        for (let i = 0; i < 20; i++) {
          context.fillStyle = `hsl(${i * 18}, 70%, 40%)`;
          context.fillRect(0, 0, 64, 36);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        recorder.stop();
        await stopped;
        const res = await fetch("/api/assets?name=loop.webm", {
          method: "POST",
          body: new Blob(chunks, { type: "video/webm" }),
        });
        return (await res.json()) as AssetMeta;
      });
      expect(video.mimeType).toBe("video/webm");

      const ranged = await fetch(new URL(`/assets/${video.id}`, storbild.viewer.url), {
        headers: { Range: "bytes=0-9" },
      });
      expect(ranged.status).toBe(206);
      expect((await ranged.arrayBuffer()).byteLength).toBe(10);

      await command("theme.update", {
        id: state().activeThemeId,
        background: { type: "video", assetId: video.id, dim: 0.3 },
      });
      await screen.locator('sb-compositor .backdrop[data-background="video"] video').waitFor();
      await screen.waitForFunction(() => {
        const element = document
          .querySelector("sb-compositor")
          ?.shadowRoot?.querySelector<HTMLVideoElement>(".backdrop video");
        return (
          element !== null && element !== undefined && !element.paused && element.readyState >= 2
        );
      });
      // The image backdrop leaves once the video has faded in.
      await screen
        .locator('sb-compositor .backdrop[data-background="image"]')
        .waitFor({ state: "detached" });
    },
    TIMEOUT,
  );
});
