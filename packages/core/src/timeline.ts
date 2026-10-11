import type { PlaylistItem } from "./schema/playlist.ts";
import { defaultShowSettings } from "./schema/settings.ts";
import type { ShowState } from "./schema/state.ts";
import type { Timeline, TimelineMain } from "./schema/timeline.ts";

/** How long an item runs before the scheduler has resolved its duration. */
export const DEFAULT_DURATION_MS = defaultShowSettings.defaultDurationMs;

/**
 * Whether an instance can be shown as a scene: it exists, isn't broken, and is of a scene type.
 * A plugin whose server part failed (`status: "error"`) still renders; plugins that can't load
 * mark their instances broken.
 */
export function isPlayableScene(state: ShowState, instanceId: string): boolean {
  const instance = state.instances[instanceId];
  if (!instance || instance.error !== undefined) return false;
  return state.plugins[instance.plugin]?.types[instance.type]?.kind === "scene";
}

export function itemDuration(item: PlaylistItem): number {
  return item.resolvedDurationMs ?? item.durationMs ?? DEFAULT_DURATION_MS;
}

export function inWindow(item: PlaylistItem, t: number): boolean {
  return (
    (item.activeFrom === undefined || item.activeFrom <= t) &&
    (item.activeUntil === undefined || t < item.activeUntil)
  );
}

/** A playlist item on air, or about to be. */
export interface RotationSlot {
  item: PlaylistItem;
  index: number;
  startsAt: number;
  endsAt: number;
}

export interface RotationAt {
  /** The item on air at t, absent in a gap (nothing eligible) or before the anchor. */
  current?: RotationSlot;
  /** The item that starts when `current` ends, or when the gap ends. */
  next?: RotationSlot | undefined;
}

/**
 * The playlist rotation at time t, ignoring live control (DESIGN.md §4.2, ADR 0006).
 *
 * From the anchor, the rotation walks the playlist in order, wrapping, and starts each item
 * that is enabled, playable and inside its time window at the moment it would start. A started
 * item always plays to its end. Between window boundaries the eligible set is fixed, so whole
 * cycles are skipped arithmetically and an old anchor stays cheap.
 */
export function rotationAt(state: ShowState, t: number): RotationAt {
  const { items, anchorAt, anchorItemId } = state.playlist;
  const n = items.length;
  const playable = items.map((item) => item.enabled && isPlayableScene(state, item.instanceId));
  const boundaries = [
    ...new Set(
      items.flatMap((item, i) =>
        playable[i] ? [item.activeFrom, item.activeUntil].filter((b) => b !== undefined) : [],
      ),
    ),
  ].sort((a, b) => a - b);
  const boundaryAfter = (c: number) => boundaries.find((b) => b > c) ?? Infinity;
  const eligible = (i: number, c: number) => playable[i] && inWindow(items[i] as PlaylistItem, c);

  /** The first item to start at or after c, searching from index p. */
  function firstStart(c: number, p: number): RotationSlot | undefined {
    for (;;) {
      for (let k = 0; k < n; k++) {
        const index = (p + k) % n;
        if (eligible(index, c)) {
          const item = items[index] as PlaylistItem;
          return { item, index, startsAt: c, endsAt: c + itemDuration(item) };
        }
      }
      const b = boundaryAfter(c);
      if (b === Infinity) return undefined;
      c = b;
    }
  }

  const anchorIndex = items.findIndex((item) => item.id === anchorItemId);
  let p = Math.max(anchorIndex, 0);
  let c = anchorAt;
  for (;;) {
    const slot = firstStart(c, p);
    if (!slot) return {};
    if (t < slot.startsAt) return { next: slot };
    c = slot.startsAt;
    p = slot.index;

    // The eligible set is fixed for starts in [c, b). Skip whole cycles, stopping a cycle short
    // of min(t, b) so every skipped start stays inside the segment.
    const b = boundaryAfter(c);
    let cycle = 0;
    for (let i = 0; i < n; i++) {
      if (eligible(i, c)) cycle += itemDuration(items[i] as PlaylistItem);
    }
    const skip = Math.floor((Math.min(t, b) - c) / cycle) - 1;
    if (skip > 0) c += skip * cycle;

    while (c < b) {
      let index = p;
      while (!eligible(index, c)) index = (index + 1) % n;
      const item = items[index] as PlaylistItem;
      const endsAt = c + itemDuration(item);
      if (t < endsAt) {
        return {
          current: { item, index, startsAt: c, endsAt },
          next: firstStart(endsAt, (index + 1) % n),
        };
      }
      c = endsAt;
      p = (index + 1) % n;
    }
  }
}

