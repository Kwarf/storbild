import { describe, expect, test } from "bun:test";
import { reservedSlots } from "./overlays.ts";
import { reconcilePlugins } from "./plugins.ts";
import type { PluginTypeInfo } from "./schema/plugin.ts";
import { createInitialState, type ShowState } from "./schema/state.ts";
import { testCatalog } from "./test/catalog.ts";

function stateWith(types: Record<string, Partial<PluginTypeInfo>>): ShowState {
  let next = 0;
  const state = reconcilePlugins(
    createInitialState({ now: 0, newId: () => `id${++next}` }),
    testCatalog,
  );
  const plugin = state.plugins.markdown;
  if (!plugin) throw new Error("no plugin");
  const instances: ShowState["instances"] = {};
  const pluginTypes = { ...plugin.types };
  for (const [id, info] of Object.entries(types)) {
    pluginTypes[id] = { kind: "scene", label: id, viewer: "x-scene", ...info };
    instances[id] = { id, plugin: "markdown", type: id, name: id, config: {}, configVersion: 1 };
  }
  return {
    ...state,
    instances,
    plugins: { ...state.plugins, markdown: { ...plugin, types: pluginTypes } },
  };
}

describe("reservedSlots", () => {
  const state = stateWith({
    plain: {},
    corner: { reserveSlots: ["bottom-right"] },
    bars: { reserveSlots: ["top-bar", "bottom-bar"] },
    full: { hideOverlays: true },
  });
  const on = (main?: string, interrupt?: string) =>
    [
      ...reservedSlots(state, {
        mode: "auto",
        blackout: false,
        ...(main && { main: { instanceId: main, startedAt: 0 } }),
        ...(interrupt && { interrupt: { instanceId: interrupt, startedAt: 0, below: "show" } }),
      }),
    ].sort();

  test("nothing on air or a plain scene reserves nothing", () => {
    expect(on()).toEqual([]);
    expect(on("plain")).toEqual([]);
    expect(on("gone")).toEqual([]);
  });

  test("the scene on air and the interrupt reserve together", () => {
    expect(on("corner")).toEqual(["bottom-right"]);
    expect(on("corner", "bars")).toEqual(["bottom-bar", "bottom-right", "top-bar"]);
  });

  test("hideOverlays reserves every slot", () => {
    expect(on("plain", "full")).toHaveLength(10);
  });
});
