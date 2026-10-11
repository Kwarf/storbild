import { interrupt, overrideActive, take } from "./live-control.ts";
import type { Cue } from "./schema/cue.ts";
import type { PlaylistItem } from "./schema/playlist.ts";
import type { PluginCatalog } from "./schema/plugin.ts";
import type { ShowState } from "./schema/state.ts";
import {
  DEFAULT_DURATION_MS,
  inWindow,
  isPlayableScene,
  itemDuration,
  resolveTimeline,
  rotationAt,
} from "./timeline.ts";

export interface SettleContext {
  /** Server time, epoch ms. */
  now: number;
  /** The loaded plugins, whose types compute durations. */
  catalog: PluginCatalog;
}

/**
 * The scheduler's step (ADR 0006), run by the server after every change to the state and at
 * every timeline boundary. It resolves durations, keeps the rotation going across edits, fires
 * due cues, drops live control that has ended, and stores the timeline for `now`.
 */
export function settle(before: ShowState, after: ShowState, ctx: SettleContext): ShowState {
  let state = resolveDurations(after, ctx.catalog);
  state = keepRotation(before, state, ctx.now);
  state = fireDueCues(state, ctx.now);
  state = dropEnded(state, ctx.now);
  return { ...state, timeline: resolveTimeline(state, ctx.now) };
}

/**
 * Sets every item's `resolvedDurationMs`: its override, else its type's `duration(config,
 * settings)`, else the default. A type whose `duration` throws or returns something other than
 * a positive number gets the default.
 */
export function resolveDurations(state: ShowState, catalog: PluginCatalog): ShowState {
  let changed = false;
  const items = state.playlist.items.map((item) => {
    const resolved = item.durationMs ?? typeDuration(state, catalog, item) ?? DEFAULT_DURATION_MS;
    if (item.resolvedDurationMs === resolved) return item;
    changed = true;
    return { ...item, resolvedDurationMs: resolved };
  });
  return changed ? { ...state, playlist: { ...state.playlist, items } } : state;
}

function typeDuration(
  state: ShowState,
  catalog: PluginCatalog,
  item: PlaylistItem,
): number | undefined {
  const instance = state.instances[item.instanceId];
  if (!instance || instance.error !== undefined) return undefined;
  const duration = catalog[instance.plugin]?.types?.[instance.type]?.duration;
  if (!duration) return undefined;
  try {
    const value = duration(instance.config, state.plugins[instance.plugin]?.settings);
    return typeof value === "number" && Number.isFinite(value) && value >= 1
      ? Math.round(value)
      : undefined;
  } catch {
    return undefined;
  }
}

/** What decides the rotation's course, per item. */
function rotationKey(state: ShowState): string {
  return JSON.stringify(
    state.playlist.items.map((item) => [
      item.id,
      item.instanceId,
      item.enabled && isPlayableScene(state, item.instanceId),
      itemDuration(item),
      item.activeFrom ?? null,
      item.activeUntil ?? null,
    ]),
  );
}

/**
 * Re-anchors the rotation when its content changes, so an edit never restarts the show. The
 * item on air keeps playing (with its new duration) if it is still eligible; otherwise the
 * rotation continues now with the item after it. While live control is on air, only an anchor
 * item that was removed is replaced.
 */
function keepRotation(before: ShowState, after: ShowState, now: number): ShowState {
  if (rotationKey(before) === rotationKey(after)) return after;
  const old = before.playlist.items;
  const { items } = after.playlist;
  const present = new Set(items.map((item) => item.id));
  /** The first item still in the playlist, from position i of the old order. */
  const firstPresentFrom = (i: number) => {
    for (let k = 0; k < old.length; k++) {
      const id = old[(i + k) % old.length]?.id;
      if (id !== undefined && present.has(id)) return id;
    }
    return undefined;
  };
  const anchored = (anchorAt: number, anchorItemId: string | undefined): ShowState => {
    const { anchorItemId: _, ...playlist } = after.playlist;
    return {
      ...after,
      playlist: { ...playlist, anchorAt, ...(anchorItemId !== undefined && { anchorItemId }) },
    };
  };
  const anchorId = after.playlist.anchorItemId;
  const anchorItem =
    anchorId !== undefined && present.has(anchorId)
      ? anchorId
      : firstPresentFrom(
          Math.max(
            old.findIndex((item) => item.id === anchorId),
            0,
          ),
        );

  if (overrideActive(after, now)) return anchored(after.playlist.anchorAt, anchorItem);

  const current = rotationAt(before, now).current;
  if (!current) return anchored(now, anchorItem);
  const item = items.find((item) => item.id === current.item.id);
  if (
    item?.enabled &&
    isPlayableScene(after, item.instanceId) &&
    inWindow(item, current.startsAt)
  ) {
    return anchored(current.startsAt, item.id);
  }
  return anchored(now, firstPresentFrom(current.index + 1));
}

/**
 * Applies every unfired cue that is due, in time order, as of its `at`, and marks it fired.
 * A take or interrupt that would already have ended has no effect.
 */
export function fireDueCues(state: ShowState, now: number): ShowState {
  const due = state.cues.filter((cue) => !cue.fired && cue.at <= now).sort((a, b) => a.at - b.at);
  if (due.length === 0) return state;
  for (const cue of due) state = applyCue(state, cue, now);
  return {
    ...state,
    cues: state.cues.map((cue) => (due.includes(cue) ? { ...cue, fired: true } : cue)),
  };
}

function applyCue(state: ShowState, { at, action }: Cue, now: number): ShowState {
  switch (action.type) {
    case "take":
    case "interrupt": {
      const ended = action.durationMs !== undefined && at + action.durationMs <= now;
      if (ended || !isPlayableScene(state, action.instanceId)) return state;
      return action.type === "take" ? take(state, action, at) : interrupt(state, action, at);
    }
    case "activateTheme":
      return state.themes[action.themeId] ? { ...state, activeThemeId: action.themeId } : state;
  }
}

/** Removes a take or interrupt whose end has passed; resolving already ignores them. */
function dropEnded(state: ShowState, now: number): ShowState {
  const ended = (entry: { endsAt?: number | undefined } | undefined) =>
    entry?.endsAt !== undefined && entry.endsAt <= now;
  const { main, interrupt } = state.live;
  if (!ended(main) && !ended(interrupt)) return state;
  const live = { ...state.live };
  if (ended(main)) delete live.main;
  if (ended(interrupt)) delete live.interrupt;
  return { ...state, live };
}