/** What the main layer shows at t, and until when. */
interface MainAt {
  main?: TimelineMain;
  /** When the main layer changes next, if known. */
  until: number | undefined;
  /** Whether live control decides the main layer. */
  override: boolean;
}

function active(entry: { endsAt?: number | undefined } | undefined, t: number): boolean {
  return entry !== undefined && (entry.endsAt === undefined || t < entry.endsAt);
}

function mainAt(state: ShowState, t: number): MainAt {
  const { live } = state;
  if (active(live.main, t)) {
    const main = live.main as TimelineMain;
    return { main, until: main.endsAt, override: true };
  }
  if (active(live.interrupt, t)) {
    // The rotation is paused under an interrupt; with nothing frozen, the main layer is empty.
    return { until: live.interrupt?.endsAt, override: true };
  }
  const { current, next } = rotationAt(state, t);
  if (!current) return { until: next?.startsAt, override: false };
  return {
    main: {
      instanceId: current.item.instanceId,
      itemId: current.item.id,
      startedAt: current.startsAt,
      endsAt: current.endsAt,
    },
    until: current.endsAt,
    override: false,
  };
}

/**
 * Resolves what is on air at time t (DESIGN.md §4.4, ADR 0006). Pure: the server uses it to
 * set `timeline`, and the viewer to switch at `next.startsAt` on its own clock.
 *
 * Live control comes first: a take or a frozen scene in `live.main`, and an interrupt, which
 * pauses the rotation. When they end, the rotation continues from its anchor, which live
 * commands set to the item after the one that was on air. Blackout covers everything while
 * the timeline keeps advancing underneath.
 */
export function resolveTimeline(state: ShowState, t: number): Timeline {
  const now = mainAt(state, t);
  const interrupt = active(state.live.interrupt, t) ? state.live.interrupt : undefined;
  let next: Timeline["next"];
  if (now.until !== undefined) {
    const then = mainAt(state, now.until);
    if (then.main) {
      next = {
        instanceId: then.main.instanceId,
        ...(then.main.itemId !== undefined && { itemId: then.main.itemId }),
        startsAt: now.until,
      };
    } else if (then.until !== undefined && !then.override) {
      // A gap in the rotation: announce what ends it.
      const after = mainAt(state, then.until).main;
      if (after) {
        next = {
          instanceId: after.instanceId,
          ...(after.itemId !== undefined && { itemId: after.itemId }),
          startsAt: then.until,
        };
      }
    }
  }
  return {
    mode: now.override ? "override" : "auto",
    ...(now.main && { main: now.main }),
    ...(next && { next }),
    ...(interrupt && { interrupt }),
    blackout: state.live.blackout,
  };
}

/** How far a screen's clock may trail the server's before a fresh anchor shows a gap. */
export const ANCHOR_LAG_MS = 1_000;

/**
 * `resolveTimeline` for a screen, whose clock may trail the server's (ADR 0013). A command that
 * re-anchors the rotation at the server's now leaves such a screen just before the anchor, where
 * nothing is on air, so the scene on air would start to fade out. Within `ANCHOR_LAG_MS` of the
 * anchor, with no live control on air, it resolves at the anchor instead.
 */
export function resolveTimelineOnScreen(state: ShowState, t: number): Timeline {
  const timeline = resolveTimeline(state, t);
  const { anchorAt } = state.playlist;
  if (timeline.main || timeline.mode !== "auto" || t >= anchorAt || anchorAt - t > ANCHOR_LAG_MS) {
    return timeline;
  }
  return resolveTimeline(state, anchorAt);
}

/**
 * When the resolved timeline changes next: the next item's start, or the end of the main
 * scene or interrupt. The server and the viewer arm their timers for it.
 */
export function nextBoundary(timeline: Timeline): number | undefined {
  const times = [timeline.next?.startsAt, timeline.main?.endsAt, timeline.interrupt?.endsAt].filter(
    (time) => time !== undefined,
  );
  return times.length > 0 ? Math.min(...times) : undefined;
}
