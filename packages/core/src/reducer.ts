import type { Command, HostCommand } from "./commands.ts";
import { endOverride, interrupt, take } from "./live-control.ts";
import { type Issue, type Normalized, normalizeConfig, normalizeSettings } from "./plugins.ts";
import type { Instance } from "./schema/instance.ts";
import type { PlaylistItem } from "./schema/playlist.ts";
import type { PluginCatalog, PluginEntry } from "./schema/plugin.ts";
import type { ShowState } from "./schema/state.ts";
import { isPlayableScene, resolveTimeline } from "./timeline.ts";

export interface CommandContext {
  /** Server time of the command, epoch ms. */
  now: number;
  newId: () => string;
  /** The loaded plugins, which validate settings and instance config. */
  catalog: PluginCatalog;
}

export interface CommandOutcome {
  state: ShowState;
  /** The ID of the entity a create command made. */
  id?: string;
}

export type CommandErrorCode = "not_found" | "invalid";

/** A well-formed command that cannot be applied to the current state. */
export class CommandError extends Error {
  constructor(
    readonly code: CommandErrorCode,
    message: string,
    readonly issues?: Issue[],
  ) {
    super(message);
    this.name = "CommandError";
  }
}

function unwrap<T>(result: Normalized<T>): T {
  if (!result.ok) throw new CommandError(result.code, result.message, result.issues);
  return result.value;
}

/**
 * Applies a validated command to the state and returns the next state with `revision` bumped.
 * Pure: time and IDs come from `ctx`, and the input state is never mutated.
 */
export function applyCommand(
  state: ShowState,
  command: Command | HostCommand,
  ctx: CommandContext,
): CommandOutcome {
  const outcome = reduce(state, command, ctx);
  return { ...outcome, state: { ...outcome.state, revision: state.revision + 1 } };
}

function reduce(
  state: ShowState,
  command: Command | HostCommand,
  ctx: CommandContext,
): CommandOutcome {
  switch (command.type) {
    case "instance.create": {
      const { config, configVersion, background, ...rest } = command.payload;
      const singleton = state.plugins[rest.plugin]?.types[rest.type]?.singleton;
      if (
        singleton &&
        Object.values(state.instances).some(
          (other) => other.plugin === rest.plugin && other.type === rest.type,
        )
      ) {
        throw new CommandError("invalid", `${rest.plugin}/${rest.type} allows only one instance`);
      }
      const instance: Instance = {
        id: ctx.newId(),
        ...rest,
        ...unwrap(normalizeConfig(ctx.catalog, rest.plugin, rest.type, config, configVersion)),
        ...(background !== undefined && { background }),
      };
      return {
        state: { ...state, instances: { ...state.instances, [instance.id]: instance } },
        id: instance.id,
      };
    }

    case "instance.update": {
      const { id, config, configVersion, ...changes } = command.payload;
      let instance = merge(getInstance(state, id), changes);
      if (config !== undefined || configVersion !== undefined) {
        // A new config without a version is in the type's current version.
        const { error: _, ...rest } = instance;
        instance = {
          ...rest,
          ...unwrap(
            normalizeConfig(
              ctx.catalog,
              instance.plugin,
              instance.type,
              config ?? instance.config,
              config !== undefined ? configVersion : (configVersion ?? instance.configVersion),
            ),
          ),
        };
      }
      return { state: { ...state, instances: { ...state.instances, [id]: instance } } };
    }

    case "instance.delete": {
      const { id } = command.payload;
      getInstance(state, id);
      return { state: withoutInstances(state, new Set([id])) };
    }

    case "playlist.addItem": {
      const { instanceId, enabled, index, ...windowAndDuration } = command.payload;
      getInstance(state, instanceId);
      const item = checkWindow(
        merge<PlaylistItem>(
          { id: ctx.newId(), instanceId, enabled: enabled ?? true },
          windowAndDuration,
        ),
      );
      const items = [...state.playlist.items];
      items.splice(index ?? items.length, 0, item);
      return { state: withItems(state, items), id: item.id };
    }

    case "playlist.updateItem": {
      const { id, ...changes } = command.payload;
      const index = getItemIndex(state, id);
      if (changes.instanceId !== undefined) getInstance(state, changes.instanceId);
      const items = [...state.playlist.items];
      items[index] = checkWindow(merge(items[index] as PlaylistItem, changes));
      return { state: withItems(state, items) };
    }

    case "playlist.removeItem": {
      const index = getItemIndex(state, command.payload.id);
      return { state: withItems(state, state.playlist.items.toSpliced(index, 1)) };
    }

    case "playlist.reorder": {
      const { itemIds } = command.payload;
      const byId = new Map(state.playlist.items.map((item) => [item.id, item]));
      const items = itemIds.flatMap((id) => {
        const item = byId.get(id);
        byId.delete(id);
        return item ? [item] : [];
      });
      if (items.length !== itemIds.length || byId.size > 0) {
        throw new CommandError("invalid", "itemIds must be a permutation of the playlist items");
      }
      return { state: withItems(state, items) };
    }

    case "plugin.updateSettings": {
      const { plugin, settings } = command.payload;
      const entry = getPlugin(state, plugin);
      const value = unwrap(normalizeSettings(ctx.catalog, plugin, settings));
      return { state: withPlugin(state, plugin, { ...entry, settings: value }) };
    }

    case "plugin.remove": {
      const { plugin } = command.payload;
      if (getPlugin(state, plugin).status !== "missing") {
        throw new CommandError(
          "invalid",
          `plugin ${plugin} is installed; only a missing plugin can be removed`,
        );
      }
      const ids = Object.values(state.instances)
        .filter((instance) => instance.plugin === plugin)
        .map((instance) => instance.id);
      const next = withoutInstances(state, new Set(ids));
      const { [plugin]: _, ...plugins } = next.plugins;
      return { state: { ...next, plugins } };
    }

    case "settings.update":
      return { state: { ...state, settings: merge(state.settings, command.payload) } };

    case "plugin.setState": {
      const { plugin, state: value } = command.payload;
      return { state: withPlugin(state, plugin, { ...getPlugin(state, plugin), state: value }) };
    }

    case "plugin.setStatus": {
      const { plugin, status, error } = command.payload;
      const { error: _, ...entry } = getPlugin(state, plugin);
      return {
        state: withPlugin(state, plugin, {
          ...entry,
          status,
          ...(error !== undefined && { error }),
        }),
      };
    }

    case "live.take":
      checkScene(state, command.payload.instanceId);
      return { state: take(state, command.payload, ctx.now) };

    case "live.interrupt":
      checkScene(state, command.payload.instanceId);
      return { state: interrupt(state, command.payload, ctx.now) };

    case "live.clearInterrupt":
      if (!resolveTimeline(state, ctx.now).interrupt) {
        throw new CommandError("invalid", "no interrupt is active");
      }
      return { state: endOverride(state, ctx.now) };

    case "live.resume":
      return { state: endOverride(state, ctx.now) };

    case "live.blackout":
      return { state: { ...state, live: { ...state.live, blackout: command.payload.on } } };

    case "instance.setState": {
      const { id, state: value } = command.payload;
      const instance = { ...getInstance(state, id), state: value };
      return { state: { ...state, instances: { ...state.instances, [id]: instance } } };
    }
  }
}

