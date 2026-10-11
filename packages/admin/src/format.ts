/** `m:ss`, or `h:mm:ss` from an hour. Rounds up, so a countdown shows 0:00 only at the end. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * Parses a duration typed by the operator: seconds (`90`), `m:ss` or `h:mm:ss`. Blank means no
 * duration (hold until cleared) and returns `undefined`; anything else invalid returns `null`.
 */
export function parseDuration(text: string): number | undefined | null {
  const value = text.trim();
  if (value === "") return undefined;
  if (!/^\d+(?::[0-5]?\d){0,2}$/.test(value)) return null;
  const seconds = value.split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
  return seconds > 0 ? seconds * 1000 : null;
}

/** Local wall-clock time, `HH:MM`. */
export function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
