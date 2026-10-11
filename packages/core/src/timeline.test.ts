import { describe, expect, test } from "bun:test";
import type { Command } from "./commands.ts";
import { reconcilePlugins } from "./plugins.ts";
import { applyCommand } from "./reducer.ts";
import type { PlaylistItem } from "./schema/playlist.ts";
import { createInitialState, type ShowState } from "./schema/state.ts";
import { testCatalog } from "./test/catalog.ts";
import {
  inWindow,
  isPlayableScene,
  nextBoundary,
  resolveTimeline,
  rotationAt,
} from "./timeline.ts";

type ItemSpec = Omit<PlaylistItem, "instanceId" | "enabled"> & { enabled?: boolean };

/**
 * A show with one markdown instance per playlist item, named like the item. Commands run at
 * `s.now`, which tests move.
 */
function setup(items: ItemSpec[] = [], anchorAt = 0) {
  let next = 0;
  const ctx = { now: 0, newId: () => `id${++next}`, catalog: testCatalog };
  let state = reconcilePlugins(createInitialState(ctx), testCatalog);
  const run = (command: Command) => {
    const outcome = applyCommand(state, command, ctx);
    state = outcome.state;
    return outcome.id as string;
  };
  const scene = (name = "Text") =>
    run({
      type: "instance.create",
      payload: { plugin: "markdown", type: "text", name, config: { content: "#" } },
    });
  const playlist = items.map(({ enabled = true, ...item }) => ({
    ...item,
    instanceId: scene(item.id),
    enabled,
  }));
  state = { ...state, playlist: { items: playlist, anchorAt } };
  return {
    run,
    scene,
    /** The instance shown by an item. */
    of: (itemId: string) => playlist.find((item) => item.id === itemId)?.instanceId as string,
    at(now: number) {
      ctx.now = now;
      return this;
    },
    resolve: (t: number) => resolveTimeline(state, t),
    get state(): ShowState {
      return state;
    },
    set state(value: ShowState) {
      state = value;
    },
  };
}

const abc = () => [
  { id: "A", durationMs: 10 },
  { id: "B", durationMs: 20 },
  { id: "C", durationMs: 30 },
];

/** What a rotation item looks like on the timeline. */
const on = (s: ReturnType<typeof setup>, itemId: string, startedAt: number, endsAt: number) => ({
  instanceId: s.of(itemId),
  itemId,
  startedAt,
  endsAt,
});
const upNext = (s: ReturnType<typeof setup>, itemId: string, startsAt: number) => ({
  instanceId: s.of(itemId),
  itemId,
  startsAt,
});

/** The rotation by stepping one item at a time, as the reference for `rotationAt`. */
function naiveItemAt(state: ShowState, t: number): string | undefined {
  const { items, anchorAt, anchorItemId } = state.playlist;
  let c = anchorAt;
  let p = Math.max(
    items.findIndex((item) => item.id === anchorItemId),
    0,
  );
  for (let guard = 0; guard < 1_000_000; guard++) {
    const k = [...items.keys()].find((k) => {
      const item = items[(p + k) % items.length] as PlaylistItem;
      return item.enabled && isPlayableScene(state, item.instanceId) && inWindow(item, c);
    });
    if (k === undefined) {
      c += 1;
      continue;
    }
    const item = items[(p + k) % items.length] as PlaylistItem;
    const duration = item.durationMs as number;
    if (t < c + duration) return c <= t ? item.id : undefined;
    c += duration;
    p = (p + k + 1) % items.length;
  }
  throw new Error("no convergence");
}

