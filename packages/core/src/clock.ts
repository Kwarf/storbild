/** One `/time` round trip: local send time, server time, local receive time. */
export interface ClockSample {
  t0: number;
  server: number;
  t3: number;
}

/**
 * Estimates `serverTime − localTime` from round trips. The samples with the lowest round-trip
 * time are the least affected by queueing, so the lower half is kept and its median offset used.
 * Returns undefined for no samples.
 */
export function estimateOffset(samples: readonly ClockSample[]): number | undefined {
  if (samples.length === 0) return undefined;
  const best = [...samples]
    .sort((a, b) => a.t3 - a.t0 - (b.t3 - b.t0))
    .slice(0, Math.ceil(samples.length / 2));
  const offsets = best.map((s) => s.server - (s.t0 + s.t3) / 2).sort((a, b) => a - b);
  const mid = offsets.length >> 1;
  return offsets.length % 2 === 1
    ? (offsets[mid] as number)
    : ((offsets[mid - 1] as number) + (offsets[mid] as number)) / 2;
}

export interface ServerClockOptions {
  /** How fast the offset moves toward a new estimate, in ms per elapsed ms. Must be below 1. */
  slewRate?: number;
  /** Corrections larger than this (ms) are applied at once instead of slewed. */
  snapThresholdMs?: number;
}

export interface ServerClock {
  /** The estimated server time, epoch ms. */
  serverNow(): number;
  /** Sets a new offset estimate. The first one, and any far-off one, applies immediately. */
  setOffset(offset: number): void;
  /** The offset currently applied. */
  readonly offset: number;
}

/**
 * A server clock on top of a local clock, with no timers: the offset slews toward its target
 * lazily whenever the clock is read. While slewing, `serverNow()` still never goes backwards,
 * because the slew rate is below 1 ms per ms. Only snaps can move it backwards.
 */
export function createServerClock(
  localNow: () => number,
  { slewRate = 0.05, snapThresholdMs = 1000 }: ServerClockOptions = {},
): ServerClock {
  let offset: number | undefined;
  let target = 0;
  let lastLocal = localNow();

  function advance(local: number) {
    if (offset !== undefined) {
      const step = Math.max(0, local - lastLocal) * slewRate;
      offset += Math.min(step, Math.max(-step, target - offset));
    }
    lastLocal = local;
  }

  return {
    serverNow() {
      const local = localNow();
      advance(local);
      return local + (offset ?? 0);
    },
    setOffset(next) {
      advance(localNow());
      if (offset === undefined || Math.abs(next - offset) > snapThresholdMs) offset = next;
      target = next;
    },
    get offset() {
      return offset ?? 0;
    },
  };
}
