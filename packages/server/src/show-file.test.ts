import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShowState } from "@storbild/core";
import { createTestAdminApp, TEST_PASSWORD } from "./testing.ts";
import { writeZip, ZipReader, type ZipSource } from "./zip.ts";

/** A real 1×1 PNG. */
const png = Uint8Array.fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
);
/** A WebP header, which is all a thumbnail needs to sniff as one. */
const webp = new Uint8Array([
  ...new TextEncoder().encode("RIFF"),
  0,
  0,
  0,
  0,
  ...new TextEncoder().encode("WEBPVP8X"),
  10,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
]);
const pngId = new Bun.CryptoHasher("sha256").update(png).digest("hex");

/** An admin app with assets and show files, logged in. */
function install(name: string) {
  const root = mkdtempSync(join(tmpdir(), `storbild-show-${name}-`));
  const assetsDir = join(root, "assets");
  const tmp = join(root, "tmp");
  const setup = createTestAdminApp({ assetsDir, tmpDir: tmp, maxImportBytes: 1024 * 1024 });
  let cookie = "";
  const headers = () => ({ Cookie: cookie, Origin: "http://localhost" });
  return {
    ...setup,
    root,
    assetsDir,
    tmp,
    headers,
    async login() {
      const res = await setup.app.request("/login", {
        method: "POST",
        headers: { Origin: "http://localhost" },
        body: new URLSearchParams({ username: "admin", password: TEST_PASSWORD }),
      });
      cookie = res.headers.get("Set-Cookie")?.split(";")[0] as string;
    },
    async command(type: string, payload: unknown) {
      const res = await setup.app.request("/api/commands", {
        method: "POST",
        headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ type, payload }),
      });
      const body = (await res.json()) as { id?: string };
      if (!res.ok) throw new Error(`${type} failed: ${JSON.stringify(body)}`);
      return body.id as string;
    },
    import(body: Blob | Uint8Array) {
      return setup.app.request("/api/show/import", { method: "POST", headers: headers(), body });
    },
  };
}

const archive = (bytes: Uint8Array) => new Blob([bytes]);

const zip = async (sources: ZipSource[]) =>
  new Uint8Array(await new Response(writeZip(sources)).arrayBuffer());

/** The content an import keeps, which must match between the two installs. */
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

