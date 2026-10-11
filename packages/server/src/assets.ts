import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AssetMeta } from "@storbild/core";
import { Hono } from "hono";
import { sniff } from "./sniff.ts";
import type { StateHub } from "./state-hub.ts";

/** The largest thumbnail the admin may store with an upload. */
export const MAX_THUMBNAIL_BYTES = 256 * 1024;

const assetId = /^[0-9a-f]{64}$/;

export type UploadResult =
  | { ok: true; asset: AssetMeta }
  | { ok: false; status: 415; error: "unsupported_type"; message: string };

export interface AssetStoreOptions {
  /** The directory files are kept in, named by content hash. */
  dir: string;
  hub: StateHub;
  now: () => number;
}

/**
 * Uploaded files on disk (DESIGN.md §4.7, ADR 0011). A file is stored under its SHA-256 and
 * registered in the show with the host command `asset.add`; a thumbnail made by the admin is
 * kept beside it in `thumbs/`. Files whose asset leaves the show are deleted.
 */
export class AssetStore {
  readonly #dir: string;
  readonly #thumbs: string;
  readonly #hub: StateHub;
  readonly #now: () => number;
  #known = new Set<string>();
  #unwatch: (() => void) | undefined;

  constructor({ dir, hub, now }: AssetStoreOptions) {
    this.#dir = dir;
    this.#thumbs = join(dir, "thumbs");
    this.#hub = hub;
    this.#now = now;
  }

  /** Removes files the show doesn't know, such as a crashed upload's, and starts watching. */
  start() {
    mkdirSync(this.#thumbs, { recursive: true });
    const assets = this.#hub.state.assets;
    for (const name of readdirSync(this.#dir)) {
      if (name !== "thumbs" && !assets[name]) rmSync(join(this.#dir, name), { force: true });
    }
    for (const name of readdirSync(this.#thumbs)) {
      if (!assets[name.replace(/\.webp$/, "")]) rmSync(join(this.#thumbs, name), { force: true });
    }
    this.#known = new Set(Object.keys(assets));
    this.#unwatch = this.#hub.watch(() => this.#collect());
  }

  stop() {
    this.#unwatch?.();
  }

  /** Stores a file and registers it, or refuses a type that isn't allowed. */
  async upload(file: Blob, name: string, thumbnail?: Blob): Promise<UploadResult> {
    const bytes = await file.bytes();
    const sniffed = sniff(bytes);
    if (!sniffed) {
      return {
        ok: false,
        status: 415,
        error: "unsupported_type",
        message: "Only PNG, JPEG, GIF, WebP, AVIF, SVG and woff2 files can be uploaded.",
      };
    }
    const id = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    await this.#write(join(this.#dir, id), bytes);

    let hasThumbnail = false;
    if (thumbnail && thumbnail.size <= MAX_THUMBNAIL_BYTES) {
      const thumb = await thumbnail.bytes();
      // A thumbnail that isn't a WebP image is dropped; the admin then shows the file itself.
      if (sniff(thumb)?.mimeType === "image/webp") {
        await this.#write(this.#thumbnailPath(id), thumb);
        hasThumbnail = true;
      }
    }

    this.#hub.dispatchHost({
      type: "asset.add",
      payload: {
        id,
        name: name.trim().slice(0, 200) || "Untitled",
        size: bytes.length,
        ...sniffed,
        ...(hasThumbnail && { thumbnail: true }),
        createdAt: this.#now(),
      },
    });
    this.#known.add(id);
    return { ok: true, asset: this.#hub.state.assets[id] as AssetMeta };
  }

  /** The stored file of an asset in the show. */
  file(id: string): { path: string; asset: AssetMeta } | undefined {
    const asset = assetId.test(id) ? this.#hub.state.assets[id] : undefined;
    return asset && { path: join(this.#dir, id), asset };
  }

  /** The thumbnail of an asset in the show, if it has one. */
  thumbnail(id: string): string | undefined {
    const asset = assetId.test(id) ? this.#hub.state.assets[id] : undefined;
    return asset?.thumbnail ? this.#thumbnailPath(id) : undefined;
  }

  #thumbnailPath(id: string) {
    return join(this.#thumbs, `${id}.webp`);
  }

  /** Writes to a temporary name first, so a file under its hash is always complete. */
  async #write(path: string, bytes: Uint8Array) {
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await Bun.write(temporary, bytes);
    renameSync(temporary, path);
  }

  /** Deletes the files of assets that have left the show. */
  #collect() {
    const assets = this.#hub.state.assets;
    for (const id of this.#known) {
      if (assets[id]) continue;
      rmSync(join(this.#dir, id), { force: true });
      rmSync(this.#thumbnailPath(id), { force: true });
      this.#known.delete(id);
    }
  }
}

const headers = (type: string) => ({
  "Content-Type": type,
  "Cache-Control": "public, max-age=31536000, immutable",
  "X-Content-Type-Options": "nosniff",
  // Opened directly, an upload (an SVG, say) must never run as a page of this origin.
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
});

/** Serves a file that may have vanished from disk as a 404. */
async function sendFile(path: string | undefined, type: string) {
  const file = path ? Bun.file(path) : undefined;
  if (!file || !(await file.exists())) return new Response("not found", { status: 404 });
  return new Response(file, { headers: headers(type) });
}

/**
 * Serves `/assets/<id>` immutably, on both apps, and `/assets/<id>/thumbnail` on the admin's.
 * Only assets in the show are served.
 */
export function createAssetRoutes(store: AssetStore, { thumbnails = false } = {}) {
  const app = new Hono().get("/assets/:id", (c) => {
    const found = store.file(c.req.param("id"));
    return sendFile(found?.path, found?.asset.mimeType ?? "");
  });
  if (thumbnails) {
    app.get("/assets/:id/thumbnail", (c) =>
      sendFile(store.thumbnail(c.req.param("id")), "image/webp"),
    );
  }
  return app;
}
