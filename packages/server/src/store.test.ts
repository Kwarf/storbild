import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialState, type ShowState } from "@storbild/core";
import { openDatabase } from "./db.ts";
import { loadState, saveState } from "./store.ts";

function fullState(): ShowState {
  const base = createInitialState({ now: 100, newId: () => "theme1" });
  return {
    ...base,
    revision: 42,
    plugins: {
      "now-playing": {
        settings: { url: "http://x" },
        state: { artist: "A", title: "B" },
        version: "1.0.0",
        status: "error",
        error: "boom",
        module: "/plugins/now-playing/1.0.0/viewer.js",
        types: { track: { kind: "overlay", label: "Track", viewer: "sb-track", singleton: true } },
      },
    },
    instances: {
      i1: {
        id: "i1",
        plugin: "markdown",
        type: "text",
        name: "Rules",
        config: { content: "#" },
        configVersion: 2,
      },
      i2: {
        id: "i2",
        plugin: "info",
        type: "clock",
        name: "Clock",
        config: {},
        configVersion: 1,
        background: { assetId: "abc", fit: "cover" },
        state: { tick: 1 },
      },
    },
    playlist: {
      anchorAt: 500,
      items: [
        { id: "p2", instanceId: "i1", enabled: false, durationMs: 1000 },
        { id: "p1", instanceId: "i1", enabled: true, activeFrom: 1, activeUntil: 2 },
      ],
    },
    cues: [{ id: "c1", at: 9000, action: { type: "interrupt", instanceId: "i1", dimBelow: true } }],
    overlays: [
      { instanceId: "i2", slot: "bottom-right", order: 1, visible: true },
      { instanceId: "i1", slot: "top", order: 0, visible: false },
    ],
    themes: {
      ...base.themes,
      theme2: {
        id: "theme2",
        name: "Party",
        background: { type: "image", assetId: "bg", fit: "contain", dim: 0.5 },
        fonts: { heading: { family: "Display", assetIds: ["f1"] }, body: { family: "Body" } },
        colors: { text: "#fff", muted: "#999", accent: "#f0f", surface: "#111" },
        safeArea: 48,
        customCss: "h1 { color: red }",
      },
    },
    activeThemeId: "theme2",
    timeline: {
      mode: "auto",
      main: { instanceId: "i1", itemId: "p1", startedAt: 10 },
      blackout: true,
    },
  };
}

describe("persistence", () => {
  test("a fresh database has no state", () => {
    expect(loadState(openDatabase(":memory:"))).toBeUndefined();
  });

  test("round-trips a full state through a new connection", () => {
    const dir = mkdtempSync(join(tmpdir(), "storbild-"));
    try {
      const path = join(dir, "storbild.db");
      const state = fullState();
      const db = openDatabase(path);
      saveState(db, state);
      db.close();
      const reopened = openDatabase(path);
      expect(loadState(reopened)).toEqual(state);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("writes only the given keys", () => {
    const db = openDatabase(":memory:");
    const state = fullState();
    saveState(db, state);
    saveState(db, { ...state, revision: 43, cues: [], instances: {} }, ["revision", "cues"]);
    const loaded = loadState(db);
    expect(loaded?.revision).toBe(43);
    expect(loaded?.cues).toEqual([]);
    expect(loaded?.instances).toEqual(state.instances);
  });

  test("skips and reports rows that fail validation", () => {
    const db = openDatabase(":memory:");
    saveState(db, fullState());
    db.run(`UPDATE instances SET data = '{"id":"i1"}' WHERE id = 'i1'`);
    const logged: string[] = [];
    const loaded = loadState(db, (message) => logged.push(message));
    expect(Object.keys(loaded?.instances ?? {})).toEqual(["i2"]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("instance i1");
  });

  test("tables reject invalid JSON", () => {
    const db = openDatabase(":memory:");
    expect(() => db.run(`INSERT INTO instances (id, data) VALUES ('x', 'not json')`)).toThrow();
  });
});
