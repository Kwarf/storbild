// Admin acceptance tests (DESIGN.md §9 M5) in a real Chromium: log in, see what is on screen
// and next, take, announce, black out and resume, with a viewer alongside. Screenshots for the
// visual review (§8.3) go to e2e/screenshots/. Runs only with STORBILD_E2E=1.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { type Storbild, start } from "../src/main.ts";
import { adminHeaders, TEST_PASSWORD, testConfig } from "../src/testing.ts";

const enabled = process.env.STORBILD_E2E === "1";
const TIMEOUT = 30_000;
const screenshots = join(import.meta.dir, "screenshots");

describe.skipIf(!enabled)("admin", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "storbild-e2e-"));
  let storbild: Storbild;
  let browser: Browser;
  let admin: Page;
  let screen: Page;
  let auth: Record<string, string>;
  const ids: Record<string, string> = {};

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

  const probe = async (label: string) => {
    ids[label] = (await command("instance.create", {
      plugin: "probe",
      type: "scene",
      name: label,
      config: { label },
    })) as string;
    return ids[label] as string;
  };

  const shot = async (page: Page, name: string) => {
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      // Let colour transitions settle.
      await Bun.sleep(300);
      await page.screenshot({ path: join(screenshots, `${name}-${colorScheme}.png`) });
    }
    await page.emulateMedia({ colorScheme: "light" });
  };

  const mode = () => admin.locator("sb-strip .mode");
  const onScreen = (layer: string, label: string) =>
    screen.locator(`sb-compositor .${layer} > .scene[data-phase="current"] .probe`, {
      hasText: label,
    });

  beforeAll(async () => {
    mkdirSync(screenshots, { recursive: true });
    storbild = await start(
      testConfig({
        STORBILD_VIEWER_PORT: "0",
        STORBILD_ADMIN_PORT: "0",
        STORBILD_DATA_DIR: dataDir,
        STORBILD_PLUGIN_PATHS: join(import.meta.dir, "probe-plugin"),
      }),
      { stream: { heartbeatMs: 1_000 } },
    );
    auth = await adminHeaders(storbild.admin.url);
    for (const label of ["Welcome", "Rules"]) {
      await command("playlist.addItem", { instanceId: await probe(label), durationMs: 600_000 });
    }
    await probe("Fire exit");
    await probe("Prizegiving");

    browser = await chromium.launch();
    screen = await (await browser.newContext({ viewport: { width: 960, height: 540 } })).newPage();
    await screen.goto(storbild.viewer.url.href);
    admin = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    for (const page of [screen, admin]) {
      page.on("pageerror", (error) => console.error("page error:", error));
    }
  }, TIMEOUT);

  afterAll(async () => {
    await browser?.close();
    await storbild?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test(
    "an operator logs in through the form",
    async () => {
      await admin.goto(storbild.admin.url.href);
      expect(new URL(admin.url()).pathname).toBe("/login");
      await shot(admin, "login");

      await admin.getByLabel("Username").fill("admin");
      await admin.getByLabel("Password").fill("wrong");
      await admin.getByRole("button", { name: "Log in" }).click();
      await admin.getByText("Wrong username or password.").waitFor();

      await admin.getByLabel("Password").fill(TEST_PASSWORD);
      await admin.getByRole("button", { name: "Log in" }).click();
      await admin.waitForURL((url) => url.pathname === "/live");
      await admin.getByRole("heading", { name: "Live" }).waitFor();
    },
    TIMEOUT,
  );

  test(
    "the strip shows what is on screen and what is next, with a live preview",
    async () => {
      await admin.locator('sb-strip [data-row="now"]', { hasText: "Welcome" }).waitFor();
      await admin.locator('sb-strip [data-row="next"]', { hasText: "Rules" }).waitFor();
      expect(await mode().getAttribute("data-mode")).toBe("rotation");
      await admin
        .locator('sb-strip sb-compositor .main > .scene[data-phase="current"] .probe', {
          hasText: "Welcome",
        })
        .waitFor();
      await admin.locator("sb-admin .connection.on").waitFor();
      await shot(admin, "live");
    },
    TIMEOUT,
  );

  test(
    "take now and resume",
    async () => {
      await admin.getByLabel("Scene to take").selectOption({ label: "Prizegiving" });
      await admin.getByLabel("Take duration").fill("5:00");
      await admin.getByRole("button", { name: "Take now" }).click();
      await admin
        .locator('sb-strip .mode[data-mode="take"]', { hasText: "Take: Prizegiving" })
        .waitFor();
      expect(await mode().textContent()).toMatch(/returns to rotation in [45]:\d\d/);
      await onScreen("main", "Prizegiving").waitFor();
      await shot(admin, "live-take");

      await admin.getByRole("button", { name: "Resume rotation" }).click();
      await admin.locator('sb-strip .mode[data-mode="rotation"]').waitFor();
      // The rotation continues with the item after the one the take replaced.
      await onScreen("main", "Rules").waitFor();
    },
    TIMEOUT,
  );

  test(
    "announce an instance as an interrupt, then dismiss it",
    async () => {
      await admin.getByLabel("Announcement", { exact: true }).selectOption({ label: "Fire exit" });
      await admin.getByRole("button", { name: "Interrupt" }).click();
      await admin
        .locator('sb-strip .mode[data-mode="interrupt"]', { hasText: "until dismissed" })
        .waitFor();
      await onScreen("interrupt", "Fire exit").waitFor();
      await screen.locator("sb-compositor .dim.on").waitFor({ state: "attached" });
      await shot(admin, "live-interrupt");

      await admin.getByRole("button", { name: "Dismiss" }).click();
      await admin.locator('sb-strip .mode[data-mode="rotation"]').waitFor();
      await screen.locator("sb-compositor .interrupt > .scene").waitFor({ state: "detached" });
    },
    TIMEOUT,
  );

  test(
    "blackout needs a hold; a click does nothing",
    async () => {
      const hold = admin.locator("sb-hold-button button");
      await hold.click();
      await Bun.sleep(2_000);
      expect(storbild.hub.state.live.blackout).toBe(false);

      await hold.hover();
      await admin.mouse.down();
      await Bun.sleep(1_700);
      await admin.mouse.up();
      await admin.locator('sb-strip .mode[data-mode="blackout"]').waitFor();
      expect(storbild.hub.state.live.blackout).toBe(true);
      await screen.locator("sb-compositor .blackout.on").waitFor({ state: "attached" });
      await shot(admin, "live-blackout");

      await admin.getByRole("button", { name: "End blackout" }).click();
      await admin.locator('sb-strip .mode[data-mode="rotation"]').waitFor();
      await screen.locator("sb-compositor .blackout.on").waitFor({ state: "detached" });
    },
    TIMEOUT,
  );

  test(
    "pages not built yet say so; logging out returns to the form",
    async () => {
      await admin.getByRole("link", { name: /Rotation/ }).click();
      await admin.getByText("This page arrives in M6.").waitFor();
      expect(new URL(admin.url()).pathname).toBe("/rotation");
      await admin.goBack();
      await admin.getByRole("heading", { name: "Live" }).waitFor();

      await admin.getByRole("button", { name: "Log out" }).click();
      await admin.waitForURL((url) => url.pathname === "/login");
      const res = await admin.request.get(new URL("/api/time", storbild.admin.url).href);
      expect(res.status()).toBe(401);
    },
    TIMEOUT,
  );
});
