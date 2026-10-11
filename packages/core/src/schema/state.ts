import { z } from "zod";
import { assetMetaSchema } from "./asset.ts";
import { idSchema } from "./common.ts";
import { cueSchema } from "./cue.ts";
import { instanceSchema } from "./instance.ts";
import { liveSchema } from "./live.ts";
import { overlayPlacementSchema } from "./overlay.ts";
import { playlistSchema } from "./playlist.ts";
import { pluginEntrySchema } from "./plugin.ts";
import { defaultShowSettings, showSettingsSchema } from "./settings.ts";
import { type Theme, themeSchema } from "./theme.ts";
import { type Timeline, timelineSchema } from "./timeline.ts";

export const showStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  plugins: z.record(z.string(), pluginEntrySchema),
  instances: z.record(idSchema, instanceSchema),
  playlist: playlistSchema,
  cues: z.array(cueSchema),
  overlays: z.array(overlayPlacementSchema),
  themes: z.record(idSchema, themeSchema),
  activeThemeId: idSchema,
  live: liveSchema,
  timeline: timelineSchema,
  assets: z.record(z.string(), assetMetaSchema),
  settings: showSettingsSchema,
});
export type ShowState = z.infer<typeof showStateSchema>;

/** Nothing on air: only the theme background. */
export const placeholderTimeline: Timeline = { mode: "auto", blackout: false };

/** The values a theme starts from when nothing else is given. */
export function defaultThemeValues(): Omit<Theme, "id" | "name"> {
  return {
    background: { type: "color", color: "#000000" },
    fonts: { heading: { family: "sans-serif" }, body: { family: "sans-serif" } },
    colors: { text: "#ffffff", muted: "#a0a0a0", accent: "#ffcc00", surface: "#1a1a1a" },
  };
}

export function createDefaultTheme(id: string): Theme {
  return { id, name: "Default", ...defaultThemeValues() };
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
    live: { blackout: false },
    timeline: placeholderTimeline,
    assets: {},
    settings: defaultShowSettings,
  };
}

/**
 * Makes sure the active theme exists (ADR 0014): a stored show whose theme rows were lost
 * activates its first theme, or gets a new default one. Returns `state` itself when it is fine.
 */
export function withActiveTheme(state: ShowState, newId: () => string): ShowState {
  if (state.themes[state.activeThemeId]) return state;
  const first = Object.keys(state.themes)[0];
  if (first !== undefined) return { ...state, activeThemeId: first };
  const theme = createDefaultTheme(newId());
  return { ...state, themes: { [theme.id]: theme }, activeThemeId: theme.id };
}
