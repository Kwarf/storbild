// The page's side of the service worker (ADR 0019). Browsers without one, or pages that aren't
// a secure context (a plain-http LAN address), simply don't get offline starts.

/** Registers `/sw.js` and asks the browser not to evict what it caches. */
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker
    .register("/sw.js", { scope: "/" })
    .catch((error) => console.warn("the service worker failed to register", error));
  void navigator.storage?.persist?.().catch(() => {});
}

/** Tells the service worker which asset URLs to keep cached; the rest are dropped. */
export function cacheAssets(urls: string[]) {
  if (!("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.ready.then((registration) =>
    registration.active?.postMessage({ type: "assets", urls }),
  );
}
