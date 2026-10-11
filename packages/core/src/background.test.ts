import { describe, expect, test } from "bun:test";
import { sceneBackground } from "./background.ts";
import { reconcilePlugins } from "./plugins.ts";
import { createInitialState, type ShowState, withActiveTheme } from "./schema/state.ts";
import { testCatalog } from "./test/catalog.ts";

function stateWith(own: boolean, background?: ShowState["instances"][string]["background"]) {
  const state = reconcilePlugins(createInitialState({ now: 0, newId: () => "t" }), testCatalog);
  const plugin = state.plugins.markdown;
  if (!plugin) throw new Error("no plugin");
  const types = {
    ...plugin.types,
    slides: {
      kind: "scene" as const,
      label: "Slides",
      viewer: "x-slides",
      background: "own" as const,
    },
  };
  const instance = {
    id: "a",
    plugin: "markdown",
    type: own ? "slides" : "text",
    name: "A",
    config: {},
    configVersion: 1,
    ...(background !== undefined && { background }),
  };
  return {
    ...state,
    instances: { a: instance },
    plugins: { ...state.plugins, markdown: { ...plugin, types } },
  } satisfies ShowState;
}

describe("sceneBackground", () => {
  test("a scene shows the theme background by default", () => {
    expect(sceneBackground(stateWith(false), "a")).toBe("theme");
  });

  test("a type that draws its own background hides the theme's", () => {
    expect(sceneBackground(stateWith(true), "a")).toBe("none");
  });

  test("the instance's background overrides the type", () => {
    expect(sceneBackground(stateWith(true, "theme"), "a")).toBe("theme");
    expect(sceneBackground(stateWith(false, "none"), "a")).toBe("none");
    const image = { assetId: "x", fit: "cover" as const };
    expect(sceneBackground(stateWith(false, image), "a")).toEqual(image);
  });

  test("an unknown instance falls back to the theme", () => {
    expect(sceneBackground(stateWith(false), "missing")).toBe("theme");
  });
});

describe("withActiveTheme", () => {
  const base = () => createInitialState({ now: 0, newId: () => "t1" });

  test("leaves a state with its active theme alone", () => {
    const state = base();
    expect(withActiveTheme(state, () => "new")).toBe(state);
  });

  test("activates the first theme when the active one is missing", () => {
    const state = { ...base(), activeThemeId: "gone" };
    expect(withActiveTheme(state, () => "new").activeThemeId).toBe("t1");
  });

  test("creates a default theme when there is none", () => {
    const repaired = withActiveTheme({ ...base(), themes: {}, activeThemeId: "" }, () => "new");
    expect(repaired.activeThemeId).toBe("new");
    expect(repaired.themes.new?.name).toBe("Default");
  });
});
