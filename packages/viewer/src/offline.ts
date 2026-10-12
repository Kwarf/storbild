// Pure helpers for the viewer's service worker (ADR 0019). No DOM or worker types, so both the
// page and the worker can use them, and they are unit-tested under Bun.

/** The service worker's caches: one per precache version, and one for assets. */
export const CACHE_PREFIX = "storbild-";
export const ASSET_CACHE = "storbild-assets";

/** How the service worker answers a request. */
export type Strategy =
  /** Not handled: straight to the network, as without a service worker. */
  | "network"
  /** The viewer page: network first, falling back to the cached copy. */
  | "page"
  /** Versioned bundles and modules: cache first. */
  | "immutable"
  /** Uploaded files: from the asset cache when there, with Range support. */
  | "asset";

const immutable = /^\/(?:app|vendor|plugins)\//;
const asset = /^\/assets\/[0-9a-f]{64}$/;

/**
 * Chooses the strategy for a same-origin request. The stream, the clock and anything that
 * isn't a GET always go to the network, so a cached answer can never pass for a live one.
 */
export function route(path: string, method: string, mode: string): Strategy {
  if (method !== "GET") return "network";
  if (mode === "navigate") return path === "/" ? "page" : "network";
  if (immutable.test(path)) return "immutable";
  if (asset.test(path)) return "asset";
  return "network";
}

/** What to fetch into, and delete from, the asset cache to hold exactly `wanted`. */
export function assetDelta(
  cached: readonly string[],
  wanted: readonly string[],
): { add: string[]; remove: string[] } {
  const have = new Set(cached);
  const want = new Set(wanted);
  return {
    add: [...want].filter((url) => !have.has(url)),
    remove: [...have].filter((url) => !want.has(url)),
  };
}

/**
 * Parses a `Range` header for a file of `size` bytes. Only a single range is supported, which
 * is what media elements send; anything else is answered with the whole file (undefined).
 * Returns the inclusive byte range, or "unsatisfiable" for a range outside the file.
 */
export function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | "unsatisfiable" | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, from = "", to = ""] = match;
  if (from === "" && to === "") return undefined;
  let start: number;
  let end: number;
  if (from === "") {
    // The last `to` bytes.
    const length = Number(to);
    if (length === 0) return "unsatisfiable";
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(from);
    end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}
