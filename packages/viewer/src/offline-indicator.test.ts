import { describe, expect, test } from "bun:test";
import { OfflineTracker, offlineLabel } from "./offline-indicator.ts";

describe("OfflineTracker", () => {
  test("says so only after 10 s without a stream", () => {
    const tracker = new OfflineTracker();
    expect(tracker.update({ connected: true, lastMessageAt: 0, now: 1_000 })).toBe(false);
    expect(tracker.update({ connected: false, lastMessageAt: 1_000, now: 2_000 })).toBe(false);
    expect(tracker.update({ connected: false, lastMessageAt: 1_000, now: 11_999 })).toBe(false);
    expect(tracker.update({ connected: false, lastMessageAt: 1_000, now: 12_000 })).toBe(true);
    expect(tracker.update({ connected: true, lastMessageAt: 12_500, now: 12_500 })).toBe(false);
  });

  test("a short drop never shows", () => {
    const tracker = new OfflineTracker();
    expect(tracker.update({ connected: false, lastMessageAt: 0, now: 1_000 })).toBe(false);
    expect(tracker.update({ connected: true, lastMessageAt: 6_000, now: 6_000 })).toBe(false);
    expect(tracker.update({ connected: false, lastMessageAt: 6_000, now: 7_000 })).toBe(false);
    expect(tracker.update({ connected: false, lastMessageAt: 6_000, now: 16_000 })).toBe(false);
  });

  test("an open stream that has gone silent counts as lost since its last message", () => {
    const tracker = new OfflineTracker();
    expect(tracker.update({ connected: true, lastMessageAt: 0, now: 20_000 })).toBe(false);
    expect(tracker.update({ connected: true, lastMessageAt: 0, now: 20_001 })).toBe(true);
  });

  test("a screen started from its stored state says so at once, until a stream opens", () => {
    const tracker = new OfflineTracker();
    tracker.startedOffline(0);
    expect(tracker.update({ connected: false, lastMessageAt: -5_000, now: 0 })).toBe(true);
    expect(tracker.update({ connected: true, lastMessageAt: 3_000, now: 3_000 })).toBe(false);
    expect(tracker.update({ connected: false, lastMessageAt: 3_000, now: 4_000 })).toBe(false);
  });
});

describe("offlineLabel", () => {
  test("shows the time of the last update in the screen's time zone", () => {
    const at = Date.UTC(2026, 9, 12, 12, 32);
    expect(offlineLabel(at, "UTC")).toBe("Offline · last update 12:32");
    expect(offlineLabel(at, "Europe/Stockholm")).toBe("Offline · last update 14:32");
    expect(offlineLabel(undefined)).toBe("Offline");
  });
});
