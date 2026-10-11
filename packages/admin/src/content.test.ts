import { describe, expect, test } from "bun:test";
import { createInitialState, resolveTimeline, type ShowState } from "@storbild/core";
import {
  fromLocalInput,
  groupInstances,
  move,
  previewState,
  rotationCount,
  sameValue,
  toLocalInput,
  typeChoices,
} from "./content.ts";

function show(): ShowState {
  const state = createInitialState({ now: 0, newId: () => "theme" });
  const text = { kind: "scene" as const, label: "Markdown text", viewer: "sb-md" };
  return {
    ...state,
    plugins: {
      markdown: { status: "ok", settings: {}, state: null, types: { text } },
      np: {
        status: "ok",
        settings: {},
        state: null,
        types: {
          track: { kind: "overlay", label: "Now playing", viewer: "sb-np", singleton: true },
        },
      },
      gone: { status: "missing", settings: {}, state: null, types: {} },
    },
    instances: {
      b: { id: "b", plugin: "markdown", type: "text", name: "Rules", config: {}, configVersion: 1 },
      a: { id: "a", plugin: "markdown", type: "text", name: "Food", config: {}, configVersion: 1 },
      t: { id: "t", plugin: "np", type: "track", name: "Track", config: {}, configVersion: 1 },
      g: {
        id: "g",
        plugin: "gone",
        type: "x",
        name: "Old",
        config: {},
        configVersion: 1,
        error: "gone",
      },
    },
    playlist: {
      items: [
        { id: "p1", instanceId: "a", enabled: true },
        { id: "p2", instanceId: "a", enabled: false },
      ],
      anchorAt: 0,
    },
  };
}

describe("content helpers", () => {
  test("typeChoices lists the types of loaded plugins and marks taken singletons", () => {
    expect(typeChoices(show())).toEqual([
      { plugin: "markdown", type: "text", label: "Markdown text", kind: "scene", taken: false },
      { plugin: "np", type: "track", label: "Now playing", kind: "overlay", taken: true },
    ]);
  });

  test("groupInstances groups by type label and sorts by name", () => {
    const groups = groupInstances(show());
    expect(groups.map((g) => [g.label, g.instances.map((i) => i.name)])).toEqual([
      ["gone/x", ["Old"]],
      ["Markdown text", ["Food", "Rules"]],
      ["Now playing", ["Track"]],
    ]);
  });

  test("rotationCount", () => {
    expect(rotationCount(show(), "a")).toBe(2);
    expect(rotationCount(show(), "b")).toBe(0);
  });

  test("previewState shows an overlay alone, in its slot or bottom-right", () => {
    const state: ShowState = {
      ...show(),
      instances: {
        ...show().instances,
        t: { id: "t", plugin: "np", type: "track", name: "Track", config: {}, configVersion: 1 },
      },
      overlays: [
        { instanceId: "t", slot: "top-bar", order: 2, visible: false },
        { instanceId: "x", slot: "top-bar", order: 0, visible: true },
      ],
    };
    const placed = previewState(state, {
      id: "t",
      plugin: "np",
      type: "track",
      name: "T",
      config: {},
    });
    expect(placed.live).toEqual({ blackout: false });
    expect(placed.overlays).toEqual([
      { instanceId: "t", slot: "top-bar", order: 0, visible: true },
    ]);
    const draft = previewState(state, { plugin: "np", type: "track", name: "New", config: {} });
    expect(draft.overlays).toEqual([
      { instanceId: "draft", slot: "bottom-right", order: 0, visible: true },
    ]);
  });

  test("previewState puts only the draft on air, unbroken, over a live show", () => {
    const state = { ...show(), live: { blackout: true } };
    const preview = previewState(state, {
      id: "g",
      plugin: "gone",
      type: "x",
      name: "Draft",
      config: { content: "new" },
    });
    expect(preview.instances.g).toMatchObject({ name: "Draft", config: { content: "new" } });
    expect(preview.instances.g?.error).toBeUndefined();
    expect(preview.live).toEqual({ main: { instanceId: "g", startedAt: 0 }, blackout: false });
    expect(preview.overlays).toEqual([]);

    const fresh = previewState(show(), {
      plugin: "markdown",
      type: "text",
      name: "New",
      config: {},
    });
    expect(resolveTimeline(fresh, 99_999).main?.instanceId).toBe("draft");
  });

  test("move", () => {
    expect(move(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(move(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(move(["a", "b", "c"], 1, 9)).toEqual(["a", "c", "b"]);
  });

  test("local datetime inputs round-trip to the minute", () => {
    const at = new Date(2026, 9, 11, 14, 30).getTime();
    expect(toLocalInput(at)).toBe("2026-10-11T14:30");
    expect(fromLocalInput("2026-10-11T14:30")).toBe(at);
    expect(fromLocalInput("")).toBeUndefined();
    expect(toLocalInput(undefined)).toBe("");
  });

  test("sameValue ignores key order and undefined fields", () => {
    expect(sameValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameValue({ a: 1, x: undefined }, { a: 1 })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameValue([1], { 0: 1 })).toBe(false);
  });
});
