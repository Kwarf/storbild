import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetMeta } from "@storbild/core";
import { AssetStore } from "./assets.ts";
import { sniff } from "./sniff.ts";
import { createTestAdminApp, createTestHub, TEST_PASSWORD } from "./testing.ts";
import { createViewerApp } from "./viewer-app.ts";

/** A real 1×1 PNG. */
const png = Uint8Array.fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
);

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(
    parts.flatMap((part) =>
      typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : part,
    ),
  );
const u16le = (n: number) => [n & 0xff, n >> 8];
const u16be = (n: number) => [n >> 8, n & 0xff];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, n >> 16];
const u32be = (n: number) => [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

/** A WebP header (VP8X) of the given size. */
const webp = (width: number, height: number) =>
  bytes(
    "RIFF",
    [0, 0, 0, 0],
    "WEBPVP8X",
    [10, 0, 0, 0, 0, 0, 0, 0],
    u24le(width - 1),
    u24le(height - 1),
  );

describe("sniff", () => {
  test.each<[string, Uint8Array, ReturnType<typeof sniff>]>([
    ["png", png, { mimeType: "image/png", width: 1, height: 1 }],
    [
      "gif",
      bytes("GIF89a", u16le(320), u16le(200)),
      { mimeType: "image/gif", width: 320, height: 200 },
    ],
    [
      "jpeg",
      bytes(
        [0xff, 0xd8, 0xff, 0xe0],
        u16be(4),
        [0, 0],
        [0xff, 0xc2],
        u16be(11),
        [8],
        u16be(1080),
        u16be(1920),
        [3],
      ),
      { mimeType: "image/jpeg", width: 1920, height: 1080 },
    ],
    ["webp (VP8X)", webp(4000, 3000), { mimeType: "image/webp", width: 4000, height: 3000 }],
    [
      "webp (VP8)",
      bytes(
        "RIFF",
        [0, 0, 0, 0],
        "WEBPVP8 ",
        [0, 0, 0, 0],
        [0, 0, 0, 0x9d, 0x01, 0x2a],
        u16le(640),
        u16le(480),
      ),
      { mimeType: "image/webp", width: 640, height: 480 },
    ],
    [
      "avif",
      bytes(
        u32be(24),
        "ftypavif",
        [0, 0, 0, 0],
        "mif1avif",
        u32be(20),
        "ispe",
        [0, 0, 0, 0],
        u32be(800),
        u32be(600),
      ),
      { mimeType: "image/avif", width: 800, height: 600 },
    ],
    [
      "svg with a prolog and px sizes",
      bytes(
        '<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" width="120px" height="40">',
      ),
      { mimeType: "image/svg+xml", width: 120, height: 40 },
    ],
    [
      "svg sized by its viewBox",
      bytes('<svg viewBox="0 0 64.4 32" width="100%">'),
      { mimeType: "image/svg+xml", width: 64, height: 32 },
    ],
    ["woff2", bytes("wOF2", [0, 1, 0, 0]), { mimeType: "font/woff2" }],
  ])("identifies %s", (_, file, expected) => {
    expect(sniff(file)).toEqual(expected);
  });

  test.each([
    ["html", bytes("<!doctype html><svg>")],
    ["html with svg inside", bytes("<html><body><svg></svg>")],
    ["text", bytes("hello")],
    ["empty", new Uint8Array()],
  ])("refuses %s", (_, file) => {
    expect(sniff(file)).toBeUndefined();
  });
});

describe("asset uploads", () => {
  const dir = mkdtempSync(join(tmpdir(), "storbild-assets-"));
  afterAll(() => rmSync(dir, { recursive: true }));
  const { app, hub, assets } = createTestAdminApp({ assetsDir: dir, maxUploadBytes: 4096 });
  const viewer = createViewerApp({ hub, now: () => 0, ...(assets && { assets }) });
  let cookie: string;
  beforeAll(async () => {
    const res = await app.request("/login", {
      method: "POST",
      headers: { Origin: "http://localhost" },
      body: new URLSearchParams({ username: "admin", password: TEST_PASSWORD }),
    });
    cookie = res.headers.get("Set-Cookie")?.split(";")[0] as string;
  });

  const upload = (file: Blob, extra: Record<string, string | Blob> = {}) => {
    const form = new FormData();
    form.set("file", file, "logo.png");
    for (const [key, value] of Object.entries(extra)) form.set(key, value);
    return app.request("/api/assets", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "http://localhost" },
      body: form,
    });
  };
  const id = new Bun.CryptoHasher("sha256").update(png).digest("hex");

  test("stores a file by its hash and registers it with its size", async () => {
    const res = await upload(new Blob([png], { type: "text/html" }), {
      thumbnail: new Blob([webp(1, 1)]),
    });
    expect(res.status).toBe(200);
    const asset = (await res.json()) as AssetMeta;
    expect(asset).toEqual({
      id,
      name: "logo.png",
      mimeType: "image/png",
      size: png.length,
      width: 1,
      height: 1,
      thumbnail: true,
      createdAt: 1_000_000,
    });
    expect(hub.state.assets[id]).toEqual(asset);
    expect(existsSync(join(dir, id))).toBe(true);
  });

  test("the same file again keeps the first upload's name", async () => {
    const revision = hub.state.revision;
    const res = await upload(new Blob([png]), { name: "Other" });
    expect(((await res.json()) as AssetMeta).name).toBe("logo.png");
    expect(hub.state.revision).toBe(revision);
  });

  test("serves the file immutably on both apps, and the thumbnail on the admin's", async () => {
    for (const target of [app, viewer]) {
      const res = await target.request(`/assets/${id}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/png");
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Content-Security-Policy")).toContain("sandbox");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
    }
    const thumb = await app.request(`/assets/${id}/thumbnail`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("Content-Type")).toBe("image/webp");
    expect((await viewer.request(`/assets/${id}/thumbnail`)).status).toBe(404);
  });

  test.each(["0".repeat(64), "../storbild.db", "thumbs"])("does not serve %s", async (path) => {
    expect((await viewer.request(`/assets/${path}`)).status).toBe(404);
  });

  test("refuses files that aren't allowed, whatever their declared type", async () => {
    const res = await upload(new Blob(["<html><script>alert(1)</script>"], { type: "image/png" }));
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: string }).error).toBe("unsupported_type");
  });

  test("refuses files over the limit", async () => {
    const big = new Uint8Array(5000);
    big.set(png);
    expect((await upload(new Blob([big]))).status).toBe(413);
  });

  test("needs a session and a matching origin", async () => {
    const form = new FormData();
    form.set("file", new Blob([png]));
    const anonymous = await app.request("/api/assets", {
      method: "POST",
      headers: { Origin: "http://localhost" },
      body: form,
    });
    expect(anonymous.status).toBe(401);
    const foreign = await app.request("/api/assets", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "http://evil.example" },
      body: form,
    });
    expect(foreign.status).toBe(403);
  });

  test("deleting an asset deletes its files", async () => {
    hub.dispatch({ type: "asset.delete", payload: { id } });
    await Bun.sleep(0);
    expect(existsSync(join(dir, id))).toBe(false);
    expect(existsSync(join(dir, "thumbs", `${id}.webp`))).toBe(false);
    expect((await viewer.request(`/assets/${id}`)).status).toBe(404);
  });
});

test("on start, the store removes files the show doesn't know", async () => {
  const dir = mkdtempSync(join(tmpdir(), "storbild-assets-"));
  try {
    const hub = createTestHub();
    const store = new AssetStore({ dir, hub, now: () => 0 });
    store.start();
    const result = await store.upload(new Blob([png]), "keep.png");
    if (!result.ok) throw new Error("upload failed");
    const orphan = "f".repeat(64);
    writeFileSync(join(dir, orphan), "x");
    writeFileSync(join(dir, `${orphan}.123.tmp`), "x");
    writeFileSync(join(dir, "thumbs", `${orphan}.webp`), "x");
    store.stop();

    new AssetStore({ dir, hub, now: () => 0 }).start();
    expect(existsSync(join(dir, result.asset.id))).toBe(true);
    expect(existsSync(join(dir, orphan))).toBe(false);
    expect(existsSync(join(dir, `${orphan}.123.tmp`))).toBe(false);
    expect(existsSync(join(dir, "thumbs", `${orphan}.webp`))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
