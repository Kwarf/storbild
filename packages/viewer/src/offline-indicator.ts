/** How long a screen is out of touch before it says so (ADR 0019). */
export const OFFLINE_GRACE_MS = 10_000;
/** Silence after which an open stream counts as lost: the server pings every 15 s. */
export const SILENCE_MS = 20_000;

export interface Contact {
  /** Whether a stream is open. */
  connected: boolean;
  /** When the server was last heard from, or when the stored state was received. */
  lastMessageAt: number | undefined;
  now: number;
}

/**
 * Decides when a screen shows that it is offline. A screen is out of touch when no stream is
 * open, or when an open one has gone silent (a network drop the browser hasn't noticed). It
 * says so after `OFFLINE_GRACE_MS` out of touch, so a server restart doesn't flash it, or at
 * once after starting from the stored state. A silent stream has been out of touch since its
 * last message, so it is past the grace as soon as it counts as silent.
 */
export class OfflineTracker {
  #since: number | undefined;
  #immediate = false;

  /** The screen started from its stored state, so it is offline until a stream opens. */
  startedOffline(now: number) {
    this.#since ??= now;
    this.#immediate = true;
  }

  /** Whether the screen should say it is offline. */
  update({ connected, lastMessageAt, now }: Contact): boolean {
    const silent = lastMessageAt === undefined || now - lastMessageAt > SILENCE_MS;
    if (connected && !silent) {
      this.#since = undefined;
      this.#immediate = false;
      return false;
    }
    this.#since ??= now;
    const since =
      connected && lastMessageAt !== undefined ? Math.min(this.#since, lastMessageAt) : this.#since;
    return this.#immediate || now - since >= OFFLINE_GRACE_MS;
  }
}

/** The indicator's text: "Offline · last update 14:32", in the screen's time zone. */
export function offlineLabel(lastUpdateAt: number | undefined, timeZone?: string): string {
  if (lastUpdateAt === undefined) return "Offline";
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timeZone && { timeZone }),
  }).format(lastUpdateAt);
  return `Offline · last update ${time}`;
}
