import { applyPatch, type JsonPatchOp, type ShowState } from "@storbild/core";

/** The parts of `EventSource` the client uses. */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

/** `EventSource.CLOSED`: the browser has given up and will not reconnect by itself. */
const CLOSED = 2;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SyncClientOptions {
  /** The SSE stream, e.g. `/events`. */
  url: string;
  /** Probed before a watchdog reload, e.g. `/time`. */
  probeUrl: string;
  openEventSource(url: string): EventSourceLike;
  fetch(url: string): Promise<{ ok: boolean }>;
  timers: Timers;
  reload(): void;
  /** Called with every new state. */
  onState(state: ShowState): void;
  /** Called when a stream opens, the first time and after every reconnect. */
  onConnect?(): void;
  /** The clock `lastMessageAt` is read from. */
  now?(): number;
  /** Silence (no snapshot, patch or ping) after which the page reloads, if the server answers. */
  watchdogMs?: number;
  /** Backoff for reopening a stream the browser closed. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  log?: (message: string, error?: unknown) => void;
}

/**
 * Keeps a copy of the show state in sync with the server (DESIGN.md §5.1, ADR 0005).
 *
 * - The browser reconnects a dropped stream itself and resumes with `Last-Event-ID`.
 * - A patch that doesn't follow the current revision, or doesn't apply, opens a fresh stream,
 *   which starts with a snapshot.
 * - A stream the browser closed (for example after a proxy 502) is reopened with backoff.
 * - After `watchdogMs` of silence the page reloads, but only if the server answers a probe:
 *   reloading while it is unreachable would leave a kiosk on an error page.
 */
export class SyncClient {
  readonly #options: Required<
    Pick<SyncClientOptions, "watchdogMs" | "minBackoffMs" | "maxBackoffMs" | "log">
  > &
    SyncClientOptions;
  #source: EventSourceLike | undefined;
  #state: ShowState | undefined;
  #watchdog: unknown;
  #reopen: unknown;
  #backoffMs: number;
  #stopped = false;
  #lastMessageAt: number | undefined;

  constructor(options: SyncClientOptions) {
    this.#options = {
      watchdogMs: 60_000,
      minBackoffMs: 1_000,
      maxBackoffMs: 30_000,
      log: (message, error) => console.warn(message, error ?? ""),
      ...options,
    };
    this.#backoffMs = this.#options.minBackoffMs;
  }

  get state(): ShowState | undefined {
    return this.#state;
  }

  /** When the last snapshot, patch or ping arrived, by `now`; undefined before the first. */
  get lastMessageAt(): number | undefined {
    return this.#lastMessageAt;
  }

  /** Whether a stream is currently open. */
  get connected(): boolean {
    return this.#source?.readyState === 1;
  }

  start() {
    this.#stopped = false;
    this.#open();
  }

  stop() {
    this.#stopped = true;
    this.#source?.close();
    this.#source = undefined;
    this.#options.timers.clearTimeout(this.#watchdog);
    this.#options.timers.clearTimeout(this.#reopen);
  }

  #open() {
    const { openEventSource, url } = this.#options;
    this.#source?.close();
    this.#options.timers.clearTimeout(this.#reopen);
    const source = openEventSource(url);
    this.#source = source;
    // Events from a stream that was replaced are ignored.
    const current = () => this.#source === source;

    source.onopen = () => {
      if (!current()) return;
      this.#backoffMs = this.#options.minBackoffMs;
      this.#options.onConnect?.();
    };
    source.onerror = () => {
      if (current() && source.readyState === CLOSED) this.#scheduleReopen();
    };
    source.addEventListener("snapshot", (event) => {
      if (!current()) return;
      this.#heard();
      this.#setState(JSON.parse(event.data) as ShowState);
    });
    source.addEventListener("patch", (event) => {
      if (!current()) return;
      this.#heard();
      this.#onPatch(Number(event.lastEventId), event.data);
    });
    source.addEventListener("ping", () => {
      if (current()) this.#heard();
    });
    this.#alive();
  }

  #onPatch(revision: number, data: string) {
    const state = this.#state;
    if (!state || revision !== state.revision + 1) {
      this.#options.log(`revision ${revision} doesn't follow ${state?.revision}; resyncing`);
      this.#open();
      return;
    }
    let next: ShowState;
    try {
      next = applyPatch(state, JSON.parse(data) as JsonPatchOp[]);
    } catch (error) {
      this.#options.log(`patch ${revision} failed to apply; resyncing`, error);
      this.#open();
      return;
    }
    this.#setState(next);
  }

  #setState(state: ShowState) {
    this.#state = state;
    try {
      this.#options.onState(state);
    } catch (error) {
      this.#options.log("state listener failed", error);
    }
  }

  #scheduleReopen() {
    if (this.#stopped) return;
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, this.#options.maxBackoffMs);
    this.#options.timers.clearTimeout(this.#reopen);
    this.#reopen = this.#options.timers.setTimeout(() => this.#open(), delay);
  }

  /** A message arrived from the server. */
  #heard() {
    this.#lastMessageAt = (this.#options.now ?? Date.now)();
    this.#alive();
  }

  /** Re-arms the watchdog. */
  #alive() {
    const { timers, watchdogMs } = this.#options;
    timers.clearTimeout(this.#watchdog);
    if (this.#stopped) return;
    this.#watchdog = timers.setTimeout(() => void this.#onSilence(), watchdogMs);
  }

  async #onSilence() {
    let reachable = false;
    try {
      reachable = (await this.#options.fetch(this.#options.probeUrl)).ok;
    } catch {
      // Unreachable; keep waiting.
    }
    if (this.#stopped) return;
    if (reachable) {
      this.#options.log("no messages from a reachable server; reloading");
      this.#options.reload();
    } else {
      // The stream may be half-open after a silent network drop; start a new one.
      this.#open();
    }
  }
}
