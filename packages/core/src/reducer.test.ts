import { describe, expect, test } from "bun:test";
import { type Command, commandSchema, type HostCommand } from "./commands.ts";
import { reconcilePlugins } from "./plugins.ts";
import { applyCommand, CommandError } from "./reducer.ts";
import { createInitialState, type ShowState } from "./schema/state.ts";
import { testCatalog } from "./test/catalog.ts";

function setup() {
  let next = 0;
  const ctx = { now: 1_000, newId: () => `id${++next}`, catalog: testCatalog };
  let state = reconcilePlugins(createInitialState(ctx), testCatalog);
  const run = (command: Command | HostCommand) => {
    const outcome = applyCommand(state, command, ctx);
    state = outcome.state;
    return outcome.id;
  };
  return {
    ctx,
    run,
    get state(): ShowState {
      return state;
    },
  };
}

const markdown = { plugin: "markdown", type: "text", name: "Rules", config: { content: "#" } };

function errorOf(fn: () => unknown): CommandError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CommandError) return error;
    throw error;
  }
  throw new Error("expected a CommandError");
}

describe("applyCommand", () => {
  test("the initial state has one active default theme", () => {
    const { state } = setup();
    expect(state.revision).toBe(0);
    expect(state.themes[state.activeThemeId]?.name).toBe("Default");
  });

  test("bumps the revision and does not mutate the input", () => {
    const s = setup();
    const before = s.state;
    const frozen = structuredClone(before);
    s.run({ type: "instance.create", payload: markdown });
    expect(s.state.revision).toBe(1);
    expect(before).toEqual(frozen);
  });

  test("instance.create returns the new ID and defaults configVersion", () => {
    const s = setup();
    const id = s.run({ type: "instance.create", payload: markdown });
    expect(id).toBeDefined();
    expect(s.state.instances[id as string]).toEqual({
      id: id as string,
      ...markdown,
      configVersion: 1,
    });
  });

  test("instance.update changes given fields and clears with null", () => {
    const s = setup();
    const id = s.run({
      type: "instance.create",
      payload: { ...markdown, background: "none" },
    }) as string;
    s.run({ type: "instance.update", payload: { id, name: "Welcome", background: null } });
    expect(s.state.instances[id]).toEqual({ id, ...markdown, name: "Welcome", configVersion: 1 });
  });

  test("instance.delete cascades to playlist items, overlays and cues", () => {
    const s = setup();
    const a = s.run({ type: "instance.create", payload: markdown }) as string;
    const b = s.run({ type: "instance.create", payload: markdown }) as string;
    s.run({ type: "playlist.addItem", payload: { instanceId: a } });
    const keep = s.run({ type: "playlist.addItem", payload: { instanceId: b } });
    s.run({ type: "playlist.addItem", payload: { instanceId: a } });
    // Overlays and cues have no commands until later milestones; seed them directly.
    const seeded: ShowState = {
      ...s.state,
      overlays: [
        { instanceId: a, slot: "top", order: 0, visible: true },
        { instanceId: b, slot: "top", order: 1, visible: true },
      ],
      cues: [
        { id: "c1", at: 5, action: { type: "take", instanceId: a } },
        { id: "c2", at: 6, action: { type: "activateTheme", themeId: s.state.activeThemeId } },
      ],
    };
    const { state } = applyCommand(seeded, { type: "instance.delete", payload: { id: a } }, s.ctx);
    expect(Object.keys(state.instances)).toEqual([b]);
    expect(state.playlist.items.map((item) => item.id)).toEqual([keep as string]);
    expect(state.overlays.map((o) => o.instanceId)).toEqual([b]);
    expect(state.cues.map((c) => c.id)).toEqual(["c2"]);
  });

  test("instance.delete refuses an instance used as a theme background", () => {
    const s = setup();
    const id = s.run({ type: "instance.create", payload: markdown }) as string;
    const theme = s.state.themes[s.state.activeThemeId];
    if (!theme) throw new Error("no theme");
    const state: ShowState = {
      ...s.state,
      themes: { [theme.id]: { ...theme, background: { type: "scene", instanceId: id } } },
    };
    const error = errorOf(() =>
      applyCommand(state, { type: "instance.delete", payload: { id } }, s.ctx),
    );
    expect(error.code).toBe("invalid");
  });

  test("playlist.addItem appends or inserts at an index", () => {
    const s = setup();
    const inst = s.run({ type: "instance.create", payload: markdown }) as string;
    const first = s.run({ type: "playlist.addItem", payload: { instanceId: inst } });
    const second = s.run({
      type: "playlist.addItem",
      payload: { instanceId: inst, index: 0, enabled: false, durationMs: 5000 },
    });
    expect(s.state.playlist.items).toEqual([
      { id: second as string, instanceId: inst, enabled: false, durationMs: 5000 },
      { id: first as string, instanceId: inst, enabled: true },
    ]);
  });

  test("playlist.updateItem merges, clears with null and validates the window", () => {
    const s = setup();
    const inst = s.run({ type: "instance.create", payload: markdown }) as string;
    const id = s.run({
      type: "playlist.addItem",
      payload: { instanceId: inst, durationMs: 5000, activeFrom: 10 },
    }) as string;
    s.run({ type: "playlist.updateItem", payload: { id, durationMs: null, activeUntil: 20 } });
    expect(s.state.playlist.items[0]).toEqual({
      id,
      instanceId: inst,
      enabled: true,
      activeFrom: 10,
      activeUntil: 20,
    });
    const error = errorOf(() =>
      s.run({ type: "playlist.updateItem", payload: { id, activeFrom: 30 } }),
    );
    expect(error.code).toBe("invalid");
  });

  test("playlist.removeItem and playlist.reorder", () => {
    const s = setup();
    const inst = s.run({ type: "instance.create", payload: markdown }) as string;
    const [a, b, c] = [1, 2, 3].map(
      () => s.run({ type: "playlist.addItem", payload: { instanceId: inst } }) as string,
    ) as [string, string, string];
    s.run({ type: "playlist.reorder", payload: { itemIds: [c, a, b] } });
    s.run({ type: "playlist.removeItem", payload: { id: a } });
    expect(s.state.playlist.items.map((item) => item.id)).toEqual([c, b]);
  });

  test.each([[["x"]], [["i3"]], [["i3", "i3"]], [["i3", "i4", "i4"]]])(
    "playlist.reorder rejects a non-permutation %p",
    (itemIds) => {
      const s = setup();
      const inst = s.run({ type: "instance.create", payload: markdown }) as string;
      s.run({ type: "playlist.addItem", payload: { instanceId: inst } }); // id3
      s.run({ type: "playlist.addItem", payload: { instanceId: inst } }); // id4
      const ids = itemIds.map((id) => id.replace("i", "id"));
      const error = errorOf(() => s.run({ type: "playlist.reorder", payload: { itemIds: ids } }));
      expect(error.code).toBe("invalid");
    },
  );

  test.each<Command>([
    { type: "instance.update", payload: { id: "nope", name: "x" } },
    { type: "instance.delete", payload: { id: "nope" } },
    { type: "playlist.addItem", payload: { instanceId: "nope" } },
    { type: "playlist.updateItem", payload: { id: "nope" } },
    { type: "playlist.removeItem", payload: { id: "nope" } },
  ])("$type reports unknown IDs as not_found", (command) => {
    const s = setup();
    expect(errorOf(() => s.run(command)).code).toBe("not_found");
    expect(s.state.revision).toBe(0);
  });

  test("instance.create validates config against the plugin and applies defaults", () => {
    const s = setup();
    const id = s.run({
      type: "instance.create",
      payload: { plugin: "markdown", type: "counter", name: "C", config: { count: 3 } },
    }) as string;
    expect(s.state.instances[id]).toMatchObject({
      config: { count: 3, step: 1 },
      configVersion: 2,
    });

    const invalid = errorOf(() =>
      s.run({ type: "instance.create", payload: { ...markdown, config: { content: 5 } } }),
    );
    expect(invalid.code).toBe("invalid");
    expect(invalid.issues).toEqual([{ path: ["content"], message: expect.any(String) }]);
  });

  test.each([
    ["an unknown plugin", { plugin: "nope", type: "text" }, "not_found"],
    ["an unknown type", { plugin: "markdown", type: "nope" }, "not_found"],
    ["an incompatible plugin", { plugin: "legacy", type: "text" }, "invalid"],
  ] as const)("instance.create rejects %s", (_, target, code) => {
    const s = setup();
    const error = errorOf(() =>
      s.run({ type: "instance.create", payload: { ...markdown, ...target } }),
    );
    expect(error.code).toBe(code);
    expect(s.state.revision).toBe(0);
  });

  test("instance.create migrates a config in an older version", () => {
    const s = setup();
    const payload = { plugin: "markdown", type: "counter", name: "C", config: { n: "4" } };
    const id = s.run({ type: "instance.create", payload: { ...payload, configVersion: 1 } });
    expect(s.state.instances[id as string]).toMatchObject({
      config: { count: 4, step: 1 },
      configVersion: 2,
    });
    const newer = errorOf(() =>
      s.run({ type: "instance.create", payload: { ...payload, configVersion: 3 } }),
    );
    expect(newer.code).toBe("invalid");
  });

  test("instance.update validates a new config and clears a broken flag", () => {
    const s = setup();
    const id = s.run({ type: "instance.create", payload: markdown }) as string;
    expect(
      errorOf(() => s.run({ type: "instance.update", payload: { id, config: {} } })).code,
    ).toBe("invalid");

    const instance = s.state.instances[id];
    if (!instance) throw new Error("no instance");
    const broken: ShowState = {
      ...s.state,
      instances: { [id]: { ...instance, error: "bad" } },
    };
    const renamed = applyCommand(
      broken,
      { type: "instance.update", payload: { id, name: "Renamed" } },
      s.ctx,
    ).state;
    expect(renamed.instances[id]?.error).toBe("bad");
    const fixed = applyCommand(
      broken,
      { type: "instance.update", payload: { id, config: { content: "ok" } } },
      s.ctx,
    ).state;
    expect(fixed.instances[id]).toEqual({ ...instance, config: { content: "ok" } });
  });

  test("plugin.updateSettings validates and replaces the settings", () => {
    const s = setup();
    expect(s.state.plugins.markdown?.settings).toEqual({ fontScale: 1 });
    s.run({ type: "plugin.updateSettings", payload: { plugin: "markdown", settings: {} } });
    expect(s.state.plugins.markdown?.settings).toEqual({ fontScale: 1 });
    s.run({
      type: "plugin.updateSettings",
      payload: { plugin: "markdown", settings: { fontScale: 2 } },
    });
    expect(s.state.plugins.markdown?.settings).toEqual({ fontScale: 2 });

    const update = (plugin: string, settings: unknown) => () =>
      s.run({ type: "plugin.updateSettings", payload: { plugin, settings: settings as never } });
    const invalid = errorOf(update("markdown", { fontScale: -1 }));
    expect(invalid.code).toBe("invalid");
    expect(invalid.issues?.[0]?.path).toEqual(["fontScale"]);
    expect(errorOf(update("legacy", {})).code).toBe("invalid");
    expect(errorOf(update("nope", {})).code).toBe("not_found");
  });

  test("host commands set plugin state, status and instance state", () => {
    const s = setup();
    const id = s.run({ type: "instance.create", payload: markdown }) as string;
    s.run({ type: "plugin.setState", payload: { plugin: "markdown", state: { n: 1 } } });
    s.run({
      type: "plugin.setStatus",
      payload: { plugin: "markdown", status: "error", error: "boom" },
    });
    s.run({ type: "instance.setState", payload: { id, state: [1, 2] } });
    expect(s.state.plugins.markdown).toMatchObject({
      state: { n: 1 },
      status: "error",
      error: "boom",
    });
    expect(s.state.instances[id]?.state).toEqual([1, 2]);

    s.run({ type: "plugin.setStatus", payload: { plugin: "markdown", status: "ok" } });
    expect(s.state.plugins.markdown?.error).toBeUndefined();
    expect(
      errorOf(() => s.run({ type: "plugin.setState", payload: { plugin: "nope", state: 1 } })).code,
    ).toBe("not_found");
  });

  test("the admin command schema does not accept host commands", () => {
    const parsed = commandSchema.safeParse({
      type: "plugin.setState",
      payload: { plugin: "markdown", state: 1 },
    });
    expect(parsed.success).toBe(false);
  });

  test("live.take and live.interrupt need a playable scene", () => {
    const s = setup();
    const take = (instanceId: string) => () =>
      s.run({ type: "live.take", payload: { instanceId } });
    expect(errorOf(take("nope")).code).toBe("not_found");
    const overlay = s.run({
      type: "instance.create",
      payload: { plugin: "markdown", type: "counter", name: "N", config: { count: 1 } },
    }) as string;
    expect(errorOf(take(overlay)).code).toBe("invalid");
    expect(
      errorOf(() => s.run({ type: "live.interrupt", payload: { instanceId: overlay } })).code,
    ).toBe("invalid");
  });

  test("live.clearInterrupt without an interrupt is invalid", () => {
    const s = setup();
    expect(errorOf(() => s.run({ type: "live.clearInterrupt", payload: {} })).code).toBe("invalid");
  });
});
