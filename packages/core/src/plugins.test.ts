import { describe, expect, test } from "bun:test";
import { reconcilePlugins } from "./plugins.ts";
import { createInitialState, type ShowState } from "./schema/state.ts";
import { testCatalog } from "./test/catalog.ts";

function stateWith(partial: Partial<ShowState>): ShowState {
  let next = 0;
  return { ...createInitialState({ now: 0, newId: () => `t${++next}` }), ...partial };
}

const instance = (
  id: string,
  plugin: string,
  type: string,
  config: unknown,
  configVersion = 1,
) => ({
  id,
  plugin,
  type,
  name: id,
  config: config as never,
  configVersion,
});

describe("reconcilePlugins", () => {
  test("fills plugin entries from the catalog and keeps missing plugins' data", () => {
    const state = reconcilePlugins(
      stateWith({
        plugins: {
          markdown: { status: "missing", settings: {}, state: { kept: true }, types: {} },
          gone: { status: "ok", settings: { a: 1 }, state: 2, types: {} },
        },
      }),
      testCatalog,
    );
    expect(state.plugins.markdown).toEqual({
      status: "ok",
      version: "1.0.0",
      module: "/plugins/markdown/1.0.0/viewer.js",
      settings: { fontScale: 1 },
      state: { kept: true },
      types: {
        text: { kind: "scene", label: "Text", viewer: "sb-markdown-scene" },
        counter: { kind: "overlay", label: "Counter", viewer: "sb-counter" },
      },
    });
    expect(state.plugins.gone).toEqual({
      status: "missing",
      settings: { a: 1 },
      state: 2,
      types: {},
    });
    expect(state.plugins.legacy).toEqual({
      status: "incompatible",
      version: "0.1.0",
      error: "needs API 0",
      settings: {},
      state: null,
      types: {},
    });
  });

  test("keeps invalid settings for the runtime to report", () => {
    const state = reconcilePlugins(
      stateWith({
        plugins: {
          markdown: { status: "ok", settings: { fontScale: "x" }, state: null, types: {} },
        },
      }),
      testCatalog,
    );
    expect(state.plugins.markdown?.settings).toEqual({ fontScale: "x" });
  });

  test("migrates instances and marks the ones that fail as broken", () => {
    const state = reconcilePlugins(
      stateWith({
        instances: {
          ok: { ...instance("ok", "markdown", "text", { content: "x" }), error: "stale" },
          migrated: instance("migrated", "markdown", "counter", { n: "7" }),
          invalid: instance("invalid", "markdown", "text", { title: 1 }),
          newer: instance("newer", "markdown", "text", { content: "x" }, 5),
          noType: instance("noType", "markdown", "gone", {}),
          missing: instance("missing", "gone", "text", {}),
          incompatible: instance("incompatible", "legacy", "text", {}),
        },
      }),
      testCatalog,
    );
    const { ok, migrated, ...broken } = state.instances;
    expect(ok?.error).toBeUndefined();
    expect(migrated).toMatchObject({ config: { count: 7, step: 1 }, configVersion: 2 });
    expect(migrated?.error).toBeUndefined();
    for (const [id, value] of Object.entries(broken)) {
      expect([id, value.error]).toEqual([id, expect.any(String)]);
    }
    // A broken instance keeps its stored config, so fixing the plugin restores it.
    expect(state.instances.invalid?.config).toEqual({ title: 1 });
  });
});
