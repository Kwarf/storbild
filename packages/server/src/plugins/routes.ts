import { Hono } from "hono";
import type { ModuleFile, ModuleFiles, Vendor } from "./bundle.ts";
import type { PluginModule } from "./load.ts";

/** Everything the browser loads for plugins: vendor modules, plugin modules, the import map. */
export interface ModuleRegistry {
  vendor: Vendor;
  /** Bundled viewer modules by plugin ID. */
  plugins: Map<string, { version: string; files: ModuleFiles }>;
  importMap: { imports: Record<string, string> };
}

export function createModuleRegistry(vendor: Vendor, modules: Iterable<PluginModule>) {
  const plugins: ModuleRegistry["plugins"] = new Map();
  for (const { plugin, viewer } of modules) {
    if (viewer && plugin.version)
      plugins.set(plugin.id, { version: plugin.version, files: viewer });
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

function serve(file: ModuleFile | undefined) {
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
 * Serves `/importmap.json`, `/vendor/<hash>/…` and `/plugins/<id>/<version>/…`. Versioned
 * paths are immutable; a stale hash or version is a 404, never another version's file.
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
    .get("/plugins/:id/:version/*", (c) => {
      const { id, version } = c.req.param();
      const plugin = plugins.get(id);
      if (!plugin || plugin.version !== version) return serve(undefined);
      return serve(plugin.files.get(rest(c.req.path, `/plugins/${id}/${version}/`)));
    });
}
