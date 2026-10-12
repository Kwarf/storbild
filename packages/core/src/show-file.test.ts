import { describe, expect, test } from "bun:test";
import { type Command, type HostCommand, hostCommandSchema } from "./commands.ts";
import { reconcilePlugins } from "./plugins.ts";
import { applyCommand, CommandError } from "./reducer.ts";
import { createInitialState, type ShowState } from "./schema/state.ts";
import { exportShow, parseShowFile, type ShowFile } from "./show-file.ts";
import { testCatalog } from "./test/catalog.ts";

const image = "a".repeat(64);

/** A show with content of every kind, built through commands. */
function buildShow() {
  let next = 0;
  const ctx = { now: 1_000, newId: () => `id${++next}`, catalog: testCatalog };
  let state = reconcilePlugins(createInitialState(ctx), testCatalog);
  const run = (command: Command | HostCommand) => {
    const outcome = applyCommand(state, command, ctx);
    state = outcome.state;
    return outcome.id as string;
  };
  run({
    type: "asset.add",
    payload: { id: image, name: "Logo", mimeType: "image/png", size: 3, createdAt: 5 },
  });
  const text = run({
    type: "instance.create",
    payload: {
      plugin: "markdown",
      type: "text",
      name: "Rules",
      config: { content: "# Rules" },
      background: { assetId: image, fit: "cover" },
    },
  });
  const counter = run({
    type: "instance.create",
    payload: { plugin: "markdown", type: "counter", name: "Count", config: { count: 1 } },
  });
  run({ type: "playlist.addItem", payload: { instanceId: text, durationMs: 5_000 } });
  run({ type: "overlay.place", payload: { instanceId: counter, slot: "top-right" } });
  run({ type: "cue.create", payload: { at: 50_000, action: { type: "take", instanceId: text } } });
  run({
    type: "plugin.updateSettings",
    payload: { plugin: "markdown", settings: { fontScale: 2 } },
  });
  run({ type: "settings.update", payload: { transitionMs: 300 } });
  run({ type: "live.blackout", payload: { on: true } });
  run({ type: "instance.setState", payload: { id: text, state: { runtime: true } } });
  run({ type: "plugin.setState", payload: { plugin: "markdown", state: { runtime: true } } });
  return { state, text, counter };
}

const fresh = () =>
  reconcilePlugins(createInitialState({ now: 0, newId: () => "fresh-theme" }), testCatalog);

function importInto(target: ShowState, file: ShowFile, now = 20_000) {
  const command = hostCommandSchema.parse({ type: "show.import", payload: file });
  return applyCommand(target, command, { now, newId: () => "x", catalog: testCatalog }).state;
}

/** A show file after a trip through JSON, as the server reads it. */
const roundTrip = (file: ShowFile) => {
  const parsed = parseShowFile(JSON.parse(JSON.stringify(file)));
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.file;
};

describe("show files", () => {
  test("an exported show imports with the same content and fresh runtime data", () => {
    const { state, text } = buildShow();
    const file = roundTrip(exportShow(state, 9_000));
    expect(file.exportedAt).toBe(9_000);

    const target = { ...fresh(), revision: 41 };
    const imported = importInto(target, file);
    expect(imported.revision).toBe(42);
    expect(imported.themes).toEqual(state.themes);
    expect(imported.activeThemeId).toBe(state.activeThemeId);
    expect(imported.overlays).toEqual(state.overlays);
    expect(imported.cues).toEqual(state.cues);
    expect(imported.assets).toEqual(state.assets);
    expect(imported.settings).toEqual(state.settings);
    expect(imported.plugins.markdown?.settings).toEqual({ fontScale: 2 });
    expect(imported.playlist.items.map((item) => item.instanceId)).toEqual([text]);
    // Runtime data starts over.
    expect(imported.live).toEqual({ blackout: false });
    expect(imported.playlist.anchorAt).toBe(20_000);
    expect(imported.instances[text]?.state).toBeUndefined();
    expect(imported.plugins.markdown?.state).toBeNull();
    const { state: _, ...content } = state.instances[text] ?? {};
    expect(imported.instances[text]).toEqual(content as never);
  });

  test("unfired cues that have passed are imported as fired", () => {
    const { state } = buildShow();
    const file = exportShow(state, 9_000);
    const imported = importInto(fresh(), file, 60_000);
    expect(imported.cues.map((cue) => cue.fired)).toEqual([true]);
    expect(importInto(fresh(), file, 40_000).cues.map((cue) => cue.fired)).toEqual([undefined]);
  });

  test("instances of plugins this install lacks are kept, broken", () => {
    const { state } = buildShow();
    const file = exportShow(state, 9_000);
    file.plugins.gone = { version: "2.0.0", settings: { a: 1 } };
    file.instances.push({
      id: "gone1",
      plugin: "gone",
      type: "thing",
      name: "Gone",
      config: {},
      configVersion: 1,
    });
    const imported = importInto(fresh(), roundTrip(file));
    expect(imported.plugins.gone).toEqual({
      status: "missing",
      settings: { a: 1 },
      state: null,
      types: {},
    });
    expect(imported.instances.gone1?.error).toBeString();
  });

  test("a file that refers to something it lacks is refused", () => {
    const { state } = buildShow();
    const cases: ((file: ShowFile) => void)[] = [
      (file) => {
        file.instances = file.instances.filter((i) => i.plugin !== "markdown" || i.type !== "text");
      },
      (file) => {
        file.assets = [];
      },
      (file) => {
        file.activeThemeId = "nope";
      },
      (file) => {
        file.instances.push({ ...(file.instances[0] as ShowFile["instances"][number]) });
      },
    ];
    for (const change of cases) {
      const file = structuredClone(exportShow(state, 0));
      change(file);
      expect(() => importInto(fresh(), file)).toThrow(CommandError);
    }
  });

  test("parseShowFile tells other files and newer versions apart", () => {
    const other = parseShowFile({ hello: 1 });
    expect(!other.ok && other.message).toContain("not a Storbild show file");
    const newer = parseShowFile({ format: "storbild-show", version: 2 });
    expect(!newer.ok && newer.message).toContain("newer Storbild");
    const broken = parseShowFile({ format: "storbild-show", version: 1 });
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.issues?.length).toBeGreaterThan(0);
  });
});
