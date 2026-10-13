import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import { type PluginCatalog, reconcilePlugins } from "@storbild/core";
import type { StateHub } from "../state-hub.ts";
import { type Log, loadPlugin, type PluginModule, type PluginSchemas } from "./load.ts";
import { type ModuleRegistry, pluginFiles } from "./routes.ts";
import type { PluginRuntime } from "./runtime.ts";

export interface PluginReloaderOptions {
  hub: StateHub;
  runtime: PluginRuntime;
  /** The loaded plugins by ID, updated in place. */
  modules: Map<string, PluginModule>;
  /** Served modules, updated in place. */
  registry: ModuleRegistry;
  /** The schemas behind `/api/schemas`, updated in place. */
  schemas: Record<string, PluginSchemas>;
  dataDir: string;
  /** Called after every reload, for example to rebuild the service worker manifest. */
  onReload?: () => void;
  log?: Log;
}

/**
 * Reloads plugins from their directories (ADR 0025). A reload goes through the same loading
 * as at boot, so a broken edit is reported and never stops the show. Reloads run one at a time.
 */
export class PluginReloader {
  readonly #options: PluginReloaderOptions;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: PluginReloaderOptions) {
    this.#options = options;
  }

  /** Reloads the plugin in `dir`. Resolves once the change is in state. */
  reload(dir: string): Promise<void> {
    const next = this.#queue.then(() => this.#reload(dir));
    this.#queue = next.catch((error) => console.error(`reloading ${dir} failed`, error));
    return next;
  }

  async #reload(dir: string) {
    const { hub, runtime, modules, registry, schemas, dataDir, onReload } = this.#options;
    const log = this.#options.log ?? console.warn;
    const old = [...modules.values()].find((module) => module.dir === dir);
    const loaded = await loadPlugin(dir, join(dataDir, "cache", "plugins"), log);
    const { id, status, error } = loaded.plugin;
    const changed = new Set<string>([id]);

    if (old && old.plugin.id !== id) {
      log(`plugin in ${dir} changed its ID from ${old.plugin.id} to ${id}`);
      changed.add(old.plugin.id);
      modules.delete(old.plugin.id);
    }
    const owner = modules.get(id);
    if (owner && owner.dir !== dir) {
      log(`plugin ${id} in ${dir} ignored: another plugin with that ID is already loaded`);
      changed.delete(id);
    } else {
      modules.set(id, loaded);
      log(
        status === "ok" ? `plugin ${id} reloaded` : `plugin ${id} (${dir}) is ${status}: ${error}`,
      );
    }
    if (changed.size === 0) return;

    const catalog = catalogOf(modules);
    hub.setCatalog(catalog);
    hub.update((state) => reconcilePlugins(state, catalog, changed));
    for (const key of changed) {
      const module = modules.get(key);
      const files = module && pluginFiles(module);
      if (files) registry.plugins.set(key, files);
      else registry.plugins.delete(key);
      if (module?.schemas) schemas[key] = module.schemas;
      else delete schemas[key];
      runtime.replace(key, module);
    }
    onReload?.();
  }
}

/** The plugin catalog of the loaded modules. */
export const catalogOf = (modules: Map<string, PluginModule>): PluginCatalog =>
  Object.fromEntries([...modules].map(([id, { plugin }]) => [id, plugin]));

/** Whether a changed path inside a plugin directory should be ignored. */
export function ignoredPath(path: string): boolean {
  return path.split(/[\\/]/).some((part) => part === "node_modules" || part.startsWith("."));
}

/**
 * Watches each directory recursively and calls `onChange(dir)` once changes have stopped for
 * `debounceMs`. Returns a function that stops watching.
 */
export function watchPluginDirs(
  dirs: string[],
  onChange: (dir: string) => void,
  { debounceMs = 200, log = console.warn }: { debounceMs?: number; log?: Log } = {},
): () => void {
  const watchers: FSWatcher[] = [];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  for (const dir of dirs) {
    try {
      const watcher = watch(dir, { recursive: true }, (_event, file) => {
        if (file && ignoredPath(String(file))) return;
        clearTimeout(timers.get(dir));
        timers.set(
          dir,
          setTimeout(() => {
            timers.delete(dir);
            onChange(dir);
          }, debounceMs),
        );
      });
      watcher.on("error", (error) => log(`watching ${dir} failed: ${error.message}`));
      watchers.push(watcher);
    } catch (error) {
      log(`cannot watch ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return () => {
    for (const watcher of watchers) watcher.close();
    for (const timer of timers.values()) clearTimeout(timer);
  };
}
