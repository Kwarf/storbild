import { describe, expect, test } from "bun:test";
import { createInitialState } from "@storbild/core";
import { LastState, type StorageLike } from "./last-state.ts";

const state = createInitialState({ now: 0, newId: () => "theme" });

function setup(storage: StorageLike) {
  let now = 0;
  let timer: (() => void) | undefined;
  const last = new LastState({
    storage,
    now: () => now,
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
    last,
    tick(ms: number) {
      now += ms;
    },
    fire() {
      timer?.();
    },
  };
}

const memory = (): StorageLike => {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  };
};

describe("LastState", () => {
  test("round-trips the state, offset and time of contact", () => {
    const s = setup(memory());
    expect(s.last.load()).toBeUndefined();
    s.last.save({ state, offsetMs: 42, receivedAt: 1_000 });
    expect(s.last.load()).toEqual({ state, offsetMs: 42, receivedAt: 1_000 });
  });

  test("throttles writes but keeps the last one", () => {
    const s = setup(memory());
    s.last.save({ state, offsetMs: 1, receivedAt: 1 });
    s.last.save({ state, offsetMs: 2, receivedAt: 2 });
    s.last.save({ state, offsetMs: 3, receivedAt: 3 });
    expect(s.last.load()?.offsetMs).toBe(1);
    s.tick(1_000);
    s.fire();
    expect(s.last.load()?.offsetMs).toBe(3);
    s.last.save({ state, offsetMs: 4, receivedAt: 4 });
    s.last.flush();
    expect(s.last.load()?.offsetMs).toBe(4);
  });

  test("ignores stored values that don't validate", () => {
    const store = memory();
    store.setItem(
      "storbild:last",
      JSON.stringify({ state: { revision: "x" }, offsetMs: 0, receivedAt: 0 }),
    );
    expect(setup(store).last.load()).toBeUndefined();
    store.setItem("storbild:last", JSON.stringify({ state, offsetMs: "0", receivedAt: 0 }));
    expect(setup(store).last.load()).toBeUndefined();
    store.setItem("storbild:last", "{not json");
    expect(setup(store).last.load()).toBeUndefined();
  });

  test("survives storage that throws, or none at all", () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    const s = setup(throwing);
    expect(() => s.last.save({ state, offsetMs: 0, receivedAt: 0 })).not.toThrow();
    expect(s.last.load()).toBeUndefined();
    const none = new LastState({
      storage: undefined,
      now: () => 0,
      timers: { setTimeout: () => 0, clearTimeout: () => {} },
    });
    none.save({ state, offsetMs: 0, receivedAt: 0 });
    expect(none.load()).toBeUndefined();
  });
});
