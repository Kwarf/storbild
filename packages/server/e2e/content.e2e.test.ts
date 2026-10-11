// M6a acceptance tests (DESIGN.md §9) in a real Chromium: from an empty show, build a rotation
// of markdown scenes in the admin alone (Library, Rotation, Settings, Plugins), and watch a
// viewer run it unattended. Screenshots for the visual review (§8.3) go to e2e/screenshots/.
// Runs only with STORBILD_E2E=1.
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

describe.skipIf(!enabled)("content pages", () => {
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
  const onScreen = (text: string) =>
    screen.locator('sb-compositor .main > .scene[data-phase="current"] sb-markdown-scene', {
      hasText: text,
    });

  async function newMarkdown(name: string, title: string, content: string) {
    await admin.getByRole("button", { name: "New instance" }).click();
    await editor().getByLabel("Instance type").selectOption({ label: "Markdown text" });
    await editor().getByLabel("Name").fill(name);
    await editor().getByLabel("Title").fill(title);
    await editor().getByLabel("Content").fill(content);
    await editor().getByRole("button", { name: "Create" }).click();
    await until(() => named(name) !== undefined);
  }

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
    browser = await chromium.launch();
    screen = await (await browser.newContext({ viewport: { width: 960, height: 540 } })).newPage();
    admin = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    for (const page of [screen, admin]) {
      page.on("pageerror", (error) => console.error("page error:", error));
    }
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
    "the Library creates markdown scenes from a generated form, with a live preview",
    async () => {
      await go("Library");
      await admin.getByText("No instances yet.").waitFor();
      await admin.getByRole("button", { name: "New instance" }).click();
      await editor().getByLabel("Instance type").selectOption({ label: "Markdown text" });
      await editor().getByLabel("Name").fill("Welcome");
      await editor().getByLabel("Title").fill("Welcome to the party");
      await editor().getByLabel("Content").fill("Have fun");
      await editor().locator("sb-markdown-scene", { hasText: "Welcome to the party" }).waitFor();
      await shot(admin, "library-new");
      await editor().getByRole("button", { name: "Create" }).click();
      await until(() => named("Welcome") !== undefined);
      expect(named("Welcome")?.config).toEqual({
        title: "Welcome to the party",
        content: "Have fun",
      });

      await newMarkdown("Rules", "Rules", "Be nice");
      await newMarkdown("Bar", "Bar", "Open all night");
      await admin.locator('[data-group="markdown/text"] li').nth(2).waitFor();
    },
    TIMEOUT,
  );

  test(
    "editing an instance saves its config, and a custom editor replaces the form",
    async () => {
      await admin.getByRole("button", { name: "Rules" }).click();
      await editor().getByLabel("Content").fill("Be excellent to each other");
      await editor().locator("sb-markdown-scene", { hasText: "Be excellent" }).waitFor();
      await editor().getByRole("button", { name: "Save" }).click();
      const content = () => (named("Rules")?.config as { content?: string } | undefined)?.content;
      await until(() => content() === "Be excellent to each other");
      await expect(editor().getByRole("button", { name: "Save" }).isDisabled()).resolves.toBe(true);
      await shot(admin, "library-edit");

      await admin.getByRole("button", { name: "New instance" }).click();
      await editor().getByLabel("Instance type").selectOption({ label: "Probe card" });
      await editor().locator(".custom-editor").waitFor();
      await editor().getByLabel("Name").fill("Card");
      // An empty text fails the plugin's schema; the issue shows at the field.
      await editor().getByRole("button", { name: "Create" }).click();
      await editor().getByRole("alert").first().waitFor();
      await editor().getByLabel("Card text").fill("Hello card");
      await editor().getByRole("button", { name: "Create" }).click();
      await until(() => named("Card") !== undefined);
      expect(named("Card")?.config).toEqual({ text: "Hello card" });

      await editor().getByRole("button", { name: "Delete" }).click();
      await editor().getByRole("button", { name: "Delete" }).click();
      await until(() => named("Card") === undefined);
    },
    TIMEOUT,
  );

  test(
    "Settings change the default duration and the transition length",
    async () => {
      await go("Settings");
      await admin.getByLabel("Default duration").fill("2");
      await admin.getByLabel("Transition length (ms)").fill("200");
      await shot(admin, "settings");
      await admin.getByRole("button", { name: "Save" }).click();
      await until(() => state().settings.defaultDurationMs === 2_000);
      expect(state().settings.transitionMs).toBe(200);
    },
    TIMEOUT,
  );

  test(
    "the Rotation adds, times, reorders and toggles items",
    async () => {
      await go("Rotation");
      await admin.getByText("The rotation is empty.").waitFor();
      for (const name of ["Welcome", "Rules", "Bar"]) {
        await admin.getByLabel("Scene to add").selectOption({ label: name });
        await admin.getByRole("button", { name: "Add to rotation" }).click();
        await until(
          () => state().playlist.items.length === ["Welcome", "Rules", "Bar"].indexOf(name) + 1,
        );
      }
      const row = (name: string) => admin.locator("li[data-item]", { hasText: name });

      await row("Rules").getByLabel("Duration").fill("3");
      await row("Rules").getByLabel("Duration").press("Enter");
      await until(() => state().playlist.items[1]?.durationMs === 3_000);

      // Drag Bar above Welcome.
      await row("Bar")
        .locator(".handle")
        .dragTo(row("Welcome"), { targetPosition: { x: 40, y: 4 } });
      await until(() => state().playlist.items[0]?.instanceId === named("Bar")?.id);

      await row("Bar").getByLabel("Enabled").uncheck();
      await until(() => state().playlist.items[0]?.enabled === false);

      await row("Welcome").getByRole("button", { name: "Window" }).click();
      await row("Welcome").locator('[data-window="activeFrom"]').fill("2020-01-01T10:00");
      await until(() => state().playlist.items[1]?.activeFrom !== undefined);
      await admin.locator(".badge.live").waitFor();
      await shot(admin, "rotation");

      const names = state().playlist.items.map((item) => state().instances[item.instanceId]?.name);
      expect(names).toEqual(["Bar", "Welcome", "Rules"]);
    },
    TIMEOUT,
  );

  test(
    "a viewer runs the rotation unattended",
    async () => {
      await screen.goto(storbild.viewer.url.href);
      // Welcome (default 2 s) and Rules (3 s) alternate; Bar is off.
      for (const text of [
        "Welcome to the party",
        "Be excellent",
        "Welcome to the party",
        "Be excellent",
      ]) {
        await onScreen(text).waitFor({ timeout: 6_000 });
      }
      expect(await onScreen("Open all night").count()).toBe(0);
    },
    TIMEOUT,
  );

  test(
    "Plugins show status and edit settings",
    async () => {
      await go("Plugins");
      const markdown = admin.locator('section[data-plugin="markdown"]');
      await markdown.getByLabel("Font scale").fill("1.5");
      await markdown.getByRole("button", { name: "Save settings" }).click();
      await until(
        () =>
          (state().plugins.markdown?.settings as { fontScale?: number } | undefined)?.fontScale ===
          1.5,
      );
      await admin.locator('section[data-plugin="probe"]').waitFor();
      await shot(admin, "plugins");
    },
    TIMEOUT,
  );
});
