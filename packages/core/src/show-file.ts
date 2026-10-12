import { z } from "zod";
import { reconcilePlugins } from "./plugins.ts";
import { CommandError } from "./reducer.ts";
import { assetMetaSchema } from "./schema/asset.ts";
import { epochMsSchema, idSchema, jsonSchema } from "./schema/common.ts";
import { cueSchema } from "./schema/cue.ts";
import { instanceSchema } from "./schema/instance.ts";
import { overlayPlacementSchema } from "./schema/overlay.ts";
import { playlistItemSchema } from "./schema/playlist.ts";
import type { PluginCatalog, PluginEntry } from "./schema/plugin.ts";
import { showSettingsSchema } from "./schema/settings.ts";
import { placeholderTimeline, type ShowState } from "./schema/state.ts";
import { themeSchema } from "./schema/theme.ts";

/** The `format` of a show file (ADR 0019). */
export const SHOW_FILE_FORMAT = "storbild-show";
/** The show file version this Storbild writes and reads. */
export const SHOW_FILE_VERSION = 1;

/**
 * The content of `show.json` in an exported show (ADR 0019): what the operator prepared, and
 * none of the runtime data (live control, the timeline, plugin and instance state, the anchor).
 * Collections are arrays, so the file reads in order.
 */
export const showFileSchema = z.object({
  format: z.literal(SHOW_FILE_FORMAT),
  version: z.literal(SHOW_FILE_VERSION),
  exportedAt: epochMsSchema,
  plugins: z.record(z.string(), z.object({ version: z.string().optional(), settings: jsonSchema })),
  instances: z.array(instanceSchema.omit({ state: true, error: true })),
  playlist: z.array(playlistItemSchema.omit({ resolvedDurationMs: true })),
  cues: z.array(cueSchema),
  overlays: z.array(overlayPlacementSchema),
  themes: z.array(themeSchema).min(1),
  activeThemeId: idSchema,
  settings: showSettingsSchema,
  assets: z.array(assetMetaSchema),
});
export type ShowFile = z.infer<typeof showFileSchema>;

/** Just enough of a show file to tell what it is before validating the rest. */
const headerSchema = z.object({ format: z.literal(SHOW_FILE_FORMAT), version: z.number().int() });

export type ParsedShowFile =
  | { ok: true; file: ShowFile }
  | { ok: false; message: string; issues?: z.core.$ZodIssue[] };

/** Validates the parsed JSON of `show.json`, telling a file from a newer Storbild apart. */
export function parseShowFile(json: unknown): ParsedShowFile {
  const header = headerSchema.safeParse(json);
  if (!header.success) return { ok: false, message: "This is not a Storbild show file." };
  if (header.data.version > SHOW_FILE_VERSION) {
    return {
      ok: false,
      message: `The show file is version ${header.data.version}, from a newer Storbild; this one reads version ${SHOW_FILE_VERSION}.`,
    };
  }
  const parsed = showFileSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, message: "The show file is invalid.", issues: parsed.error.issues };
  }
  return { ok: true, file: parsed.data };
}

/** The show as a show file. Pure; `now` is the export time. */
export function exportShow(state: ShowState, now: number): ShowFile {
  return {
    format: SHOW_FILE_FORMAT,
    version: SHOW_FILE_VERSION,
    exportedAt: now,
    plugins: Object.fromEntries(
      Object.entries(state.plugins).map(([id, plugin]) => [
        id,
        {
          ...(plugin.version !== undefined && { version: plugin.version }),
          settings: plugin.settings,
        },
      ]),
    ),
    instances: Object.values(state.instances).map(
      ({ state: _, error: __, ...instance }) => instance,
    ),
    playlist: state.playlist.items.map(({ resolvedDurationMs: _, ...item }) => item),
    cues: state.cues,
    overlays: state.overlays,
    themes: Object.values(state.themes),
    activeThemeId: state.activeThemeId,
    settings: state.settings,
    assets: Object.values(state.assets),
  };
}

