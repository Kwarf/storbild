/** What an uploaded file is, judged by its content (ADR 0011). */
export interface Sniffed {
  mimeType: string;
  width?: number;
  height?: number;
}

const ascii = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, start + length));

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  signature.every((byte, i) => bytes[offset + i] === byte);

/** Width and height when both are positive integers. */
function size(width: number, height: number): Pick<Sniffed, "width" | "height"> {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    ? { width, height }
    : {};
}

function png(bytes: Uint8Array, view: DataView): Sniffed | undefined {
  if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return undefined;
  const dimensions = ascii(bytes, 12, 4) === "IHDR" && bytes.length >= 24;
  return {
    mimeType: "image/png",
    ...(dimensions && size(view.getUint32(16), view.getUint32(20))),
  };
}

function gif(bytes: Uint8Array, view: DataView): Sniffed | undefined {
  const magic = ascii(bytes, 0, 6);
  if (magic !== "GIF87a" && magic !== "GIF89a") return undefined;
  return {
    mimeType: "image/gif",
    ...(bytes.length >= 10 && size(view.getUint16(6, true), view.getUint16(8, true))),
  };
}

function jpeg(bytes: Uint8Array, view: DataView): Sniffed | undefined {
  if (!startsWith(bytes, [0xff, 0xd8, 0xff])) return undefined;
  // Walk the segments to the first start-of-frame marker, which holds the size.
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1] as number;
    if (marker === 0xff) {
      offset++;
      continue;
    }
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      return {
        mimeType: "image/jpeg",
        ...size(view.getUint16(offset + 7), view.getUint16(offset + 5)),
      };
    }
    offset += 2 + view.getUint16(offset + 2);
  }
  return { mimeType: "image/jpeg" };
}

function webp(bytes: Uint8Array, view: DataView): Sniffed | undefined {
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return undefined;
  const result: Sniffed = { mimeType: "image/webp" };
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8 " && bytes.length >= 30) {
    return {
      ...result,
      ...size(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff),
    };
  }
  if (chunk === "VP8L" && bytes.length >= 25) {
    const [b1, b2, b3, b4] = [21, 22, 23, 24].map((i) => bytes[i] as number) as [
      number,
      number,
      number,
      number,
    ];
    const width = 1 + (((b2 & 0x3f) << 8) | b1);
    const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
    return { ...result, ...size(width, height) };
  }
  if (chunk === "VP8X" && bytes.length >= 30) {
    const u24 = (i: number) => view.getUint16(i, true) | ((bytes[i + 2] as number) << 16);
    return { ...result, ...size(1 + u24(24), 1 + u24(27)) };
  }
  return result;
}

function avif(bytes: Uint8Array, view: DataView): Sniffed | undefined {
  if (ascii(bytes, 4, 4) !== "ftyp") return undefined;
  const boxEnd = Math.min(view.byteLength >= 4 ? view.getUint32(0) : 0, bytes.length);
  const brands = [ascii(bytes, 8, 4)];
  for (let i = 16; i + 4 <= boxEnd; i += 4) brands.push(ascii(bytes, i, 4));
  if (!brands.includes("avif") && !brands.includes("avis")) return undefined;
  // The image spatial extents property: 4 bytes of version and flags, then width and height.
  const last = Math.min(bytes.length, 64 * 1024) - 16;
  for (let i = 0; i <= last; i++) {
    if (bytes[i] === 0x69 && ascii(bytes, i, 4) === "ispe") {
      return { mimeType: "image/avif", ...size(view.getUint32(i + 8), view.getUint32(i + 12)) };
    }
  }
  return { mimeType: "image/avif" };
}

/** A pixel length from an SVG attribute: unitless or px only. */
function svgLength(value: string | undefined): number {
  const match = value?.trim().match(/^(\d+(?:\.\d+)?)(px)?$/);
  return match ? Math.round(Number(match[1])) : Number.NaN;
}

function svg(bytes: Uint8Array): Sniffed | undefined {
  const head = new TextDecoder().decode(bytes.subarray(0, 4096)).replace(/^﻿/, "");
  const prolog = /^\s*(?:<\?xml[^>]*>\s*)?(?:(?:<!--[\s\S]*?-->|<!DOCTYPE\s+svg[^>]*>)\s*)*/i;
  const rest = head.replace(prolog, "");
  const tag = rest.match(/^<svg(?=[\s>/])[^>]*>/i)?.[0];
  if (!tag) return undefined;
  const attribute = (name: string) =>
    tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];
  let width = svgLength(attribute("width"));
  let height = svgLength(attribute("height"));
  if (!(width > 0 && height > 0)) {
    const box = attribute("viewBox")
      ?.trim()
      .split(/[\s,]+/)
      .map(Number);
    if (box?.length === 4) [width, height] = [Math.round(box[2] ?? 0), Math.round(box[3] ?? 0)];
  }
  return { mimeType: "image/svg+xml", ...size(width, height) };
}

function woff2(bytes: Uint8Array): Sniffed | undefined {
  return ascii(bytes, 0, 4) === "wOF2" ? { mimeType: "font/woff2" } : undefined;
}

/**
 * Identifies an uploaded file by its content, never by the name or type the client gave, and
 * reads an image's size from its header. Returns undefined for anything not allowed: PNG,
 * JPEG, GIF, WebP, AVIF, SVG and woff2.
 */
export function sniff(bytes: Uint8Array): Sniffed | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    return (
      png(bytes, view) ??
      jpeg(bytes, view) ??
      gif(bytes, view) ??
      webp(bytes, view) ??
      avif(bytes, view) ??
      woff2(bytes) ??
      svg(bytes)
    );
  } catch (error) {
    // A truncated header reads past the end; treat it as not an allowed file.
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}
