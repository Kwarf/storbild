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
