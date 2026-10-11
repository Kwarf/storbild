import { z } from "zod";
import { epochMsSchema, idSchema } from "./common.ts";

/** The resolved output of the scheduler (M4), which is what viewers render. */
export const timelineSchema = z.object({
  /** override = a manual take or interrupt is active. */
  mode: z.enum(["auto", "override"]),
  /** Absent when nothing is on air, e.g. an empty playlist: only the theme background shows. */
  main: z
    .object({
      instanceId: idSchema,
      itemId: idSchema.optional(),
      startedAt: epochMsSchema,
      endsAt: epochMsSchema.optional(),
    })
    .optional(),
  next: z
    .object({ instanceId: idSchema, itemId: idSchema.optional(), startsAt: epochMsSchema })
    .optional(),
  interrupt: z
    .object({
      instanceId: idSchema,
      startedAt: epochMsSchema,
      endsAt: epochMsSchema.optional(),
      dimBelow: z.boolean(),
    })
    .optional(),
  blackout: z.boolean(),
});
export type Timeline = z.infer<typeof timelineSchema>;
