import { z } from "zod";
import { durationMsSchema, epochMsSchema, idSchema } from "./common.ts";
import { interruptBelowSchema } from "./timeline.ts";

export const cueActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("take"),
    instanceId: idSchema,
    durationMs: durationMsSchema.optional(),
  }),
  z.object({
    type: z.literal("interrupt"),
    instanceId: idSchema,
    durationMs: durationMsSchema.optional(),
    below: interruptBelowSchema.optional(),
  }),
  z.object({ type: z.literal("activateTheme"), themeId: idSchema }),
]);
export type CueAction = z.infer<typeof cueActionSchema>;

export const cueSchema = z.object({
  id: idSchema,
  at: epochMsSchema,
  action: cueActionSchema,
  fired: z.boolean().optional(),
});
export type Cue = z.infer<typeof cueSchema>;