function getPlugin(state: ShowState, id: string): PluginEntry {
  const entry = state.plugins[id];
  if (!entry) throw new CommandError("not_found", `plugin ${id} not found`);
  return entry;
}

function withPlugin(state: ShowState, id: string, entry: PluginEntry): ShowState {
  return { ...state, plugins: { ...state.plugins, [id]: entry } };
}

/**
 * Deletes instances along with the playlist items, overlay placements, cues and live control
 * that reference them (DESIGN.md §5.3). An instance that is a theme's background can't go.
 */
function withoutInstances(state: ShowState, ids: ReadonlySet<string>): ShowState {
  if (ids.size === 0) return state;
  const theme = Object.values(state.themes).find(
    (t) => t.background.type === "scene" && ids.has(t.background.instanceId),
  );
  if (theme?.background.type === "scene") {
    throw new CommandError(
      "invalid",
      `instance ${theme.background.instanceId} is the background of theme ${theme.id}`,
    );
  }
  const instances = Object.fromEntries(
    Object.entries(state.instances).filter(([id]) => !ids.has(id)),
  );
  const live = { ...state.live };
  if (live.main && ids.has(live.main.instanceId)) delete live.main;
  if (live.interrupt && ids.has(live.interrupt.instanceId)) delete live.interrupt;
  return {
    ...state,
    instances,
    live,
    playlist: {
      ...state.playlist,
      items: state.playlist.items.filter((item) => !ids.has(item.instanceId)),
    },
    overlays: state.overlays.filter((placement) => !ids.has(placement.instanceId)),
    cues: state.cues.filter(
      (cue) => !("instanceId" in cue.action) || !ids.has(cue.action.instanceId),
    ),
  };
}

function getInstance(state: ShowState, id: string): Instance {
  const instance = state.instances[id];
  if (!instance) throw new CommandError("not_found", `instance ${id} not found`);
  return instance;
}

/** Live control shows only scenes that can render. */
function checkScene(state: ShowState, id: string) {
  getInstance(state, id);
  if (!isPlayableScene(state, id)) {
    throw new CommandError("invalid", `instance ${id} is broken or not a scene`);
  }
}

function getItemIndex(state: ShowState, id: string): number {
  const index = state.playlist.items.findIndex((item) => item.id === id);
  if (index === -1) throw new CommandError("not_found", `playlist item ${id} not found`);
  return index;
}

function withItems(state: ShowState, items: PlaylistItem[]): ShowState {
  return { ...state, playlist: { ...state.playlist, items } };
}

function checkWindow(item: PlaylistItem): PlaylistItem {
  if (
    item.activeFrom !== undefined &&
    item.activeUntil !== undefined &&
    item.activeFrom >= item.activeUntil
  ) {
    throw new CommandError("invalid", "activeFrom must be before activeUntil");
  }
  return item;
}

/**
 * Returns a copy of `target` with `changes` applied: `undefined` leaves a field unchanged and
 * `null` removes it. Callers pass changes that were validated against the target's schema.
 */
function merge<T extends object>(target: T, changes: object): T {
  const result: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete result[key];
    else if (value !== undefined) result[key] = value;
  }
  return result as T;
}
