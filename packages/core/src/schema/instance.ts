import { z } from "zod";
import { idSchema } from "./common.ts";

export const fitSchema = z.enum(["cover", "contain"]);

export const instanceBackgroundSchema = z.union([
  z.literal("theme"),
  z.literal("none"),
  z.object({ assetId: idSchema, fit: fitSchema }),
]);
export type InstanceBackground = z.infer<typeof instanceBackgroundSchema>;

export const instanceSchema = z.object({
  id: idSchema,
  plugin: z.string().min(1),
  type: z.string().min(1),
  name: z.string().min(1),
  /** Validated against the instance type's config schema by the plugin host (M2). */
  config: z.json(),
  configVersion: z.number().int().nonnegative(),
  background: instanceBackgroundSchema.optional(),
  /** Runtime data written by the plugin's server part. */
  state: z.json().optional(),
});
export type Instance = z.infer<typeof instanceSchema>;
