import { describe, expect, test } from "bun:test";
import { type Command, commandSchema, type HostCommand } from "./commands.ts";
import { reconcilePlugins } from "./plugins.ts";
import { applyCommand, CommandError } from "./reducer.ts";
import type { LoadedPlugin, LoadedType, PluginCatalog } from "./schema/plugin.ts";
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

/** A well-formed asset ID. */
const hash = (seed: string) => seed.padEnd(64, "0").replace(/[^0-9a-f]/g, "a");

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
    { type: "cue.create", payload: { at: 5_000, action: { type: "take", instanceId: "nope" } } },
    {
      type: "cue.create",
      payload: { at: 5_000, action: { type: "activateTheme", themeId: "nope" } },
    },
    { type: "cue.update", payload: { id: "nope", at: 5_000 } },
    { type: "cue.delete", payload: { id: "nope" } },
    { type: "asset.update", payload: { id: hash("nope"), name: "x" } },
    { type: "asset.delete", payload: { id: hash("nope") } },
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

  test("settings.update merges into the show settings and validates them", () => {
    const s = setup();
    expect(s.state.settings).toEqual({ defaultDurationMs: 15_000, transitionMs: 800 });
    s.run({ type: "settings.update", payload: { transitionMs: 0 } });
    expect(s.state.settings).toEqual({ defaultDurationMs: 15_000, transitionMs: 0 });
    const invalid = commandSchema.safeParse({
      type: "settings.update",
      payload: { defaultDurationMs: 0 },
    });
    expect(invalid.success).toBe(false);
  });

  test("plugin.remove deletes a missing plugin and its instances, and nothing else", () => {
    const s = setup();
    const id = s.run({ type: "instance.create", payload: markdown }) as string;
    s.run({ type: "playlist.addItem", payload: { instanceId: id } });
    const remove = () => s.run({ type: "plugin.remove", payload: { plugin: "markdown" } });
    expect(errorOf(remove).code).toBe("invalid");
    expect(errorOf(() => s.run({ type: "plugin.remove", payload: { plugin: "nope" } })).code).toBe(
      "not_found",
    );

    const { markdown: _, ...rest } = testCatalog;
    let state = reconcilePlugins(s.state, rest);
    expect(state.plugins.markdown?.status).toBe("missing");
    state = applyCommand(
      state,
      { type: "plugin.remove", payload: { plugin: "markdown" } },
      {
        ...s.ctx,
        catalog: rest,
      },
    ).state;
    expect(state.plugins.markdown).toBeUndefined();
    expect(state.instances).toEqual({});
    expect(state.playlist.items).toEqual([]);
  });

  test("instance.create allows only one instance of a singleton type", () => {
    const markdownPlugin = testCatalog.markdown as LoadedPlugin;
    const types = markdownPlugin.types as Record<string, LoadedType>;
    const catalog: PluginCatalog = {
      markdown: {
        ...markdownPlugin,
        types: { ...types, text: { ...(types.text as LoadedType), singleton: true } },
      },
    };
    const ctx = { now: 0, newId: () => "only", catalog };
    let state = reconcilePlugins(createInitialState(ctx), catalog);
    state = applyCommand(state, { type: "instance.create", payload: markdown }, ctx).state;
    const again = () => applyCommand(state, { type: "instance.create", payload: markdown }, ctx);
    expect(errorOf(again).code).toBe("invalid");
  });
});

