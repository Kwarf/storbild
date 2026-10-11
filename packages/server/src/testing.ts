import {
  type Config,
  createInitialState,
  type PluginCatalog,
  parseConfig,
  reconcilePlugins,
  type ShowState,
} from "@storbild/core";
import { z } from "zod";
import { type AdminAppDeps, createAdminApp } from "./admin-app.ts";
import { AssetStore } from "./assets.ts";
import { LoginLimiter, SessionStore } from "./auth.ts";
import { openDatabase } from "./db.ts";
import type { SchedulerTimers } from "./scheduler.ts";
import { StateHub } from "./state-hub.ts";
import { saveState } from "./store.ts";

/** The admin password in tests. Its hash is cheap to compute and verify. */
export const TEST_PASSWORD = "correct horse";
export const testPasswordHash = await Bun.password.hash(TEST_PASSWORD, {
  algorithm: "argon2id",
  memoryCost: 1024,
  timeCost: 1,
});

/** Config from `env`, with the test password. */
export function testConfig(env: Record<string, string>): Config {
  return parseConfig({ STORBILD_ADMIN_PASSWORD_HASH: testPasswordHash, ...env });
}

/** Logs in to a running admin app and returns the headers an API call needs. */
export async function adminHeaders(adminUrl: URL): Promise<Record<string, string>> {
  const res = await fetch(new URL("/login", adminUrl), {
    method: "POST",
    headers: { Origin: adminUrl.origin },
    body: new URLSearchParams({ username: "admin", password: TEST_PASSWORD }),
    redirect: "manual",
  });
  const cookie = res.headers.get("Set-Cookie")?.split(";")[0];
  if (res.status !== 303 || !cookie) throw new Error(`login failed: ${res.status}`);
  return { Cookie: cookie, Origin: adminUrl.origin };
}

/** A catalog with one plugin, shaped like the built-in `markdown`. */
export const testCatalog: PluginCatalog = {
  markdown: {
    id: "markdown",
    version: "0.1.0",
    status: "ok",
    settings: z.object({ fontScale: z.number().positive().default(1) }),
    types: {
      text: {
        kind: "scene",
        label: "Markdown text",
        viewer: "sb-markdown-scene",
        config: z.object({ content: z.string() }),
        configVersion: 1,
      },
    },
  },
};

/** A hub on an in-memory database with deterministic time and IDs, and `testCatalog`. */
export function createTestHub(bufferSize?: number): StateHub {
  let next = 0;
  const newId = () => `id${++next}`;
  const db = openDatabase(":memory:");
  const initial: ShowState = reconcilePlugins(createInitialState({ now: 0, newId }), testCatalog);
  saveState(db, initial);
  return new StateHub({
    db,
    initial,
    now: () => 0,
    newId,
    catalog: testCatalog,
    ...(bufferSize !== undefined && { bufferSize }),
  });
}

export interface TestAdminAppOptions {
  /** The admin's public URL; https makes the session cookie Secure. */
  publicUrl?: string;
  clock?: FakeClock;
  bundle?: AdminAppDeps["bundle"];
  schemas?: AdminAppDeps["schemas"];
  /** A directory for an asset store; without it, the app has none. */
  assetsDir?: string;
  maxUploadBytes?: number;
  maxVideoUploadBytes?: number;
}

/** An admin app on `createTestHub()`, with sessions in memory and time on a `FakeClock`. */
export function createTestAdminApp({
  publicUrl = "http://localhost",
  clock = new FakeClock(1_000_000),
  bundle,
  schemas,
  assetsDir,
  maxUploadBytes,
  maxVideoUploadBytes,
}: TestAdminAppOptions = {}) {
  const hub = createTestHub();
  const assets = assetsDir ? new AssetStore({ dir: assetsDir, hub, now: clock.now }) : undefined;
  assets?.start();
  const sessions = new SessionStore(openDatabase(":memory:"), { now: clock.now });
  const app = createAdminApp({
    hub,
    now: clock.now,
    auth: {
      username: "admin",
      passwordHash: testPasswordHash,
      publicUrl,
      sessions,
      limiter: new LoginLimiter({ now: clock.now }),
    },
    ...(bundle && { bundle }),
    ...(schemas && { schemas }),
    ...(assets && { assets }),
    ...(maxUploadBytes !== undefined && { maxUploadBytes }),
    ...(maxVideoUploadBytes !== undefined && { maxVideoUploadBytes }),
  });
  return { app, hub, sessions, clock, assets };
}

