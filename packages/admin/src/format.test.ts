import { describe, expect, test } from "bun:test";
import { formatDuration, parseDuration } from "./format.ts";

describe("formatDuration", () => {
  test.each([
    [0, "0:00"],
    [1, "0:01"],
    [59_001, "1:00"],
    [150_000, "2:30"],
    [3_600_000, "1:00:00"],
    [3_725_000, "1:02:05"],
    [-5, "0:00"],
  ])("%p ms is %p", (ms, text) => expect(formatDuration(ms)).toBe(text));
});

describe("parseDuration", () => {
  test.each([
    ["", undefined],
    ["  ", undefined],
    ["90", 90_000],
    ["1:30", 90_000],
    ["0:05", 5_000],
    ["1:00:00", 3_600_000],
    ["0", null],
    ["1:75", null],
    ["abc", null],
    ["1.5", null],
    ["-3", null],
  ])("%p is %p", (text, ms) => expect(parseDuration(text)).toBe(ms as number | undefined | null));
});
