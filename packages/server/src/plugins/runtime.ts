import type { Instance, JsonValue, PluginDefinitionShape } from "@storbild/core";
import type {
  Logger,
  RouteHandler,
  JsonValue as SdkJson,
  ServerContext,
} from "@storbild/plugin-sdk";
import type { z } from "zod";
import type { StateHub } from "../state-hub.ts";
import type { PluginModule } from "./load.ts";

export interface RestartOptions {
  /** Delay before the first restart of a failed server part; doubles on every failure. */
  baseMs?: number;
  maxMs?: number;
}

interface Running {
  id: string;
  definition: PluginDefinitionShape;
  /** Present while the server part runs (or, without a server part, while settings are valid). */
  controller?: AbortController | undefined;
  settingsListeners: Set<(settings: unknown) => void>;
  instancesListeners: Set<() => void>;
  route?: RouteHandler;
  failures: number;
  restart?: ReturnType<typeof setTimeout>;
  /** JSON of the last settings and instances seen, to detect changes. */
  lastSettings?: string;
  lastInstances?: string;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Runs plugins' server parts in-process, isolated from each other and from the host: a part
 * that throws is reported as `status: "error"` and restarted with backoff, and never takes
 * the show down. It also reports invalid settings, and tells parts about relevant changes.
 */
export class PluginRuntime {
  readonly #hub: StateHub;
  readonly #plugins = new Map<string, Running>();
  readonly #baseMs: number;
  readonly #maxMs: number;
  #unwatch?: () => void;
  #stopped = false;

