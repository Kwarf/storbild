import { z } from "zod";
import { epochMsSchema, idSchema } from "./common.ts";

/** What is on the main layer: a playlist item (with `itemId`) or a take. */
export const timelineMainSchema = z.object({
  instanceId: idSchema,
  itemId: idSchema.optional(),
  startedAt: epochMsSchema,
  /** Absent while a take or interrupt holds until it is cleared. */
  endsAt: epochMsSchema.optional(),
});
export type TimelineMain = z.infer<typeof timelineMainSchema>;

/**
 * What the screen shows beneath an interrupt (ADR 0008): `hide` covers the layers below with
 * the theme background, so the interrupt looks like a full-screen scene; `dim` darkens them;
 * `show` leaves them as they are, for interrupts that draw their own panel.
 */
export const interruptBelowSchema = z.enum(["show", "dim", "hide"]);
export type InterruptBelow = z.infer<typeof interruptBelowSchema>;

export const timelineInterruptSchema = z.object({
  instanceId: idSchema,
  startedAt: epochMsSchema,
  /** Absent while the interrupt holds until it is dismissed. */
  endsAt: epochMsSchema.optional(),
  below: interruptBelowSchema,
});
export type TimelineInterrupt = z.infer<typeof timelineInterruptSchema>;

/** The resolved output of the scheduler: what is on air at a given time. */
export const timelineSchema = z.object({
  /** override = a manual take or interrupt is active. */
  mode: z.enum(["auto", "override"]),
  /** Absent when nothing is on air, e.g. an empty playlist: only the theme background shows. */
  main: timelineMainSchema.optional(),
  next: z
    .object({ instanceId: idSchema, itemId: idSchema.optional(), startsAt: epochMsSchema })
    .optional(),
  interrupt: timelineInterruptSchema.optional(),
  blackout: z.boolean(),
});
export type Timeline = z.infer<typeof timelineSchema>;
