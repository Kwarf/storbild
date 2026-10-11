import { delimiter, resolve } from "node:path";
import { type Config, parseConfig } from "@storbild/core";

/** Loads config from the process environment (Bun reads .env automatically). */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const config = parseConfig(env, delimiter);
  return {
    ...config,
    dataDir: resolve(config.dataDir),
    pluginPaths: config.pluginPaths.map((p) => resolve(p)),
  };
}