  constructor(hub: StateHub, modules: Iterable<PluginModule>, restart: RestartOptions = {}) {
    this.#hub = hub;
    this.#baseMs = restart.baseMs ?? 1_000;
    this.#maxMs = restart.maxMs ?? 60_000;
    for (const { plugin, definition } of modules) {
      if (plugin.status !== "ok" || !definition) continue;
      this.#plugins.set(plugin.id, {
        id: plugin.id,
        definition,
        settingsListeners: new Set(),
        instancesListeners: new Set(),
        failures: 0,
      });
    }
  }

  start() {
    this.#unwatch = this.#hub.watch(() => this.#onChange());
    for (const plugin of this.#plugins.values()) {
      plugin.lastSettings = JSON.stringify(this.#settingsOf(plugin.id));
      plugin.lastInstances = JSON.stringify(this.#instancesOf(plugin.id));
      this.#check(plugin);
    }
  }

  stop() {
    this.#stopped = true;
    this.#unwatch?.();
    for (const plugin of this.#plugins.values()) {
      clearTimeout(plugin.restart);
      this.#halt(plugin);
    }
  }

  /** Passes a request to a plugin's route handler; undefined when it has none. */
  async handle(id: string, request: Request): Promise<Response | undefined> {
    const route = this.#plugins.get(id)?.route;
    if (!route) return undefined;
    try {
      return await route(request);
    } catch (error) {
      console.error(`[plugin ${id}] route failed`, error);
      return new Response("plugin route failed", { status: 500 });
    }
  }

  #settingsOf(id: string): JsonValue | undefined {
    return this.#hub.state.plugins[id]?.settings;
  }

  #instancesOf(id: string, type?: string) {
    return Object.values(this.#hub.state.instances)
      .filter(
        (i: Instance) => i.plugin === id && !i.error && (type === undefined || i.type === type),
      )
      .map(({ id, type, name, config, state }) => ({
        id,
        type,
        name,
        config,
        ...(state !== undefined && { state }),
      }));
  }

  #parseSettings(plugin: Running) {
    const schema = plugin.definition.settings;
    const settings = this.#settingsOf(plugin.id) ?? {};
    if (!schema) return { success: true as const, data: settings };
    try {
      return schema.safeParse(settings);
    } catch (error) {
      return { success: false as const, error: new Error(errorMessage(error)) };
    }
  }

  #setStatus(id: string, status: "ok" | "error", error?: string) {
    this.#hub.dispatchHost({
      type: "plugin.setStatus",
      payload: { plugin: id, status, ...(error !== undefined && { error }) },
    });
  }

  #onChange() {
    if (this.#stopped) return;
    for (const plugin of this.#plugins.values()) {
      const settings = JSON.stringify(this.#settingsOf(plugin.id));
      if (settings !== plugin.lastSettings) {
        plugin.lastSettings = settings;
        // A settings change is an operator action: retry a failed part right away.
        plugin.failures = 0;
        clearTimeout(plugin.restart);
        this.#check(plugin, true);
      }
      const instances = JSON.stringify(this.#instancesOf(plugin.id));
      if (instances !== plugin.lastInstances) {
        plugin.lastInstances = instances;
        if (plugin.controller) this.#notify(plugin, plugin.instancesListeners, undefined);
      }
    }
  }

  /** Starts the plugin if its settings are valid, or stops it and reports them if not. */
  #check(plugin: Running, settingsChanged = false) {
    const parsed = this.#parseSettings(plugin);
    if (!parsed.success) {
      this.#halt(plugin);
      this.#setStatus(plugin.id, "error", `invalid settings: ${errorMessage(parsed.error)}`);
      return;
    }
    if (!plugin.controller) {
      void this.#run(plugin);
    } else if (settingsChanged) {
      this.#notify(plugin, plugin.settingsListeners, parsed.data);
    }
  }

  #notify<T>(plugin: Running, listeners: Set<(value: T) => void>, value: T) {
    const signal = plugin.controller?.signal;
    for (const listener of listeners) {
      try {
        listener(value);
      } catch (error) {
        if (signal) this.#fail(plugin, signal, error);
        return;
      }
    }
  }

  async #run(plugin: Running) {
    const controller = new AbortController();
    plugin.controller = controller;
    this.#setStatus(plugin.id, "ok");
    const server = plugin.definition.server as
      | ((ctx: ServerContext<z.ZodType, Record<string, z.ZodType>>) => unknown)
      | undefined;
    if (!server) return;
    try {
      await server(this.#context(plugin, controller.signal));
    } catch (error) {
      this.#fail(plugin, controller.signal, error);
    }
  }

  #halt(plugin: Running) {
    plugin.controller?.abort();
    plugin.controller = undefined;
    plugin.settingsListeners.clear();
    plugin.instancesListeners.clear();
    delete plugin.route;
  }

  /** Stops a failed run and schedules a restart, unless that run was already stopped. */
  #fail(plugin: Running, signal: AbortSignal, error: unknown) {
    if (signal.aborted || this.#stopped) return;
    console.error(`[plugin ${plugin.id}] server part failed`, error);
    this.#halt(plugin);
    this.#setStatus(plugin.id, "error", `server part failed: ${errorMessage(error)}`);
    const delay = Math.min(this.#baseMs * 2 ** plugin.failures, this.#maxMs);
    plugin.failures++;
    plugin.restart = setTimeout(() => {
      if (!this.#stopped) this.#check(plugin);
    }, delay);
  }

  #context(
    plugin: Running,
    signal: AbortSignal,
  ): ServerContext<z.ZodType, Record<string, z.ZodType>> {
    const { id } = plugin;
    const live = () => !signal.aborted;
    const prefix = `[plugin ${id}]`;
    const log: Logger = {
      info: (...args) => console.info(prefix, ...args),
      warn: (...args) => console.warn(prefix, ...args),
      error: (...args) => console.error(prefix, ...args),
    };
    return {
      settings: () => {
        const parsed = this.#parseSettings(plugin);
        if (!parsed.success) throw new Error(`invalid settings: ${errorMessage(parsed.error)}`);
        return parsed.data;
      },
      onSettingsChange: (listener) => {
        if (live()) plugin.settingsListeners.add(listener);
      },
      instances: (type) => this.#instancesOf(id, type) as never,
      onInstancesChange: (listener) => {
        if (live()) plugin.instancesListeners.add(listener);
      },
      setPluginState: (state: SdkJson) => {
        if (!live()) return log.warn("setPluginState after the server part was stopped");
        this.#hub.dispatchHost({ type: "plugin.setState", payload: { plugin: id, state } });
      },
      setInstanceState: (instanceId: string, state: SdkJson) => {
        if (!live()) return log.warn("setInstanceState after the server part was stopped");
        if (this.#hub.state.instances[instanceId]?.plugin !== id) {
          throw new Error(`instance ${instanceId} does not belong to plugin ${id}`);
        }
        this.#hub.dispatchHost({ type: "instance.setState", payload: { id: instanceId, state } });
      },
      route: (handler) => {
        if (live()) plugin.route = handler;
      },
      log,
      signal,
    };
  }
}
