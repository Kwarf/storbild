// M6b acceptance tests (DESIGN.md §9, ADR 0011) in a real Chromium: upload an image and build a
// slideshow in the admin alone, announce a typed message within seconds, and schedule a cue
// that fires on the screen. Screenshots for the visual review (§8.3) go to e2e/screenshots/.
// Runs only with STORBILD_E2E=1.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { type Browser, chromium, type Page } from "playwright";
import { type Storbild, start } from "../src/main.ts";
import { TEST_PASSWORD, testConfig } from "../src/testing.ts";

const enabled = process.env.STORBILD_E2E === "1";
const TIMEOUT = 30_000;
const screenshots = join(import.meta.dir, "screenshots");

/** A solid-colour RGB PNG of the given size. */
function makePng(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array([...new TextEncoder().encode(type), ...data]);
    const out = new DataView(new ArrayBuffer(body.length + 8));
    out.setUint32(0, data.length);
    new Uint8Array(out.buffer).set(body, 4);
    out.setUint32(body.length + 4, Bun.hash.crc32(body));
    return new Uint8Array(out.buffer);
  };
  const header = new DataView(new ArrayBuffer(13));
  header.setUint32(0, width);
  header.setUint32(4, height);
  header.setUint8(8, 8); // bit depth
  header.setUint8(9, 2); // truecolour
  const row = [0, ...Array.from({ length: width }, () => rgb).flat()];
  const pixels = new Uint8Array(Array.from({ length: height }, () => row).flat());
  return new Uint8Array([
    ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ...chunk("IHDR", new Uint8Array(header.buffer)),
    ...chunk("IDAT", deflateSync(pixels)),
    ...chunk("IEND", new Uint8Array()),
  ]);
}

