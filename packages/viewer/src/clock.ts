import {
  type ClockSample,
  createServerClock,
  estimateOffset,
  type ServerClock,
} from "@storbild/core";
import type { Timers } from "./sync.ts";

export interface ClockSyncOptions {
  /** Returns `{ now }` in server epoch ms, e.g. `/time`. */
  url: string;
  fetch(url: string): Promise<{ ok: boolean; json(): Promise<unknown> }>;
  /** A monotonic local clock in epoch ms. */
  localNow(): number;
  timers: Timers;
  /** Round trips per sync. */
  samples?: number;
  /** Time between periodic syncs. */
  intervalMs?: number;
}

/**
 * Estimates the server clock from `/time` round trips (DESIGN.md §5.2). It syncs on start,
 * every `intervalMs`, and whenever `sync()` is called (after reconnects and when the page
 * becomes visible). Offset changes are slewed by `createServerClock`, so time never jumps.
 */
export class ClockSync {
  readonly #options: Required<ClockSyncOptions>;
  readonly #clock: ServerClock;
  #syncing: Promise<void> | undefined;
  #timer: unknown;
  #stopped = true;
  #synced = false;

  constructor(options: ClockSyncOptions) {
    this.#options = { samples: 8, intervalMs: 5 * 60_000, ...options };
    this.#clock = createServerClock(options.localNow);
  }

  /** The estimated server time, epoch ms. Local time until the first sync completes. */
  readonly serverNow = (): number => this.#clock.serverNow();

  get offset(): number {
    return this.#clock.offset;
  }

  /**
   * Starts from an offset kept from an earlier visit, such as the one stored with the last
   * state (ADR 0019), so a screen that boots during an outage keeps the server's time. It is
   * ignored once a sync has succeeded, and the first sync slews from it.
   */
  seed(offset: number) {
    if (!this.#synced) this.#clock.setOffset(offset);
  }

  start() {
    this.#stopped = false;
    void this.sync();
  }

  stop() {
    this.#stopped = true;
    this.#options.timers.clearTimeout(this.#timer);
  }

  /** Takes a new set of samples. Calls during a sync share it. */
  sync(): Promise<void> {
    this.#syncing ??= this.#sample().finally(() => {
      this.#syncing = undefined;
      this.#schedule();
    });
    return this.#syncing;
  }

  #schedule() {
    const { timers, intervalMs } = this.#options;
    timers.clearTimeout(this.#timer);
    if (!this.#stopped) this.#timer = timers.setTimeout(() => void this.sync(), intervalMs);
  }

  async #sample() {
    const { url, localNow, samples: count } = this.#options;
    const samples: ClockSample[] = [];
    // Sequential, so the round trips don't queue behind each other.
    for (let i = 0; i < count; i++) {
      try {
        const t0 = localNow();
        const response = await this.#options.fetch(url);
        if (!response.ok) continue;
        const { now } = (await response.json()) as { now: number };
        samples.push({ t0, server: now, t3: localNow() });
      } catch {
        // Offline; use what we have, or keep the current offset.
      }
    }
    const offset = estimateOffset(samples);
    if (offset !== undefined) {
      this.#clock.setOffset(offset);
      this.#synced = true;
    }
  }
}
