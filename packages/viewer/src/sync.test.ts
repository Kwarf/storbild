import { beforeEach, describe, expect, test } from "bun:test";
import { createInitialState, diff, type ShowState } from "@storbild/core";
import { type EventSourceLike, SyncClient } from "./sync.ts";

class FakeEventSource implements EventSourceLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  readonly #listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  fail(closed: boolean) {
    this.readyState = closed ? 2 : 0;
    this.onerror?.(new Event("error"));
  }

  emit(type: string, data: string, lastEventId = "") {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data, lastEventId }));
    }
  }

  snapshot(state: ShowState) {
    this.emit("snapshot", JSON.stringify(state), String(state.revision));
  }

  patch(before: ShowState, after: ShowState) {
    this.emit("patch", JSON.stringify(diff(before, after)), String(after.revision));
  }
}

/** Timers driven by hand: `advance(ms)` runs everything due. */
class FakeTimers {
  now = 0;
  #next = 0;
  readonly #pending = new Map<number, { at: number; fn: () => void }>();

  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.#next;
    this.#pending.set(id, { at: this.now + ms, fn });
    return id;
  };

  clearTimeout = (handle: unknown) => {
    this.#pending.delete(handle as number);
  };

  async advance(ms: number) {
    const until = this.now + ms;
    for (;;) {
      const due = [...this.#pending]
        .filter(([, t]) => t.at <= until)
        .sort(([, a], [, b]) => a.at - b.at)[0];
      if (!due) break;
      this.#pending.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
      // Let async work started by the timer (a probe) settle.
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    this.now = until;
  }
}

let sources: FakeEventSource[];
let timers: FakeTimers;
let states: ShowState[];
let reloads: number;
let connects: number;
let probeOk: boolean | "throw";
let client: SyncClient;
const base = createInitialState({ now: 0, newId: () => "theme" });

const last = () => sources.at(-1) as FakeEventSource;
const bump = (state: ShowState, change: Partial<ShowState> = {}): ShowState => ({
  ...state,
  ...change,
  revision: state.revision + 1,
});

beforeEach(() => {
  sources = [];
  timers = new FakeTimers();
  states = [];
  reloads = 0;
  connects = 0;
  probeOk = false;
  client = new SyncClient({
    url: "/events",
    probeUrl: "/time",
    openEventSource: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
    fetch: async () => {
      if (probeOk === "throw") throw new TypeError("network");
      return { ok: probeOk };
    },
    timers,
    reload: () => reloads++,
    onState: (state) => states.push(state),
    onConnect: () => connects++,
    log: () => {},
  });
  client.start();
});

describe("SyncClient", () => {
  test("takes a snapshot, then applies patches", () => {
    last().open();
    last().snapshot(base);
    const next = bump(base, { activeThemeId: "other" });
    last().patch(base, next);
    expect(states).toEqual([base, next]);
    expect(client.state).toEqual(next);
    expect(connects).toBe(1);
    expect(client.connected).toBe(true);
  });

  test("a revision gap opens a fresh stream", () => {
    last().snapshot(base);
    const skipped = bump(bump(base));
    last().patch(base, skipped);
    expect(sources).toHaveLength(2);
    expect(sources[0]?.closed).toBe(true);
    expect(states).toEqual([base]);
    // The fresh stream's snapshot is taken as is.
    last().snapshot(skipped);
    expect(client.state).toEqual(skipped);
  });

  test("a patch that doesn't apply opens a fresh stream", () => {
    last().snapshot(base);
    last().emit("patch", JSON.stringify([{ op: "remove", path: "/nope" }]), "1");
    expect(sources).toHaveLength(2);
    expect(states).toEqual([base]);
  });

  test("events from a replaced stream are ignored", () => {
    const first = last();
    first.snapshot(base);
    first.patch(base, bump(bump(base)));
    first.snapshot(bump(base));
    expect(states).toEqual([base]);
  });

  test("a stream the browser closed is reopened with backoff, reset on open", async () => {
    last().fail(true);
    await timers.advance(999);
    expect(sources).toHaveLength(1);
    await timers.advance(1);
    expect(sources).toHaveLength(2);
    last().fail(true);
    await timers.advance(1999);
    expect(sources).toHaveLength(2);
    await timers.advance(1);
    expect(sources).toHaveLength(3);
    last().open();
    last().fail(true);
    await timers.advance(1000);
    expect(sources).toHaveLength(4);
  });

  test("a stream the browser is still retrying is left alone", async () => {
    last().fail(false);
    await timers.advance(30_000);
    expect(sources).toHaveLength(1);
  });

  test("silence with the server reachable reloads the page", async () => {
    last().snapshot(base);
    probeOk = true;
    await timers.advance(59_999);
    expect(reloads).toBe(0);
    await timers.advance(1);
    expect(reloads).toBe(1);
  });

  test("silence with the server unreachable opens a new stream and keeps waiting", async () => {
    last().snapshot(base);
    probeOk = "throw";
    await timers.advance(60_000);
    expect(reloads).toBe(0);
    expect(sources).toHaveLength(2);
    probeOk = false;
    await timers.advance(60_000);
    expect(reloads).toBe(0);
    expect(sources).toHaveLength(3);
  });

  test("pings keep the watchdog quiet", async () => {
    probeOk = true;
    for (let i = 0; i < 10; i++) {
      await timers.advance(15_000);
      last().emit("ping", "1");
    }
    expect(reloads).toBe(0);
  });

  test("stop closes the stream and cancels timers", async () => {
    probeOk = true;
    client.stop();
    expect(last().closed).toBe(true);
    await timers.advance(120_000);
    expect(reloads).toBe(0);
    expect(sources).toHaveLength(1);
  });
});
