import { Hono } from "hono";
import { type AppBundle, buildApp, createBundleRoutes, once } from "./app-bundle.ts";
import type { ModuleRegistry } from "./plugins/routes.ts";

/** The viewer app's browser bundle. */
export type ViewerBundle = AppBundle;

/** The viewer build, made once per process. */
export const getViewerBundle = once(() =>
  buildApp(Bun.resolveSync("@storbild/viewer/main", import.meta.dir), "viewer"),
);

/** JSON that is safe inside a `<script>` element. */
const scriptJson = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");

/** The service worker's code, built once per process (ADR 0019). */
export const getServiceWorkerCode = once(async () => {
  const result = await Bun.build({
    entrypoints: [Bun.resolveSync("@storbild/viewer/sw", import.meta.dir)],
    target: "browser",
    format: "iife",
    minify: true,
    throw: false,
  });
  const output = result.outputs[0];
  if (!result.success || !output) {
    throw new Error(`service worker build failed: ${result.logs.map(String).join("\n")}`);
  }
  return output.text();
});

/**
 * Every URL a screen needs to start without the server: the page, the viewer bundle, the
 * vendor modules and every plugin's modules. All but the page are versioned and immutable.
 */
export function precacheUrls(bundle: ViewerBundle, registry: ModuleRegistry | undefined): string[] {
  const urls = ["/", ...[...bundle.files.keys()].map((path) => `/app/${bundle.hash}/${path}`)];
  if (registry) {
    const { vendor, plugins } = registry;
    urls.push(...[...vendor.files.keys()].map((path) => `/vendor/${vendor.hash}/${path}`));
    for (const [id, { version, hash, files }] of plugins) {
      urls.push(...[...files.keys()].map((path) => `/plugins/${id}/${version}/${hash}/${path}`));
    }
  }
  return urls.map((url) => url.split("/").map(encodeURIComponent).join("/"));
}

/**
 * The service worker script: its manifest, then its code. The manifest's version is a hash
 * of both, so the script changes, and screens install it again, whenever anything precached
 * or the worker itself does.
 */
export function serviceWorkerScript(code: string, precache: string[]): string {
  const version = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(precache))
    .update(code)
    .digest("hex")
    .slice(0, 12);
  return `self.__STORBILD__=${scriptJson({ version, precache })};\n${code}`;
}

function page(bundle: ViewerBundle, importMap: unknown): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Storbild</title>
<script type="importmap">${scriptJson(importMap)}</script>
<style>
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000; cursor: none; }
sb-viewer { display: block; width: 100%; height: 100%; }
</style>
<script type="module" src="/app/${bundle.hash}/viewer.js"></script>
</head>
<body><sb-viewer></sb-viewer></body>
</html>
`;
}

/**
 * Serves the viewer page at `/`, with the import map inline, and its bundle at
 * `/app/<hash>/…`. The page is never cached, so a new server's bundle is picked up on reload;
 * the bundle is immutable.
 */
export function createViewerPageRoutes(
  bundle: ViewerBundle,
  importMap: unknown,
  serviceWorker?: string | (() => string),
) {
  const html = page(bundle, importMap);
  const app = new Hono()
    .get("/", (c) => {
      c.header("Cache-Control", "no-store");
      return c.html(html);
    })
    .route("/", createBundleRoutes(bundle));
  if (serviceWorker !== undefined) {
    // Revalidated on every check, so a new server's worker is picked up at once.
    app.get("/sw.js", (c) =>
      c.body(typeof serviceWorker === "string" ? serviceWorker : serviceWorker(), 200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-cache",
      }),
    );
  }
  return app;
}
