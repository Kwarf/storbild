import { Hono } from "hono";
import type { ModuleFile, ModuleFiles, Vendor } from "./bundle.ts";
import type { PluginModule } from "./load.ts";

/** Everything the browser loads for plugins: vendor modules, plugin modules, the import map. */
export interface ModuleRegistry {
  vendor: Vendor;
  /** Bundled browser modules (viewer and admin) by plugin ID. Updated in place on reload. */
  plugins: Map<string, PluginFiles>;
  importMap: { imports: Record<string, string> };
}

/** A plugin's browser modules, served below `base`. */
export interface PluginFiles {
  version: string;
  hash: string;
  files: ModuleFiles;
}

/** A plugin's served files, if it has any. */
export function pluginFiles({ plugin, files, hash }: PluginModule): PluginFiles | undefined {
  return files && hash && plugin.version ? { version: plugin.version, hash, files } : undefined;
}

export function createModuleRegistry(vendor: Vendor, modules: Iterable<PluginModule>) {
  const plugins: ModuleRegistry["plugins"] = new Map();
  for (const module of modules) {
    const files = pluginFiles(module);
    if (files) plugins.set(module.plugin.id, files);
  }
  const imports = Object.fromEntries(
    Object.entries(vendor.specifiers).map(([specifier, path]) => [
      specifier,
      `/vendor/${vendor.hash}/${path}`,
    ]),
  );
  return { vendor, plugins, importMap: { imports } };
}

const immutable = "public, max-age=31536000, immutable";

/** Serves a built file as immutable, or a 404. */
export function serve(file: ModuleFile | undefined) {
  if (!file) return new Response("not found", { status: 404 });
  return new Response(file.body, {
    headers: {
      "Content-Type": file.type,
      "Cache-Control": immutable,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** The rest of the path after `prefix`, decoded. */
const rest = (path: string, prefix: string) => decodeURIComponent(path.slice(prefix.length));

/**
 * Serves `/importmap.json`, `/vendor/<hash>/…` and `/plugins/<id>/<version>/<hash>/…`.
 * Versioned paths are immutable; a stale hash or version is a 404, never another build's file.
 */
export function createModuleRoutes(registry: ModuleRegistry) {
  const { vendor, plugins, importMap } = registry;
  return new Hono()
    .get("/importmap.json", (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(importMap);
    })
    .get("/vendor/:hash/*", (c) => {
      const hash = c.req.param("hash");
      if (hash !== vendor.hash) return serve(undefined);
      return serve(vendor.files.get(rest(c.req.path, `/vendor/${hash}/`)));
    })
    .get("/plugins/:id/:version/:hash/*", (c) => {
      const { id, version, hash } = c.req.param();
      const plugin = plugins.get(id);
      if (!plugin || plugin.version !== version || plugin.hash !== hash) return serve(undefined);
      return serve(plugin.files.get(rest(c.req.path, `/plugins/${id}/${version}/${hash}/`)));
    });
}
