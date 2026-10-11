import { z } from "zod";
import { jsonSchema } from "./common.ts";
import { overlaySlotSchema } from "./overlay.ts";

/** The plugin API version this host implements. Plugins declaring another one are incompatible. */
export const API_VERSION = "1";

export const pluginIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase letters, digits and hyphens");

export const instanceKindSchema = z.enum(["scene", "overlay"]);
export type InstanceKind = z.infer<typeof instanceKindSchema>;

/** A custom element name: lowercase, starting with a letter, containing a hyphen. */
const elementNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9._]*-[a-z0-9._-]*$/, "must be a valid custom element name");

/** What the viewer and admin need to know about an instance type, without plugin code. */
export const pluginTypeInfoSchema = z.object({
  kind: instanceKindSchema,
  label: z.string().min(1),
  viewer: elementNameSchema,
  editor: elementNameSchema.optional(),
  background: z.enum(["theme", "own"]).optional(),
  reserveSlots: z.array(overlaySlotSchema).optional(),
  hideOverlays: z.boolean().optional(),
  singleton: z.boolean().optional(),
});
export type PluginTypeInfo = z.infer<typeof pluginTypeInfoSchema>;

/**
 * `missing` is a plugin whose settings are stored but which is no longer installed. `error`
 * covers both load failures and a failing server part or invalid settings at runtime.
 */
export const pluginStatusSchema = z.enum(["ok", "incompatible", "error", "missing"]);
export type PluginStatus = z.infer<typeof pluginStatusSchema>;

/**
 * A plugin's entry in the show state. Only `settings` and `state` are persisted; the rest is
 * computed by the plugin host on load.
 */
export const pluginEntrySchema = z.object({
  version: z.string().optional(),
  status: pluginStatusSchema,
  error: z.string().optional(),
  settings: jsonSchema,
  state: jsonSchema,
  /** URL of the plugin's browser module, which registers its custom elements. */
  module: z.string().optional(),
  types: z.record(z.string(), pluginTypeInfoSchema),
});
export type PluginEntry = z.infer<typeof pluginEntrySchema>;

const zodSchema = z.custom<z.ZodType>((value) => value instanceof z.ZodType, {
  message: "must be a Zod schema",
});
const fn = z.custom<(...args: never[]) => unknown>((value) => typeof value === "function", {
  message: "must be a function",
});

export type Migrate = (fromVersion: number, config: unknown) => unknown;
export type Duration = (config: unknown, settings: unknown) => unknown;

/**
 * The runtime shape of what `definePlugin` returns. The SDK adds the static types; the host
 * validates untrusted plugin modules against this before using them.
 */
export const pluginDefinitionSchema = z.object({
  id: pluginIdSchema,
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+].*)?$/, "must be a semver version"),
  apiVersion: z.string(),
  settings: zodSchema.optional(),
  types: z
    .record(
      z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase letters, digits and hyphens"),
      pluginTypeInfoSchema.extend({
        config: zodSchema,
        configVersion: z.number().int().positive().optional(),
        migrate: fn.optional(),
        duration: fn.optional(),
      }),
    )
    .refine((types) => Object.keys(types).length > 0, "must declare at least one type"),
  server: fn.optional(),
});
export type PluginDefinitionShape = z.infer<typeof pluginDefinitionSchema>;

export interface LoadedType extends PluginTypeInfo {
  config: z.ZodType;
  /** The current config version; stored configs with a lower one are migrated. */
  configVersion: number;
  migrate?: Migrate;
  /** Computes how long an instance runs from its config and the plugin settings. */
  duration?: Duration;
}

/** A plugin as the host loaded it. `types` is absent when the plugin is unusable. */
export interface LoadedPlugin {
  id: string;
  version?: string;
  status: Exclude<PluginStatus, "missing">;
  error?: string;
  module?: string;
  settings?: z.ZodType;
  types?: Record<string, LoadedType>;
}

/** Every plugin the host found, by ID. Passed to the reducer to validate plugin data. */
export type PluginCatalog = Readonly<Record<string, LoadedPlugin>>;
