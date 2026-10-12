// The viewer's service worker (ADR 0019). It keeps a screen able to start and play through
// an outage: the page, bundles and plugin modules are precached from a manifest the server
// puts in front of this script, and the assets the show uses are cached as the page asks.
import { ASSET_CACHE, assetDelta, CACHE_PREFIX, parseRange, route } from "./offline.ts";

interface Manifest {
  /** Changes whenever any precached file does, so the browser installs a new worker. */
  version: string;
  precache: string[];
}

declare const self: ServiceWorkerGlobalScope & { __STORBILD__: Manifest };

const { version, precache } = self.__STORBILD__;
const PRECACHE = `${CACHE_PREFIX}${version}`;
/** How long the page may take from the network before the cached copy is used. */
const PAGE_TIMEOUT_MS = 4_000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(PRECACHE)
      .then((cache) => cache.addAll(precache))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(CACHE_PREFIX) && name !== PRECACHE && name !== ASSET_CACHE) {
          await caches.delete(name);
        }
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  switch (route(url.pathname, request.method, request.mode)) {
    case "page":
      event.respondWith(page(request));
      return;
    case "immutable":
      event.respondWith(immutable(request));
      return;
    case "asset":
      event.respondWith(asset(request, url.pathname));
      return;
    case "network":
      return;
  }
});

/**
 * The page from the network, or the cached copy when the network fails, is too slow, or
 * answers with an error: a proxy says 502 while the server restarts.
 */
async function page(request: Request): Promise<Response> {
  const cache = await caches.open(PRECACHE);
  let response: Response | undefined;
  try {
    response = await Promise.race([
      fetch(request),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timed out")), PAGE_TIMEOUT_MS),
      ),
    ]);
    if (response.ok) {
      await cache.put("/", response.clone());
      return response;
    }
  } catch {
    // Offline; use the cached page.
  }
  return (await cache.match("/")) ?? response ?? Response.error();
}

/** Versioned files never change, so a cached copy is always right. */
async function immutable(request: Request): Promise<Response> {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(PRECACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

/**
 * An uploaded file from the asset cache, or the network. Media elements ask for ranges, which
 * are cut from the cached whole file.
 */
async function asset(request: Request, path: string): Promise<Response> {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(path);
  if (!cached) return fetch(request);
  const header = request.headers.get("Range");
  if (!header) return cached;
  const body = await cached.blob();
  const range = parseRange(header, body.size);
  if (range === undefined) return cached;
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${body.size}` },
    });
  }
  const headers = new Headers(cached.headers);
  headers.set("Content-Range", `bytes ${range.start}-${range.end}/${body.size}`);
  headers.set("Content-Length", String(range.end - range.start + 1));
  headers.set("Accept-Ranges", "bytes");
  return new Response(body.slice(range.start, range.end + 1), { status: 206, headers });
}

/** The asset URLs the page last asked for. */
let wanted: string[] | undefined;
let syncing: Promise<void> = Promise.resolve();

self.addEventListener("message", (event) => {
  const data = event.data as { type?: unknown; urls?: unknown } | null;
  if (data?.type !== "assets" || !Array.isArray(data.urls)) return;
  wanted = data.urls.filter((url): url is string => typeof url === "string");
  syncing = syncing.then(syncAssets, syncAssets);
  event.waitUntil(syncing);
});

/**
 * Makes the asset cache hold exactly what the page asked for. Files are fetched whole and one
 * at a time, so a large video doesn't crowd out the screen's stream. A file that fails is
 * tried again the next time the page asks, which it does after every change and reconnect.
 */
async function syncAssets() {
  const target = wanted;
  if (!target) return;
  const cache = await caches.open(ASSET_CACHE);
  const cached = (await cache.keys()).map((request) => new URL(request.url).pathname);
  const { add, remove } = assetDelta(cached, target);
  for (const url of remove) await cache.delete(url);
  for (const url of add) {
    // A newer list has arrived; the next run takes over.
    if (wanted !== target) return;
    try {
      const response = await fetch(url);
      if (response.status === 200) await cache.put(url, response);
    } catch {
      // Offline; try again later.
    }
  }
}