describe("cues", () => {
  test("cue.create, cue.update and cue.delete", () => {
    const s = setup();
    const a = s.run({ type: "instance.create", payload: markdown }) as string;
    const b = s.run({ type: "instance.create", payload: markdown }) as string;
    const id = s.run({
      type: "cue.create",
      payload: { at: 5_000, action: { type: "take", instanceId: a } },
    }) as string;
    expect(s.state.cues).toEqual([{ id, at: 5_000, action: { type: "take", instanceId: a } }]);

    const interrupt = {
      type: "interrupt",
      instanceId: b,
      durationMs: 30_000,
      below: "dim",
    } as const;
    s.run({ type: "cue.update", payload: { id, action: interrupt } });
    s.run({ type: "cue.update", payload: { id, at: 6_000 } });
    expect(s.state.cues).toEqual([{ id, at: 6_000, action: interrupt }]);

    s.run({ type: "cue.delete", payload: { id } });
    expect(s.state.cues).toEqual([]);
  });

  test("a cue must be in the future and play a scene", () => {
    const s = setup();
    const id = s.run({ type: "instance.create", payload: markdown }) as string;
    const counter = s.run({
      type: "instance.create",
      payload: { plugin: "markdown", type: "counter", name: "n", config: { count: 1 } },
    }) as string;
    const take = (instanceId: string, at: number) => () =>
      s.run({ type: "cue.create", payload: { at, action: { type: "take", instanceId } } });
    expect(errorOf(take(id, 1_000)).code).toBe("invalid");
    expect(errorOf(take(counter, 5_000)).code).toBe("invalid");
    const cue = take(id, 5_000)() as string;
    expect(errorOf(() => s.run({ type: "cue.update", payload: { id: cue, at: 500 } })).code).toBe(
      "invalid",
    );
  });

  test("a fired cue can be deleted but not changed", () => {
    const s = setup();
    const instanceId = s.run({ type: "instance.create", payload: markdown }) as string;
    const state: ShowState = {
      ...s.state,
      cues: [{ id: "c1", at: 500, action: { type: "take", instanceId }, fired: true }],
    };
    const update = () =>
      applyCommand(state, { type: "cue.update", payload: { id: "c1", at: 9_000 } }, s.ctx);
    expect(errorOf(update).code).toBe("invalid");
    const { state: after } = applyCommand(
      state,
      { type: "cue.delete", payload: { id: "c1" } },
      s.ctx,
    );
    expect(after.cues).toEqual([]);
  });

  test("activateTheme cues need an existing theme", () => {
    const s = setup();
    const themeId = s.state.activeThemeId;
    s.run({
      type: "cue.create",
      payload: { at: 5_000, action: { type: "activateTheme", themeId } },
    });
    expect(s.state.cues).toHaveLength(1);
  });
});

describe("assets", () => {
  const meta = (id: string) => ({
    id,
    name: "logo.png",
    mimeType: "image/png",
    size: 10,
    width: 4,
    height: 2,
    createdAt: 0,
  });

  test("asset.add registers an asset once; asset.update renames it", () => {
    const s = setup();
    const id = hash("1");
    s.run({ type: "asset.add", payload: meta(id) });
    s.run({ type: "asset.add", payload: { ...meta(id), name: "again.png", createdAt: 5 } });
    expect(s.state.assets[id]).toEqual(meta(id));
    s.run({ type: "asset.update", payload: { id, name: "Logo" } });
    expect(s.state.assets[id]?.name).toBe("Logo");
  });

  test("the admin command schema does not accept asset.add", () => {
    const parsed = commandSchema.safeParse({ type: "asset.add", payload: meta(hash("1")) });
    expect(parsed.success).toBe(false);
  });

  test("asset.delete is refused while an instance or theme uses the asset", () => {
    const s = setup();
    const [inConfig, inBackground, inTheme, unused] = ["1", "2", "3", "4"].map(hash) as [
      string,
      string,
      string,
      string,
    ];
    for (const id of [inConfig, inBackground, inTheme, unused]) {
      s.run({ type: "asset.add", payload: meta(id) });
    }
    s.run({
      type: "instance.create",
      payload: { ...markdown, name: "Logo", config: { content: "x", title: inConfig } },
    });
    s.run({
      type: "instance.create",
      payload: { ...markdown, background: { assetId: inBackground, fit: "cover" } },
    });
    const theme = s.state.themes[s.state.activeThemeId];
    if (!theme) throw new Error("no theme");
    const state: ShowState = {
      ...s.state,
      themes: {
        [theme.id]: {
          ...theme,
          fonts: { ...theme.fonts, body: { family: "X", assetIds: [inTheme] } },
        },
      },
    };
    const remove = (id: string) =>
      applyCommand(state, { type: "asset.delete", payload: { id } }, s.ctx);
    const error = errorOf(() => remove(inConfig));
    expect(error.code).toBe("invalid");
    expect(error.message).toContain('instance "Logo"');
    expect(errorOf(() => remove(inBackground)).code).toBe("invalid");
    expect(errorOf(() => remove(inTheme)).message).toContain("theme");
    expect(Object.keys(remove(unused).state.assets)).toEqual([inConfig, inBackground, inTheme]);
  });
});

