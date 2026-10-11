import type { AssetMeta, ShowState } from "@storbild/core";
import type { AssetSource } from "@storbild/plugin-sdk/admin";
import { api, toLogin } from "./api.ts";

/** The longest side of a thumbnail, in px. */
const THUMBNAIL_SIZE = 320;

/** Draws an image or video frame as a small WebP, or undefined when the browser can't. */
async function drawThumbnail(
  source: CanvasImageSource,
  naturalWidth: number,
  naturalHeight: number,
): Promise<Blob | undefined> {
  const width = naturalWidth || THUMBNAIL_SIZE;
  const height = naturalHeight || THUMBNAIL_SIZE;
  const scale = Math.min(1, THUMBNAIL_SIZE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext("2d")?.drawImage(source, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp", 0.8),
  );
  // Browsers that can't encode WebP fall back to PNG, which the server would refuse.
  return blob?.type === "image/webp" ? blob : undefined;
}

/** Resolves once `target` fires `event`, or rejects on `error`. */
const once = (target: HTMLMediaElement, event: string) =>
  new Promise<void>((resolve, reject) => {
    target.addEventListener(event, () => resolve(), { once: true });
    target.addEventListener("error", () => reject(target.error), { once: true });
  });

/** A frame a second into a video (or halfway, for a short one). */
async function videoThumbnail(url: string): Promise<Blob | undefined> {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = url;
  await once(video, "loadeddata");
  video.currentTime = Math.min(1, (video.duration || 0) / 2);
  await once(video, "seeked");
  return drawThumbnail(video, video.videoWidth, video.videoHeight);
}

/**
 * Draws a small WebP of an image file or of a frame of a video, or resolves to undefined when
 * the browser can't (ADR 0011, ADR 0014). Thumbnails are made here so the server needs no
 * image library.
 */
export async function makeThumbnail(file: Blob): Promise<Blob | undefined> {
  const image = file.type.startsWith("image/");
  if (!image && !file.type.startsWith("video/")) return undefined;
  const url = URL.createObjectURL(file);
  try {
    if (!image) return await videoThumbnail(url);
    // An <img> decodes everything the browser shows, SVG included.
    const img = new Image();
    img.src = url;
    await img.decode();
    return await drawThumbnail(img, img.naturalWidth, img.naturalHeight);
  } catch {
    return undefined;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Uploads a file as the raw request body, which the server streams to disk, then its thumbnail
 * (ADR 0014). Rejects with a message fit to show; a thumbnail that fails only leaves the file
 * without one.
 */
export async function uploadAsset(file: File): Promise<AssetMeta> {
  const thumbnail = await makeThumbnail(file);
  const url = api.api.assets.$url();
  url.searchParams.set("name", file.name);
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", body: file });
  } catch {
    throw new Error("Can't reach the server.");
  }
  if (res.status === 401) {
    toLogin();
    throw new Error("Your session has expired.");
  }
  const body = (await res.json().catch(() => ({}))) as AssetMeta & { message?: string };
  if (!res.ok) throw new Error(body.message ?? `Upload failed (${res.status}).`);
  if (thumbnail) {
    await fetch(`${api.api.assets.$url()}/${body.id}/thumbnail`, {
      method: "PUT",
      body: thumbnail,
    }).catch(() => undefined);
  }
  return body;
}

/** The show's assets for asset pickers, following the admin's state. */
export class StateAssetSource implements AssetSource {
  #assets: ShowState["assets"] = {};
  readonly #listeners = new Set<() => void>();

  /** Takes the assets of a new state, telling pickers when they changed. */
  update(state: ShowState) {
    if (state.assets === this.#assets) return;
    this.#assets = state.assets;
    for (const listener of this.#listeners) listener();
  }

  list(): AssetMeta[] {
    return Object.values(this.#assets);
  }

  url(id: string): string {
    return `/assets/${encodeURIComponent(id)}`;
  }

  previewUrl(id: string): string {
    return this.#assets[id]?.thumbnail ? `${this.url(id)}/thumbnail` : this.url(id);
  }

  upload(file: File): Promise<AssetMeta> {
    return uploadAsset(file);
  }

  subscribe(callback: () => void): () => void {
    this.#listeners.add(callback);
    return () => this.#listeners.delete(callback);
  }
}
