import { describe, expect, test } from "bun:test";
import { createInitialState, type Instance, type ShowState } from "@storbild/core";
import {
  DRAFT_THEME_ID,
  duplicateOf,
  sceneInstances,
  switchBackground,
  type ThemeDraft,
  themePayload,
  themePreviewState,
} from "./theme-form.ts";

function show(): ShowState {
  const state = createInitialState({ now: 0, newId: () => "theme" });
  const instance = (id: string, type: string): Instance => ({
    id,
    plugin: "markdown",
    type,
    name: id,
    config: {},
    configVersion: 1,
  });
  return {
    ...state,
    plugins: {
      markdown: {
        status: "ok",
        settings: {},
        state: null,
        types: {
          text: { kind: "scene", label: "Text", viewer: "sb-md" },
          clock: { kind: "overlay", label: "Clock", viewer: "sb-clock" },
        },
      },
    },
    instances: {
      b: instance("b", "text"),
      a: instance("a", "text"),
      c: instance("c", "clock"),
      broken: { ...instance("broken", "text"), error: "x" },
    },
  };
}

const draft = (): ThemeDraft => ({
  name: " Party ",
  background: { type: "color", color: "#101010" },
  fonts: {
    heading: { family: "Display", faces: [{ assetId: "f1", weight: 700, style: "normal" }] },
    body: { family: "sans-serif", faces: [{ assetId: "", weight: 400, style: "normal" }] },
    mono: { family: " " },
  },
  colors: { text: "#fff", muted: "#999", accent: "#f80", surface: "#222" },
});

describe("theme form", () => {
  test("background scenes are the playable scenes, by name", () => {
    expect(sceneInstances(show()).map((i) => i.id)).toEqual(["a", "b"]);
  });

  test("switching the background type keeps the dim and picks a scene", () => {
    const state = show();
    const image = switchBackground(state, { type: "video", assetId: "v", dim: 0.4 }, "image");
    expect(image).toEqual({ type: "image", assetId: "", fit: "cover", dim: 0.4 });
    expect(switchBackground(state, image, "scene")).toEqual({ type: "scene", instanceId: "a" });
    expect(switchBackground(state, image, "image")).toBe(image);
  });

  test("the payload trims the name, drops empty file rows and an unused mono font", () => {
    expect(themePayload({ ...draft(), gap: 12 })).toEqual({
      name: "Party",
      background: { type: "color", color: "#101010" },
      fonts: {
        heading: { family: "Display", faces: [{ assetId: "f1", weight: 700, style: "normal" }] },
        body: { family: "sans-serif" },
      },
      colors: { text: "#fff", muted: "#999", accent: "#f80", surface: "#222" },
      safeArea: null,
      gap: 12,
      customCss: null,
    });
  });

  test("a duplicate has no ID and a new name", () => {
    const copy = duplicateOf({ ...draft(), id: "t1", name: "Main" });
    expect(copy.id).toBeUndefined();
    expect(copy.name).toBe("Main copy");
  });

  test("the preview makes the draft the active theme over the live show", () => {
    const state = show();
    const preview = themePreviewState(state, draft());
    expect(preview.activeThemeId).toBe(DRAFT_THEME_ID);
    expect(preview.themes[DRAFT_THEME_ID]?.colors.accent).toBe("#f80");
    expect(preview.live).toBe(state.live);
  });

  test("with nothing on air, the preview shows the sample", () => {
    const sample: Instance = {
      id: "sample",
      plugin: "markdown",
      type: "text",
      name: "Sample",
      config: {},
      configVersion: 1,
    };
    const preview = themePreviewState(show(), { ...draft(), id: "t1" }, sample);
    expect(preview.activeThemeId).toBe("t1");
    expect(preview.live.main?.instanceId).toBe("sample");
    expect(preview.instances.sample).toEqual(sample);
  });
});