/** A clock and timers that only move when told to, for the scheduler. */
export class FakeClock {
  #now: number;
  #nextId = 0;
  readonly #pending = new Map<number, { at: number; fn: () => void }>();

  constructor(now: number) {
    this.#now = now;
  }

  readonly now = () => this.#now;

  readonly timers: SchedulerTimers = {
    setTimeout: (fn, ms) => {
      const id = ++this.#nextId;
      this.#pending.set(id, { at: this.#now + ms, fn });
      return id;
    },
    clearTimeout: (handle) => {
      this.#pending.delete(handle as number);
    },
  };

  /** Moves time forward, firing due timers in order and letting watchers run in between. */
  async advance(ms: number) {
    const end = this.#now + ms;
    for (;;) {
      await Bun.sleep(0);
      const [id, timer] = [...this.#pending].reduce<[number, { at: number; fn: () => void }] | []>(
        (earliest, entry) => (earliest[1] && earliest[1].at <= entry[1].at ? earliest : entry),
        [],
      );
      if (id === undefined || !timer || timer.at > end) break;
      this.#pending.delete(id);
      this.#now = Math.max(this.#now, timer.at);
      timer.fn();
    }
    this.#now = end;
  }
}

export interface SseFrame {
  event?: string;
  id?: string;
  data?: string;
  retry?: string;
  comment?: string;
}

/** A minimal SSE client over fetch, reading one frame at a time. */
export class SseClient {
  readonly #abort = new AbortController();
  #read: () => Promise<{ done: boolean; value?: Uint8Array | undefined }> = async () => ({
    done: true,
  });
  readonly #decoder = new TextDecoder();
  #buffer = "";

  static async connect(
    url: string | URL,
    lastEventId?: string,
    headers: Record<string, string> = {},
  ): Promise<SseClient> {
    const client = new SseClient();
    const res = await fetch(url, {
      signal: client.#abort.signal,
      headers: lastEventId === undefined ? headers : { ...headers, "Last-Event-ID": lastEventId },
    });
    if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
    client.headers = res.headers;
    const reader = res.body.getReader();
    client.#read = () => reader.read();
    return client;
  }

  headers = new Headers();

  /** The next frame, failing after `timeoutMs`. */
  async next(timeoutMs = 2000): Promise<SseFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const end = this.#buffer.indexOf("\n\n");
      if (end !== -1) {
        const block = this.#buffer.slice(0, end);
        this.#buffer = this.#buffer.slice(end + 2);
        return parseFrame(block);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("timed out waiting for an SSE frame");
      const read = await Promise.race([this.#read(), Bun.sleep(remaining).then(() => undefined)]);
      if (read === undefined) continue;
      if (read.done || !read.value) throw new Error("stream ended");
      this.#buffer += this.#decoder.decode(read.value, { stream: true });
    }
  }

  /** Reads frames until one matches, skipping heartbeats and `retry`. */
  async nextEvent(
    timeoutMs = 2000,
  ): Promise<SseFrame & { event: string; id: string; data: string }> {
    for (;;) {
      const frame = await this.next(timeoutMs);
      if (frame.event !== undefined && frame.event !== "ping")
        return frame as SseFrame & { event: string; id: string; data: string };
    }
  }

  close() {
    this.#abort.abort();
  }
}

function parseFrame(block: string): SseFrame {
  const frame: SseFrame = {};
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) {
      frame.comment = line.slice(1).trim();
      continue;
    }
    const colon = line.indexOf(":");
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, "");
    if (field === "data") frame.data = frame.data === undefined ? value : `${frame.data}\n${value}`;
    else if (field === "event" || field === "id" || field === "retry") frame[field] = value;
  }
  return frame;
}
