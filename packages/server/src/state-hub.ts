import type { Database } from "bun:sqlite";
import {
  applyCommand,
  type Command,
  diff,
  type JsonPatchOp,
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
  readonly #bufferSize: number;
  readonly #buffer: PatchEvent[] = [];
  /** Streams that have seen this revision or later can resume from the buffer. */
  #bufferBase: number;
  readonly #listeners = new Set<(event: PatchEvent) => void>();

  constructor({ db, initial, now, newId, bufferSize = 256 }: StateHubOptions) {
    this.#db = db;
    this.#state = initial;
    this.#now = now;
    this.#newId = newId;
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
    const outcome = applyCommand(before, command, { now: this.#now(), newId: this.#newId });
    const ops = diff(before, outcome.state);
    const keys = new Set(
      ops.map((op) => unescapePointerToken(op.path.split("/")[1] ?? "") as keyof ShowState),
    );
    saveState(this.#db, outcome.state, keys);
    this.#state = outcome.state;
    this.#publish({ revision: outcome.state.revision, ops });
    return {
      revision: outcome.state.revision,
      ...(outcome.id !== undefined && { id: outcome.id }),
    };
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
  }
}
