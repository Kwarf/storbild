import { describe, expect, test } from "bun:test";
import { formatTime, untilNextTick } from "./clock.ts";

const at = Date.UTC(2026, 9, 11, 7, 5, 9, 500);

describe("formatTime", () => {
  test("24-hour time with or without seconds", () => {
    expect(formatTime(at, { seconds: false, timeZone: "UTC" })).toBe("07:05");
    expect(formatTime(at, { seconds: true, timeZone: "UTC" })).toBe("07:05:09");
  });

  test("in the given time zone", () => {
    expect(formatTime(at, { seconds: false, timeZone: "Europe/Stockholm" })).toBe("09:05");
  });

  test("an unknown time zone falls back to local time", () => {
    expect(formatTime(at, { seconds: false, timeZone: "Nowhere/Special" })).toMatch(/^\d\d:05$/);
  });
});

describe("untilNextTick", () => {
  test("waits for the next second or minute", () => {
    expect(untilNextTick(at, true)).toBe(500);
    expect(untilNextTick(at, false)).toBe(50_500);
  });
});
