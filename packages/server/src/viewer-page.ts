import { Hono } from "hono";
import { type AppBundle, buildApp, createBundleRoutes, once } from "./app-bundle.ts";

/** The viewer app's browser bundle. */
export type ViewerBundle = AppBundle;

/** The viewer build, made once per process. */
export const getViewerBundle = once(() =>
  buildApp(Bun.resolveSync("@storbild/viewer/main", import.meta.dir), "viewer"),
);

/** JSON that is safe inside a `<script>` element. */
const scriptJson = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");

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
export function createViewerPageRoutes(bundle: ViewerBundle, importMap: unknown) {
  const html = page(bundle, importMap);
  return new Hono()
    .get("/", (c) => {
      c.header("Cache-Control", "no-store");
      return c.html(html);
    })
    .route("/", createBundleRoutes(bundle));
}
