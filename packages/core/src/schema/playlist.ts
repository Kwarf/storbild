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
  /** Set by the scheduler (M4): the override, the type's duration or the global default. */
  resolvedDurationMs: durationMsSchema.optional(),
});
export type PlaylistItem = z.infer<typeof playlistItemSchema>;

export const playlistSchema = z.object({
  items: z.array(playlistItemSchema),
  /** The rotation's position at time t is computed from this anchor (M4). */
  anchorAt: epochMsSchema,
});
export type Playlist = z.infer<typeof playlistSchema>;
