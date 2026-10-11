import type { ShowState } from "./schema/state.ts";
import type { Timeline } from "./schema/timeline.ts";

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

/**
 * Stands in for the scheduler until M4 replaces it with `resolveTimeline`: `main` is the first
 * enabled, playable playlist item, with no end. It owns only `main`; the rest of the timeline is
 * kept. While the pick stays the same, `startedAt` is kept, so recomputing changes nothing.
 */
export function interimTimeline(state: ShowState, now: number): Timeline {
  const { main: current, ...rest } = state.timeline;
  const item = state.playlist.items.find(
    (item) => item.enabled && isPlayableScene(state, item.instanceId),
  );
  if (!item) return rest;
  if (current?.itemId === item.id && current.instanceId === item.instanceId) {
    return state.timeline;
  }
  return { ...rest, main: { instanceId: item.instanceId, itemId: item.id, startedAt: now } };
}