/** A `datetime-local` value with seconds, in local time. */
function toLocalInput(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

describe.skipIf(!enabled)("assets, schedule and quick announce", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "storbild-e2e-"));
  const image = join(dataDir, "sponsor.png");
  let storbild: Storbild;
  let browser: Browser;
  let admin: Page;
  let screen: Page;

  const state = () => storbild.hub.state;
  const named = (name: string) => Object.values(state().instances).find((i) => i.name === name);
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
  const editor = () => admin.getByLabel("Instance editor");
  const layer = (name: "main" | "interrupt", element: string, text?: string) =>
    screen.locator(`sb-compositor .${name} > .scene[data-phase="current"] ${element}`, {
      ...(text && { hasText: text }),
    });

  beforeAll(async () => {
    mkdirSync(screenshots, { recursive: true });
    writeFileSync(image, makePng(320, 180, [214, 92, 40]));
    storbild = await start(
      testConfig({
        STORBILD_VIEWER_PORT: "0",
        STORBILD_ADMIN_PORT: "0",
        STORBILD_DATA_DIR: join(dataDir, "data"),
      }),
      { stream: { heartbeatMs: 1_000 } },
    );
    browser = await chromium.launch();
    screen = await (await browser.newContext({ viewport: { width: 960, height: 540 } })).newPage();
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
    "an image uploaded through the picker plays in a slideshow on the screen",
    async () => {
      await go("Library");
      await admin.getByRole("button", { name: "New instance" }).click();
      await editor().getByLabel("Instance type").selectOption({ label: "Slideshow" });
      await editor().getByLabel("Name").fill("Sponsors");
      await editor().getByRole("button", { name: "Add", exact: true }).click();
      await editor().getByLabel("Upload Image 1").setInputFiles(image);
      await until(() => Object.keys(state().assets).length === 1);
      const [asset] = Object.values(state().assets);
      const id = asset?.id as string;
      expect(asset).toMatchObject({ name: "sponsor.png", mimeType: "image/png", width: 320 });
      // The admin made a thumbnail in the browser.
      expect(asset?.thumbnail).toBe(true);
      await editor().locator("sb-asset-picker .name", { hasText: "sponsor.png" }).waitFor();
      await editor().locator("sb-slideshow img.shown").waitFor();
      // Decoded, not just sized: the thumbnail made from it has pixels too.
      await Bun.sleep(1_200);
      await shot(admin, "library-slideshow");

      await editor().getByRole("button", { name: "Create" }).click();
      await until(() => named("Sponsors") !== undefined);
      expect(named("Sponsors")?.config).toEqual({ images: [id], fit: "cover" });
      await editor().getByRole("button", { name: "Add to rotation" }).click();

      const shown = layer("main", "sb-slideshow img.shown");
      await shown.waitFor({ timeout: 10_000 });
      expect(await shown.getAttribute("src")).toBe(`/assets/${id}`);
      expect(await shown.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(320);
      await Bun.sleep(1_200);
      await screen.screenshot({ path: join(screenshots, "screen-slideshow.png") });
    },
    TIMEOUT,
  );

  test(
    "the file panel shows where a file is used and won't delete it",
    async () => {
      await admin.locator('[data-group="files"] li button').first().click();
      const panel = admin.getByLabel("File", { exact: true });
      await panel.getByText("Sponsors").waitFor();
      await panel.getByText("In use, so it can't be deleted.").waitFor();
      await panel.getByLabel("Name").fill("Main sponsor");
      await panel.getByRole("button", { name: "Rename" }).click();
      await until(() => Object.values(state().assets)[0]?.name === "Main sponsor");
      await shot(admin, "library-file");
    },
    TIMEOUT,
  );

  test(
    "a typed message is on the screen within seconds, over the dimmed scene",
    async () => {
      await go("Live");
      await admin.getByLabel("Beneath the announcement").selectOption({ label: "Dim the screen" });
      await admin.getByLabel("Message").fill("Doors open at 20:00\nBring your ticket");
      const started = Date.now();
      await admin.getByRole("button", { name: "Announce", exact: true }).click();
      await layer("interrupt", "sb-announcement", "Bring your ticket").waitFor({ timeout: 3_000 });
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(state().live.interrupt?.below).toBe("dim");
      await screen.locator("sb-compositor .dim.on").waitFor({ state: "attached" });
      // The message is kept, named after its first line, and can be picked again.
      expect(named("Doors open at 20:00")?.config).toEqual({
        message: "Doors open at 20:00\nBring your ticket",
        tone: "info",
      });
      expect(await admin.getByLabel("Message").inputValue()).toBe("");
      await shot(admin, "live-quick-announce");
      await screen.screenshot({ path: join(screenshots, "screen-announcement.png") });

      await admin.getByRole("button", { name: "Dismiss" }).click();
      await until(() => state().live.interrupt === undefined);
    },
    TIMEOUT,
  );

  test(
    "a cue added on the Schedule page fires on the screen at its time",
    async () => {
      await go("Schedule");
      await admin.getByText("Nothing is scheduled.").waitFor();
      const form = admin.getByLabel("New cue");
      const at = Date.now() + 4_000;
      await form.getByLabel("At", { exact: true }).fill(toLocalInput(at));
      await form
        .getByLabel("Scene", { exact: true })
        .selectOption({ label: "Doors open at 20:00" });
      await form.getByLabel("Duration", { exact: true }).fill("30");
      await form.getByLabel("Beneath", { exact: true }).selectOption({ label: "Over the screen" });
      await form.getByRole("button", { name: "Add cue" }).click();
      await until(() => state().cues.length === 1);
      const [cue] = state().cues;
      expect(cue?.action).toEqual({
        type: "interrupt",
        instanceId: named("Doors open at 20:00")?.id as string,
        durationMs: 30_000,
        below: "show",
      });
      await admin.locator(`[data-cue="${cue?.id}"]`).getByText("Next").waitFor();
      await shot(admin, "schedule");

      await layer("interrupt", "sb-announcement", "Doors open").waitFor({ timeout: 10_000 });
      expect(state().cues[0]?.fired).toBe(true);
      await admin.locator(`[data-cue="${cue?.id}"]`).getByText("Fired").waitFor();
      await admin.getByRole("button", { name: "Remove fired (1)" }).click();
      await until(() => state().cues.length === 0);
    },
    TIMEOUT,
  );
});