describe("resolveTimeline: rotation", () => {
  test("an empty playlist shows only the background", () => {
    expect(setup().resolve(5)).toEqual({ mode: "auto", blackout: false });
  });

  test("an all-disabled playlist shows only the background", () => {
    const s = setup(abc().map((item) => ({ ...item, enabled: false })));
    expect(s.resolve(5)).toEqual({ mode: "auto", blackout: false });
  });

  test("loops through the items from the anchor, announcing the next one", () => {
    const s = setup(abc());
    expect(s.resolve(0)).toEqual({
      mode: "auto",
      main: on(s, "A", 0, 10),
      next: upNext(s, "B", 10),
      blackout: false,
    });
    expect(s.resolve(25)).toMatchObject({ main: on(s, "B", 10, 30), next: upNext(s, "C", 30) });
    expect(s.resolve(59)).toMatchObject({ main: on(s, "C", 30, 60), next: upNext(s, "A", 60) });
    expect(s.resolve(60)).toMatchObject({ main: on(s, "A", 60, 70) });
    expect(s.resolve(6_000_015)).toMatchObject({ main: on(s, "B", 6_000_010, 6_000_030) });
  });

  test("is deterministic: the same state and time give the same timeline", () => {
    const s = setup(abc());
    expect(s.resolve(12_345)).toEqual(s.resolve(12_345));
  });

  test("starts at the anchor item, and has nothing on air before the anchor", () => {
    const s = setup(abc(), 100);
    s.state = { ...s.state, playlist: { ...s.state.playlist, anchorItemId: "B" } };
    expect(s.resolve(100)).toMatchObject({ main: on(s, "B", 100, 120) });
    expect(s.resolve(150)).toMatchObject({ main: on(s, "A", 150, 160) });
    expect(s.resolve(50)).toEqual({ mode: "auto", next: upNext(s, "B", 100), blackout: false });
  });

  test("an unknown anchor item starts from the first item", () => {
    const s = setup(abc());
    s.state = { ...s.state, playlist: { ...s.state.playlist, anchorItemId: "gone" } };
    expect(s.resolve(0).main).toEqual(on(s, "A", 0, 10));
  });

  test("skips disabled items, broken instances and non-scene types", () => {
    const s = setup([...abc(), { id: "D", durationMs: 5 }, { id: "E", durationMs: 5 }]);
    const counter = s.run({
      type: "instance.create",
      payload: { plugin: "markdown", type: "counter", name: "N", config: { count: 1 } },
    });
    const items = s.state.playlist.items.map((item) => {
      if (item.id === "A") return { ...item, enabled: false };
      if (item.id === "D") return { ...item, instanceId: counter };
      return item;
    });
    const c = s.of("C");
    s.state = {
      ...s.state,
      playlist: { ...s.state.playlist, items },
      instances: {
        ...s.state.instances,
        [c]: { ...(s.state.instances[c] as ShowState["instances"][string]), error: "broken" },
      },
    };
    // Only B and E remain: B 0–20, E 20–25.
    expect(s.resolve(0).main).toEqual(on(s, "B", 0, 20));
    expect(s.resolve(22).main).toEqual(on(s, "E", 20, 25));
    expect(s.resolve(25).main).toEqual(on(s, "B", 25, 45));
  });

  test("a window that opens joins mid-rotation; an item started before it closes plays out", () => {
    // B is active in [100, 200). A, C until 100: A 0, C 10, A 40, C 50, A 80, C 90 (B not yet).
    const s = setup([
      { id: "A", durationMs: 10 },
      { id: "B", durationMs: 20, activeFrom: 100, activeUntil: 200 },
      { id: "C", durationMs: 30 },
    ]);
    expect(s.resolve(95).main).toEqual(on(s, "C", 90, 120));
    expect(s.resolve(125)).toMatchObject({ main: on(s, "A", 120, 130), next: upNext(s, "B", 130) });
    expect(s.resolve(135).main).toEqual(on(s, "B", 130, 150));
    // A 180–190, then B starts at 190, still inside its window, and plays out past 200.
    expect(s.resolve(205).main).toEqual(on(s, "B", 190, 210));
    // A 240–250, then B is skipped: its window has closed.
    expect(s.resolve(245)).toMatchObject({ main: on(s, "A", 240, 250), next: upNext(s, "C", 250) });
  });

  test("with nothing in its window, waits for the next window to open", () => {
    const s = setup([{ id: "A", durationMs: 30, activeFrom: 100, activeUntil: 200 }]);
    expect(s.resolve(50)).toEqual({ mode: "auto", next: upNext(s, "A", 100), blackout: false });
    expect(s.resolve(100).main).toEqual(on(s, "A", 100, 130));
    // The last start inside the window is at 190.
    expect(s.resolve(215)).toMatchObject({ main: on(s, "A", 190, 220) });
    expect(s.resolve(215).next).toBeUndefined();
    expect(s.resolve(250)).toEqual({ mode: "auto", blackout: false });
  });

  test("matches stepping item by item, with windows, across many cycles", () => {
    const s = setup([
      { id: "A", durationMs: 7 },
      { id: "B", durationMs: 13, activeFrom: 500, activeUntil: 2_000 },
      { id: "C", durationMs: 3, activeUntil: 5_000 },
      { id: "D", durationMs: 11, activeFrom: 1_500 },
      { id: "E", durationMs: 5, enabled: false },
    ]);
    s.state = { ...s.state, playlist: { ...s.state.playlist, anchorItemId: "C" } };
    for (let t = 0; t < 8_000; t += 37) {
      expect(rotationAt(s.state, t).current?.item.id).toBe(naiveItemAt(s.state, t));
    }
  });

  test("an anchor from days ago resolves quickly", () => {
    const s = setup(abc(), -5 * 24 * 3_600_000);
    const started = performance.now();
    expect(s.resolve(0).main).toEqual(on(s, "A", 0, 10));
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe("resolveTimeline: live control", () => {
  test("a timed take replaces main, then the rotation continues after the item it replaced", () => {
    const s = setup(abc());
    const x = s.scene("X");
    s.at(15).run({ type: "live.take", payload: { instanceId: x, durationMs: 100 } });
    expect(s.resolve(20)).toEqual({
      mode: "override",
      main: { instanceId: x, startedAt: 15, endsAt: 115 },
      next: upNext(s, "C", 115),
      blackout: false,
    });
    expect(s.resolve(115)).toMatchObject({
      mode: "auto",
      main: on(s, "C", 115, 145),
      next: upNext(s, "A", 145),
    });
  });

  test("a take without a duration holds until resumed, with no next", () => {
    const s = setup(abc());
    const x = s.scene("X");
    s.at(15).run({ type: "live.take", payload: { instanceId: x } });
    expect(s.resolve(10_000)).toEqual({
      mode: "override",
      main: { instanceId: x, startedAt: 15 },
      blackout: false,
    });
    s.at(500).run({ type: "live.resume", payload: {} });
    expect(s.resolve(500)).toMatchObject({ mode: "auto", main: on(s, "C", 500, 530) });
  });

  test("resuming a timed take early continues the rotation now", () => {
    const s = setup(abc());
    const x = s.scene("X");
    s.at(15).run({ type: "live.take", payload: { instanceId: x, durationMs: 100 } });
    s.at(40).run({ type: "live.resume", payload: {} });
    expect(s.resolve(40).main).toEqual(on(s, "C", 40, 70));
  });

  test("resume without live control changes nothing", () => {
    const s = setup(abc());
    const before = s.state;
    s.at(15).run({ type: "live.resume", payload: {} });
    expect(s.state.playlist).toEqual(before.playlist);
    expect(s.resolve(15).main).toEqual(on(s, "B", 10, 30));
  });

  test("an interrupt pauses the rotation, dims, and then continues with the next item", () => {
    const s = setup(abc());
    const y = s.scene("Y");
    s.at(15).run({
      type: "live.interrupt",
      payload: { instanceId: y, durationMs: 50, dimBelow: true },
    });
    expect(s.resolve(20)).toEqual({
      mode: "override",
      // B stays on air under the interrupt, past its own end at 30.
      main: on(s, "B", 10, 65),
      next: upNext(s, "C", 65),
      interrupt: { instanceId: y, startedAt: 15, endsAt: 65, dimBelow: true },
      blackout: false,
    });
    expect(s.resolve(65)).toMatchObject({ mode: "auto", main: on(s, "C", 65, 95) });
    expect(s.resolve(65).interrupt).toBeUndefined();
  });

  test("dimBelow defaults to false", () => {
    const s = setup(abc());
    s.at(15).run({ type: "live.interrupt", payload: { instanceId: s.scene("Y") } });
    expect(s.resolve(20).interrupt?.dimBelow).toBe(false);
  });

  test("dismissing an interrupt early continues with the next item now", () => {
    const s = setup(abc());
    const y = s.scene("Y");
    s.at(15).run({ type: "live.interrupt", payload: { instanceId: y } });
    expect(s.resolve(1_000)).toMatchObject({ mode: "override", main: { itemId: "B" } });
    expect(s.resolve(1_000).next).toBeUndefined();
    s.at(1_000).run({ type: "live.clearInterrupt", payload: {} });
    expect(s.resolve(1_000)).toMatchObject({ mode: "auto", main: on(s, "C", 1_000, 1_030) });
  });

  test("an interrupt over an empty main layer keeps the rotation from starting", () => {
    const s = setup([{ id: "A", durationMs: 30, activeFrom: 100 }]);
    const y = s.scene("Y");
    s.at(50).run({ type: "live.interrupt", payload: { instanceId: y, durationMs: 100 } });
    expect(s.resolve(120)).toMatchObject({ mode: "override", next: upNext(s, "A", 150) });
    expect(s.resolve(120).main).toBeUndefined();
    expect(s.resolve(150).main).toEqual(on(s, "A", 150, 180));
  });

  test("an interrupt during a take ends the take with it", () => {
    const s = setup(abc());
    const x = s.scene("X");
    const y = s.scene("Y");
    s.at(15).run({ type: "live.take", payload: { instanceId: x, durationMs: 1_000 } });
    s.at(20).run({ type: "live.interrupt", payload: { instanceId: y, durationMs: 10 } });
    expect(s.resolve(25).main).toEqual({ instanceId: x, startedAt: 15, endsAt: 30 });
    expect(s.resolve(30).main).toEqual(on(s, "C", 30, 60));
  });

  test("blackout covers everything while the rotation keeps advancing", () => {
    const s = setup(abc());
    s.at(5).run({ type: "live.blackout", payload: { on: true } });
    expect(s.resolve(25)).toMatchObject({ blackout: true, main: on(s, "B", 10, 30) });
    expect(s.resolve(65)).toMatchObject({ blackout: true, main: on(s, "A", 60, 70) });
    s.run({ type: "live.blackout", payload: { on: false } });
    expect(s.resolve(65).blackout).toBe(false);
  });

  test("deleting an instance that is live clears it", () => {
    const s = setup(abc());
    const x = s.scene("X");
    s.at(15).run({ type: "live.take", payload: { instanceId: x } });
    s.run({ type: "instance.delete", payload: { id: x } });
    expect(s.state.live.main).toBeUndefined();
  });
});

describe("nextBoundary", () => {
  test("is the earliest of the next start and the main and interrupt ends", () => {
    const s = setup(abc());
    expect(nextBoundary(s.resolve(15))).toBe(30);
    s.at(15).run({ type: "live.interrupt", payload: { instanceId: s.scene("Y"), durationMs: 5 } });
    expect(nextBoundary(s.resolve(15))).toBe(20);
  });

  test("is undefined when nothing will change", () => {
    const s = setup(abc());
    expect(nextBoundary(setup().resolve(15))).toBeUndefined();
    s.at(15).run({ type: "live.take", payload: { instanceId: s.scene("X") } });
    expect(nextBoundary(s.resolve(15))).toBeUndefined();
  });
});
