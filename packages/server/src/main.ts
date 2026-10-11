import { join } from "node:path";
import type { Config } from "@storbild/core";
import { ConfigError, createInitialState } from "@storbild/core";
import { createAdminApp } from "./admin-app.ts";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db.ts";
import type { StreamOptions } from "./sse.ts";
import { StateHub } from "./state-hub.ts";
import { loadState, saveState } from "./store.ts";
import { createViewerApp } from "./viewer-app.ts";

export interface Storbild {
  viewer: Bun.Server<undefined>;
  admin: Bun.Server<undefined>;
  hub: StateHub;
  stop(): Promise<void>;
}

export interface StartOptions {
  now?: () => number;
  newId?: () => string;
  /** Patches kept for `Last-Event-ID` resume. */
  bufferSize?: number;
  stream?: StreamOptions;
}

/** Opens the database, restores the show and starts the viewer and admin apps in one process. */
export function start(config: Config, options: StartOptions = {}): Storbild {
  const { now = Date.now, newId = () => crypto.randomUUID(), bufferSize, stream } = options;

  const db = openDatabase(join(config.dataDir, "storbild.db"));
  let initial = loadState(db);
  if (!initial) {
    initial = createInitialState({ now: now(), newId });
    saveState(db, initial);
  }
  const hub = new StateHub({
    db,
    initial,
    now,
    newId,
    ...(bufferSize !== undefined && { bufferSize }),
  });

  // Bun closes connections idle for 10 s by default, which would cut SSE streams between
  // 15 s heartbeats.
  const idleTimeout = 60;
  const viewer = Bun.serve({
    hostname: config.host,
    port: config.viewer.port,
    idleTimeout,
    fetch: createViewerApp({ hub, now, ...(stream && { stream }) }).fetch,
  });
  const admin = Bun.serve({
    hostname: config.host,
    port: config.admin.port,
    idleTimeout,
    fetch: createAdminApp({ hub, ...(stream && { stream }) }).fetch,
  });
  return {
    viewer,
    admin,
    hub,
    async stop() {
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

  const storbild = start(config);
  console.log(`viewer listening on ${storbild.viewer.url}`);
  console.log(`admin listening on ${storbild.admin.url}`);

  const shutdown = async () => {
    await storbild.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
