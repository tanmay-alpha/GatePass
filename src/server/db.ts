import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Database = DatabaseSync;

/**
 * Ordered schema migrations. `PRAGMA user_version` records how many have run,
 * so each one executes exactly once per database file. Never edit a shipped
 * migration; append a new one.
 */
const migrations: string[] = [
  `
  CREATE TABLE events (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    venue       TEXT CHECK (venue IS NULL OR length(venue) <= 200),
    starts_at   TEXT NOT NULL,
    ends_at     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    design_json TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    CHECK (ends_at > starts_at)
  ) STRICT;

  CREATE TABLE scanners (
    id           TEXT PRIMARY KEY,
    event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
    label        TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
    key_hash     TEXT NOT NULL UNIQUE CHECK (length(key_hash) = 64),
    created_at   TEXT NOT NULL,
    revoked_at   TEXT,
    last_used_at TEXT
  ) STRICT;
  CREATE INDEX scanners_event_idx ON scanners(event_id);

  CREATE TABLE passes (
    id             TEXT PRIMARY KEY,
    event_id       TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
    token_hash     TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
    attendee_name  TEXT CHECK (attendee_name IS NULL OR length(attendee_name) <= 200),
    attendee_email TEXT CHECK (attendee_email IS NULL OR length(attendee_email) <= 254),
    expires_at     TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    revoked_at     TEXT
  ) STRICT;
  CREATE INDEX passes_event_idx ON passes(event_id, created_at);

  -- One row per redeemed pass. The primary key on pass_id is the
  -- database-level guarantee that a pass can be redeemed at most once.
  CREATE TABLE redemptions (
    pass_id     TEXT PRIMARY KEY REFERENCES passes(id) ON DELETE RESTRICT,
    scanner_id  TEXT NOT NULL REFERENCES scanners(id) ON DELETE RESTRICT,
    redeemed_at TEXT NOT NULL
  ) STRICT;

  -- Every scan attempt, successful or not.
  CREATE TABLE scans (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
    scanner_id TEXT NOT NULL REFERENCES scanners(id) ON DELETE RESTRICT,
    pass_id    TEXT REFERENCES passes(id) ON DELETE RESTRICT,
    outcome    TEXT NOT NULL CHECK (outcome IN ('admitted', 'already_redeemed', 'expired', 'revoked', 'invalid', 'event_closed', 'wrong_event')),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX scans_event_idx ON scans(event_id, id);

  CREATE TABLE audit_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id     TEXT REFERENCES events(id) ON DELETE RESTRICT,
    actor        TEXT NOT NULL,
    action       TEXT NOT NULL,
    entity_id    TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at   TEXT NOT NULL
  ) STRICT;
  CREATE INDEX audit_event_idx ON audit_log(event_id, id);
  `
];

export function openDatabase(file: string): Database {
  if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    // WAL lets readers proceed during a write; busy_timeout makes a second
    // connection wait for the write lock instead of failing immediately.
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

export function migrate(db: Database): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let version = current; version < migrations.length; version += 1) {
    transaction(db, () => {
      db.exec(migrations[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
}

/**
 * Runs `fn` in a write transaction. BEGIN IMMEDIATE takes the write lock up
 * front, so read-then-write sequences inside `fn` cannot interleave with
 * another connection's writes.
 */
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The transaction may already be rolled back by SQLite (e.g. on SQLITE_FULL).
    }
    throw error;
  }
}
