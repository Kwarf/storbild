import { describe, expect, test } from "bun:test";
import type { Command } from "./commands.ts";
import { reconcilePlugins } from "./plugins.ts";
import { applyCommand } from "./reducer.ts";
import { settle } from "./schedule.ts";
import type { Cue } from "./schema/cue.ts";
import type { PluginCatalog } from "./schema/plugin.ts";
import { createInitialState, type ShowState } from "./schema/state.ts";
import { testCatalog } from "./test/catalog.ts";

// `markdown/text` lasts as many seconds as its content is long, or misbehaves on request.
const markdown = testCatalog.markdown as NonNullable<PluginCatalog[string]>;
const text = markdown.types?.text as NonNullable<NonNullable<typeof markdown.types>["text"]>;
const catalog: PluginCatalog = {
  ...testCatalog,
  markdown: {
    ...markdown,
    types: {
      ...markdown.types,
      text: {
        ...text,
        duration: (config, settings) => {
          const { content } = config as { content: string };
          if (content === "throw") throw new Error("boom");
          if (content === "negative") return -1;
          if (content === "nan") return Number.NaN;
          return content.length * 1_000 * (settings as { fontScale: number }).fontScale;
        },
      },
    },
  },
};

/** A show where every command is settled, as the server does. */
function setup() {
  let next = 0;
  const ctx = { now: 0, newId: () => `id${++next}`, catalog };
  let state = settle(
    createInitialState(ctx),
    reconcilePlugins(createInitialState(ctx), catalog),
    ctx,
  );
  const s = {
    at(now: number) {
      ctx.now = now;
      return s;
    },
    run(command: Command) {
      const outcome = applyCommand(state, command, ctx);
      state = settle(state, outcome.state, ctx);
      return outcome.id as string;
    },
    /** Settles at the current time without a command, like the server's timer. */
    tick() {
      state = settle(state, state, ctx);
    },
    scene(content = "#") {
      return s.run({
        type: "instance.create",
        payload: { plugin: "markdown", type: "text", name: content, config: { content } },
      });
    },
    add(instanceId: string, durationMs?: number) {
      return s.run({
        type: "playlist.addItem",
        payload: { instanceId, ...(durationMs !== undefined && { durationMs }) },
      });
    },
    get state(): ShowState {
      return state;
    },
    set state(value: ShowState) {
      state = value;
    },
  };
  return s;
}

/** A, B, C of 10, 20 and 30 s from time 0. */
function abc() {
  const s = setup();
  const ids = [s.add(s.scene("x".repeat(10))), s.add(s.scene("x".repeat(20)))];
  ids.push(s.add(s.scene("x".repeat(30))));
  return { s, a: ids[0] as string, b: ids[1] as string, c: ids[2] as string };
}

const durations = (state: ShowState) => state.playlist.items.map((item) => item.resolvedDurationMs);

describe("settle: durations", () => {
  test("the item override wins, then the type's duration, then the default", () => {
    const s = setup();
    s.add(s.scene("abc"));
    s.add(s.scene("abc"), 4_000);
    s.add(s.scene("abc"));
    const overlay = s.run({
      type: "instance.create",
      payload: { plugin: "markdown", type: "counter", name: "N", config: { count: 1 } },
    });
    s.add(overlay);
    expect(durations(s.state)).toEqual([3_000, 4_000, 3_000, 15_000]);
  });

  test("a duration that throws or isn't a positive number falls back to the default", () => {
    const s = setup();
    for (const content of ["throw", "negative", "nan"]) s.add(s.scene(content));
    expect(durations(s.state)).toEqual([15_000, 15_000, 15_000]);
  });

  test("follows config and settings changes", () => {
    const s = setup();
    const id = s.scene("ab");
    s.add(id);
    s.run({ type: "instance.update", payload: { id, config: { content: "abcd" } } });
    expect(durations(s.state)).toEqual([4_000]);
    s.run({
      type: "plugin.updateSettings",
      payload: { plugin: "markdown", settings: { fontScale: 2 } },
    });
    expect(durations(s.state)).toEqual([8_000]);
  });

  test("the show's default duration applies and re-anchors the rotation when it changes", () => {
    const s = setup();
    const overlay = s.run({
      type: "instance.create",
      payload: { plugin: "markdown", type: "counter", name: "N", config: { count: 1 } },
    });
    const a = s.add(s.scene("throw"));
    s.add(overlay);
    s.at(5_000).run({ type: "settings.update", payload: { defaultDurationMs: 8_000 } });
    expect(durations(s.state)).toEqual([8_000, 8_000]);
    // The item on air keeps playing with its new length.
    expect(s.state.timeline.main).toMatchObject({ itemId: a, startedAt: 0, endsAt: 8_000 });
  });
});

