import type { Database } from "bun:sqlite";
import {
  applyCommand,
  type Command,
  diff,
  type HostCommand,
  hostCommandSchema,
  type JsonPatchOp,
  type PluginCatalog,
  type ShowState,
  unescapePointerToken,
} from "@storbild/core";
import { saveState } from "./store.ts";

export interface PatchEvent {
  revision: number;
  ops: JsonPatchOp[];
}

/** What a new stream starts with: the full state, or the patches it missed. */
export type StreamStart =
  | { kind: "snapshot"; revision: number; state: ShowState }
  | { kind: "replay"; events: PatchEvent[] };

export interface Subscription {
  start: StreamStart;
  unsubscribe(): void;
}

export interface DispatchResult {
  revision: number;
  id?: string;
}

/** `expectedRevision` did not match the current revision. */
export class RevisionConflictError extends Error {
  override name = "RevisionConflictError";
  constructor(readonly revision: number) {
    super(`stale revision; current revision is ${revision}`);
  }
}

export interface StateHubOptions {
  db: Database;
  initial: ShowState;
  now: () => number;
  newId: () => string;
  /** The loaded plugins, which validate settings and instance config. */
  catalog?: PluginCatalog;
  /** How many patches are kept for `Last-Event-ID` resume. */
  bufferSize?: number;
}

/**
 * Owns the authoritative state. Commands are reduced, persisted and only then published as
 * patches. Subscribing happens synchronously with reading the start point, so a stream never
 * misses or duplicates a revision.
 */
export class StateHub {
  #state: ShowState;
  readonly #db: Database;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #catalog: PluginCatalog;
  readonly #bufferSize: number;
  readonly #buffer: PatchEvent[] = [];
  /** Streams that have seen this revision or later can resume from the buffer. */
  #bufferBase: number;
  readonly #listeners = new Set<(event: PatchEvent) => void>();
  readonly #watchers = new Set<(event: PatchEvent) => void>();

  constructor({ db, initial, now, newId, catalog = {}, bufferSize = 256 }: StateHubOptions) {
    this.#db = db;
    this.#state = initial;
    this.#now = now;
    this.#newId = newId;
    this.#catalog = catalog;
    this.#bufferSize = bufferSize;
    this.#bufferBase = initial.revision;
  }

  get state(): ShowState {
    return this.#state;
  }

  /** Open streams, viewer and admin. */
  get subscriberCount(): number {
    return this.#listeners.size;
  }

  /**
   * Applies a command. Throws `CommandError` or `RevisionConflictError` without changing
   * anything, and leaves the state unchanged if persisting fails.
   */
  dispatch(command: Command, expectedRevision?: number): DispatchResult {
    const before = this.#state;
    if (expectedRevision !== undefined && expectedRevision !== before.revision) {
      throw new RevisionConflictError(before.revision);
    }
    const outcome = applyCommand(before, command, this.#context());
    this.#commit(outcome.state);
    return {
      revision: outcome.state.revision,
      ...(outcome.id !== undefined && { id: outcome.id }),
    };
  }

  /**
   * Applies a command on behalf of the plugin runtime. The payload is validated here, so a
   * plugin passing non-JSON state gets a ZodError. A command that changes nothing is dropped.
   */
  dispatchHost(command: HostCommand): number {
    const before = this.#state;
    const { state } = applyCommand(before, hostCommandSchema.parse(command), this.#context());
    if (diff(before, { ...state, revision: before.revision }).length > 0) this.#commit(state);
    return this.#state.revision;
  }

  /** Replaces the state with `fn(state)` as one new revision, unless nothing changes. */
  update(fn: (state: ShowState) => ShowState): number {
    const before = this.#state;
    const next = { ...fn(before), revision: before.revision };
    if (diff(before, next).length > 0) this.#commit({ ...next, revision: before.revision + 1 });
    return this.#state.revision;
  }

  /**
   * Watches every new revision from inside the server. Unlike stream listeners, watchers are
   * called in a microtask, so they may dispatch without reordering other streams' patches.
   */
  watch(watcher: (event: PatchEvent) => void): () => void {
    this.#watchers.add(watcher);
    return () => this.#watchers.delete(watcher);
  }

  #context() {
    return { now: this.#now(), newId: this.#newId, catalog: this.#catalog };
  }

  #commit(next: ShowState) {
    const ops = diff(this.#state, next);
    const keys = new Set(
      ops.map((op) => unescapePointerToken(op.path.split("/")[1] ?? "") as keyof ShowState),
    );
    saveState(this.#db, next, keys);
    this.#state = next;
    this.#publish({ revision: next.revision, ops });
  }

  /**
   * Starts a stream. A `lastEventId` inside the buffer's range resumes with the missed patches;
   * anything else (none, malformed, rolled past, from the future) gets a snapshot.
   */
  subscribe(lastEventId: string | undefined, listener: (event: PatchEvent) => void): Subscription {
    const current = this.#state.revision;
    const last = lastEventId !== undefined && /^\d+$/.test(lastEventId) ? Number(lastEventId) : -1;
    const start: StreamStart =
      last >= this.#bufferBase && last <= current
        ? { kind: "replay", events: this.#buffer.filter((event) => event.revision > last) }
        : { kind: "snapshot", revision: current, state: this.#state };
    this.#listeners.add(listener);
    return { start, unsubscribe: () => this.#listeners.delete(listener) };
  }

  #publish(event: PatchEvent) {
    this.#buffer.push(event);
    while (this.#buffer.length > this.#bufferSize) {
      this.#bufferBase = (this.#buffer.shift() as PatchEvent).revision;
    }
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("state listener failed", error);
      }
    }
    for (const watcher of this.#watchers) {
      queueMicrotask(() => {
        try {
          watcher(event);
        } catch (error) {
          console.error("state watcher failed", error);
        }
      });
    }
  }
}
