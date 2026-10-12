// Seeds a deterministic demo show and takes the README screenshots (see docs/screenshots/).
//
//   bun run demo                  every shot in shots.ts
//   bun run demo <name>…          only the named shots
//   bun run demo --serve          seed the show on :3000/:3001 with a running clock, and keep
//                                 it up to look around
//
// Screenshots run on a frozen clock at DEMO_NOW, on the server and in the browser, with
// deterministic IDs and generated images, so a rerun gives the same pictures.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fontFiles } from "@storbild/admin";
import type { ShowState } from "@storbild/core";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { type Storbild, start } from "../src/main.ts";
import { adminHeaders, FakeClock, TEST_PASSWORD, testConfig } from "../src/testing.ts";
import { type DemoFile, renderImages } from "./images.ts";
import { type Demo, type Shot, shots } from "./shots.ts";
import { type AssetIds, type CommandFn, DEMO_NOW, seedShow, TIME_ZONE } from "./show.ts";

const rootDir = join(import.meta.dir, "../../..");
const outDir = join(rootDir, "docs/screenshots");
const args = process.argv.slice(2);
const serve = args.includes("--serve");
const names = args.filter((arg) => !arg.startsWith("--"));
const unknown = names.filter((name) => !shots.some((shot) => shot.name === name));
if (unknown.length > 0) {
  console.error(`unknown shots: ${unknown.join(", ")}`);
  console.error(`shots: ${shots.map((shot) => shot.name).join(", ")}`);
  process.exit(1);
}

const dataDir = mkdtempSync(join(tmpdir(), "storbild-demo-"));
const clock = serve ? undefined : new FakeClock(DEMO_NOW);
let nextId = 0;
const storbild = await start(
  testConfig({
    STORBILD_VIEWER_PORT: serve ? "3000" : "0",
    STORBILD_ADMIN_PORT: serve ? "3001" : "0",
    STORBILD_DATA_DIR: dataDir,
  }),
  {
    newId: () => `demo-${++nextId}`,
    ...(clock && { now: clock.now, timers: clock.timers }),
  },
);
// Native inputs, such as the date picker, follow the browser language, not the context locale.
const browser = await chromium.launch({ args: ["--lang=en-GB"] });

async function cleanUp() {
  await browser.close();
  await storbild.stop();
  rmSync(dataDir, { recursive: true, force: true });
}

try {
  const auth = await adminHeaders(storbild.admin.url);
  const command: CommandFn = async (type, payload) => {
    const res = await fetch(new URL("/api/commands", storbild.admin.url), {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ type, payload }),
    });
    const body = (await res.json()) as { id?: string };
    if (!res.ok) throw new Error(`${type} failed: ${JSON.stringify(body)}`);
    return body.id;
  };

  const admin = await newPage(browser, { width: 1440, height: 900 });
  await logIn(admin, storbild);
  const assets = await upload(admin, storbild, [
    ...(await renderImages(browser)),
    ...(await fonts()),
  ]);
  const ids = await seedShow(command, assets, serve ? Date.now() : DEMO_NOW);

  if (serve) {
    await browser.close();
    console.log(`viewer: ${storbild.viewer.url}`);
    console.log(`admin:  ${storbild.admin.url} (admin / ${TEST_PASSWORD})`);
    console.log("Ctrl+C to stop.");
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  } else {
    const seeded = storbild.hub.state;
    const screen = await newPage(browser, { width: 1920, height: 1080 });
    const demo: Demo = {
      screen,
      admin,
      command,
      ids,
      async section(label) {
        await admin.goto(new URL(`/${label.toLowerCase()}`, storbild.admin.url).href);
        await admin.getByRole("heading", { name: label, level: 1 }).waitFor();
        await admin.locator("sb-admin .connection.on").waitFor();
      },
      async onScreen(name, layer = "main") {
        await screen
          .locator(
            `sb-compositor .${layer} > .scene[data-scene="${ids[name]}"][data-phase="current"]`,
          )
          .waitFor();
      },
    };
    mkdirSync(outDir, { recursive: true });
    for (const shot of shots) {
      if (names.length > 0 && !names.includes(shot.name)) continue;
      await reset(storbild, seeded);
      const page = shot.page === "screen" ? screen : admin;
      if (shot.page === "screen") await screen.goto(storbild.viewer.url.href);
      await shot.prepare(demo);
      await settle(page);
      const path = join(outDir, `${shot.name}.png`);
      await page.screenshot({ path, animations: "disabled" });
      console.log(path);
    }
    writeFileSync(join(rootDir, "SCREENSHOTS.md"), gallery(shots));
  }
} finally {
  await cleanUp();
}

