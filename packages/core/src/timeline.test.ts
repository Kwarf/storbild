import { describe, expect, test } from "bun:test";
import type { Command } from "./commands.ts";
import { reconcilePlugins } from "./plugins.ts";
import { applyCommand } from "./reducer.ts";
import { createInitialState, type ShowState } from "./schema/state.ts";
import { testCatalog } from "./test/catalog.ts";
import { interimTimeline } from "./timeline.ts";

function setup() {
  let next = 0;
  const ctx = { now: 1_000, newId: () => `id${++next}`, catalog: testCatalog };
  let state = reconcilePlugins(createInitialState(ctx), testCatalog);
  const run = (command: Command) => {
    const outcome = applyCommand(state, command, ctx);
    state = outcome.state;
    return outcome.id as string;
  };
  const scene = () =>
    run({
      type: "instance.create",
      payload: { plugin: "markdown", type: "text", name: "Text", config: { content: "#" } },
    });
  const add = (instanceId: string) => run({ type: "playlist.addItem", payload: { instanceId } });
  return {
    run,
    scene,
    add,
    get state(): ShowState {
      return state;
    },
    set state(value: ShowState) {
      state = value;
    },
  };
}

describe("interimTimeline", () => {
  test("an empty playlist has no main", () => {
    const s = setup();
    expect(interimTimeline(s.state, 5)).toEqual({ mode: "auto", blackout: false });
  });

  test("main is the first enabled item, started now", () => {
    const s = setup();
    const a = s.scene();
    const b = s.scene();
    const first = s.add(a);
    const second = s.add(b);
    s.run({ type: "playlist.updateItem", payload: { id: first, enabled: false } });
    expect(interimTimeline(s.state, 5).main).toEqual({
      instanceId: b,
      itemId: second,
      startedAt: 5,
    });
  });

  test("broken instances and non-scene types are skipped", () => {
    const s = setup();
    const broken = s.scene();
    const overlay = s.run({
      type: "instance.create",
      payload: { plugin: "markdown", type: "counter", name: "Counter", config: { count: 1 } },
    });
    const ok = s.scene();
    s.add(broken);
    s.add(overlay);
    const item = s.add(ok);
    const instance = s.state.instances[broken];
    if (!instance) throw new Error("missing instance");
    s.state = {
      ...s.state,
      instances: { ...s.state.instances, [broken]: { ...instance, error: "broken" } },
    };
    expect(interimTimeline(s.state, 5).main).toEqual({
      instanceId: ok,
      itemId: item,
      startedAt: 5,
    });
  });

  test("an unchanged pick keeps startedAt; reordering starts the new first item", () => {
    const s = setup();
    const a = s.add(s.scene());
    const b = s.add(s.scene());
    s.state = { ...s.state, timeline: interimTimeline(s.state, 5) };
    const same = interimTimeline(s.state, 9);
    expect(same).toBe(s.state.timeline);
    s.run({ type: "playlist.reorder", payload: { itemIds: [b, a] } });
    expect(interimTimeline(s.state, 9).main).toMatchObject({ itemId: b, startedAt: 9 });
  });

  test("the rest of the timeline is kept", () => {
    const s = setup();
    const a = s.scene();
    s.add(a);
    s.state = {
      ...s.state,
      timeline: {
        mode: "override",
        blackout: true,
        interrupt: { instanceId: a, startedAt: 1, dimBelow: true },
      },
    };
    const timeline = interimTimeline(s.state, 5);
    expect(timeline).toMatchObject({
      mode: "override",
      blackout: true,
      interrupt: { dimBelow: true },
    });
    expect(timeline.main?.instanceId).toBe(a);
  });
});
