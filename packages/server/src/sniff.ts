// What an uploaded file is, judged by its content (ADR 0011, ADR 0021). file-type recognises the
// binary formats and image-size reads an image's dimensions. Neither checks that a text file is
// an SVG document rather than, say, HTML with an <svg> inside, so that check is ours.
import { fileTypeFromBuffer } from "file-type";
import { imageSize } from "image-size";

export interface Sniffed {
  mimeType: string;
  width?: number;
  height?: number;
}

/** The binary types an upload may have, by file-type's MIME type, and the type they're kept as. */
const allowed = new Map([
  ["image/png", "image/png"],
  ["image/jpeg", "image/jpeg"],
  ["image/gif", "image/gif"],
  ["image/webp", "image/webp"],
  ["image/avif", "image/avif"],
  ["video/mp4", "video/mp4"],
  // An MP4 with the `M4V ` brand, which browsers play as MP4.
  ["video/x-m4v", "video/mp4"],
  ["video/webm", "video/webm"],
  ["font/woff2", "font/woff2"],
]);

/** The XML declaration, comments and an SVG doctype, which may come before the root element. */
const svgProlog = /^\s*(?:<\?xml[^>]*>\s*)?(?:(?:<!--[\s\S]*?-->|<!DOCTYPE\s+svg[^>]*>)\s*)*/i;

/** Whether the document's root element is `<svg>`. */
function isSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 4096)).replace(/^﻿/, "");
  return /^<svg[\s>/]/i.test(head.replace(svgProlog, ""));
}

/** Width and height when the header has both as positive integers. */
function dimensions(bytes: Uint8Array): Pick<Sniffed, "width" | "height"> {
  let width: number | undefined;
  let height: number | undefined;
  try {
    ({ width, height } = imageSize(bytes));
  } catch {
    // A header too short or too odd to read; the type stands without a size.
    return {};
  }
  return width !== undefined &&
    height !== undefined &&
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0
    ? { width, height }
    : {};
}

/**
 * Identifies an uploaded file by its content, never by the name or type the client gave, and
 * reads an image's size from its header. Returns undefined for anything not allowed: PNG,
 * JPEG, GIF, WebP, AVIF, SVG, woff2, MP4 and WebM (ADR 0014). A video is recognised from its
 * first bytes alone.
 */
export async function sniff(bytes: Uint8Array): Promise<Sniffed | undefined> {
  const detected = (await fileTypeFromBuffer(bytes).catch(() => undefined))?.mime;
  let mimeType = detected && allowed.get(detected);
  // file-type calls an SVG with an XML declaration application/xml, and one without nothing.
  if (!mimeType && (!detected || detected === "application/xml") && isSvg(bytes)) {
    mimeType = "image/svg+xml";
  }
  if (!mimeType) return undefined;
  return mimeType.startsWith("image/") ? { mimeType, ...dimensions(bytes) } : { mimeType };
}
