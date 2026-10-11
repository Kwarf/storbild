import { resolveTimeline, type ShowState, type Timeline } from "@storbild/core";
import { formatDuration } from "./format.ts";

/** What the screens show, summarised for the auto/override indicator (DESIGN.md §8.2). */
export interface OnAir {
  timeline: Timeline;
  mode: "rotation" | "take" | "interrupt" | "blackout";
  title: string;
  detail: string;
}

export function instanceName(state: ShowState, instanceId: string): string {
  return state.instances[instanceId]?.name ?? "Deleted instance";
}

/** The type's label, e.g. "Markdown text", for an instance. */
export function typeLabel(state: ShowState, instanceId: string): string | undefined {
  const instance = state.instances[instanceId];
  return instance && state.plugins[instance.plugin]?.types[instance.type]?.label;
}

const until = (endsAt: number | undefined, now: number, held: string) =>
  endsAt === undefined ? held : `returns to rotation in ${formatDuration(endsAt - now)}`;

export function onAir(state: ShowState, now: number): OnAir {
  const timeline = resolveTimeline(state, now);
  const { main, interrupt } = timeline;
  if (timeline.blackout) {
    return {
      timeline,
      mode: "blackout",
      title: "Blackout",
      detail: "Screens are black; the show keeps running underneath",
    };
  }
  if (interrupt) {
    return {
      timeline,
      mode: "interrupt",
      title: `Interrupt: ${instanceName(state, interrupt.instanceId)}`,
      detail: until(interrupt.endsAt, now, "until dismissed"),
    };
  }
  if (timeline.mode === "override" && main) {
    return {
      timeline,
      mode: "take",
      title: `Take: ${instanceName(state, main.instanceId)}`,
      detail: until(main.endsAt, now, "until resumed"),
    };
  }
  return {
    timeline,
    mode: "rotation",
    title: "Rotation",
    detail: main ? "running on schedule" : "nothing to play; showing the background",
  };
}
