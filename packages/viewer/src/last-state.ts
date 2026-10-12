import { type ShowState, showStateSchema } from "@storbild/core";
import type { Timers } from "./sync.ts";

/** What a screen keeps of its last visit, to start from during an outage (ADR 0019). */
export interface StoredShow {
  state: ShowState;
  /** The clock offset, `serverNow − localNow`, when it was saved. */
  offsetMs: number;
  /** Server time when the state last came from the server. */
  receivedAt: number;
}

/** The parts of `Storage` the store uses. */
export type StorageLike = Pick<Storage, "getItem" | "setItem">;

export interface LastStateOptions {
  /** Absent when the browser has no storage, or refuses it. */
  storage: StorageLike | undefined;
  timers: Timers;
  /** A local clock for throttling, ms. */
  now(): number;
  key?: string;
  /** Writes are at most this often; the last one is never lost. */
  throttleMs?: number;
}

/**
 * The last state, clock offset and time of contact, in `localStorage`. Writes are throttled and
 * every access is guarded: storage can be full, disabled or throw, and a screen must start
 * either way. A stored value that doesn't validate is ignored.
 */
export class LastState {
  readonly #options: Required<LastStateOptions>;
  #pending: StoredShow | undefined;
  #timer: unknown;
  #lastWrite = Number.NEGATIVE_INFINITY;

  constructor(options: LastStateOptions) {
    this.#options = { key: "storbild:last", throttleMs: 1_000, ...options };
  }

  load(): StoredShow | undefined {
    try {
      const text = this.#options.storage?.getItem(this.#options.key);
      if (!text) return undefined;
      const value = JSON.parse(text) as Partial<Record<keyof StoredShow, unknown>> | null;
      const { offsetMs, receivedAt } = value ?? {};
      if (!Number.isFinite(offsetMs) || !Number.isFinite(receivedAt)) return undefined;
      const state = showStateSchema.safeParse(value?.state);
      return state.success
        ? { state: state.data, offsetMs: offsetMs as number, receivedAt: receivedAt as number }
        : undefined;
    } catch {
      return undefined;
    }
  }

  save(value: StoredShow) {
    this.#pending = value;
    const { timers, now, throttleMs } = this.#options;
    const wait = this.#lastWrite + throttleMs - now();
    if (wait <= 0) {
      this.flush();
      return;
    }
    if (this.#timer === undefined) {
      this.#timer = timers.setTimeout(() => {
        this.#timer = undefined;
        this.flush();
      }, wait);
    }
  }

  /** Writes a pending save now, e.g. when the page is hidden. */
  flush() {
    const value = this.#pending;
    this.#pending = undefined;
    this.#options.timers.clearTimeout(this.#timer);
    this.#timer = undefined;
    if (!value) return;
    this.#lastWrite = this.#options.now();
    try {
      this.#options.storage?.setItem(this.#options.key, JSON.stringify(value));
    } catch {
      // Full or disabled; the screen still works, it just can't start offline.
    }
  }
}
