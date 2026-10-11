export interface ClockOptions {
  seconds: boolean;
  /** An IANA time zone; the local one when absent or unknown. */
  timeZone?: string | undefined;
}

/** Formats epoch ms as a 24-hour time, `HH:MM` or `HH:MM:SS`. */
export function formatTime(at: number, options: ClockOptions): string {
  const format = (timeZone: string | undefined) =>
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      ...(options.seconds && { second: "2-digit" }),
      hourCycle: "h23",
      ...(timeZone !== undefined && { timeZone }),
    }).format(at);
  try {
    return format(options.timeZone);
  } catch {
    // An unknown time zone throws a RangeError; a clock in local time beats no clock.
    return format(undefined);
  }
}

/** How long until the displayed time changes. */
export function untilNextTick(at: number, seconds: boolean): number {
  const unit = seconds ? 1_000 : 60_000;
  return unit - (((at % unit) + unit) % unit);
}
