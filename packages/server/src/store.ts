import type { Database } from "bun:sqlite";
import {
  assetMetaSchema,
  cueSchema,
  defaultShowSettings,
  idSchema,
  instanceSchema,
  liveSchema,
  overlayPlacementSchema,
  type PluginEntry,
  placeholderTimeline,
  playlistItemSchema,
  pluginEntrySchema,
  type ShowState,
  showSettingsSchema,
  themeSchema,
  timelineSchema,
} from "@storbild/core";
import { z } from "zod";

export type Log = (message: string) => void;

const pluginInfoSchema = pluginEntrySchema.omit({ settings: true, state: true });

type Key = keyof ShowState;

const allKeys: readonly Key[] = [
  "revision",
  "plugins",
  "instances",
  "playlist",
  "cues",
  "overlays",
  "themes",
  "activeThemeId",
  "live",
  "timeline",
  "assets",
  "settings",
];

/**
 * Writes the parts of `state` named by `keys` (all by default) in one transaction. Collections
 * are rewritten whole: shows have tens of rows, so this is cheap and needs no bookkeeping.
 */
export function saveState(db: Database, state: ShowState, keys: Iterable<Key> = allKeys) {
  const setMeta = db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  const meta = (key: string, value: unknown) => setMeta.run(key, JSON.stringify(value));
  const rewrite = (table: string, columns: string[], rows: unknown[][]) => {
    db.run(`DELETE FROM ${table}`);
    const insert = db.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    );
    for (const row of rows) insert.run(...(row as string[]));
  };

  db.transaction(() => {
    for (const key of new Set(keys)) {
      switch (key) {
        case "revision":
        case "activeThemeId":
        case "live":
        case "timeline":
        case "settings":
          meta(key, state[key]);
          break;
        case "playlist":
          meta("playlist.anchorAt", state.playlist.anchorAt);
          meta("playlist.anchorItemId", state.playlist.anchorItemId ?? null);
          rewrite(
            "playlist_items",
            ["id", "position", "data"],
            state.playlist.items.map((item, i) => [item.id, i, JSON.stringify(item)]),
          );
          break;
        case "instances":
        case "themes":
        case "assets":
          rewrite(
            key,
            ["id", "data"],
            Object.values(state[key]).map((value) => [value.id, JSON.stringify(value)]),
          );
          break;
        case "cues":
          rewrite(
            "cues",
            ["id", "data"],
            state.cues.map((cue) => [cue.id, JSON.stringify(cue)]),
          );
          break;
        case "overlays":
          rewrite(
            "overlays",
            ["instance_id", "position", "data"],
            state.overlays.map((o, i) => [o.instanceId, i, JSON.stringify(o)]),
          );
          break;
        case "plugins":
          rewrite(
            "plugins",
            ["id", "settings", "state", "info"],
            Object.entries(state.plugins).map(([id, { settings, state, ...info }]) => [
              id,
              JSON.stringify(settings),
              JSON.stringify(state),
              JSON.stringify(info),
            ]),
          );
          break;
      }
    }
  })();
}

/**
 * Loads the persisted state, or returns undefined for a fresh database. Rows that fail
 * validation are logged and skipped, so one bad row never stops the show.
 */
export function loadState(db: Database, log: Log = console.warn): ShowState | undefined {
  const meta = new Map(
    (db.query("SELECT key, value FROM meta").all() as { key: string; value: string }[]).map(
      (row) => [row.key, JSON.parse(row.value) as unknown],
    ),
  );
  if (!meta.has("revision")) return undefined;

  function rows<T>(sql: string, schema: z.ZodType<T>, what: string): T[] {
    const result: T[] = [];
    for (const row of db.query(sql).all() as { id: string; data: string }[]) {
      const parsed = schema.safeParse(JSON.parse(row.data));
      if (parsed.success) result.push(parsed.data);
      else log(`skipping invalid ${what} ${row.id}: ${z.prettifyError(parsed.error)}`);
    }
    return result;
  }
  function metaValue<T>(key: string, schema: z.ZodType<T>, fallback: T): T {
    // Keys added after a database was created are absent rather than invalid.
    if (!meta.has(key)) return fallback;
    const parsed = schema.safeParse(meta.get(key));
    if (parsed.success) return parsed.data;
    log(`invalid meta ${key}, using the default`);
    return fallback;
  }
  const byId = <T extends { id: string }>(list: T[]) =>
    Object.fromEntries(list.map((value) => [value.id, value]));

  const plugins: Record<string, PluginEntry> = {};
  for (const row of db.query("SELECT id, settings, state, info FROM plugins").all() as {
    id: string;
    settings: string;
    state: string;
    info: string;
  }[]) {
    // The plugin host recomputes everything but settings and state when it reconciles the
    // loaded plugins with this state, so an unreadable `info` only needs a placeholder.
    const info = pluginInfoSchema.safeParse(JSON.parse(row.info));
    plugins[row.id] = {
      ...(info.success ? info.data : { status: "missing", types: {} }),
      settings: JSON.parse(row.settings),
      state: JSON.parse(row.state),
    };
  }

  const anchorItemId = metaValue("playlist.anchorItemId", idSchema.nullable(), null);
  return {
    revision: metaValue("revision", z.number().int().nonnegative(), 0),
    plugins,
    instances: byId(rows("SELECT id, data FROM instances", instanceSchema, "instance")),
    playlist: {
      items: rows(
        "SELECT id, data FROM playlist_items ORDER BY position",
        playlistItemSchema,
        "playlist item",
      ),
      anchorAt: metaValue("playlist.anchorAt", z.number().int(), 0),
      ...(anchorItemId !== null && { anchorItemId }),
    },
    cues: rows("SELECT id, data FROM cues", cueSchema, "cue"),
    overlays: rows(
      "SELECT instance_id AS id, data FROM overlays ORDER BY position",
      overlayPlacementSchema,
      "overlay placement",
    ),
    themes: byId(rows("SELECT id, data FROM themes", themeSchema, "theme")),
    activeThemeId: metaValue("activeThemeId", z.string(), ""),
    live: metaValue("live", liveSchema, { blackout: false }),
    timeline: metaValue("timeline", timelineSchema, placeholderTimeline),
    assets: byId(rows("SELECT id, data FROM assets", assetMetaSchema, "asset")),
    settings: metaValue("settings", showSettingsSchema, defaultShowSettings),
  };
}
