import { z } from "zod";
import { timelineInterruptSchema, timelineMainSchema } from "./timeline.ts";

/**
 * Live control, the input `resolveTimeline` combines with the rotation (ADR 0006). An entry
 * whose `endsAt` has passed is ignored, and the scheduler removes it.
 */
export const liveSchema = z.object({
  /**
   * Replaces the rotation on the main layer: a take, or the scene frozen under an interrupt.
   */
  main: timelineMainSchema.optional(),
  interrupt: timelineInterruptSchema.optional(),
  blackout: z.boolean(),
});
export type Live = z.infer<typeof liveSchema>;
