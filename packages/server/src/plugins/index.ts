import { join } from "node:path";
import type { PluginCatalog } from "@storbild/core";
import { getVendor } from "./bundle.ts";
import { discoverPlugins, type Log, loadPlugins, type PluginModule } from "./load.ts";
import { createModuleRegistry, type ModuleRegistry } from "./routes.ts";

export { builtinPluginsDir } from "./load.ts";
export { createModuleRoutes, type ModuleRegistry } from "./routes.ts";
export { PluginRuntime, type RestartOptions } from "./runtime.ts";

export interface LoadedPlugins {
  modules: Map<string, PluginModule>;
  catalog: PluginCatalog;
  registry: ModuleRegistry;
}

/** Discovers, loads and bundles all plugins. Broken plugins are reported in the catalog. */
export async function loadAllPlugins(options: {
  builtinDir: string | undefined;
  paths: string[];
  dataDir: string;
  log?: Log;
}): Promise<LoadedPlugins> {
  const dirs = discoverPlugins(options.builtinDir, options.paths);
  const modules = await loadPlugins(dirs, join(options.dataDir, "cache", "plugins"), options.log);
  const catalog = Object.fromEntries([...modules].map(([id, { plugin }]) => [id, plugin]));
  const registry = createModuleRegistry(await getVendor(), modules.values());
  return { modules, catalog, registry };
}
