import { pluginExternals } from "@storbild/plugin-sdk/build";
import { Hono } from "hono";
import { type ModuleFiles, toFiles } from "./plugins/bundle.ts";
import { serve } from "./plugins/routes.ts";

/** The viewer app's browser bundle. */
export interface ViewerBundle {
  /** Content hash of all files; part of their URL. */
  hash: string;
  files: ModuleFiles;
}

const entry = Bun.resolveSync("@storbild/viewer/main", import.meta.dir);

/**
 * Bundles the viewer for the browser. lit, zod and the SDK stay external and resolve through
 * the import map, so the viewer and plugins share one copy of each.
 */
async function buildViewer(): Promise<ViewerBundle> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    splitting: true,
    minify: true,
    external: pluginExternals,
    naming: { entry: "viewer.[ext]", chunk: "chunk-[hash].[ext]", asset: "asset-[hash].[ext]" },
    throw: false,
  });
  if (!result.success) {
    throw new Error(`viewer build failed: ${result.logs.map(String).join("\n")}`);
  }
  const files = await toFiles(result.outputs);
  const hasher = new Bun.CryptoHasher("sha256");
  for (const [path, file] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    hasher.update(path);
    hasher.update(await file.body.arrayBuffer());
  }
  return { hash: hasher.digest("hex").slice(0, 12), files };
}

let viewer: Promise<ViewerBundle> | undefined;

/** The viewer build, made once per process. */
export function getViewerBundle(): Promise<ViewerBundle> {
  viewer ??= buildViewer();
  viewer.catch(() => {
    viewer = undefined;
  });
  return viewer;
}

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
    .get("/app/:hash/*", (c) => {
      const hash = c.req.param("hash");
      if (hash !== bundle.hash) return serve(undefined);
      return serve(bundle.files.get(decodeURIComponent(c.req.path.slice(`/app/${hash}/`.length))));
    });
}
