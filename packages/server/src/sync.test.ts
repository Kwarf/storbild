import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch, type JsonPatchOp, type ShowState } from "@storbild/core";
import { type StartOptions, type Storbild, start } from "./main.ts";
import { adminHeaders, FakeClock, SseClient, testConfig } from "./testing.ts";

const BUFFER_SIZE = 4;

let dataDir: string;
let storbild: Storbild;
/** A logged-in admin session, for API calls. */
let auth: Record<string, string>;
const clients: SseClient[] = [];

async function boot(options: StartOptions = {}) {
  storbild = await start(
    testConfig({
      STORBILD_VIEWER_PORT: "0",
      STORBILD_ADMIN_PORT: "0",
      STORBILD_DATA_DIR: dataDir,
    }),
    { bufferSize: BUFFER_SIZE, stream: { heartbeatMs: 100 }, ...options },
  );
  auth = await adminHeaders(storbild.admin.url);
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "storbild-"));
  await boot();
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await storbild.stop();
  rmSync(dataDir, { recursive: true });
});

async function connect(lastEventId?: string, path = "/events") {
  const client = await SseClient.connect(new URL(path, storbild.viewer.url), lastEventId);
  clients.push(client);
  return client;
}

async function command(type: string, payload: unknown) {
  const res = await fetch(new URL("/api/commands", storbild.admin.url), {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ type, payload }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { revision: number; id?: string };
}

const createInstance = (name: string) =>
  command("instance.create", { plugin: "markdown", type: "text", name, config: { content: name } });

async function snapshotOf(client: SseClient) {
  const frame = await client.nextEvent();
  expect(frame.event).toBe("snapshot");
  const state = JSON.parse(frame.data) as ShowState;
  expect(Number(frame.id)).toBe(state.revision);
  return state;
}

async function patchOf(client: SseClient) {
  const frame = await client.nextEvent();
  expect(frame.event).toBe("patch");
  return { revision: Number(frame.id), ops: JSON.parse(frame.data) as JsonPatchOp[] };
}

describe("GET /events", () => {
  test("sends retry and an SSE content type, then a snapshot", async () => {
    const client = await connect();
    expect(client.headers.get("Content-Type")).toStartWith("text/event-stream");
    expect(client.headers.get("Cache-Control")).toBe("no-cache");
    expect(client.headers.get("Content-Encoding")).toBeNull();
    expect(await client.next()).toEqual({ retry: "2000" });
    expect(await snapshotOf(client)).toEqual(storbild.hub.state);
  });

  test("sends a heartbeat event without an ID, which browsers can observe", async () => {
    const client = await connect();
    await snapshotOf(client);
    expect(await client.next()).toEqual({ event: "ping", data: "1" });
  });

  test("adding the first playlist item puts it on air in the same revision", async () => {
    const { id } = await createInstance("Rules");
    const client = await connect();
    await snapshotOf(client);
    const { id: itemId } = await command("playlist.addItem", { instanceId: id });
    const { ops } = await patchOf(client);
    const startedAt = storbild.hub.state.timeline.main?.startedAt as number;
    expect(ops).toContainEqual({
      op: "add",
      path: "/timeline/main",
      value: { instanceId: id, itemId, startedAt, endsAt: startedAt + 15_000 },
    });
  });

  test("streams patches that rebuild the server state", async () => {
    const client = await connect();
    let state = await snapshotOf(client);
    const { id } = await createInstance("Rules");
    await command("playlist.addItem", { instanceId: id });
    await command("instance.update", { id, name: "House rules" });
    for (let expected = state.revision + 1; expected <= storbild.hub.state.revision; expected++) {
      const patch = await patchOf(client);
      expect(patch.revision).toBe(expected);
      state = applyPatch(state, patch.ops);
    }
    expect(state).toEqual(storbild.hub.state);
  });

  test("patches target the narrowest path", async () => {
    const { id } = await createInstance("Rules");
    const client = await connect();
    await snapshotOf(client);
    await command("instance.update", { id, name: "Welcome" });
    expect((await patchOf(client)).ops).toEqual([
      { op: "replace", path: "/revision", value: storbild.hub.state.revision },
      { op: "replace", path: `/instances/${id}/name`, value: "Welcome" },
    ]);
  });

  test("resumes with exactly the missed patches after Last-Event-ID", async () => {
    const first = await connect();
    let state = await snapshotOf(first);
    await createInstance("A");
    const seen = await patchOf(first);
    state = applyPatch(state, seen.ops);
    first.close();

    await createInstance("B");
    await createInstance("C");

    const second = await connect(String(seen.revision));
    expect(await second.next()).toEqual({ retry: "2000" });
    const missed = [await patchOf(second), await patchOf(second)];
    expect(missed.map((p) => p.revision)).toEqual([seen.revision + 1, seen.revision + 2]);
    for (const patch of missed) state = applyPatch(state, patch.ops);
    expect(state).toEqual(storbild.hub.state);

    // Then it continues live.
    await createInstance("D");
    expect((await patchOf(second)).revision).toBe(seen.revision + 3);
  });

  test("resuming at the current revision sends no patches", async () => {
    const client = await connect(String(storbild.hub.state.revision));
    expect(await client.next()).toEqual({ retry: "2000" });
    expect(await client.next()).toEqual({ event: "ping", data: "1" });
  });

  test("sends a snapshot when the buffer has rolled past Last-Event-ID", async () => {
    const lastSeen = storbild.hub.state.revision;
    for (let i = 0; i <= BUFFER_SIZE; i++) await createInstance(`I${i}`);
    const client = await connect(String(lastSeen));
    expect(await snapshotOf(client)).toEqual(storbild.hub.state);
  });

  test("resumes from the oldest revision still in the buffer", async () => {
    for (let i = 0; i <= BUFFER_SIZE; i++) await createInstance(`I${i}`);
    const oldest = storbild.hub.state.revision - BUFFER_SIZE;
    const client = await connect(String(oldest));
    for (let i = 1; i <= BUFFER_SIZE; i++)
      expect((await patchOf(client)).revision).toBe(oldest + i);
  });

  test("unsubscribes when the client disconnects", async () => {
    const client = await connect();
    await snapshotOf(client);
    expect(storbild.hub.subscriberCount).toBe(1);
    client.close();
    for (let i = 0; i < 50 && storbild.hub.subscriberCount > 0; i++) await Bun.sleep(10);
    expect(storbild.hub.subscriberCount).toBe(0);
  });

  test.each(["999", "abc", "-1", "1.5"])("sends a snapshot for Last-Event-ID %p", async (id) => {
    await createInstance("A");
    const client = await connect(id);
    expect(await snapshotOf(client)).toEqual(storbild.hub.state);
  });

  test("survives a restart with state and revision intact", async () => {
    const { id } = await createInstance("Rules");
    await command("playlist.addItem", { instanceId: id });
    const before = storbild.hub.state;

    await storbild.stop();
    await boot();
    expect(storbild.hub.state).toEqual(before);

    // A viewer that saw the last revision before the restart resumes without a snapshot.
    const resumed = await connect(String(before.revision));
    expect(await resumed.next()).toEqual({ retry: "2000" });
    await createInstance("After restart");
    expect((await patchOf(resumed)).revision).toBe(before.revision + 1);

    // One from before an earlier revision cannot be served from the empty buffer.
    const stale = await connect(String(before.revision - 1));
    expect(await snapshotOf(stale)).toEqual(storbild.hub.state);
  });
});

describe("GET /api/events", () => {
  test("follows the same protocol as /events", async () => {
    const client = await SseClient.connect(
      new URL("/api/events", storbild.admin.url),
      undefined,
      auth,
    );
    clients.push(client);
    const state = await snapshotOf(client);
    await createInstance("A");
    expect((await patchOf(client)).revision).toBe(state.revision + 1);
  });
});

describe("scheduler", () => {
  let clock: FakeClock;

  beforeEach(async () => {
    await storbild.stop();
    clock = new FakeClock(1_000_000);
    await boot({ now: clock.now, timers: clock.timers });
  });

  /** A playlist of one instance per duration, in order. */
  async function rotation(...durations: number[]) {
    const items: string[] = [];
    for (const [i, durationMs] of durations.entries()) {
      const { id } = await createInstance(`Item ${i}`);
      items.push((await command("playlist.addItem", { instanceId: id, durationMs })).id as string);
    }
    return items;
  }

  /** Follows a stream, applying patches as they arrive, until `ready(state)` holds. */
  async function follow(client: SseClient, state: ShowState, ready: (state: ShowState) => boolean) {
    while (!ready(state)) {
      const patch = await patchOf(client);
      state = applyPatch(state, patch.ops);
    }
    return state;
  }

  test("the rotation advances on the stream when the next item starts", async () => {
    const [a, b] = await rotation(10_000, 20_000);
    const client = await connect();
    let state = await snapshotOf(client);
    expect(state.timeline).toMatchObject({
      main: { itemId: a, startedAt: 1_000_000, endsAt: 1_010_000 },
      next: { itemId: b, startsAt: 1_010_000 },
    });

    await clock.advance(10_000);
    state = await follow(client, state, (s) => s.timeline.main?.itemId === b);
    expect(state.timeline.main).toMatchObject({ startedAt: 1_010_000, endsAt: 1_030_000 });
    await clock.advance(20_000);
    state = await follow(client, state, (s) => s.timeline.main?.itemId === a);
    expect(state.timeline.main?.startedAt).toBe(1_030_000);
    expect(state).toEqual(storbild.hub.state);
  });

  test("live commands take over, and the rotation continues after them", async () => {
    const [a, b] = await rotation(10_000, 20_000);
    const { id: x } = await createInstance("Take");
    await command("live.take", { instanceId: x, durationMs: 5_000 });
    expect(storbild.hub.state.timeline).toMatchObject({
      mode: "override",
      main: { instanceId: x, startedAt: 1_000_000, endsAt: 1_005_000 },
      next: { itemId: b, startsAt: 1_005_000 },
    });
    await clock.advance(5_000);
    expect(storbild.hub.state.timeline).toMatchObject({ mode: "auto", main: { itemId: b } });
    expect(storbild.hub.state.live.main).toBeUndefined();

    await command("live.interrupt", { instanceId: x, below: "dim" });
    await command("live.blackout", { on: true });
    expect(storbild.hub.state.timeline).toMatchObject({
      mode: "override",
      interrupt: { instanceId: x, below: "dim" },
      blackout: true,
    });
    await command("live.resume", {});
    expect(storbild.hub.state.timeline).toMatchObject({ mode: "auto", main: { itemId: a } });
  });

  test("live commands reject unknown and unplayable instances", async () => {
    const res = await fetch(new URL("/api/commands", storbild.admin.url), {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "live.take", payload: { instanceId: "nope" } }),
    });
    expect(res.status).toBe(404);
    const clear = await fetch(new URL("/api/commands", storbild.admin.url), {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "live.clearInterrupt", payload: {} }),
    });
    expect(clear.status).toBe(422);
  });

  test("fires a cue at its time", async () => {
    await rotation(10_000);
    const x = (await createInstance("Cue")).id as string;
    storbild.hub.update((state) => ({
      ...state,
      cues: [
        { id: "q", at: 1_003_000, action: { type: "interrupt", instanceId: x, durationMs: 1_000 } },
      ],
    }));
    await clock.advance(3_000);
    expect(storbild.hub.state.cues[0]?.fired).toBe(true);
    expect(storbild.hub.state.timeline.interrupt).toMatchObject({
      instanceId: x,
      startedAt: 1_003_000,
    });
    await clock.advance(1_000);
    expect(storbild.hub.state.timeline.interrupt).toBeUndefined();
  });

  test("a restart resumes the rotation where time says it is", async () => {
    const [, b] = await rotation(10_000, 20_000);
    await storbild.stop();
    await clock.advance(25_000);
    await boot({ now: clock.now, timers: clock.timers });
    expect(storbild.hub.state.timeline.main).toMatchObject({
      itemId: b,
      startedAt: 1_010_000,
      endsAt: 1_030_000,
    });
  });
});
