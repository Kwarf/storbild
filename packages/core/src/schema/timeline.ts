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

export const timelineInterruptSchema = z.object({
  instanceId: idSchema,
  startedAt: epochMsSchema,
  /** Absent while the interrupt holds until it is dismissed. */
  endsAt: epochMsSchema.optional(),
  dimBelow: z.boolean(),
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
