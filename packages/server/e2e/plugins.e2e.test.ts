// M9 acceptance in a real Chromium (DESIGN.md §9, ADR 0015): markdown, countdown and Wi-Fi
// instances are made in the admin from generated forms and a custom editor, run on the screen,
// and follow a theme switch without a reload. Screenshots for the visual review (§8.3) go to
// e2e/screenshots/. Runs only with STORBILD_E2E=1.
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

/** A `datetime-local` value in local time, with seconds unless they are 0 (Chrome drops them). */
function toLocalInput(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  const seconds = date.getSeconds() ? `:${pad(date.getSeconds())}` : "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}${seconds}`;
}

describe.skipIf(!enabled)("built-in plugins", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "storbild-e2e-"));
  let storbild: Storbild;
  let browser: Browser;
  let admin: Page;
  let screen: Page;
  let auth: Record<string, string>;

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
  const editor = () => admin.getByLabel("Instance editor");
  /** Starts a new instance of the type with this label in the Scenes or Overlays group. */
  const newInstance = async (group: "Scenes" | "Overlays", label: string, name: string) => {
    await admin.getByRole("button", { name: "New instance" }).click();
    const picker = editor().getByLabel("Instance type");
    const value = await picker
      .locator(`optgroup[label="${group}"] option`, { hasText: label })
      .getAttribute("value");
    await picker.selectOption(value ?? "");
    await editor().getByLabel("Name", { exact: true }).fill(name);
  };
  const create = async (name: string) => {
    await editor().getByRole("button", { name: "Create" }).click();
    await until(() => named(name) !== undefined);
  };
  const take = async (name: string) => {
    await go("Live");
    await admin.getByLabel("Scene to take").selectOption({ label: name });
    await admin.getByLabel("Take duration").fill("10:00");
    await admin.getByRole("button", { name: "Take now" }).click();
    await until(() => state().live.main?.instanceId === named(name)?.id);
  };
  const place = async (name: string, slot: string) => {
    await go("Overlays");
    await admin.getByLabel("Widget to place").selectOption({ label: name });
    await admin.getByLabel("Slot to place in").selectOption({ label: slot });
    await admin.getByRole("button", { name: "Place", exact: true }).click();
    await until(() => state().overlays.some((p) => p.instanceId === named(name)?.id));
  };
  const onAir = (selector: string) =>
    screen.locator(`sb-compositor .main .scene[data-phase='current'] ${selector}`);
  const widget = (name: string, phase = "shown") =>
    screen.locator(
      `sb-compositor .widget[data-widget="${named(name)?.id}"][data-phase="${phase}"]`,
    );
  /** Waits until a computed style of the first match inside the compositor has this value. */
  const styled = (selector: string, property: string, value: string) =>
    screen.waitForFunction(
      ([selector, property, value]) => {
        const find = (root: ParentNode, parts: string[]): Element | null => {
          const [first, ...rest] = parts;
          const found = first ? root.querySelector(first) : null;
          if (!found || rest.length === 0) return found;
          return found.shadowRoot ? find(found.shadowRoot, rest) : null;
        };
        const element = find(document, (selector as string).split(" >> "));
        return (
          element !== null &&
          getComputedStyle(element).getPropertyValue(property as string) === value
        );
      },
      [selector, property, value],
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
    auth = await adminHeaders(storbild.admin.url);
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
    "markdown renders headings and lists, and sanitizes raw HTML",
    async () => {
      await go("Library");
      await newInstance("Scenes", "Markdown text", "Program");
      await editor()
        .getByLabel("Content")
        .fill(
          [
            "## Tonight",
            "",
            "- **20:00** Demo compo",
            "- **22:00** Music compo",
            "",
            "> Vote at `vote.party`",
            "",
            '<img src="x" onerror="window.__pwned = true">',
          ].join("\n"),
        );
      await editor().locator("sb-markdown-scene h2", { hasText: "Tonight" }).waitFor();
      await create("Program");

      await take("Program");
      await onAir("sb-markdown-scene h2").filter({ hasText: "Tonight" }).waitFor();
      expect(await onAir("sb-markdown-scene li").count()).toBe(2);
      expect(await onAir("sb-markdown-scene li strong").first().textContent()).toBe("20:00");
      const img = onAir("sb-markdown-scene img");
      expect(await img.count()).toBe(1);
      expect(await img.getAttribute("onerror")).toBeNull();
      for (const page of [screen, admin]) {
        expect(await page.evaluate(() => (window as { __pwned?: boolean }).__pwned)).toBe(
          undefined,
        );
      }
    },
    TIMEOUT,
  );

  test(
    "a Wi-Fi widget is made in its custom editor, whose QR code follows the form",
    async () => {
      await go("Library");
      await newInstance("Overlays", "Wi-Fi", "Wi-Fi");
      const custom = editor().locator("sb-info-wifi-editor");
      await custom.getByText("Enter a network name").waitFor();
      await custom.getByLabel("Network name").fill("party-net");
      await custom.getByLabel("Password", { exact: true }).fill("demoscene");
      const preview = custom.getByRole("img", { name: "QR code preview" }).locator("path");
      await preview.waitFor();
      const before = await preview.getAttribute("d");
      await custom.getByLabel("Password", { exact: true }).fill("demoscene2026");
      for (let i = 0; (await preview.getAttribute("d")) === before; i++) {
        if (i > 50) throw new Error("the QR preview did not follow the password");
        await Bun.sleep(50);
      }
      await shot(admin, "library-wifi");
      await create("Wi-Fi");
      expect(named("Wi-Fi")?.config).toEqual({
        ssid: "party-net",
        password: "demoscene2026",
        security: "WPA",
        hidden: false,
        showPassword: true,
      });

      await place("Wi-Fi", "Bottom left");
      await widget("Wi-Fi").locator("sb-info-wifi svg path").waitFor();
      await widget("Wi-Fi").locator("sb-info-wifi .ssid", { hasText: "party-net" }).waitFor();
      await widget("Wi-Fi")
        .locator("sb-info-wifi .password", { hasText: "demoscene2026" })
        .waitFor();
      await Bun.sleep(600);
      await screen.screenshot({ path: join(screenshots, "screen-markdown-wifi.png") });
    },
    TIMEOUT,
  );

  test(
    "a theme switch restyles the markdown scene and the Wi-Fi widget without a reload",
    async () => {
      const markdown = "sb-compositor >> .main .scene[data-phase='current'] sb-markdown-scene";
      const id = await command("theme.create", {
        name: "Party",
        background: { type: "color", color: "#202040" },
        colors: { text: "#ffe08a", muted: "#a0a8c0", accent: "#ff5577", surface: "#203050" },
        fonts: { heading: { family: "serif" }, body: { family: "monospace" } },
      });
      await command("theme.activate", { id });
      await styled(`${markdown} >> h2`, "color", "rgb(255, 224, 138)");
      await styled(`${markdown} >> li`, "font-family", "monospace");
      await styled(`${markdown} >> blockquote`, "background-color", "rgb(32, 48, 80)");
      await styled("sb-compositor >> sb-info-wifi", "background-color", "rgb(32, 48, 80)");
      await styled("sb-compositor >> sb-info-wifi >> .ssid", "font-family", "serif");
      await Bun.sleep(600);
      await screen.screenshot({ path: join(screenshots, "screen-markdown-wifi-theme.png") });
    },
    TIMEOUT,
  );

  test(
    "a countdown scene counts down to its target in the theme",
    async () => {
      await go("Library");
      await newInstance("Scenes", "Countdown", "Demo compo");
      await editor().getByLabel("Title").fill("Demo compo starts in");
      // Whole minutes, an hour and a bit ahead, so the screen shows 1:0M:SS.
      const target = Math.ceil(Date.now() / 60_000) * 60_000 + 3_600_000;
      await editor().getByLabel("Counts down to").fill(toLocalInput(target));
      await editor().locator("sb-countdown-scene .time").waitFor();
      await create("Demo compo");
      expect(named("Demo compo")?.config).toEqual({ title: "Demo compo starts in", target });

      await take("Demo compo");
      const time = onAir("sb-countdown-scene .time");
      await time.waitFor();
      expect(await time.textContent()).toMatch(/^1:0[01]:\d\d$/);
      const first = await time.textContent();
      await screen.waitForFunction(
        ([first]) =>
          document
            .querySelector("sb-compositor")
            ?.shadowRoot?.querySelector(".main .scene[data-phase='current'] sb-countdown-scene")
            ?.shadowRoot?.querySelector(".time")?.textContent !== first,
        [first],
      );
      await styled(
        "sb-compositor >> .main .scene[data-phase='current'] sb-countdown-scene >> .time",
        "color",
        "rgb(255, 224, 138)",
      );
      await Bun.sleep(600);
      await screen.screenshot({ path: join(screenshots, "screen-countdown.png") });
    },
    TIMEOUT,
  );

  test(
    "a countdown widget shows its done text at the target and then hides",
    async () => {
      await go("Library");
      await newInstance("Overlays", "Countdown", "Doors");
      await editor().getByLabel("Label").fill("Doors open in");
      const target = Math.ceil(Date.now() / 1_000) * 1_000 + 8_000;
      await editor().getByLabel("Counts down to").fill(toLocalInput(target));
      await editor().getByLabel("When it's time").fill("Doors are open");
      await editor().getByLabel("Hide after").fill("3");
      await create("Doors");
      expect(named("Doors")?.config).toEqual({
        label: "Doors open in",
        target,
        doneText: "Doors are open",
        hideAfterMs: 3_000,
      });

      await place("Doors", "Top right");
      await widget("Doors")
        .locator("sb-countdown-widget .label", { hasText: "Doors open in" })
        .waitFor();
      expect(await widget("Doors").locator("sb-countdown-widget .time").textContent()).toMatch(
        /^00:0\d$/,
      );
      await widget("Doors")
        .locator("sb-countdown-widget .time", { hasText: "Doors are open" })
        .waitFor({ timeout: 10_000 });
      await widget("Doors").waitFor({ state: "detached", timeout: 10_000 });
      expect(Date.now()).toBeGreaterThanOrEqual(target + 3_000 - 500);
      // Still placed: it hid itself, the operator didn't remove it.
      expect(state().overlays.some((p) => p.instanceId === named("Doors")?.id)).toBe(true);
    },
    TIMEOUT,
  );
});
