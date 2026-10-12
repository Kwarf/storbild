import { z } from "zod";

const port = z.coerce.number().int().min(0).max(65535);

const envSchema = z
  .object({
    STORBILD_HOST: z.string().min(1).default("127.0.0.1"),
    STORBILD_VIEWER_PORT: port.default(3000),
    STORBILD_ADMIN_PORT: port.default(3001),
    STORBILD_DATA_DIR: z.string().min(1).default("./data"),
    STORBILD_ADMIN_USERNAME: z.string().min(1).default("admin"),
    STORBILD_ADMIN_PASSWORD_HASH: z
      .string({ error: "is required; generate one with `bun run hash-password`" })
      .startsWith("$argon2id$", "must be an argon2id hash ($argon2id$...)"),
    STORBILD_PLUGIN_PATHS: z.string().default(""),
    STORBILD_MAX_UPLOAD_MB: z.coerce.number().positive().max(1024).default(25),
    STORBILD_MAX_VIDEO_UPLOAD_MB: z.coerce.number().positive().max(4096).default(200),
    STORBILD_MAX_IMPORT_MB: z.coerce.number().positive().max(65536).default(4096),
    STORBILD_VIEWER_URL: z.url().default("http://localhost:3000"),
    STORBILD_ADMIN_URL: z.url().default("http://localhost:3001"),
  })
  .refine(
    (env) => env.STORBILD_VIEWER_PORT === 0 || env.STORBILD_VIEWER_PORT !== env.STORBILD_ADMIN_PORT,
    {
      message: "viewer and admin ports must differ",
      path: ["STORBILD_ADMIN_PORT"],
    },
  );

export interface Config {
  host: string;
  viewer: { port: number; publicUrl: string };
  admin: { port: number; publicUrl: string; username: string; passwordHash: string };
  dataDir: string;
  pluginPaths: string[];
  /** The largest asset upload, in bytes. */
  maxUploadBytes: number;
  /** The largest video upload, in bytes. */
  maxVideoUploadBytes: number;
  /** The largest show file that can be imported, in bytes (ADR 0019). */
  maxImportBytes: number;
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/**
 * Parses Storbild configuration from an environment record. Pure: the caller passes the
 * environment and the platform's path-list delimiter.
 */
export function parseConfig(env: Record<string, string | undefined>, pathDelimiter = ":"): Config {
  // Treat empty strings as unset so `FOO=` in a .env file falls back to the default.
  const defined = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const result = envSchema.safeParse(defined);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  const e = result.data;
  return {
    host: e.STORBILD_HOST,
    viewer: { port: e.STORBILD_VIEWER_PORT, publicUrl: e.STORBILD_VIEWER_URL },
    admin: {
      port: e.STORBILD_ADMIN_PORT,
      publicUrl: e.STORBILD_ADMIN_URL,
      username: e.STORBILD_ADMIN_USERNAME,
      passwordHash: e.STORBILD_ADMIN_PASSWORD_HASH,
    },
    dataDir: e.STORBILD_DATA_DIR,
    pluginPaths: e.STORBILD_PLUGIN_PATHS.split(pathDelimiter)
      .map((p) => p.trim())
      .filter((p) => p !== ""),
    maxUploadBytes: Math.floor(e.STORBILD_MAX_UPLOAD_MB * 1024 * 1024),
    maxVideoUploadBytes: Math.floor(e.STORBILD_MAX_VIDEO_UPLOAD_MB * 1024 * 1024),
    maxImportBytes: Math.floor(e.STORBILD_MAX_IMPORT_MB * 1024 * 1024),
  };
}
