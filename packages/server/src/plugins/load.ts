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
import { bundleViewer, importDefinition, type ModuleFiles } from "./bundle.ts";

export type Log = (message: string) => void;

/** A plugin as loaded: its catalog entry, and its code when it is usable. */
export interface PluginModule {
  plugin: LoadedPlugin;
  definition?: PluginDefinitionShape;
  /** The bundled viewer module, served at `/plugins/<id>/<version>/`. */
  viewer?: ModuleFiles;
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
  storbild: z.object({ viewer: z.string().optional() }).optional(),
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

/** Checks that a schema can drive a generated admin form. */
function checkJsonSchema(schema: z.ZodType, what: string) {
  try {
    z.toJSONSchema(schema, { io: "input" });
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
  let viewer: ModuleFiles | undefined;
  try {
    if (def.settings) checkJsonSchema(def.settings, "settings");
    for (const [name, type] of Object.entries(def.types)) {
      checkJsonSchema(type.config, `config of type ${name}`);
      const { configVersion, migrate, duration, ...info } = type;
      types[name] = {
        ...info,
        configVersion: configVersion ?? 1,
        ...(migrate && { migrate: migrate as Migrate }),
        ...(duration && { duration: duration as Duration }),
      };
    }
    if (pkg.storbild?.viewer) viewer = await bundleViewer(join(dir, pkg.storbild.viewer));
  } catch (error) {
    return failed("error", errorMessage(error));
  }

  return {
    plugin: {
      id,
      version,
      status: "ok",
      ...(viewer && { module: `/plugins/${id}/${version}/viewer.js` }),
      ...(def.settings && { settings: def.settings }),
      types,
    },
    definition: def,
    ...(viewer && { viewer }),
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
