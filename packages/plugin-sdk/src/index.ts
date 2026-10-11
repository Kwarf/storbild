// The public plugin SDK (DESIGN.md §6). Keep this surface small: it is a public API, and
// breaking changes bump API_VERSION and the SDK major version.
import type { JsonValue, OverlaySlot } from "@storbild/core";
import type { z } from "zod";

export { API_VERSION, type JsonValue, type OverlaySlot } from "@storbild/core";
export { z } from "zod";

/** One instance type a plugin contributes: a full-screen scene or an overlay widget. */
export interface InstanceTypeDefinition<Config extends z.ZodType, Settings extends z.ZodType> {
  kind: "scene" | "overlay";
  /** Shown in the admin. */
  label: string;
  /** Validates each instance's config. Must be representable as JSON Schema. */
  config: Config;
  /** The current config version, 1 by default. Bump it when `config` changes incompatibly. */
  configVersion?: number;
  /** Upgrades a stored config from an older `configVersion` to the current one. */
  migrate?: (fromVersion: number, config: unknown) => unknown;
  /** How long an instance runs in the rotation, in ms. Evaluated on the server. */
  duration?: (config: z.output<Config>, settings: z.output<Settings>) => number;
  /** The custom element that renders an instance in the viewer. */
  viewer: string;
  /** An optional custom admin editor element. */
  editor?: string;
  /** `own` hides or dims the theme background while the scene is live. Default `theme`. */
  background?: "theme" | "own";
  /** Overlay slots whose widgets fade out while this scene is live. */
  reserveSlots?: OverlaySlot[];
  /** Fades out all overlay widgets while this scene is live. */
  hideOverlays?: boolean;
  /** At most one instance of this type may exist. */
  singleton?: boolean;
}

type ConfigSchemas = Record<string, z.ZodType>;

/** An instance of one of the plugin's types, as its server part sees it. */
export type PluginInstance<
  Configs extends ConfigSchemas,
  Type extends keyof Configs = keyof Configs,
> = {
  [K in Type]: {
    id: string;
    type: K;
    name: string;
    config: z.output<Configs[K]>;
    state?: JsonValue;
  };
}[Type];

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** A handler for the plugin's admin-side HTTP routes. */
export type RouteHandler = (request: Request) => Response | Promise<Response>;

/** What a plugin's server part gets from the host. */
export interface ServerContext<Settings extends z.ZodType, Configs extends ConfigSchemas> {
  /** The current, validated settings. */
  settings(): z.output<Settings>;
  onSettingsChange(listener: (settings: z.output<Settings>) => void): void;
  /** The plugin's instances that are not broken, optionally of one type. */
  instances<Type extends keyof Configs & string>(type?: Type): PluginInstance<Configs, Type>[];
  /** Called when any of the plugin's instances is created, changed or deleted. */
  onInstancesChange(listener: () => void): void;
  /** Replaces the plugin's runtime state, which viewers receive as a patch. */
  setPluginState(state: JsonValue): void;
  /** Replaces the runtime state of one of the plugin's instances. */
  setInstanceState(instanceId: string, state: JsonValue): void;
  /**
   * Handles requests to `/api/plugins/<id>/*` on the admin app. The request URL's path is
   * relative to that prefix.
   */
  route(handler: RouteHandler): void;
  log: Logger;
  /** Aborted when the server part is stopped or restarted. Listeners are removed then too. */
  signal: AbortSignal;
}

export interface PluginDefinition<Settings extends z.ZodType, Configs extends ConfigSchemas> {
  /** Lowercase letters, digits and hyphens. */
  id: string;
  /** Semver. Modules are served under it, so bump it on every release. */
  version: string;
  /** The SDK API version the plugin was written for; use `API_VERSION`. */
  apiVersion: string;
  settings?: Settings;
  types: { [K in keyof Configs]: InstanceTypeDefinition<Configs[K], Settings> };
  /** Runs in the host process when the plugin loads. Restarted with backoff if it fails. */
  server?: (ctx: ServerContext<Settings, Configs>) => void | Promise<void>;
}

/** Declares a plugin. Types for settings and each instance type's config are inferred. */
export function definePlugin<
  // biome-ignore lint/complexity/noBannedTypes: a plugin without settings has `{}`.
  Settings extends z.ZodType = z.ZodObject<{}>,
  Configs extends ConfigSchemas = ConfigSchemas,
>(definition: PluginDefinition<Settings, Configs>): PluginDefinition<Settings, Configs> {
  return definition;
}

// biome-ignore lint/suspicious/noExplicitAny: matches any plugin definition.
type AnyPlugin = PluginDefinition<any, any>;

/** The parsed settings of a plugin: `PluginSettings<typeof plugin>`. */
export type PluginSettings<P extends AnyPlugin> =
  P extends PluginDefinition<infer S, ConfigSchemas> ? z.output<S> : never;

/** The parsed config of one of a plugin's types: `PluginConfig<typeof plugin, "text">`. */
export type PluginConfig<P extends AnyPlugin, Type extends keyof P["types"]> =
  P extends PluginDefinition<z.ZodType, infer C>
    ? Type extends keyof C
      ? z.output<C[Type]>
      : never
    : never;
