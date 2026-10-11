import { z } from "zod";
import { idSchema } from "./common.ts";
import { fitSchema } from "./instance.ts";

const dimSchema = z.number().min(0).max(1);

export const fontRefSchema = z.object({
  family: z.string().min(1),
  /** Uploaded woff2 files. */
  assetIds: z.array(idSchema).optional(),
});
export type FontRef = z.infer<typeof fontRefSchema>;

export const themeBackgroundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("color"), color: z.string().min(1) }),
  z.object({
    type: z.literal("image"),
    assetId: idSchema,
    fit: fitSchema,
    dim: dimSchema.optional(),
  }),
  z.object({ type: z.literal("video"), assetId: idSchema, dim: dimSchema.optional() }),
  z.object({ type: z.literal("scene"), instanceId: idSchema }),
]);
export type ThemeBackground = z.infer<typeof themeBackgroundSchema>;

export const themeSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  background: themeBackgroundSchema,
  fonts: z.object({
    heading: fontRefSchema,
    body: fontRefSchema,
    mono: fontRefSchema.optional(),
  }),
  colors: z.object({
    text: z.string().min(1),
    muted: z.string().min(1),
    accent: z.string().min(1),
    surface: z.string().min(1),
  }),
  /** px on the 1920×1080 canvas. */
  safeArea: z.number().nonnegative().optional(),
  /** Escape hatch, viewer-scoped, at your own risk. */
  customCss: z.string().optional(),
});
export type Theme = z.infer<typeof themeSchema>;
