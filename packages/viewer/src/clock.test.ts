import { expect, test } from "bun:test";
import { ClockSync } from "./clock.ts";

function setup(serverAhead: number) {
  let local = 1_000_000;
  const requests: string[] = [];
  let timer: (() => void) | undefined;
  let failing = false;
  const clock = new ClockSync({
    url: "/time",
    localNow: () => local,
    fetch: async (url) => {
      requests.push(url);
      if (failing) throw new TypeError("network");
      local += 10; // 20 ms round trip, server answers in the middle.
      const now = local + serverAhead;
      local += 10;
      return { ok: true, json: async () => ({ now }) };
    },
    timers: {
      setTimeout: (fn) => {
        timer = fn;
        return 1;
      },
      clearTimeout: () => {
        timer = undefined;
      },
    },
  });
  return {
    clock,
    requests,
    fireTimer: () => timer?.(),
    hasTimer: () => timer !== undefined,
    setFailing: (value: boolean) => {
      failing = value;
    },
  };
}

test("estimates the offset from 8 sequential samples", async () => {
  const s = setup(5_000);
  await s.clock.sync();
  expect(s.requests).toHaveLength(8);
  expect(s.clock.offset).toBe(5_000);
});

test("resyncs periodically once started, and stops", async () => {
  const s = setup(0);
  s.clock.start();
  await s.clock.sync();
  expect(s.hasTimer()).toBe(true);
  s.fireTimer();
  await s.clock.sync();
  expect(s.requests).toHaveLength(16);
  s.clock.stop();
  expect(s.hasTimer()).toBe(false);
});

test("concurrent syncs share one set of samples", async () => {
  const s = setup(0);
  await Promise.all([s.clock.sync(), s.clock.sync()]);
  expect(s.requests).toHaveLength(8);
});

test("a failed sync keeps the current offset", async () => {
  const s = setup(2_000);
  await s.clock.sync();
  s.setFailing(true);
  await s.clock.sync();
  expect(s.clock.offset).toBe(2_000);
});
