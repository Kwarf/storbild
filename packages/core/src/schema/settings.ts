import { z } from "zod";
import { durationMsSchema } from "./common.ts";

/** Show-wide defaults, edited on the admin's Settings page (ADR 0010). */
export const showSettingsSchema = z.object({
  /** How long a playlist item runs when neither it nor its type says. */
  defaultDurationMs: durationMsSchema,
  /** The length of the compositor's crossfades. 0 switches without a fade. */
  transitionMs: z.number().int().nonnegative().max(10_000),
});
export type ShowSettings = z.infer<typeof showSettingsSchema>;

export const defaultShowSettings: ShowSettings = { defaultDurationMs: 15_000, transitionMs: 800 };
