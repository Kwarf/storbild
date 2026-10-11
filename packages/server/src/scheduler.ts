import { nextBoundary } from "@storbild/core";
import type { StateHub } from "./state-hub.ts";

export interface SchedulerTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: SchedulerTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as Timer),
};

export interface SchedulerOptions {
  now: () => number;
  timers?: SchedulerTimers;
  /** The longest the scheduler sleeps, so a jump of the system clock corrects itself. */
  maxDelayMs?: number;
}

/**
 * Advances the show on the server (ADR 0006): one timer for the next timeline boundary or due
 * cue, re-armed after every new revision. Each firing settles the state at the current time,
 * which publishes the new timeline as a patch.
 */
export class Scheduler {
  readonly #hub: StateHub;
  readonly #now: () => number;
  readonly #timers: SchedulerTimers;
  readonly #maxDelayMs: number;
  #timer: unknown;
  #unwatch: (() => void) | undefined;

  constructor(
    hub: StateHub,
    { now, timers = defaultTimers, maxDelayMs = 60_000 }: SchedulerOptions,
  ) {
    this.#hub = hub;
    this.#now = now;
    this.#timers = timers;
    this.#maxDelayMs = maxDelayMs;
  }

  start() {
    this.#unwatch ??= this.#hub.watch(() => this.#arm());
    this.#tick();
  }

  stop() {
    this.#unwatch?.();
    this.#unwatch = undefined;
    this.#timers.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #tick() {
    try {
      this.#hub.tick();
    } catch (error) {
      console.error("scheduler tick failed", error);
    }
    this.#arm();
  }

  #arm() {
    if (!this.#unwatch) return;
    this.#timers.clearTimeout(this.#timer);
    const { state } = this.#hub;
    // The stored timeline was resolved when the state last changed, so a boundary in the past
    // means it is due now.
    const times = [
      nextBoundary(state.timeline),
      ...state.cues.filter((cue) => !cue.fired).map((cue) => cue.at),
    ].filter((time) => time !== undefined);
    const delay =
      times.length > 0
        ? Math.min(Math.max(Math.min(...times) - this.#now(), 0), this.#maxDelayMs)
        : this.#maxDelayMs;
    this.#timer = this.#timers.setTimeout(() => this.#tick(), delay);
  }
}
