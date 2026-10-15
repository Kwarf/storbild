import { z } from "zod";
import { idSchema } from "./common.ts";
import { fitSchema } from "./instance.ts";

const dimSchema = z.number().min(0).max(1);

/** One uploaded woff2 file of a font family, with the weight and style it provides. */
export const fontFaceSchema = z.object({
  assetId: idSchema,
  weight: z.number().int().min(1).max(1000).default(400),
  style: z.enum(["normal", "italic"]).default("normal"),
});
export type FontFaceRef = z.infer<typeof fontFaceSchema>;

/**
 * A font for one role. Without `faces`, `family` is a font stack the screen has locally, such
 * as `sans-serif`; with them, it names the uploaded family (ADR 0014).
 */
export const fontRefSchema = z.object({
  family: z.string().min(1),
  faces: z.array(fontFaceSchema).optional(),
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

/**
 * The frame the compositor draws around each overlay widget (ADR 0028). Every field is
 * optional; the viewer has the defaults.
 */
export const widgetFrameSchema = z.object({
  /** Default `glass`. */
  style: z.enum(["glass", "solid", "none"]).optional(),
  /** Glass only: how opaque the surface colour is, default 0.55. */
  opacity: z.number().min(0).max(1).optional(),
  /** Glass only: the backdrop blur in px, default 8. */
  blur: z.number().min(0).max(64).optional(),
  /** Corner radius in px, default 20. */
  radius: z.number().min(0).max(64).optional(),
  /** Default `soft`. Ignored by `none`. */
  shadow: z.enum(["none", "soft", "deep", "glow"]).optional(),
});
export type WidgetFrame = z.infer<typeof widgetFrameSchema>;

/** The widget frame when the theme doesn't set it (ADR 0028). */
export const DEFAULT_WIDGET_FRAME = {
  style: "glass",
  opacity: 0.55,
  blur: 8,
  radius: 20,
  shadow: "soft",
} as const satisfies Required<WidgetFrame>;

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
  /** The space between overlay widgets in a slot, px on the canvas (ADR 0012). */
  gap: z.number().nonnegative().optional(),
  widgets: widgetFrameSchema.optional(),
  /** Escape hatch, viewer-scoped, at your own risk. */
  customCss: z.string().optional(),
});
export type Theme = z.infer<typeof themeSchema>;
