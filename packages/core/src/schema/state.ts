import { z } from "zod";
import { assetMetaSchema } from "./asset.ts";
import { idSchema } from "./common.ts";
import { cueSchema } from "./cue.ts";
import { instanceSchema } from "./instance.ts";
import { overlayPlacementSchema } from "./overlay.ts";
import { playlistSchema } from "./playlist.ts";
import { type Theme, themeSchema } from "./theme.ts";
import { type Timeline, timelineSchema } from "./timeline.ts";

export const pluginStatusSchema = z.enum(["ok", "incompatible", "error"]);
export type PluginStatus = z.infer<typeof pluginStatusSchema>;

export const pluginEntrySchema = z.object({
  settings: z.json(),
  state: z.json(),
  status: pluginStatusSchema,
});
export type PluginEntry = z.infer<typeof pluginEntrySchema>;

export const showStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  plugins: z.record(z.string(), pluginEntrySchema),
  instances: z.record(idSchema, instanceSchema),
  playlist: playlistSchema,
  cues: z.array(cueSchema),
  overlays: z.array(overlayPlacementSchema),
  themes: z.record(idSchema, themeSchema),
  activeThemeId: idSchema,
  timeline: timelineSchema,
  assets: z.record(z.string(), assetMetaSchema),
});
export type ShowState = z.infer<typeof showStateSchema>;

/** Shown until the scheduler (M4) resolves a real timeline. */
export const placeholderTimeline: Timeline = { mode: "auto", blackout: false };

export function createDefaultTheme(id: string): Theme {
  return {
    id,
    name: "Default",
    background: { type: "color", color: "#000000" },
    fonts: { heading: { family: "sans-serif" }, body: { family: "sans-serif" } },
    colors: { text: "#ffffff", muted: "#a0a0a0", accent: "#ffcc00", surface: "#1a1a1a" },
  };
}

/** The state of a fresh show: no content, one default theme. */
export function createInitialState(ctx: { now: number; newId: () => string }): ShowState {
  const theme = createDefaultTheme(ctx.newId());
  return {
    revision: 0,
    plugins: {},
    instances: {},
    playlist: { items: [], anchorAt: ctx.now },
    cues: [],
    overlays: [],
    themes: { [theme.id]: theme },
    activeThemeId: theme.id,
    timeline: placeholderTimeline,
    assets: {},
  };
}
