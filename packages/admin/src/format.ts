export { formatDuration, parseDuration } from "@storbild/core";

/** Local wall-clock time, `HH:MM`. */
export function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
