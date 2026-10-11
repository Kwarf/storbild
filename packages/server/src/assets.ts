import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AssetMeta } from "@storbild/core";
import { Hono } from "hono";
import { type Sniffed, sniff } from "./sniff.ts";
import type { StateHub } from "./state-hub.ts";

/** The largest thumbnail the admin may store with an upload. */
export const MAX_THUMBNAIL_BYTES = 256 * 1024;

const assetId = /^[0-9a-f]{64}$/;

/** How many bytes the first sniff reads, which is enough to recognise a video. */
const HEAD_BYTES = 256 * 1024;

export type UploadResult =
  | { ok: true; asset: AssetMeta }
  | { ok: false; status: 415; error: "unsupported_type"; message: string }
  | { ok: false; status: 413; error: "too_large"; limit: number };

/** The largest file, in bytes, and the largest video (ADR 0014). Absent means no limit. */
export interface UploadLimits {
  file?: number;
  video?: number;
}

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

  /**
   * Streams an upload to disk while hashing it, so no file is ever held whole in memory, and
   * registers it (ADR 0014). The type is judged from the first bytes, which also decides the
   * size limit; an upload is cut off as soon as it passes it, or refused when its type isn't
   * allowed.
   */
  async upload(
    body: ReadableStream<Uint8Array>,
    name: string,
    limits: UploadLimits = {},
  ): Promise<UploadResult> {
    const reader = body.getReader();
    const temporary = join(this.#dir, `${crypto.randomUUID()}.tmp`);
    const hasher = new Bun.CryptoHasher("sha256");
    const writer = Bun.file(temporary).writer();
    const abandon = async () => {
      await reader.cancel().catch(() => {});
      await Promise.resolve(writer.end()).catch(() => {});
      rmSync(temporary, { force: true });
    };

    let size = 0;
    let head: Uint8Array[] = [];
    let headSize = 0;
    let sniffed: Sniffed | undefined;
    let limit: number | undefined;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (value) {
          hasher.update(value);
          writer.write(value);
          size += value.length;
          if (!sniffed) {
            head.push(value);
            headSize += value.length;
          }
        }
        if (!sniffed && (done || headSize >= HEAD_BYTES)) {
          sniffed = sniff(Buffer.concat(head));
          head = [];
          if (!sniffed) {
            await abandon();
            return {
              ok: false,
              status: 415,
              error: "unsupported_type",
              message:
                "Only PNG, JPEG, GIF, WebP, AVIF, SVG, woff2, MP4 and WebM files can be uploaded.",
            };
          }
          limit = sniffed.mimeType.startsWith("video/") ? limits.video : limits.file;
        }
        if (limit !== undefined && size > limit) {
          await abandon();
          return { ok: false, status: 413, error: "too_large", limit };
        }
        if (done) break;
      }
      await writer.end();
    } catch (error) {
      await abandon();
      throw error;
    }
    if (!sniffed) throw new Error("unreachable: an upload ends with its type judged");
    // Some image headers lie past the first bytes; anything but a video is small enough to
    // read whole for its size.
    if (!sniffed.mimeType.startsWith("video/")) {
      sniffed = sniff(await Bun.file(temporary).bytes()) ?? sniffed;
    }
    const id = hasher.digest("hex");
    renameSync(temporary, join(this.#dir, id));

    this.#hub.dispatchHost({
      type: "asset.add",
      payload: {
        id,
        name: name.trim().slice(0, 200) || "Untitled",
        size,
        ...sniffed,
        createdAt: this.#now(),
      },
    });
    this.#known.add(id);
    return { ok: true, asset: this.#hub.state.assets[id] as AssetMeta };
  }

  /**
   * Stores the admin's thumbnail of an asset, a WebP image of at most `MAX_THUMBNAIL_BYTES`.
   * Returns false for an unknown asset or a thumbnail that isn't one.
   */
  async setThumbnail(id: string, thumbnail: Uint8Array): Promise<boolean> {
    const asset = assetId.test(id) ? this.#hub.state.assets[id] : undefined;
    if (!asset || thumbnail.length > MAX_THUMBNAIL_BYTES) return false;
    if (sniff(thumbnail)?.mimeType !== "image/webp") return false;
    await this.#write(this.#thumbnailPath(id), thumbnail);
    if (!asset.thumbnail) this.#hub.dispatchHost({ type: "asset.setThumbnail", payload: { id } });
    return true;
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