describe("settle: the rotation across edits", () => {
  test("the first item starts when it is added", () => {
    const s = setup();
    s.at(500).add(s.scene("x"));
    expect(s.state.timeline.main).toMatchObject({ startedAt: 500, endsAt: 1_500 });
  });

  test("adding an item keeps the item on air", () => {
    const { s, b } = abc();
    s.at(15_000).add(s.scene("x"));
    expect(s.state.timeline.main).toMatchObject({ itemId: b, startedAt: 10_000, endsAt: 30_000 });
  });

  test("changing the current item's duration keeps it on air with the new end", () => {
    const { s, b } = abc();
    s.at(15_000).run({ type: "playlist.updateItem", payload: { id: b, durationMs: 50_000 } });
    expect(s.state.timeline.main).toMatchObject({ itemId: b, startedAt: 10_000, endsAt: 60_000 });
  });

  test("a shortened item that has already run its new length ends now", () => {
    const { s, b, c } = abc();
    s.at(25_000).run({ type: "playlist.updateItem", payload: { id: b, durationMs: 5_000 } });
    // The anchor stays at B's start, so the rotation has moved on to C at 15 s.
    expect(s.state.timeline.main).toMatchObject({ itemId: c, startedAt: 15_000 });
  });

  test("removing or disabling the current item continues with the next one now", () => {
    const { s, b, c } = abc();
    s.at(15_000).run({ type: "playlist.removeItem", payload: { id: b } });
    expect(s.state.timeline.main).toMatchObject({ itemId: c, startedAt: 15_000, endsAt: 45_000 });

    const t = abc();
    t.s.at(15_000).run({ type: "playlist.updateItem", payload: { id: t.b, enabled: false } });
    expect(t.s.state.timeline.main).toMatchObject({ itemId: t.c, startedAt: 15_000 });
  });

  test("reordering keeps the item on air and follows the new order after it", () => {
    const { s, a, b, c } = abc();
    s.at(15_000).run({ type: "playlist.reorder", payload: { itemIds: [b, a, c] } });
    expect(s.state.timeline.main).toMatchObject({ itemId: b, startedAt: 10_000 });
    expect(s.state.timeline.next).toMatchObject({ itemId: a, startsAt: 30_000 });
  });

  test("unrelated changes don't move the anchor", () => {
    const { s } = abc();
    const playlist = s.state.playlist;
    s.at(15_000).scene("unused");
    expect(s.state.playlist).toBe(playlist);
  });

  test("during a take, removing the anchor item moves the anchor to the item after it", () => {
    const { s, a, c } = abc();
    s.at(15_000).run({
      type: "live.take",
      payload: { instanceId: s.scene("x"), durationMs: 5_000 },
    });
    expect(s.state.playlist).toMatchObject({ anchorAt: 20_000, anchorItemId: c });
    s.run({ type: "playlist.removeItem", payload: { id: c } });
    expect(s.state.playlist).toMatchObject({ anchorAt: 20_000, anchorItemId: a });
    expect(s.state.timeline).toMatchObject({
      mode: "override",
      next: { itemId: a, startsAt: 20_000 },
    });
  });
});

describe("settle: live control ends", () => {
  test("a take that has ended is removed at the next settle", () => {
    const { s, c } = abc();
    s.at(15_000).run({
      type: "live.take",
      payload: { instanceId: s.scene("x"), durationMs: 5_000 },
    });
    expect(s.state.live.main).toBeDefined();
    s.at(20_000).tick();
    expect(s.state.live.main).toBeUndefined();
    expect(s.state.timeline).toMatchObject({
      mode: "auto",
      main: { itemId: c, startedAt: 20_000 },
    });
  });
});

describe("settle: cues", () => {
  const cue = (id: string, at: number, action: Cue["action"]): Cue => ({ id, at, action });

  test("fires a due cue once, from its own time, and leaves future cues", () => {
    const { s } = abc();
    const x = s.scene("x");
    s.state = {
      ...s.state,
      cues: [
        cue("late", 90_000, { type: "take", instanceId: x }),
        cue("due", 14_000, { type: "interrupt", instanceId: x, durationMs: 10_000 }),
      ],
    };
    s.at(15_000).tick();
    expect(s.state.timeline.interrupt).toEqual({
      instanceId: x,
      startedAt: 14_000,
      endsAt: 24_000,
      below: "hide",
    });
    expect(s.state.cues.map((c) => [c.id, c.fired ?? false])).toEqual([
      ["late", false],
      ["due", true],
    ]);
    const fired = s.state;
    s.at(16_000).tick();
    expect(s.state.live).toEqual(fired.live);
  });

  test("an overdue take that would have ended is marked fired without effect", () => {
    const { s } = abc();
    const x = s.scene("x");
    s.state = {
      ...s.state,
      cues: [cue("old", 1_000, { type: "take", instanceId: x, durationMs: 2_000 })],
    };
    const playlist = s.state.playlist;
    s.at(15_000).tick();
    expect(s.state.cues[0]?.fired).toBe(true);
    expect(s.state.live.main).toBeUndefined();
    expect(s.state.playlist).toEqual(playlist);
  });

  test("activates a theme, and skips an unknown theme or unplayable instance", () => {
    const { s } = abc();
    const other = {
      ...(s.state.themes[s.state.activeThemeId] as ShowState["themes"][string]),
      id: "other",
    };
    s.state = {
      ...s.state,
      themes: { ...s.state.themes, other },
      cues: [
        cue("t1", 1_000, { type: "activateTheme", themeId: "missing" }),
        cue("t2", 2_000, { type: "activateTheme", themeId: "other" }),
        cue("t3", 3_000, { type: "take", instanceId: "missing" }),
      ],
    };
    s.at(5_000).tick();
    expect(s.state.activeThemeId).toBe("other");
    expect(s.state.live.main).toBeUndefined();
    expect(s.state.cues.every((c) => c.fired)).toBe(true);
  });
});
