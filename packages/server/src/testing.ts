import { createInitialState, type ShowState } from "@storbild/core";
import { openDatabase } from "./db.ts";
import { StateHub } from "./state-hub.ts";
import { saveState } from "./store.ts";

/** A hub on an in-memory database with deterministic time and IDs. */
export function createTestHub(bufferSize?: number): StateHub {
  let next = 0;
  const newId = () => `id${++next}`;
  const db = openDatabase(":memory:");
  const initial: ShowState = createInitialState({ now: 0, newId });
  saveState(db, initial);
  return new StateHub({
    db,
    initial,
    now: () => 0,
    newId,
    ...(bufferSize !== undefined && { bufferSize }),
  });
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

  static async connect(url: string | URL, lastEventId?: string): Promise<SseClient> {
    const client = new SseClient();
    const res = await fetch(url, {
      signal: client.#abort.signal,
      headers: lastEventId === undefined ? {} : { "Last-Event-ID": lastEventId },
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
      if (frame.event !== undefined)
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
