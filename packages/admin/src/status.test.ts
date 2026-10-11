import { describe, expect, test } from "bun:test";
import { createInitialState, interrupt, type ShowState, take } from "@storbild/core";
import { onAir } from "./status.ts";

let id = 0;
const base: ShowState = {
  ...createInitialState({ now: 0, newId: () => `t${++id}` }),
  plugins: {
    markdown: {
      status: "ok",
      settings: {},
      state: null,
      types: { text: { kind: "scene", label: "Text", viewer: "sb-markdown-scene" } },
    },
  },
  instances: {
    rules: {
      id: "rules",
      plugin: "markdown",
      type: "text",
      name: "Rules",
      config: {},
      configVersion: 1,
    },
    fire: {
      id: "fire",
      plugin: "markdown",
      type: "text",
      name: "Fire exit",
      config: {},
      configVersion: 1,
    },
  },
  playlist: {
    items: [{ id: "i1", instanceId: "rules", enabled: true, resolvedDurationMs: 60_000 }],
    anchorAt: 0,
    anchorItemId: "i1",
  },
};

describe("onAir", () => {
  test("the rotation", () => {
    expect(onAir(base, 1_000)).toMatchObject({ mode: "rotation", title: "Rotation" });
  });

  test("an empty rotation shows the background", () => {
    const empty = { ...base, playlist: { items: [], anchorAt: 0 } };
    expect(onAir(empty, 0).detail).toContain("background");
  });

  test("a take, with and without a duration", () => {
    expect(onAir(take(base, { instanceId: "fire", durationMs: 150_000 }, 0), 0)).toMatchObject({
      mode: "take",
      title: "Take: Fire exit",
      detail: "returns to rotation in 2:30",
    });
    expect(onAir(take(base, { instanceId: "fire" }, 0), 5_000).detail).toBe("until resumed");
  });

  test("an interrupt", () => {
    const state = interrupt(base, { instanceId: "fire", durationMs: 30_000 }, 0);
    expect(onAir(state, 10_000)).toMatchObject({
      mode: "interrupt",
      title: "Interrupt: Fire exit",
      detail: "returns to rotation in 0:20",
    });
    expect(onAir(interrupt(base, { instanceId: "fire" }, 0), 0).detail).toBe("until dismissed");
  });

  test("blackout wins", () => {
    const state = interrupt({ ...base, live: { blackout: true } }, { instanceId: "fire" }, 0);
    expect(onAir(state, 0)).toMatchObject({ mode: "blackout", title: "Blackout" });
  });
});
