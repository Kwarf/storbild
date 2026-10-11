// M8 acceptance in a real Chromium (DESIGN.md §9, ADR 0012): two clock widgets are created and
// placed in bottom-right from the admin alone, and stack on the screen. Moving, hiding and
// removing them in the admin changes the screen. Screenshots for the visual review (§8.3) go
// to e2e/screenshots/. Runs only with STORBILD_E2E=1.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { type Storbild, start } from "../src/main.ts";
import { TEST_PASSWORD, testConfig } from "../src/testing.ts";

const enabled = process.env.STORBILD_E2E === "1";
const TIMEOUT = 30_000;
const screenshots = join(import.meta.dir, "screenshots");

describe.skipIf(!enabled)("overlays", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "storbild-e2e-"));
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
  const widget = (name: string, phase = "shown") =>
    screen.locator(
      `sb-compositor .widget[data-widget="${named(name)?.id}"][data-phase="${phase}"]`,
    );

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
    "two clocks placed in bottom-right from the admin stack on the screen",
    async () => {
      await go("Library");
      for (const [name, seconds] of [
        ["Clock", false],
        ["Clock with seconds", true],
      ] as const) {
        await admin.getByRole("button", { name: "New instance" }).click();
        await editor().getByLabel("Instance type").selectOption({ label: "Clock" });
        await editor().getByLabel("Name").fill(name);
        if (seconds) await editor().getByLabel("Seconds").check();
        // The Library previews a widget in its slot.
        await editor().locator("sb-compositor .widget[data-phase='shown'] sb-info-clock").waitFor();
        await editor().getByRole("button", { name: "Create" }).click();
        await until(() => named(name) !== undefined);
      }
      expect(named("Clock with seconds")?.config).toEqual({ seconds: true });
      // The type picker and the list split scenes from overlays.
      await admin.getByRole("button", { name: "New instance" }).click();
      expect(
        await editor()
          .getByLabel("Instance type")
          .locator("optgroup")
          .evaluateAll((groups) => groups.map((g) => g.getAttribute("label"))),
      ).toEqual(["Scenes", "Overlays"]);
      await editor().getByRole("button", { name: "Cancel" }).click();
      await admin.locator('[data-kind="overlay"] [data-group="info/clock"] li').nth(1).waitFor();
      await shot(admin, "library-kinds");

      await go("Overlays");
      for (const name of ["Clock", "Clock with seconds"]) {
        await admin.getByLabel("Widget to place").selectOption({ label: name });
        await admin.getByLabel("Slot to place in").selectOption({ label: "Bottom right" });
        await admin.getByRole("button", { name: "Place", exact: true }).click();
        await until(() => state().overlays.some((p) => p.instanceId === named(name)?.id));
      }
      await widget("Clock").waitFor();
      await widget("Clock with seconds").waitFor();
      const first = await widget("Clock").boundingBox();
      const second = await widget("Clock with seconds").boundingBox();
      if (!first || !second) throw new Error("no boxes");
      // Order 0 in the corner, the next stacked above it, both right-aligned.
      expect(first.x + first.width).toBeCloseTo(1920 - 96, 0);
      expect(first.y + first.height).toBeCloseTo(1080 - 96, 0);
      expect(second.x + second.width).toBeCloseTo(1920 - 96, 0);
      expect(second.y + second.height).toBeCloseTo(first.y - 24, 0);
      const time = await widget("Clock with seconds")
        .locator("sb-info-clock")
        .evaluate((clock) => clock.shadowRoot?.textContent?.trim());
      expect(time).toMatch(/^\d\d:\d\d:\d\d$/);
      await admin
        .locator('.cell[data-slot="bottom-right"]', { hasText: "Clock with seconds" })
        .waitFor();
      await shot(admin, "overlays");
      await screen.screenshot({ path: join(screenshots, "screen-overlays.png") });

      // Moving the second toward the edge swaps them.
      const row = (name: string) => admin.locator(`li[data-widget="${named(name)?.id}"]`);
      await row("Clock with seconds").getByRole("button", { name: "Move toward the edge" }).click();
      await until(
        () => state().overlays.find((p) => p.instanceId === named("Clock")?.id)?.order === 1,
      );
      for (let i = 0; ; i++) {
        const box = await widget("Clock with seconds").boundingBox();
        if (box && Math.round(box.y + box.height) === 1080 - 96) break;
        if (i > 50) throw new Error("the widgets did not swap");
        await Bun.sleep(100);
      }

      await admin
        .locator('section[data-group="bottom-right"] li')
        .first()
        .and(row("Clock with seconds"))
        .waitFor();

      // Hidden in the admin: gone from the screen, still listed.
      await row("Clock").getByLabel("Visible").uncheck();
      await widget("Clock", "shown").waitFor({ state: "detached" });
      await row("Clock").locator(".badge", { hasText: "Hidden" }).waitFor();

      await row("Clock").getByRole("button", { name: "Remove" }).click();
      await until(() => state().overlays.length === 1);
      await admin
        .getByLabel("Widget to place")
        .locator("option", { hasText: /^Clock$/ })
        .waitFor({
          state: "attached",
        });
    },
    TIMEOUT,
  );
});
