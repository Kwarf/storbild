import { pluginExternals } from "@storbild/plugin-sdk/build";
import { Hono } from "hono";
import { type ModuleFiles, toFiles } from "./plugins/bundle.ts";
import { serve } from "./plugins/routes.ts";

/** A browser app's bundle: the viewer or the admin. */
export interface AppBundle {
  /** Content hash of all files; part of their URL. */
  hash: string;
  files: ModuleFiles;
}

/**
 * Bundles a browser app. lit, zod and the SDK stay external and resolve through the import
 * map, so the app and plugins share one copy of each. `extra` files (e.g. fonts) are served
 * next to the bundle and count towards its hash.
 */
export async function buildApp(
  entry: string,
  name: string,
  extra: ModuleFiles = new Map(),
): Promise<AppBundle> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    splitting: true,
    minify: true,
    external: pluginExternals,
    naming: { entry: `${name}.[ext]`, chunk: "chunk-[hash].[ext]", asset: "asset-[hash].[ext]" },
    throw: false,
  });
  if (!result.success) {
    throw new Error(`${name} build failed: ${result.logs.map(String).join("\n")}`);
  }
  const files = new Map([...(await toFiles(result.outputs)), ...extra]);
  const hasher = new Bun.CryptoHasher("sha256");
  for (const [path, file] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    hasher.update(path);
    hasher.update(await file.body.arrayBuffer());
  }
  return { hash: hasher.digest("hex").slice(0, 12), files };
}

/** Builds once per process; a failed build is retried on the next call. */
export function once<T>(build: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= build();
    pending.catch(() => {
      pending = undefined;
    });
    return pending;
  };
}

/** Serves a bundle immutably at `/app/<hash>/…`; a stale hash is a 404. */
export function createBundleRoutes(bundle: AppBundle) {
  return new Hono().get("/app/:hash/*", (c) => {
    const hash = c.req.param("hash");
    if (hash !== bundle.hash) return serve(undefined);
    return serve(bundle.files.get(decodeURIComponent(c.req.path.slice(`/app/${hash}/`.length))));
  });
}
