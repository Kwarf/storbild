import { describe, expect, test } from "bun:test";
import { formatRemaining, remaining, untilNextTick } from "./countdown.ts";

const target = Date.UTC(2026, 9, 11, 20, 0, 0);

describe("remaining", () => {
  test("rounds up to whole seconds", () => {
    expect(remaining(target, target - 1)).toBe(1_000);
    expect(remaining(target, target - 1_000)).toBe(1_000);
    expect(remaining(target, target - 1_001)).toBe(2_000);
  });

  test("is 0 exactly at the target and after it", () => {
    expect(remaining(target, target)).toBe(0);
    expect(remaining(target, target + 5_000)).toBe(0);
  });
});

describe("formatRemaining", () => {
  test("minutes and seconds under an hour", () => {
    expect(formatRemaining(0)).toBe("00:00");
    expect(formatRemaining(59_000)).toBe("00:59");
    expect(formatRemaining(59 * 60_000 + 59_000)).toBe("59:59");
  });

  test("hours under a day", () => {
    expect(formatRemaining(3_600_000)).toBe("1:00:00");
    expect(formatRemaining(23 * 3_600_000 + 5 * 60_000 + 7_000)).toBe("23:05:07");
  });

  test("days from a day", () => {
    expect(formatRemaining(2 * 86_400_000 + 3 * 3_600_000 + 4_000)).toBe("2 d 03:00:04");
  });
});

describe("untilNextTick", () => {
  test("waits for the next second boundary before the target", () => {
    expect(untilNextTick(target, target - 2_250)).toBe(250);
    expect(untilNextTick(target, target - 2_000)).toBe(1_000);
  });

  test("stops at the target", () => {
    expect(untilNextTick(target, target)).toBeUndefined();
    expect(untilNextTick(target, target + 1)).toBeUndefined();
  });
});
