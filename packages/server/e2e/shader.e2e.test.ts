// The shader plugin in a real Chromium (ADR 0031): a shader draws on the screen, keeps the last
// version that compiled, stops drawing while hidden, works as a theme background, and is
// written in the Library's custom editor. Runs only with STORBILD_E2E=1.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { type Storbild, start } from "../src/main.ts";
import { adminHeaders, testConfig } from "../src/testing.ts";
import { enabled, logIn, screenshots, shot, TIMEOUT, until } from "./helpers.ts";

const solid = (r: number, g: number, b: number) =>
  `void mainImage(out vec4 fragColor, in vec2 fragCoord) {\n  fragColor = vec4(${r.toFixed(1)}, ${g.toFixed(1)}, ${b.toFixed(1)}, 1.0);\n}\n`;

describe.skipIf(!enabled)("shader plugin", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "storbild-e2e-"));
  let storbild: Storbild;
  let browser: Browser;
  let screen: Page;
  let admin: Page;
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

  const shader = async (name: string, source: string) =>
    (await command("instance.create", {
      plugin: "shader",
      type: "shader",
      name,
      config: { source },
    })) as string;

  /** The average colour of a 40×40 square of the screen around (x, y), as 0–255 RGB. */
  async function colorAt(x = 960, y = 540): Promise<[number, number, number]> {
    const png = await screen.screenshot({ clip: { x: x - 20, y: y - 20, width: 40, height: 40 } });
    return screen.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
      if (!context) throw new Error("no 2d context");
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      const sum = [0, 0, 0];
      for (let i = 0; i < data.length; i += 4) {
        for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + (data[i + c] ?? 0);
      }
      const n = data.length / 4;
      return sum.map((s) => Math.round(s / n)) as [number, number, number];
    }, png.toString("base64"));
  }

  /** Waits until the screen around (x, y) is close to `rgb`. */
  async function untilColor(rgb: [number, number, number], x?: number, y?: number) {
    const deadline = Date.now() + 10_000;
    let last: [number, number, number] = [0, 0, 0];
    while (Date.now() < deadline) {
      last = await colorAt(x, y);
      if (last.every((value, i) => Math.abs(value - (rgb[i] ?? 0)) <= 12)) return;
      await Bun.sleep(100);
    }
    throw new Error(`expected ${rgb}, the screen shows ${last}`);
  }

  const frames = () => screen.evaluate(() => window.__frames ?? 0);

  beforeAll(async () => {
    mkdirSync(screenshots, { recursive: true });
    storbild = await start(
      testConfig({
        STORBILD_VIEWER_PORT: "0",
        STORBILD_ADMIN_PORT: "0",
        STORBILD_DATA_DIR: dataDir,
      }),
    );
    auth = await adminHeaders(storbild.admin.url);
    browser = await chromium.launch();
    screen = await (
      await browser.newContext({ viewport: { width: 1920, height: 1080 } })
    ).newPage();
    // Counts animation frames requested, which only the shader does on the screen.
    await screen.addInitScript(() => {
      const request = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => {
        window.__frames = (window.__frames ?? 0) + 1;
        return request(callback);
      };
    });
    admin = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    for (const page of [screen, admin]) {
      page.on("pageerror", (error) => console.error("page error:", error));
    }
    await screen.goto(storbild.viewer.url.href);
    await logIn(admin, storbild.admin.url);
  }, TIMEOUT);

  afterAll(async () => {
    await browser?.close();
    await storbild?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  let red: string;

  test(
    "a shader draws on the screen, and a broken edit keeps the last one that compiled",
    async () => {
      red = await shader("Red", solid(1, 0, 0));
      await command("playlist.addItem", { instanceId: red, durationMs: 600_000 });
      await untilColor([255, 0, 0]);

      await command("instance.update", { id: red, config: { source: "void mainImage(" } });
      await Bun.sleep(1_000);
      await untilColor([255, 0, 0]);

      await command("instance.update", { id: red, config: { source: solid(0, 1, 0) } });
      await untilColor([0, 255, 0]);
    },
    TIMEOUT,
  );

  test(
    "a shader stops drawing while hidden, and starts again when it comes back",
    async () => {
      const before = await frames();
      await Bun.sleep(300);
      expect(await frames()).toBeGreaterThan(before);

      await command("live.blackout", { on: true });
      // The blackout fades in for the default 800 ms, and then the shader stops.
      await Bun.sleep(1_500);
      const stopped = await frames();
      await Bun.sleep(500);
      expect(await frames()).toBe(stopped);

      await command("live.blackout", { on: false });
      await Bun.sleep(300);
      expect(await frames()).toBeGreaterThan(stopped);
    },
    TIMEOUT,
  );

  test(
    "as the theme background, it draws behind a transparent scene",
    async () => {
      const blue = await shader("Blue", solid(0, 0, 1));
      const theme = await command("theme.create", {
        name: "Shader",
        background: { type: "scene", instanceId: blue },
      });
      await command("theme.activate", { id: theme });
      const text = await command("instance.create", {
        plugin: "markdown",
        type: "text",
        name: "Hello",
        config: { content: "# Hello" },
      });
      await command("live.take", { instanceId: text as string });
      // A corner away from the text.
      await untilColor([0, 0, 255], 120, 120);
    },
    TIMEOUT,
  );

  test(
    "a channel image reaches iChannel0, with its size in iChannelResolution",
    async () => {
      // A 4×2 blue PNG, drawn and uploaded from the admin page.
      const image = await admin.evaluate(async () => {
        const canvas = new OffscreenCanvas(4, 2);
        const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
        context.fillStyle = "#0000ff";
        context.fillRect(0, 0, 4, 2);
        const res = await fetch("/api/assets?name=blue.png", {
          method: "POST",
          body: await canvas.convertToBlob({ type: "image/png" }),
        });
        return (await res.json()) as { id: string };
      });
      // Left half: the image's colour. Right half: yellow when the size is 4×2, else red.
      const channel = (await command("instance.create", {
        plugin: "shader",
        type: "shader",
        name: "Channel",
        config: {
          channels: [image.id],
          source: `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  if (fragCoord.x < iResolution.x * 0.5) {
    fragColor = vec4(texture(iChannel0, vec2(0.5)).rgb, 1.0);
  } else {
    bool size = iChannelResolution[0].xy == vec2(4.0, 2.0);
    fragColor = vec4(1.0, size ? 1.0 : 0.0, 0.0, 1.0);
  }
}
`,
        },
      })) as string;
      await command("live.take", { instanceId: channel });
      await untilColor([0, 0, 255], 480, 540);
      await untilColor([255, 255, 0], 1440, 540);
    },
    TIMEOUT,
  );

  test(
    "the Library's editor checks the shader as it is written",
    async () => {
      const editor = admin.getByLabel("Instance editor");
      await admin.getByRole("link", { name: "Library" }).click();
      await admin.getByRole("heading", { name: "Library", level: 1 }).waitFor();
      await admin.getByRole("button", { name: "New instance" }).click();
      await editor.getByLabel("Instance type").selectOption({ label: "Shader" });
      // A new shader starts from the starter, which compiles.
      await editor.locator("sb-shader-editor .status", { hasText: "Compiles" }).waitFor();
      await editor.getByLabel("Name").fill("Plasma");

      // The inputs open from a link, and close with Escape.
      await editor.getByRole("button", { name: "Shader inputs" }).click();
      const notes = editor.getByRole("heading", { name: "Shader inputs" });
      await notes.waitFor();
      await shot(admin, "shader-inputs");
      await admin.keyboard.press("Escape");
      await notes.waitFor({ state: "hidden" });

      const source = editor.getByLabel("Shader", { exact: true });
      await source.fill(
        "void mainImage(out vec4 fragColor, in vec2 fragCoord) {\n  fragColor = vec4(foo);\n}\n",
      );
      await editor.locator("sb-shader-editor .status", { hasText: "error" }).waitFor();
      await editor.getByRole("button", { name: "Line 2" }).first().click();
      await shot(admin, "shader-editor");

      await source.fill(solid(1, 1, 0));
      await editor.locator("sb-shader-editor .status", { hasText: "Compiles" }).waitFor();
      await editor.getByRole("button", { name: "Create" }).click();
      const plasma = () =>
        Object.values(storbild.hub.state.instances).find((i) => i.name === "Plasma");
      await until(() => plasma() !== undefined);
      expect(plasma()?.config).toMatchObject({ source: solid(1, 1, 0) });
    },
    TIMEOUT,
  );
});

declare global {
  interface Window {
    __frames?: number;
  }
}
