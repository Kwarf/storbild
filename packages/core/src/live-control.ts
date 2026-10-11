import type { Live } from "./schema/live.ts";
import type { ShowState } from "./schema/state.ts";
import type { TimelineMain } from "./schema/timeline.ts";
import { resolveTimeline } from "./timeline.ts";

// Live control (DESIGN.md §4.4, ADR 0006). Each function takes the time the action happens,
// which is the command's time or a cue's `at`. Callers check that the instance is playable.

export interface TakeOptions {
  instanceId: string;
  /** Holds until resumed when absent. */
  durationMs?: number | undefined;
}

export interface InterruptOptions extends TakeOptions {
  dimBelow?: boolean | undefined;
}

/** Replaces the main layer with an instance; the rotation continues after it. */
export function take(state: ShowState, options: TakeOptions, at: number): ShowState {
  const current = resolveTimeline(state, at).main;
  const main: TimelineMain = {
    instanceId: options.instanceId,
    startedAt: at,
    ...(options.durationMs !== undefined && { endsAt: at + options.durationMs }),
  };
  return reanchor({ ...state, live: { ...state.live, main } }, current, at);
}

/**
 * Shows an instance on the interrupt layer and pauses the rotation: the scene on the main
 * layer is frozen until the interrupt ends, and the rotation then continues with the next item.
 */
export function interrupt(state: ShowState, options: InterruptOptions, at: number): ShowState {
  const current = resolveTimeline(state, at).main;
  const endsAt = options.durationMs !== undefined ? at + options.durationMs : undefined;
  const { main: _, ...rest } = state.live;
  const live: Live = {
    ...rest,
    interrupt: {
      instanceId: options.instanceId,
      startedAt: at,
      ...(endsAt !== undefined && { endsAt }),
      dimBelow: options.dimBelow ?? false,
    },
  };
  if (current) {
    const { endsAt: __, ...frozen } = current;
    live.main = { ...frozen, ...(endsAt !== undefined && { endsAt }) };
  }
  return reanchor({ ...state, live }, current, at);
}

/** Whether a take or interrupt decides what is on air at t. */
export function overrideActive(state: ShowState, t: number): boolean {
  return resolveTimeline(state, t).mode === "override";
}

/** Ends any take and interrupt, and continues the rotation from its anchor item at `at`. */
export function endOverride(state: ShowState, at: number): ShowState {
  if (!overrideActive(state, at)) return state;
  const { main: _, interrupt: __, ...live } = state.live;
  return { ...state, live, playlist: { ...state.playlist, anchorAt: at } };
}

/**
 * Points the rotation at the item after `previous` (if it was a playlist item) and anchors it
 * where the live override ends. An override that holds keeps the old time; ending it sets it.
 */
function reanchor(state: ShowState, previous: TimelineMain | undefined, at: number): ShowState {
  const { items } = state.playlist;
  const index = items.findIndex((item) => item.id === previous?.itemId);
  const anchorItemId =
    index === -1 ? state.playlist.anchorItemId : items[(index + 1) % items.length]?.id;

  const entries = [state.live.main, state.live.interrupt].filter(
    (entry) => entry !== undefined && (entry.endsAt === undefined || at < entry.endsAt),
  );
  const holds = entries.some((entry) => entry?.endsAt === undefined);
  const anchorAt = holds
    ? state.playlist.anchorAt
    : Math.max(at, ...entries.map((entry) => entry?.endsAt as number));

  const { anchorItemId: _, ...playlist } = state.playlist;
  return {
    ...state,
    playlist: { ...playlist, anchorAt, ...(anchorItemId !== undefined && { anchorItemId }) },
  };
}
