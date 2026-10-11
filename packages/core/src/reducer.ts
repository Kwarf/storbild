import type { Command } from "./commands.ts";
import type { Instance } from "./schema/instance.ts";
import type { PlaylistItem } from "./schema/playlist.ts";
import type { ShowState } from "./schema/state.ts";

export interface CommandContext {
  /** Server time of the command, epoch ms. */
  now: number;
  newId: () => string;
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
  ) {
    super(message);
    this.name = "CommandError";
  }
}

/**
 * Applies a validated command to the state and returns the next state with `revision` bumped.
 * Pure: time and IDs come from `ctx`, and the input state is never mutated.
 */
export function applyCommand(
  state: ShowState,
  command: Command,
  ctx: CommandContext,
): CommandOutcome {
  const outcome = reduce(state, command, ctx);
  return { ...outcome, state: { ...outcome.state, revision: state.revision + 1 } };
}

function reduce(state: ShowState, command: Command, ctx: CommandContext): CommandOutcome {
  switch (command.type) {
    case "instance.create": {
      const { configVersion, background, ...rest } = command.payload;
      const instance: Instance = {
        id: ctx.newId(),
        ...rest,
        configVersion: configVersion ?? 1,
        ...(background !== undefined && { background }),
      };
      return {
        state: { ...state, instances: { ...state.instances, [instance.id]: instance } },
        id: instance.id,
      };
    }

    case "instance.update": {
      const { id, ...changes } = command.payload;
      const instance = merge(getInstance(state, id), changes);
      return { state: { ...state, instances: { ...state.instances, [id]: instance } } };
    }

    case "instance.delete": {
      const { id } = command.payload;
      getInstance(state, id);
      const theme = Object.values(state.themes).find(
        (t) => t.background.type === "scene" && t.background.instanceId === id,
      );
      if (theme) {
        throw new CommandError("invalid", `instance ${id} is the background of theme ${theme.id}`);
      }
      const { [id]: _, ...instances } = state.instances;
      return {
        state: {
          ...state,
          instances,
          playlist: {
            ...state.playlist,
            items: state.playlist.items.filter((item) => item.instanceId !== id),
          },
          overlays: state.overlays.filter((placement) => placement.instanceId !== id),
          cues: state.cues.filter(
            (cue) => !("instanceId" in cue.action) || cue.action.instanceId !== id,
          ),
        },
      };
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
  }
}

function getInstance(state: ShowState, id: string): Instance {
  const instance = state.instances[id];
  if (!instance) throw new CommandError("not_found", `instance ${id} not found`);
  return instance;
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
