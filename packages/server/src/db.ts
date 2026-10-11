import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Schema migrations; entry N upgrades `user_version` N to N+1. Never edit a shipped entry. */
const migrations: string[] = [
  `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL CHECK (json_valid(value))
  ) STRICT;
  CREATE TABLE instances (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL CHECK (json_valid(data))
  ) STRICT;
  CREATE TABLE playlist_items (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    data TEXT NOT NULL CHECK (json_valid(data))
  ) STRICT;
  CREATE TABLE cues (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL CHECK (json_valid(data))
  ) STRICT;
  CREATE TABLE overlays (
    instance_id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    data TEXT NOT NULL CHECK (json_valid(data))
  ) STRICT;
  CREATE TABLE themes (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL CHECK (json_valid(data))
  ) STRICT;
  CREATE TABLE plugins (
    id TEXT PRIMARY KEY,
    settings TEXT NOT NULL CHECK (json_valid(settings)),
    state TEXT NOT NULL CHECK (json_valid(state))
  ) STRICT;
  `,
  // The plugin host's view of each plugin (status, version, module, types). It is recomputed
  // on load; storing it means a restart with unchanged plugins doesn't produce a new revision.
  `
  ALTER TABLE plugins ADD COLUMN info TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(info));
  `,
  // Admin sessions (ADR 0007). `id` is the SHA-256 of the cookie's token.
  `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  ) STRICT;
  `,
  // An interrupt's `dimBelow` flag becomes `below` (ADR 0008), keeping its meaning: true is
  // "dim", false is "show".
  `
  UPDATE meta SET value = json_set(
    json_remove(value, '$.interrupt.dimBelow'),
    '$.interrupt.below',
    CASE json_extract(value, '$.interrupt.dimBelow') WHEN 1 THEN 'dim' ELSE 'show' END
  ) WHERE key IN ('live', 'timeline') AND json_type(value, '$.interrupt.dimBelow') IS NOT NULL;
  UPDATE cues SET data = json_set(
    json_remove(data, '$.action.dimBelow'),
    '$.action.below',
    CASE json_extract(data, '$.action.dimBelow') WHEN 1 THEN 'dim' ELSE 'show' END
  ) WHERE json_type(data, '$.action.dimBelow') IS NOT NULL;
  `,
  // Uploaded files' metadata (ADR 0011); the files are in the data directory's `assets/`.
  `
  CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL CHECK (json_valid(data))
  ) STRICT;
  `,
];

/** Opens (creating if needed) and migrates the database. `path` may be ":memory:". */
export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: Database) {
  const { user_version: version } = db.query("PRAGMA user_version").get() as {
    user_version: number;
  };
  if (version > migrations.length) {
    throw new Error(`database schema version ${version} is newer than this Storbild`);
  }
  db.transaction(() => {
    for (let v = version; v < migrations.length; v++) {
      db.run(migrations[v] as string);
    }
    db.run(`PRAGMA user_version = ${migrations.length}`);
  })();
}