/**
 * A page in its own context, with Stockholm time, a 24-hour locale and dark mode. Outside
 * `--serve`, its clock is paused at DEMO_NOW.
 */
async function newPage(browser: Browser, viewport: { width: number; height: number }) {
  const context: BrowserContext = await browser.newContext({
    viewport,
    colorScheme: "dark",
    timezoneId: TIME_ZONE,
    locale: "en-GB",
  });
  if (!serve) {
    // Exactly DEMO_NOW: before its first clock sync, the viewer reads `performance.timeOrigin`,
    // which is the install time. Any earlier and the compositor waits on a boundary timer that
    // the paused clock never fires.
    await context.clock.install({ time: DEMO_NOW });
    await context.clock.pauseAt(DEMO_NOW);
  }
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("page error:", error));
  return page;
}

async function logIn(admin: Page, storbild: Storbild) {
  await admin.goto(new URL("/login", storbild.admin.url).href);
  await admin.getByLabel("Username").fill("admin");
  await admin.getByLabel("Password").fill(TEST_PASSWORD);
  await admin.getByRole("button", { name: "Log in" }).click();
  await admin.waitForURL((url) => url.pathname === "/live");
}

/** The admin's font as theme fonts, so the screen looks the same on any machine. */
async function fonts(): Promise<DemoFile[]> {
  return Promise.all(
    [...fontFiles].map(async ([name, url]) => ({
      name: name.replace("-latin", "").replace("-normal", ""),
      mimeType: "font/woff2",
      buffer: Buffer.from(await Bun.file(url).arrayBuffer()),
    })),
  );
}

/**
 * Uploads through the Library, as an operator would, so the admin makes the thumbnails. Asset
 * IDs are the files' SHA-256.
 */
async function upload(admin: Page, storbild: Storbild, files: DemoFile[]): Promise<AssetIds> {
  await admin.goto(new URL("/library", storbild.admin.url).href);
  const ids: AssetIds = {};
  for (const file of files) {
    const id = new Bun.CryptoHasher("sha256").update(file.buffer).digest("hex");
    await admin.getByLabel("Upload a file").setInputFiles(file);
    const image = file.mimeType.startsWith("image/");
    await until(() => {
      const asset = storbild.hub.state.assets[id];
      return asset !== undefined && (!image || asset.thumbnail === true);
    });
    ids[file.name] = id;
  }
  return ids;
}

/** Puts the show back as it was seeded, undoing whatever the last shot did. */
async function reset(storbild: Storbild, seeded: ShowState) {
  storbild.hub.update(() => seeded);
}

/** Waits for fonts, images and the compositor's fades. */
async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState("networkidle");
  // Crossfades and layer fades run on real time; the longest is the show's 800 ms crossfade.
  await Bun.sleep(1_200);
}

/** A page listing every shot, for browsing them on GitHub. */
function gallery(shots: Shot[]): string {
  const section = (heading: string, page: Shot["page"]) => [
    `## ${heading}`,
    "",
    ...shots
      .filter((shot) => shot.page === page)
      .flatMap((shot) => [
        `### ${shot.title}`,
        "",
        `![${shot.title}](docs/screenshots/${shot.name}.png)`,
        "",
      ]),
  ];
  return [
    "<!-- Made by `bun run demo` from packages/server/demo/. Don't edit by hand. -->",
    "",
    "# Screenshots",
    "",
    "> [!NOTE]",
    "> Everything shown here is mock data. Pixelnatt 2026, its schedule, Wi-Fi network and",
    "> pictures are made up.",
    "",
    ...section("Admin", "admin"),
    ...section("Viewer", "screen"),
  ].join("\n");
}

async function until(check: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(25);
  }
}
