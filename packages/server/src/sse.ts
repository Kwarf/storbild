import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { PatchEvent, StateHub } from "./state-hub.ts";

export interface StreamOptions {
  /** Interval between `ping` events. */
  heartbeatMs?: number;
  /** A client this many messages behind is dropped; it resumes on reconnect. */
  maxQueue?: number;
}

const patchMessage = (event: PatchEvent) =>
  `event: patch\nid: ${event.revision}\ndata: ${JSON.stringify(event.ops)}\n\n`;

/**
 * A named event rather than an SSE comment, so the browser's watchdog sees it. It has no `id`,
 * which leaves the client's last event ID alone; the data must be non-empty to be dispatched.
 */
const pingMessage = "event: ping\ndata: 1\n\n";

/**
 * Streams the show state per DESIGN.md §5.1: `retry`, then a snapshot or the missed patches,
 * then live patches and a heartbeat. Shared by the viewer `/events` and admin `/api/events`.
 */
export function streamState(
  c: Context,
  hub: StateHub,
  { heartbeatMs = 15_000, maxQueue = 1_000 }: StreamOptions = {},
) {
  return streamSSE(c, async (stream) => {
    const pending: string[] = [];
    let wake: (() => void) | undefined;
    let overflow = false;
    const push = (chunk: string) => {
      if (pending.length >= maxQueue) overflow = true;
      else pending.push(chunk);
      wake?.();
    };

    const { start, unsubscribe } = hub.subscribe(c.req.header("Last-Event-ID"), (event) =>
      push(patchMessage(event)),
    );
    const heartbeat = setInterval(() => push(pingMessage), heartbeatMs);
    stream.onAbort(() => wake?.());

    try {
      await stream.write("retry: 2000\n\n");
      if (start.kind === "snapshot") {
        await stream.write(
          `event: snapshot\nid: ${start.revision}\ndata: ${JSON.stringify(start.state)}\n\n`,
        );
      } else {
        for (const event of start.events) await stream.write(patchMessage(event));
      }
      while (!stream.aborted && !overflow) {
        const chunk = pending.shift();
        if (chunk === undefined) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        } else {
          await stream.write(chunk);
        }
      }
    } catch (error) {
      // Writing to a stream the client just closed is expected; anything else is not.
      if (!stream.aborted) throw error;
    } finally {
      clearInterval(heartbeat);
      unsubscribe();
    }
  });
}
