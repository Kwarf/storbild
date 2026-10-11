const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The time left until `target`, rounded up to whole seconds so 0 comes exactly at `target`. */
export function remaining(target: number, now: number): number {
  return Math.max(0, Math.ceil((target - now) / SECOND) * SECOND);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `MM:SS` under an hour, `H:MM:SS` under a day, else `D d HH:MM:SS`. */
export function formatRemaining(ms: number): string {
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  const seconds = Math.floor((ms % MINUTE) / SECOND);
  if (days > 0) return `${days} d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(minutes)}:${pad(seconds)}`;
}

/** How long until the shown time changes, or `undefined` once the target has passed. */
export function untilNextTick(target: number, now: number): number | undefined {
  if (now >= target) return undefined;
  return (target - now) % SECOND || SECOND;
}
