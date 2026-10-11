import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  API_VERSION,
  type Duration,
  type LoadedPlugin,
  type LoadedType,
  type Migrate,
  type PluginDefinitionShape,
  pluginDefinitionSchema,
} from "@storbild/core";
import { z } from "zod";
import { bundleBrowser, importDefinition, type ModuleFiles } from "./bundle.ts";

export type Log = (message: string) => void;

/** A JSON Schema document, as `z.toJSONSchema` makes it. */
export type JsonSchema = Record<string, unknown>;

/** The JSON Schemas that drive a plugin's admin forms (ADR 0010). */
export interface PluginSchemas {
  settings?: JsonSchema;
  types: Record<string, JsonSchema>;
}

/** A plugin as loaded: its catalog entry, and its code when it is usable. */
export interface PluginModule {
  plugin: LoadedPlugin;
  definition?: PluginDefinitionShape;
  /** The bundled browser modules (`viewer.js`, `admin.js`), served at `/plugins/<id>/<version>/`. */
  files?: ModuleFiles;
  schemas?: PluginSchemas;
}

/**
 * Plugin directories: every directory with a package.json in `builtinDir`, then each of
 * `paths` (each a plugin directory itself).
 */
export function discoverPlugins(builtinDir: string | undefined, paths: string[]): string[] {
  const dirs: string[] = [];
  if (builtinDir && existsSync(builtinDir)) {
    for (const entry of readdirSync(builtinDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const dir = join(builtinDir, entry.name);
      if (entry.isDirectory() && existsSync(join(dir, "package.json"))) dirs.push(dir);
    }
  }
  return [...dirs, ...paths.map((path) => resolve(path))];
}

const packageSchema = z.object({
  version: z.string().optional(),
  main: z.string().optional(),
  exports: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  storbild: z.object({ viewer: z.string().optional(), admin: z.string().optional() }).optional(),
});

/** The package's `exports["."]` (string, or `import`/`default` condition), or `main`. */
function definitionEntry(pkg: z.infer<typeof packageSchema>): string | undefined {
  const pick = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (typeof value !== "object" || value === null) return undefined;
    const conditions = value as Record<string, unknown>;
    return pick(conditions.bun ?? conditions.import ?? conditions.default);
  };
  const exports = pkg.exports;
  const root = typeof exports === "string" || exports === undefined ? exports : exports["."];
  return pick(root) ?? pkg.main;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Converts a schema for the admin's generated forms; one that can't convert is an error. */
function toJsonSchema(schema: z.ZodType, what: string): JsonSchema {
  try {
    return z.toJSONSchema(schema, { io: "input" }) as JsonSchema;
  } catch (error) {
    throw new Error(`${what} cannot be converted to JSON Schema: ${errorMessage(error)}`);
  }
}

/**
 * Loads one plugin directory. Never throws: a plugin that cannot be loaded comes back with
 * status `incompatible` or `error`, keyed by its declared ID or else the directory name.
 */
export async function loadPlugin(
  dir: string,
  cacheDir: string,
  log: Log = console.warn,
): Promise<PluginModule> {
  let id = basename(dir);
  let version: string | undefined;
  const failed = (status: "incompatible" | "error", error: string): PluginModule => ({
    plugin: { id, status, error, ...(version !== undefined && { version }) },
  });

  let pkg: z.infer<typeof packageSchema>;
  let definition: unknown;
  try {
    pkg = packageSchema.parse(await Bun.file(join(dir, "package.json")).json());
    const entry = definitionEntry(pkg);
    if (!entry) throw new Error('package.json has no exports["."] or main');
    definition = await importDefinition(join(dir, entry), join(cacheDir, id));
  } catch (error) {
    return failed("error", `cannot load ${dir}: ${errorMessage(error)}`);
  }

  // Read the identity first, so even an invalid plugin is reported under its own ID.
  const declared = (typeof definition === "object" && definition) || {};
  if ("id" in declared && typeof declared.id === "string" && declared.id) id = declared.id;
  if ("version" in declared && typeof declared.version === "string") version = declared.version;
  const apiVersion = "apiVersion" in declared ? declared.apiVersion : undefined;
  if (apiVersion !== API_VERSION) {
    return failed(
      "incompatible",
      `plugin API version ${String(apiVersion)} is not supported (host: ${API_VERSION})`,
    );
  }

  const parsed = pluginDefinitionSchema.safeParse(definition);
  if (!parsed.success) {
    return failed("error", `invalid plugin definition: ${z.prettifyError(parsed.error)}`);
  }
  const def = parsed.data;
  id = def.id;
  version = def.version;
  if (pkg.version !== undefined && pkg.version !== def.version) {
    log(`plugin ${id}: package.json version ${pkg.version} differs from ${def.version}`);
  }

  const types: Record<string, LoadedType> = {};
  const schemas: PluginSchemas = { types: {} };
  const files: ModuleFiles = new Map();
  try {
    if (def.settings) schemas.settings = toJsonSchema(def.settings, "settings");
    for (const [name, type] of Object.entries(def.types)) {
      schemas.types[name] = toJsonSchema(type.config, `config of type ${name}`);
      const { configVersion, migrate, duration, ...info } = type;
      types[name] = {
        ...info,
        configVersion: configVersion ?? 1,
        ...(migrate && { migrate: migrate as Migrate }),
        ...(duration && { duration: duration as Duration }),
      };
    }
    for (const name of ["viewer", "admin"] as const) {
      const entry = pkg.storbild?.[name];
      if (!entry) continue;
      for (const [path, file] of await bundleBrowser(join(dir, entry), name)) files.set(path, file);
    }
  } catch (error) {
    return failed("error", errorMessage(error));
  }

  const url = (name: string) =>
    files.has(`${name}.js`) ? `/plugins/${id}/${version}/${name}.js` : undefined;
  const module = url("viewer");
  const adminModule = url("admin");
  return {
    plugin: {
      id,
      version,
      status: "ok",
      ...(module && { module }),
      ...(adminModule && { adminModule }),
      ...(def.settings && { settings: def.settings }),
      types,
    },
    definition: def,
    schemas,
    ...(files.size > 0 && { files }),
  };
}

/** Loads every plugin directory in order. The first plugin with a given ID wins. */
export async function loadPlugins(
  dirs: string[],
  cacheDir: string,
  log: Log = console.warn,
): Promise<Map<string, PluginModule>> {
  const plugins = new Map<string, PluginModule>();
  for (const dir of dirs) {
    const loaded = await loadPlugin(dir, cacheDir, log);
    const { id, status, error } = loaded.plugin;
    if (plugins.has(id)) {
      log(`plugin ${id} in ${dir} ignored: another plugin with that ID is already loaded`);
      continue;
    }
    if (status !== "ok") log(`plugin ${id} (${dir}) is ${status}: ${error}`);
    plugins.set(id, loaded);
  }
  return plugins;
}

/** The directory of the repository's built-in plugins. */
export const builtinPluginsDir = join(import.meta.dir, "../../../../plugins");
