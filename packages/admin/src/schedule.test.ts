import { describe, expect, test } from "bun:test";
import type { Cue } from "@storbild/core";
import {
  actionText,
  cueDays,
  cueOf,
  draftOf,
  emptyDraft,
  nextCue,
  relativeTime,
} from "./schedule.ts";

const at = (day: number, hour: number, minute = 0, second = 0) =>
  new Date(2026, 9, day, hour, minute, second).getTime();

const cue = (id: string, time: number, fired?: boolean): Cue => ({
  id,
  at: time,
  action: { type: "take", instanceId: "i" },
  ...(fired && { fired }),
});

describe("cueDays", () => {
  test("groups by local day in time order, labelling today and tomorrow", () => {
    const now = at(11, 20);
    const days = cueDays(
      [cue("c", at(12, 9)), cue("a", at(11, 22)), cue("d", at(14, 0, 30)), cue("b", at(11, 21))],
      now,
    );
    expect(days.map((day) => [day.key, day.label.length > 0, day.cues.map((c) => c.id)])).toEqual([
      ["2026-10-11", true, ["b", "a"]],
      ["2026-10-12", true, ["c"]],
      ["2026-10-14", true, ["d"]],
    ]);
    expect(days[0]?.label).toBe("Today");
    expect(days[1]?.label).toBe("Tomorrow");
    expect(days[2]?.label).not.toMatch(/Today|Tomorrow/);
  });
});

test("nextCue is the earliest that hasn't fired", () => {
  expect(nextCue([cue("a", 5, true), cue("c", 30), cue("b", 20)])?.id).toBe("b");
  expect(nextCue([cue("a", 5, true)])).toBeUndefined();
});

test.each([
  [at(11, 20, 0, 30), "in under a minute"],
  [at(11, 20, 5), "in 5 min"],
  [at(11, 22, 5), "in 2 h 5 min"],
  [at(11, 23), "in 3 h"],
  [at(13, 20), "in 2 d"],
  [at(11, 19, 57), "3 min ago"],
])("relativeTime %#", (time, text) => {
  expect(relativeTime(time, at(11, 20))).toBe(text);
});

describe("drafts", () => {
  test("a filled draft becomes a cue, and an interrupt cue its draft", () => {
    const draft = {
      ...emptyDraft(),
      at: "2026-10-11T21:30:15",
      instanceId: "i",
      duration: "1:30",
      below: "dim" as const,
    };
    const result = cueOf(draft);
    expect(result).toEqual({
      at: at(11, 21, 30, 15),
      action: { type: "interrupt", instanceId: "i", durationMs: 90_000, below: "dim" },
    });
    if (typeof result === "string") throw new Error(result);
    expect(draftOf({ id: "x", ...result })).toEqual(draft);
  });

  test("a take without a duration holds", () => {
    expect(
      cueOf({ ...emptyDraft(), type: "take", at: "2026-10-11T21:30", instanceId: "i" }),
    ).toEqual({ at: at(11, 21, 30), action: { type: "take", instanceId: "i" } });
  });

  test.each([
    [{}, "Choose a date and time."],
    [{ at: "2026-10-11T21:30" }, "Choose a scene."],
    [{ at: "2026-10-11T21:30", instanceId: "i", duration: "soon" }, /duration/],
  ])("an incomplete draft says what to fix %#", (changes, message) => {
    expect(cueOf({ ...emptyDraft(), ...changes })).toMatch(message);
  });
});

test("actionText", () => {
  expect(actionText({ type: "take", instanceId: "i" })).toBe("Take until resumed");
  expect(actionText({ type: "interrupt", instanceId: "i", durationMs: 30_000, below: "dim" })).toBe(
    "Interrupt for 0:30, dim the screen",
  );
});