describe("show files", () => {
  const source = install("source");
  const target = install("target");
  let exported: Uint8Array;

  beforeAll(async () => {
    await source.login();
    await target.login();
    const upload = await source.app.request("/api/assets?name=logo.png", {
      method: "POST",
      headers: source.headers(),
      body: png,
    });
    expect(upload.status).toBe(200);
    await source.app.request(`/api/assets/${pngId}/thumbnail`, {
      method: "PUT",
      headers: source.headers(),
      body: webp,
    });
    const text = await source.command("instance.create", {
      plugin: "markdown",
      type: "text",
      name: "Welcome",
      config: { content: "# Hi" },
      background: { assetId: pngId, fit: "cover" },
    });
    await source.command("playlist.addItem", { instanceId: text, durationMs: 5_000 });
    await source.command("settings.update", { transitionMs: 250 });
    await source.command("live.blackout", { on: true });
  });

  afterAll(() => {
    for (const { root } of [source, target]) rmSync(root, { recursive: true, force: true });
  });

  test("exports the show as a zip with show.json, the assets and their thumbnails", async () => {
    const res = await source.app.request("/api/show/export", { headers: source.headers() });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="storbild-show-\d{4}-\d\d-\d\d\.zip"$/,
    );
    exported = new Uint8Array(await res.arrayBuffer());
    const reader = await ZipReader.open(archive(exported));
    expect([...reader.entries.keys()]).toEqual([
      "show.json",
      `assets/${pngId}`,
      `thumbnails/${pngId}.webp`,
    ]);
  });

  test("imports into a fresh install with the same content and files", async () => {
    const res = await target.import(exported);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revision: target.hub.state.revision, missingPlugins: [] });
    expect(content(target.hub.state)).toEqual(content(source.hub.state));
    expect(target.hub.state.live).toEqual({ blackout: false });
    expect(await Bun.file(join(target.assetsDir, pngId)).bytes()).toEqual(png);
    const thumbnail = await target.app.request(`/assets/${pngId}/thumbnail`);
    expect(thumbnail.status).toBe(200);
    expect(readdirSync(target.tmp)).toEqual([]);
  });

  test("an import replaces the show, and the replaced show's files go", async () => {
    const empty = await zip([
      {
        name: "show.json",
        data: new Blob([
          JSON.stringify({
            format: "storbild-show",
            version: 1,
            exportedAt: 0,
            plugins: {},
            instances: [],
            playlist: [],
            cues: [],
            overlays: [],
            themes: [
              {
                id: "t",
                name: "Plain",
                background: { type: "color", color: "#000" },
                fonts: { heading: { family: "serif" }, body: { family: "serif" } },
                colors: { text: "#fff", muted: "#999", accent: "#f00", surface: "#111" },
              },
            ],
            activeThemeId: "t",
            settings: { defaultDurationMs: 10_000, transitionMs: 0 },
            assets: [],
          }),
        ]),
      },
    ]);
    const res = await target.import(empty);
    expect(res.status).toBe(200);
    expect(target.hub.state.instances).toEqual({});
    expect(target.hub.state.assets).toEqual({});
    await Bun.sleep(0);
    expect(readdirSync(target.assetsDir).filter((name) => name !== "thumbs")).toEqual([]);
  });

  test("refuses damaged, foreign and oversized files without changing the show", async () => {
    const before = target.hub.state;
    const reader = await ZipReader.open(archive(exported));
    const showJson = reader.entries.get("show.json");
    if (!showJson) throw new Error("no show.json");
    const json = await reader.text(showJson, 1e9);
    const other = new Uint8Array(png.length).fill(7);

    const cases: [string, Uint8Array | Blob, number][] = [
      ["not a zip", new TextEncoder().encode("hello"), 400],
      ["no show.json", await zip([{ name: "x/y", data: new Blob(["1"]) }]), 400],
      [
        "an unexpected entry",
        await zip([
          { name: "show.json", data: new Blob([json]) },
          { name: "evil.sh", data: new Blob(["#"]) },
        ]),
        400,
      ],
      ["a missing asset file", await zip([{ name: "show.json", data: new Blob([json]) }]), 400],
      [
        "an asset whose content doesn't match its hash",
        await zip([
          { name: "show.json", data: new Blob([json]) },
          { name: `assets/${pngId}`, data: new Blob([other]) },
        ]),
        400,
      ],
      [
        "a newer version",
        await zip([
          { name: "show.json", data: new Blob([json.replace('"version": 1', '"version": 9')]) },
        ]),
        400,
      ],
      [
        "a dangling reference",
        await zip([
          {
            name: "show.json",
            data: new Blob([json.replace(/"activeThemeId": "[^"]+"/, '"activeThemeId": "nope"')]),
          },
          { name: `assets/${pngId}`, data: new Blob([png]) },
        ]),
        422,
      ],
      ["a file over the limit", new Uint8Array(1024 * 1024 + 1), 413],
    ];
    for (const [what, body, status] of cases) {
      const res = await target.import(body);
      expect({ what, status: res.status }).toEqual({ what, status });
      expect(target.hub.state).toBe(before);
    }
    await Bun.sleep(0);
    expect(readdirSync(target.assetsDir).filter((name) => name !== "thumbs")).toEqual([]);
    expect(readdirSync(target.tmp)).toEqual([]);
  });

  test("needs a session and a matching Origin", async () => {
    expect((await target.app.request("/api/show/export")).status).toBe(401);
    const foreign = await target.app.request("/api/show/import", {
      method: "POST",
      headers: { ...target.headers(), Origin: "http://evil.example" },
      body: exported,
    });
    expect(foreign.status).toBe(403);
  });
});
