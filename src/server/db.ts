import { existsSync, mkdirSync } from 'node:fs';
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
  `,
  // 2 — admission policy engine (docs/decisions/0004-admission-policy-engine.md)
  `
  CREATE TABLE gates (
    id         TEXT PRIMARY KEY,
    event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
    name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    created_at TEXT NOT NULL,
    UNIQUE (event_id, name)
  ) STRICT;

  CREATE TABLE admission_policies (
    id             TEXT PRIMARY KEY,
    event_id       TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
    name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    opens_at       TEXT,
    closes_at      TEXT,
    capacity       INTEGER CHECK (capacity IS NULL OR capacity >= 1),
    -- Denormalised admission counter. The CHECK makes over-admission impossible
    -- even if application logic is wrong: the transaction aborts instead.
    admitted_count INTEGER NOT NULL DEFAULT 0 CHECK (admitted_count >= 0 AND (capacity IS NULL OR admitted_count <= capacity)),
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    UNIQUE (event_id, name),
    CHECK (opens_at IS NULL OR closes_at IS NULL OR closes_at > opens_at)
  ) STRICT;

  CREATE TABLE policy_gates (
    policy_id TEXT NOT NULL REFERENCES admission_policies(id) ON DELETE CASCADE,
    gate_id   TEXT NOT NULL REFERENCES gates(id) ON DELETE RESTRICT,
    PRIMARY KEY (policy_id, gate_id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX policy_gates_gate_idx ON policy_gates(gate_id);

  ALTER TABLE passes ADD COLUMN policy_id TEXT REFERENCES admission_policies(id) ON DELETE RESTRICT;
  CREATE INDEX passes_policy_idx ON passes(policy_id);
  ALTER TABLE scanners ADD COLUMN gate_id TEXT REFERENCES gates(id) ON DELETE RESTRICT;
  ALTER TABLE redemptions ADD COLUMN gate_id TEXT REFERENCES gates(id) ON DELETE RESTRICT;
  ALTER TABLE redemptions ADD COLUMN policy_id TEXT REFERENCES admission_policies(id) ON DELETE RESTRICT;
  CREATE INDEX redemptions_gate_idx ON redemptions(gate_id);

  -- scans: new outcomes need a new CHECK, which SQLite can only change by
  -- rebuilding the table. Nothing references scans, so a copy is safe.
  CREATE TABLE scans_v2 (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
    scanner_id TEXT NOT NULL REFERENCES scanners(id) ON DELETE RESTRICT,
    gate_id    TEXT REFERENCES gates(id) ON DELETE RESTRICT,
    pass_id    TEXT REFERENCES passes(id) ON DELETE RESTRICT,
    outcome    TEXT NOT NULL CHECK (outcome IN ('admitted', 'already_redeemed', 'expired', 'revoked', 'invalid', 'event_closed', 'wrong_event',
                                                'too_early', 'too_late', 'wrong_gate', 'capacity_full')),
    created_at TEXT NOT NULL
  ) STRICT;
  INSERT INTO scans_v2 (id, event_id, scanner_id, gate_id, pass_id, outcome, created_at)
    SELECT id, event_id, scanner_id, NULL, pass_id, outcome, created_at FROM scans;
  DROP TABLE scans;
  ALTER TABLE scans_v2 RENAME TO scans;
  CREATE INDEX scans_event_idx ON scans(event_id, id);
  CREATE INDEX scans_pass_idx ON scans(pass_id) WHERE pass_id IS NOT NULL;

  -- Cross-event integrity: a pass, scanner or policy may only reference a
  -- policy or gate of its own event.
  CREATE TRIGGER passes_policy_event_insert BEFORE INSERT ON passes
    WHEN NEW.policy_id IS NOT NULL AND (SELECT event_id FROM admission_policies WHERE id = NEW.policy_id) IS NOT NEW.event_id
    BEGIN SELECT RAISE(ABORT, 'policy belongs to another event'); END;
  CREATE TRIGGER passes_policy_event_update BEFORE UPDATE OF policy_id ON passes
    WHEN NEW.policy_id IS NOT NULL AND (SELECT event_id FROM admission_policies WHERE id = NEW.policy_id) IS NOT NEW.event_id
    BEGIN SELECT RAISE(ABORT, 'policy belongs to another event'); END;
  CREATE TRIGGER scanners_gate_event_insert BEFORE INSERT ON scanners
    WHEN NEW.gate_id IS NOT NULL AND (SELECT event_id FROM gates WHERE id = NEW.gate_id) IS NOT NEW.event_id
    BEGIN SELECT RAISE(ABORT, 'gate belongs to another event'); END;
  CREATE TRIGGER scanners_gate_event_update BEFORE UPDATE OF gate_id ON scanners
    WHEN NEW.gate_id IS NOT NULL AND (SELECT event_id FROM gates WHERE id = NEW.gate_id) IS NOT NEW.event_id
    BEGIN SELECT RAISE(ABORT, 'gate belongs to another event'); END;
  CREATE TRIGGER policy_gates_event_insert BEFORE INSERT ON policy_gates
    WHEN (SELECT event_id FROM gates WHERE id = NEW.gate_id) IS NOT (SELECT event_id FROM admission_policies WHERE id = NEW.policy_id)
    BEGIN SELECT RAISE(ABORT, 'gate belongs to another event'); END;
  `,
  // 3 — accounts, event membership, event lifecycle, idempotent scans
  // (docs/decisions/0008-accounts-and-event-roles.md)
  `
  CREATE TABLE users (
    id                  TEXT PRIMARY KEY,
    email               TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(email) BETWEEN 3 AND 254),
    name                TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    password_hash       TEXT NOT NULL,
    platform_role       TEXT NOT NULL DEFAULT 'organizer' CHECK (platform_role IN ('organizer', 'platform_admin')),
    created_at          TEXT NOT NULL,
    password_changed_at TEXT NOT NULL,
    disabled_at         TEXT
  ) STRICT;

  -- Only the SHA-256 of the session cookie is stored.
  CREATE TABLE sessions (
    id_hash      TEXT PRIMARY KEY CHECK (length(id_hash) = 64),
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    revoked_at   TEXT
  ) STRICT;
  CREATE INDEX sessions_user_idx ON sessions(user_id);

  CREATE TABLE event_members (
    event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    role       TEXT NOT NULL CHECK (role IN ('owner', 'manager')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (event_id, user_id)
  ) STRICT, WITHOUT ROWID;
  CREATE UNIQUE INDEX event_members_one_owner ON event_members(event_id) WHERE role = 'owner';
  CREATE INDEX event_members_user_idx ON event_members(user_id);

  -- One-time invitation links: 'organizer' / 'platform_admin' create an account,
  -- 'manager' adds an account to one event.
  CREATE TABLE invitations (
    id          TEXT PRIMARY KEY,
    token_hash  TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
    role        TEXT NOT NULL CHECK (role IN ('organizer', 'platform_admin', 'manager')),
    email       TEXT NOT NULL COLLATE NOCASE CHECK (length(email) BETWEEN 3 AND 254),
    event_id    TEXT REFERENCES events(id) ON DELETE RESTRICT,
    created_by  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    accepted_at TEXT,
    accepted_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
    revoked_at  TEXT,
    CHECK ((role = 'manager') = (event_id IS NOT NULL)),
    CHECK ((accepted_at IS NULL) = (accepted_by IS NULL))
  ) STRICT;
  CREATE INDEX invitations_event_idx ON invitations(event_id);

  CREATE TABLE password_resets (
    token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at    TEXT
  ) STRICT;
  CREATE INDEX password_resets_user_idx ON password_resets(user_id);

  -- events: new lifecycle states and an event-wide capacity need new CHECKs,
  -- so the table is rebuilt (foreign keys are off during migrations and
  -- re-checked before commit). admitted_count is backfilled from redemptions.
  CREATE TABLE events_v3 (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    venue          TEXT CHECK (venue IS NULL OR length(venue) <= 200),
    time_zone      TEXT NOT NULL DEFAULT 'UTC' CHECK (length(time_zone) BETWEEN 1 AND 64),
    starts_at      TEXT NOT NULL,
    ends_at        TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'ended', 'archived')),
    capacity       INTEGER CHECK (capacity IS NULL OR capacity >= 1),
    admitted_count INTEGER NOT NULL DEFAULT 0 CHECK (admitted_count >= 0 AND (capacity IS NULL OR admitted_count <= capacity)),
    design_json    TEXT NOT NULL DEFAULT '{}',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    CHECK (ends_at > starts_at)
  ) STRICT;
  INSERT INTO events_v3 (id, name, venue, starts_at, ends_at, status, admitted_count, design_json, created_at, updated_at)
    SELECT e.id, e.name, e.venue, e.starts_at, e.ends_at, e.status,
           (SELECT COUNT(*) FROM redemptions r JOIN passes p ON p.id = r.pass_id WHERE p.event_id = e.id),
           e.design_json, e.created_at, e.updated_at
    FROM events e;
  DROP TABLE events;
  ALTER TABLE events_v3 RENAME TO events;

  -- Scanner-generated request id: a retried redeem returns the original result
  -- instead of being judged again (and reported as already used).
  ALTER TABLE scans ADD COLUMN request_id TEXT CHECK (request_id IS NULL OR length(request_id) BETWEEN 8 AND 64);
  CREATE UNIQUE INDEX scans_request_idx ON scans(scanner_id, request_id) WHERE request_id IS NOT NULL;

  CREATE INDEX audit_action_idx ON audit_log(action, id);
  CREATE INDEX audit_platform_idx ON audit_log(id) WHERE event_id IS NULL;
  CREATE INDEX scans_alerts_idx ON scans(event_id, outcome, created_at);
  CREATE INDEX scans_scanner_idx ON scans(scanner_id, created_at);

  -- Scanner heartbeat (session fetch), distinct from last_used_at (last scan),
  -- and who issued the current key (keys a removed manager issued are revoked).
  ALTER TABLE scanners ADD COLUMN last_seen_at TEXT;
  ALTER TABLE scanners ADD COLUMN key_issued_by TEXT;

  -- Close the remaining cross-event gaps: policy_gates updates and
  -- redemptions whose scanner, gate or policy belong to another event.
  CREATE TRIGGER policy_gates_event_update BEFORE UPDATE ON policy_gates
    WHEN (SELECT event_id FROM gates WHERE id = NEW.gate_id) IS NOT (SELECT event_id FROM admission_policies WHERE id = NEW.policy_id)
    BEGIN SELECT RAISE(ABORT, 'gate belongs to another event'); END;
  CREATE TRIGGER redemptions_event_insert BEFORE INSERT ON redemptions
    WHEN (SELECT event_id FROM scanners WHERE id = NEW.scanner_id) IS NOT (SELECT event_id FROM passes WHERE id = NEW.pass_id)
      OR (NEW.gate_id IS NOT NULL AND (SELECT event_id FROM gates WHERE id = NEW.gate_id) IS NOT (SELECT event_id FROM passes WHERE id = NEW.pass_id))
      OR (NEW.policy_id IS NOT NULL AND (SELECT event_id FROM admission_policies WHERE id = NEW.policy_id) IS NOT (SELECT event_id FROM passes WHERE id = NEW.pass_id))
    BEGIN SELECT RAISE(ABORT, 'redemption references another event'); END;
  -- Admissions are permanent: a redemption row is never changed or removed.
  CREATE TRIGGER redemptions_immutable_update BEFORE UPDATE ON redemptions
    BEGIN SELECT RAISE(ABORT, 'redemptions are immutable'); END;
  CREATE TRIGGER redemptions_immutable_delete BEFORE DELETE ON redemptions
    BEGIN SELECT RAISE(ABORT, 'redemptions are immutable'); END;
  `
];

export const SCHEMA_VERSION = migrations.length;

/** Read-only view of the migration list, for migration tests. */
export const MIGRATIONS: readonly string[] = migrations;

export interface OpenOptions {
  /** Before applying pending migrations to an existing file, copy it to `<file>.pre-v<N>.bak`. Default true. */
  backupBeforeMigrate?: boolean;
}

export function openDatabase(file: string, options: OpenOptions = {}): Database {
  if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    // WAL lets readers proceed during a write; busy_timeout makes a second
    // connection wait for the write lock instead of failing immediately, and
    // comes first because the journal_mode pragma itself can meet that lock.
    // synchronous=FULL fsyncs the WAL on every commit: an admission that was
    // reported to the door survives power loss, not only a process crash.
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;');
    const current = schemaVersion(db);
    if (current > migrations.length) {
      throw new Error(`Database schema version ${current} is newer than this build supports (${migrations.length}). Upgrade GatePass or restore a matching backup.`);
    }
    if (file !== ':memory:' && current > 0 && current < migrations.length && options.backupBeforeMigrate !== false) {
      // A previous failed attempt may have left a backup for this version: keep it and write another.
      const backup = `${file}.pre-v${migrations.length}.bak`;
      backupDatabase(db, existsSync(backup) ? `${file}.pre-v${migrations.length}.${Date.now()}.bak` : backup);
    }
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

export function schemaVersion(db: Database): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

/**
 * Applies pending migrations, each in its own transaction together with the
 * version bump, so a failing migration leaves the previous schema and data
 * untouched. Foreign keys are switched off while migrations run (SQLite's
 * documented procedure for rebuilding a referenced table) and every migration
 * must pass `PRAGMA foreign_key_check` before it commits. `list` is
 * injectable for tests.
 */
export function migrate(db: Database, list: readonly string[] = migrations): void {
  if (schemaVersion(db) >= list.length) return;
  const foreignKeys = (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (let version = schemaVersion(db); version < list.length; version += 1) {
      transaction(db, () => {
        db.exec(list[version]);
        const violations = db.prepare('PRAGMA foreign_key_check').all();
        if (violations.length) throw new Error(`Migration ${version + 1} leaves foreign key violations: ${JSON.stringify(violations.slice(0, 5))}`);
        db.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  } finally {
    db.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  }
}

/**
 * Consistent online copy via `VACUUM INTO`, then verified with
 * `PRAGMA integrity_check` on the copy. Refuses to overwrite an existing file.
 */
export function backupDatabase(db: Database, destination: string): void {
  if (existsSync(destination)) throw new Error(`Backup destination already exists: ${destination}`);
  mkdirSync(path.dirname(path.resolve(destination)), { recursive: true });
  db.prepare('VACUUM INTO ?').run(destination);
  const copy = new DatabaseSync(destination, { readOnly: true });
  try {
    const result = copy.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
    if (result.length !== 1 || result[0].integrity_check !== 'ok') {
      throw new Error(`Backup failed integrity check: ${JSON.stringify(result.slice(0, 5))}`);
    }
  } finally {
    copy.close();
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