describe("overlays", () => {
  const counter = { plugin: "markdown", type: "counter", name: "C", config: { count: 1 } };

  function placed(s: ReturnType<typeof setup>) {
    return s.state.overlays.map(({ instanceId, slot, order, visible }) => [
      instanceId,
      slot,
      order,
      visible,
    ]);
  }

  test("overlay.place stacks widgets per slot, appending or at an index", () => {
    const s = setup();
    const [a, b, c] = [1, 2, 3].map(
      () => s.run({ type: "instance.create", payload: counter }) as string,
    ) as [string, string, string];
    s.run({ type: "overlay.place", payload: { instanceId: a, slot: "bottom-right" } });
    s.run({ type: "overlay.place", payload: { instanceId: b, slot: "top" } });
    s.run({
      type: "overlay.place",
      payload: { instanceId: c, slot: "bottom-right", index: 0, visible: false },
    });
    expect(placed(s)).toEqual([
      [b, "top", 0, true],
      [c, "bottom-right", 0, false],
      [a, "bottom-right", 1, true],
    ]);
  });

  test("overlay.place refuses scenes, unknown instances and a second placement", () => {
    const s = setup();
    const scene = s.run({ type: "instance.create", payload: markdown }) as string;
    const widget = s.run({ type: "instance.create", payload: counter }) as string;
    const place = (instanceId: string) =>
      applyCommand(s.state, { type: "overlay.place", payload: { instanceId, slot: "top" } }, s.ctx);
    expect(errorOf(() => place(scene)).code).toBe("invalid");
    expect(errorOf(() => place("nope")).code).toBe("not_found");
    s.run({ type: "overlay.place", payload: { instanceId: widget, slot: "left" } });
    expect(errorOf(() => place(widget)).code).toBe("invalid");
  });

  test("overlay.update moves within and across slots and renumbers both", () => {
    const s = setup();
    const [a, b, c] = [1, 2, 3].map(
      () => s.run({ type: "instance.create", payload: counter }) as string,
    ) as [string, string, string];
    for (const id of [a, b, c]) {
      s.run({ type: "overlay.place", payload: { instanceId: id, slot: "right" } });
    }
    s.run({ type: "overlay.update", payload: { instanceId: c, index: 0 } });
    expect(placed(s).map(([id]) => id)).toEqual([c, a, b]);
    s.run({ type: "overlay.update", payload: { instanceId: a, slot: "left" } });
    expect(placed(s)).toEqual([
      [a, "left", 0, true],
      [c, "right", 0, true],
      [b, "right", 1, true],
    ]);
    // Toggling keeps the position.
    s.run({ type: "overlay.update", payload: { instanceId: c, visible: false } });
    expect(placed(s)[1]).toEqual([c, "right", 0, false]);
    expect(
      errorOf(() =>
        applyCommand(s.state, { type: "overlay.update", payload: { instanceId: "x" } }, s.ctx),
      ).code,
    ).toBe("not_found");
  });

  test("overlay.remove closes the gap", () => {
    const s = setup();
    const [a, b] = [1, 2].map(
      () => s.run({ type: "instance.create", payload: counter }) as string,
    ) as [string, string];
    s.run({ type: "overlay.place", payload: { instanceId: a, slot: "top-bar" } });
    s.run({ type: "overlay.place", payload: { instanceId: b, slot: "top-bar" } });
    s.run({ type: "overlay.remove", payload: { instanceId: a } });
    expect(placed(s)).toEqual([[b, "top-bar", 0, true]]);
  });
});
