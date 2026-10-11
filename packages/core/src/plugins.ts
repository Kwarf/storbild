import { z } from "zod";
import { type JsonValue, jsonSchema } from "./schema/common.ts";
import type { Instance } from "./schema/instance.ts";
import type {
  LoadedPlugin,
  LoadedType,
  PluginCatalog,
  PluginEntry,
  PluginTypeInfo,
} from "./schema/plugin.ts";
import type { ShowState } from "./schema/state.ts";

/** A validation problem, in a shape that survives JSON. */
export interface Issue {
  path: (string | number)[];
  message: string;
}

export type Normalized<T> =
  | { ok: true; value: T }
  | { ok: false; code: "not_found" | "invalid"; message: string; issues?: Issue[] };

function fail(code: "not_found" | "invalid", message: string, issues?: Issue[]): Normalized<never> {
  return { ok: false, code, message, ...(issues && { issues }) };
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Parses `value` with a plugin-provided schema. Plugin refinements are plugin code, so a throw
 * is a validation failure, not a crash. The output must be JSON, because it goes into state.
 */
function parseWith(schema: z.ZodType, value: unknown, what: string): Normalized<JsonValue> {
  let result: ReturnType<z.ZodType["safeParse"]>;
  try {
    result = schema.safeParse(value);
  } catch (error) {
    return fail("invalid", `${what} validation threw: ${errorMessage(error)}`);
  }
  if (!result.success) {
    return fail(
      "invalid",
      `invalid ${what}: ${z.prettifyError(result.error)}`,
      result.error.issues.map((issue) => ({
        path: issue.path.map((key) => (typeof key === "symbol" ? String(key) : key)),
        message: issue.message,
      })),
    );
  }
  const json = jsonSchema.safeParse(result.data);
  if (!json.success) return fail("invalid", `${what} schema produced a non-JSON value`);
  return { ok: true, value: json.data };
}

function usableTypes(plugin: LoadedPlugin): Normalized<Record<string, LoadedType>> {
  if (plugin.types) return { ok: true, value: plugin.types };
  const reason = plugin.error ? `: ${plugin.error}` : "";
  return fail("invalid", `plugin ${plugin.id} is unavailable (${plugin.status})${reason}`);
}

/**
 * Migrates `config` from `fromVersion` (default: the type's current version) and validates it
 * against the instance type's schema. Returns the parsed config, with defaults applied.
 */
export function normalizeConfig(
  catalog: PluginCatalog,
  pluginId: string,
  typeName: string,
  config: unknown,
  fromVersion?: number,
): Normalized<{ config: JsonValue; configVersion: number }> {
  const plugin = catalog[pluginId];
  if (!plugin) return fail("not_found", `plugin ${pluginId} is not installed`);
  const types = usableTypes(plugin);
  if (!types.ok) return types;
  const type = types.value[typeName];
  if (!type) return fail("not_found", `plugin ${pluginId} has no type ${typeName}`);

  const version = fromVersion ?? type.configVersion;
  let migrated = config;
  if (version > type.configVersion) {
    return fail(
      "invalid",
      `config version ${version} is newer than ${pluginId}/${typeName} supports (${type.configVersion})`,
    );
  }
  if (version < type.configVersion) {
    if (!type.migrate) {
      return fail("invalid", `${pluginId}/${typeName} cannot migrate config version ${version}`);
    }
    try {
      migrated = type.migrate(version, config);
    } catch (error) {
      return fail(
        "invalid",
        `migrating config from version ${version} failed: ${errorMessage(error)}`,
      );
    }
  }
  const parsed = parseWith(type.config, migrated, "config");
  if (!parsed.ok) return parsed;
  return { ok: true, value: { config: parsed.value, configVersion: type.configVersion } };
}

/** Validates plugin settings against the plugin's settings schema, applying defaults. */
export function normalizeSettings(
  catalog: PluginCatalog,
  pluginId: string,
  settings: unknown,
): Normalized<JsonValue> {
  const plugin = catalog[pluginId];
  if (!plugin) return fail("not_found", `plugin ${pluginId} is not installed`);
  const types = usableTypes(plugin);
  if (!types.ok) return types;
  return plugin.settings
    ? parseWith(plugin.settings, settings, "settings")
    : { ok: true, value: {} };
}

/** Re-validates an instance against the catalog: migrates its config, or marks it broken. */
export function reconcileInstance(catalog: PluginCatalog, instance: Instance): Instance {
  const { error: _, ...rest } = instance;
  const result = normalizeConfig(
    catalog,
    instance.plugin,
    instance.type,
    instance.config,
    instance.configVersion,
  );
  return result.ok ? { ...rest, ...result.value } : { ...rest, error: result.message };
}

function typeInfo(type: LoadedType): PluginTypeInfo {
  const { config: _, configVersion: __, migrate: ___, duration: ____, ...info } = type;
  return info;
}

/**
 * Brings the state in line with the plugins the host loaded: plugin entries get their status,
 * version, module and types, settings get their defaults, and every instance is migrated or
 * marked broken. Plugins that are no longer installed keep their data with status `missing`.
 */
export function reconcilePlugins(state: ShowState, catalog: PluginCatalog): ShowState {
  const plugins: Record<string, PluginEntry> = {};
  for (const [id, entry] of Object.entries(state.plugins)) {
    if (!catalog[id]) {
      plugins[id] = { status: "missing", settings: entry.settings, state: entry.state, types: {} };
    }
  }
  for (const plugin of Object.values(catalog)) {
    const stored = state.plugins[plugin.id];
    const settings = stored?.settings ?? {};
    // Invalid settings are kept as they are; the plugin runtime reports them.
    const normalized = normalizeSettings(catalog, plugin.id, settings);
    plugins[plugin.id] = {
      status: plugin.status,
      ...(plugin.version !== undefined && { version: plugin.version }),
      ...(plugin.error !== undefined && { error: plugin.error }),
      ...(plugin.module !== undefined && { module: plugin.module }),
      settings: normalized.ok ? normalized.value : settings,
      state: stored?.state ?? null,
      types: Object.fromEntries(
        Object.entries(plugin.types ?? {}).map(([name, type]) => [name, typeInfo(type)]),
      ),
    };
  }
  const instances = Object.fromEntries(
    Object.entries(state.instances).map(([id, instance]) => [
      id,
      reconcileInstance(catalog, instance),
    ]),
  );
  return { ...state, plugins, instances };
}
