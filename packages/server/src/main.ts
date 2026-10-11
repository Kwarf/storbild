import type { Config } from "@storbild/core";
import { ConfigError } from "@storbild/core";
import { createAdminApp } from "./admin-app.ts";
import { loadConfig } from "./config.ts";
import { createViewerApp } from "./viewer-app.ts";

export interface Storbild {
  viewer: Bun.Server<undefined>;
  admin: Bun.Server<undefined>;
  stop(): Promise<void>;
}

/** Starts the viewer and admin apps as two servers in one process. */
export function start(config: Config): Storbild {
  const viewer = Bun.serve({
    hostname: config.host,
    port: config.viewer.port,
    fetch: createViewerApp().fetch,
  });
  const admin = Bun.serve({
    hostname: config.host,
    port: config.admin.port,
    fetch: createAdminApp().fetch,
  });
  return {
    viewer,
    admin,
    async stop() {
      await Promise.all([viewer.stop(), admin.stop()]);
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