/** Throws unless every ID in `ids` is unique. */
function unique(ids: string[], what: string) {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new CommandError("invalid", `the show file has two ${what} ${id}`);
    seen.add(id);
  }
  return seen;
}

/** Checks that everything the file refers to is in the file. */
function checkIntegrity(file: ShowFile) {
  const instances = unique(
    file.instances.map((instance) => instance.id),
    "instances",
  );
  const themes = unique(
    file.themes.map((theme) => theme.id),
    "themes",
  );
  const assets = unique(
    file.assets.map((asset) => asset.id),
    "assets",
  );
  unique(
    file.playlist.map((item) => item.id),
    "playlist items",
  );
  unique(
    file.cues.map((cue) => cue.id),
    "cues",
  );
  unique(
    file.overlays.map((placement) => placement.instanceId),
    "placements of instance",
  );

  const missing = (what: string, id: string, by: string) =>
    new CommandError("invalid", `${by} refers to ${what} ${id}, which isn't in the show file`);
  for (const item of file.playlist) {
    if (!instances.has(item.instanceId))
      throw missing("instance", item.instanceId, `playlist item ${item.id}`);
  }
  for (const placement of file.overlays) {
    if (!instances.has(placement.instanceId))
      throw missing("instance", placement.instanceId, "an overlay");
  }
  for (const cue of file.cues) {
    const { action } = cue;
    if (action.type === "activateTheme") {
      if (!themes.has(action.themeId)) throw missing("theme", action.themeId, `cue ${cue.id}`);
    } else if (!instances.has(action.instanceId)) {
      throw missing("instance", action.instanceId, `cue ${cue.id}`);
    }
  }
  if (!themes.has(file.activeThemeId))
    throw missing("theme", file.activeThemeId, "the active theme");
  for (const instance of file.instances) {
    if (typeof instance.background === "object" && !assets.has(instance.background.assetId)) {
      throw missing("asset", instance.background.assetId, `instance ${instance.id}`);
    }
  }
  for (const theme of file.themes) {
    const { background } = theme;
    if (background.type === "scene" && !instances.has(background.instanceId)) {
      throw missing("instance", background.instanceId, `theme ${theme.id}`);
    }
    const files = [
      ...(background.type === "image" || background.type === "video" ? [background.assetId] : []),
      ...Object.values(theme.fonts).flatMap(
        (font) => font?.faces?.map((face) => face.assetId) ?? [],
      ),
    ];
    for (const id of files) if (!assets.has(id)) throw missing("asset", id, `theme ${theme.id}`);
  }
}

const byId = <T extends { id: string }>(list: T[]) =>
  Object.fromEntries(list.map((value) => [value.id, value]));

/**
 * Replaces the show with an imported show file (ADR 0019). Pure; the revision is left to the
 * reducer. Throws a `CommandError` when the file refers to something it doesn't contain.
 *
 * - Live control is reset, and the rotation starts from its first item at `now`.
 * - Unfired cues whose time has passed are imported as fired, so an old file causes no
 *   surprise takes.
 * - Plugin entries and instances are reconciled with the loaded plugins: instances of plugins
 *   this install lacks are kept, broken, with their plugin `missing`.
 */
export function importShow(
  state: ShowState,
  file: ShowFile,
  ctx: { now: number; catalog: PluginCatalog },
): ShowState {
  checkIntegrity(file);
  const plugins: Record<string, PluginEntry> = Object.fromEntries(
    Object.entries(file.plugins).map(([id, { settings }]) => [
      id,
      { status: "missing", settings, state: null, types: {} },
    ]),
  );
  return reconcilePlugins(
    {
      revision: state.revision,
      plugins,
      instances: byId(file.instances),
      playlist: { items: file.playlist, anchorAt: ctx.now },
      cues: file.cues.map((cue) =>
        !cue.fired && cue.at <= ctx.now ? { ...cue, fired: true } : cue,
      ),
      overlays: file.overlays,
      themes: byId(file.themes),
      activeThemeId: file.activeThemeId,
      live: { blackout: false },
      timeline: placeholderTimeline,
      assets: byId(file.assets),
      settings: file.settings,
    },
    ctx.catalog,
  );
}
