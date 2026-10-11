import { describe, expect, test } from "bun:test";
import { createServerClock, estimateOffset } from "./clock.ts";

describe("estimateOffset", () => {
  test("returns undefined without samples", () => {
    expect(estimateOffset([])).toBeUndefined();
  });

  test("uses the median of the lowest-RTT half", () => {
    const offset = estimateOffset([
      { t0: 0, server: 1010, t3: 20 }, // rtt 20, offset 1000
      { t0: 0, server: 1012, t3: 20 }, // rtt 20, offset 1002
      { t0: 0, server: 1500, t3: 400 }, // rtt 400, discarded
      { t0: 0, server: 900, t3: 600 }, // rtt 600, discarded
    ]);
    expect(offset).toBe(1001);
  });
});

describe("createServerClock", () => {
  function setup() {
    let local = 1_000_000;
    const clock = createServerClock(() => local, { slewRate: 0.1, snapThresholdMs: 1000 });
    return { clock, tick: (ms: number) => (local += ms), now: () => local };
  }

  test("applies the first offset immediately", () => {
    const { clock, now } = setup();
    clock.setOffset(5000);
    expect(clock.serverNow()).toBe(now() + 5000);
  });

  test("slews small corrections and never goes backwards", () => {
    const { clock, tick, now } = setup();
    clock.setOffset(500);
    clock.setOffset(0);
    let previous = clock.serverNow();
    for (let i = 0; i < 100; i++) {
      tick(100);
      const current = clock.serverNow();
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
    // 10 s at 0.1 ms/ms is enough to cover the 500 ms correction.
    expect(clock.serverNow()).toBe(now());
    expect(clock.offset).toBe(0);
  });

  test("snaps corrections above the threshold", () => {
    const { clock, now } = setup();
    clock.setOffset(0);
    clock.setOffset(60_000);
    expect(clock.serverNow()).toBe(now() + 60_000);
  });
});
