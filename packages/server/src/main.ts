import { join } from "node:path";
import type { Config } from "@storbild/core";
import { ConfigError, createInitialState, reconcilePlugins } from "@storbild/core";
import { createAdminApp } from "./admin-app.ts";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db.ts";
import {
  builtinPluginsDir,
  loadAllPlugins,
  type ModuleRegistry,
  PluginRuntime,
  type RestartOptions,
} from "./plugins/index.ts";
import { Scheduler, type SchedulerTimers } from "./scheduler.ts";
import type { StreamOptions } from "./sse.ts";
import { StateHub } from "./state-hub.ts";
import { loadState, saveState } from "./store.ts";
import { createViewerApp } from "./viewer-app.ts";
import { getViewerBundle } from "./viewer-page.ts";

export interface Storbild {
  viewer: Bun.Server<undefined>;
  admin: Bun.Server<undefined>;
  hub: StateHub;
  scheduler: Scheduler;
  plugins: PluginRuntime;
  modules: ModuleRegistry;
  stop(): Promise<void>;
}

export interface StartOptions {
  now?: () => number;
  newId?: () => string;
  /** Patches kept for `Last-Event-ID` resume. */
  bufferSize?: number;
  stream?: StreamOptions;
  /** The built-in plugin directory; `null` loads none. Defaults to the repository's plugins/. */
  builtinPluginsDir?: string | null;
  /** Backoff for restarting failed plugin server parts. */
  pluginRestart?: RestartOptions;
  /** Timers for the scheduler, to drive time in tests. */
  timers?: SchedulerTimers;
}

/**
 * Opens the database, restores the show, loads the plugins and starts the viewer and admin
 * apps in one process.
 */
export async function start(config: Config, options: StartOptions = {}): Promise<Storbild> {
  const { now = Date.now, newId = () => crypto.randomUUID(), bufferSize, stream } = options;

  const db = openDatabase(join(config.dataDir, "storbild.db"));
  let initial = loadState(db);
  if (!initial) {
    initial = createInitialState({ now: now(), newId });
    saveState(db, initial);
  }
  const { modules, catalog, registry } = await loadAllPlugins({
    builtinDir:
      options.builtinPluginsDir === undefined
        ? builtinPluginsDir
        : (options.builtinPluginsDir ?? undefined),
    paths: config.pluginPaths,
    dataDir: config.dataDir,
  });
  const hub = new StateHub({
    db,
    initial,
    now,
    newId,
    catalog,
    ...(bufferSize !== undefined && { bufferSize }),
  });
  // Plugin status, versions and module URLs may differ from the stored show. Applying them as
  // a new revision means viewers resuming at the stored revision receive the change.
  hub.update((state) => reconcilePlugins(state, catalog));
  const scheduler = new Scheduler(hub, { now, ...(options.timers && { timers: options.timers }) });
  scheduler.start();
  const viewerBundle = await getViewerBundle();
  const plugins = new PluginRuntime(hub, modules.values(), options.pluginRestart);
  plugins.start();

  // Bun closes connections idle for 10 s by default, which would cut SSE streams between
  // 15 s heartbeats.
  const idleTimeout = 60;
  const viewer = Bun.serve({
    hostname: config.host,
    port: config.viewer.port,
    idleTimeout,
    fetch: createViewerApp({
      hub,
      now,
      modules: registry,
      viewer: viewerBundle,
      ...(stream && { stream }),
    }).fetch,
  });
  const admin = Bun.serve({
    hostname: config.host,
    port: config.admin.port,
    idleTimeout,
    fetch: createAdminApp({ hub, modules: registry, plugins, ...(stream && { stream }) }).fetch,
  });
  return {
    viewer,
    admin,
    hub,
    scheduler,
    plugins,
    modules: registry,
    async stop() {
      scheduler.stop();
      plugins.stop();
      // Force-close open SSE streams; clients reconnect and resume.
      await Promise.all([viewer.stop(true), admin.stop(true)]);
      db.close();
    },
  };
}

if (import.meta.main) {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(error.message);
    process.exit(1);
  }

  // Plugin code runs in-process. A stray error from a plugin's timer or callback is logged
  // instead of crashing the show.
  process.on("uncaughtException", (error) => console.error("uncaught exception", error));
  process.on("unhandledRejection", (error) => console.error("unhandled rejection", error));

  const storbild = await start(config);
  console.log(`viewer listening on ${storbild.viewer.url}`);
  console.log(`admin listening on ${storbild.admin.url}`);

  const shutdown = async () => {
    await storbild.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
