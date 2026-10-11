import { z } from "zod";
import { durationMsSchema, epochMsSchema, idSchema } from "./common.ts";

export const playlistItemSchema = z.object({
  id: idSchema,
  instanceId: idSchema,
  enabled: z.boolean(),
  /** Overrides the instance type's computed duration. */
  durationMs: durationMsSchema.optional(),
  activeFrom: epochMsSchema.optional(),
  activeUntil: epochMsSchema.optional(),
  /** Set by the scheduler: the override, the type's duration or the global default. */
  resolvedDurationMs: durationMsSchema.optional(),
});
export type PlaylistItem = z.infer<typeof playlistItemSchema>;

export const playlistSchema = z.object({
  items: z.array(playlistItemSchema),
  /** The rotation's position at time t is computed from this anchor (ADR 0006). */
  anchorAt: epochMsSchema,
  /** The item the rotation starts from at `anchorAt`; the first item when absent or unknown. */
  anchorItemId: idSchema.optional(),
});
export type Playlist = z.infer<typeof playlistSchema>;
