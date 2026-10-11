// Pure helpers for the Schedule page (ADR 0011). No DOM, so they're unit-tested.
import {
  type Cue,
  type CueAction,
  type InterruptBelow,
  isPlayableScene,
  type ShowState,
} from "@storbild/core";
import { fromLocalInput, toLocalInput } from "./content.ts";
import { formatClock, formatDuration, parseDuration } from "./format.ts";

/** The cues of one local day, in time order. */
export interface CueDay {
  /** `YYYY-MM-DD` in local time. */
  key: string;
  label: string;
  cues: Cue[];
}

const dayKey = (epochMs: number) => toLocalInput(epochMs).slice(0, 10);

/** Groups cues by local day, in time order, labelling today and tomorrow. */
export function cueDays(cues: readonly Cue[], now: number): CueDay[] {
  const today = dayKey(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const days = new Map<string, CueDay>();
  for (const cue of [...cues].sort((a, b) => a.at - b.at)) {
    const key = dayKey(cue.at);
    let day = days.get(key);
    if (!day) {
      const label =
        key === today
          ? "Today"
          : key === dayKey(tomorrow.getTime())
            ? "Tomorrow"
            : new Date(cue.at).toLocaleDateString([], {
                weekday: "long",
                day: "numeric",
                month: "long",
              });
      day = { key, label, cues: [] };
      days.set(key, day);
    }
    day.cues.push(cue);
  }
  return [...days.values()];
}

/** The next cue to fire: the earliest that hasn't. */
export function nextCue(cues: readonly Cue[]): Cue | undefined {
  return cues
    .filter((cue) => !cue.fired)
    .reduce<Cue | undefined>((next, cue) => (!next || cue.at < next.at ? cue : next), undefined);
}

/** How far away a time is, roughly: "in 5 min", "in 2 h 5 min", "3 min ago". */
export function relativeTime(at: number, now: number): string {
  const ahead = at >= now;
  const ms = Math.abs(at - now);
  if (ms < 60_000) return ahead ? "in under a minute" : "just now";
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const span =
    hours === 0
      ? `${minutes} min`
      : hours >= 24
        ? `${Math.round(hours / 24)} d`
        : `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
  return ahead ? `in ${span}` : `${span} ago`;
}

/** What the screen shows beneath an interrupt cue, as the Live panel words it (ADR 0008). */
export const belowLabels: Record<InterruptBelow, string> = {
  hide: "Cover the screen",
  dim: "Dim the screen",
  show: "Over the screen",
};

/** A cue's action in words, without the instance's name. */
export function actionText(action: CueAction): string {
  if (action.type === "activateTheme") return "Switch theme";
  const length =
    action.durationMs === undefined
      ? action.type === "take"
        ? "until resumed"
        : "until dismissed"
      : `for ${formatDuration(action.durationMs)}`;
  if (action.type === "take") return `Take ${length}`;
  return `Interrupt ${length}, ${belowLabels[action.below ?? "hide"].toLowerCase()}`;
}

/** A cue being added or edited, as the form holds it. */
export interface CueDraft {
  /** A `datetime-local` value. */
  at: string;
  type: "take" | "interrupt";
  instanceId: string;
  /** Seconds or m:ss; blank holds until cleared. */
  duration: string;
  below: InterruptBelow;
}

export const emptyDraft = (): CueDraft => ({
  at: "",
  type: "interrupt",
  instanceId: "",
  duration: "",
  below: "hide",
});

/** The draft of an existing take or interrupt cue. */
export function draftOf(cue: Cue): CueDraft | undefined {
  const { action } = cue;
  if (action.type === "activateTheme") return undefined;
  return {
    at: toLocalInput(cue.at, { seconds: true }),
    type: action.type,
    instanceId: action.instanceId,
    duration: action.durationMs === undefined ? "" : formatDuration(action.durationMs),
    below: action.type === "interrupt" ? (action.below ?? "hide") : "hide",
  };
}

/** The `at` and action a draft describes, or a message saying what to fix. */
export function cueOf(draft: CueDraft): { at: number; action: CueAction } | string {
  const at = fromLocalInput(draft.at);
  if (at === undefined) return "Choose a date and time.";
  if (!draft.instanceId) return "Choose a scene.";
  const durationMs = parseDuration(draft.duration);
  if (durationMs === null) return "Enter a duration as seconds or m:ss, or leave it blank.";
  const length = durationMs === undefined ? {} : { durationMs };
  return {
    at,
    action:
      draft.type === "take"
        ? { type: "take", instanceId: draft.instanceId, ...length }
        : { type: "interrupt", instanceId: draft.instanceId, ...length, below: draft.below },
  };
}

/** Why a cue would do nothing when it fires, if it would. */
export function cueProblem(state: ShowState, cue: Cue): string | undefined {
  const { action } = cue;
  if (action.type === "activateTheme") {
    return state.themes[action.themeId] ? undefined : "Theme deleted";
  }
  return isPlayableScene(state, action.instanceId) ? undefined : "Broken, will be skipped";
}

/** The time of a cue on its day's row: `HH:MM`, with seconds when it has them. */
export function cueClock(at: number): string {
  const seconds = new Date(at).getSeconds();
  return seconds === 0 ? formatClock(at) : `${formatClock(at)}:${String(seconds).padStart(2, "0")}`;
}
