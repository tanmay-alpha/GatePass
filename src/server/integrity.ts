import { copyFileSync, existsSync, renameSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, SCHEMA_VERSION, schemaVersion, type Database } from './db';

export interface IntegrityReport {
  ok: boolean;
  schemaVersion: number;
  counts: { events: number; passes: number; redemptions: number; scans: number; auditEntries: number; users: number };
  /** Empty when ok. Each entry names the invariant and up to five offending ids. */
  violations: string[];
}

/**
 * Admission invariants that must hold in every committed state. Each query
 * returns offending ids; an empty result means the invariant holds. These are
 * checked after restores and by `verify`, and by the concurrency tests against
 * the persisted database rather than API responses.
 */
const INVARIANTS: Array<{ name: string; sql: string }> = [
  {
    name: 'every redemption has exactly one admitted scan for the same pass',
    sql: `SELECT r.pass_id AS id FROM redemptions r
          WHERE (SELECT COUNT(*) FROM scans s WHERE s.pass_id = r.pass_id AND s.outcome = 'admitted') <> 1`
  },
  {
    name: 'no admitted scan without a redemption',
    sql: `SELECT s.id FROM scans s WHERE s.outcome = 'admitted' AND NOT EXISTS (SELECT 1 FROM redemptions r WHERE r.pass_id = s.pass_id)`
  },
  {
    name: 'policy admitted_count equals its redemptions',
    sql: `SELECT ap.id FROM admission_policies ap
          WHERE ap.admitted_count <> (SELECT COUNT(*) FROM redemptions r WHERE r.policy_id = ap.id)`
  },
  {
    name: 'event admitted_count equals its redemptions',
    sql: `SELECT e.id FROM events e
          WHERE e.admitted_count <> (SELECT COUNT(*) FROM redemptions r JOIN passes p ON p.id = r.pass_id WHERE p.event_id = e.id)`
  },
  {
    name: 'capacity never exceeded',
    sql: `SELECT id FROM admission_policies WHERE capacity IS NOT NULL AND admitted_count > capacity
          UNION ALL SELECT id FROM events WHERE capacity IS NOT NULL AND admitted_count > capacity`
  },
  {
    name: 'a redeemed pass was not revoked before its redemption',
    sql: `SELECT p.id FROM passes p JOIN redemptions r ON r.pass_id = p.id WHERE p.revoked_at IS NOT NULL AND p.revoked_at <= r.redeemed_at`
  },
  {
    name: 'redemption scanner, gate and policy belong to the pass event',
    sql: `SELECT r.pass_id AS id FROM redemptions r JOIN passes p ON p.id = r.pass_id JOIN scanners s ON s.id = r.scanner_id
          LEFT JOIN gates g ON g.id = r.gate_id LEFT JOIN admission_policies ap ON ap.id = r.policy_id
          WHERE s.event_id <> p.event_id OR (g.id IS NOT NULL AND g.event_id <> p.event_id) OR (ap.id IS NOT NULL AND ap.event_id <> p.event_id)`
  },
  {
    name: 'every revoked pass has a pass.revoked audit entry',
    sql: `SELECT p.id FROM passes p WHERE p.revoked_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.action = 'pass.revoked' AND a.entity_id = p.id)`
  },
  {
    name: 'every event has at most one owner',
    sql: `SELECT event_id AS id FROM event_members WHERE role = 'owner' GROUP BY event_id HAVING COUNT(*) > 1`
  }
];

/** Read-only. Runs SQLite's integrity and foreign-key checks, then the admission invariants. */
export function verifyDatabase(db: Database): IntegrityReport {
  const violations: string[] = [];
  const integrity = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
    violations.push(`integrity_check: ${integrity.slice(0, 5).map((row) => row.integrity_check).join('; ')}`);
  }
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeys.length) violations.push(`foreign_key_check: ${JSON.stringify(foreignKeys.slice(0, 5))}`);
  const version = schemaVersion(db);
  if (version === SCHEMA_VERSION) {
    for (const invariant of INVARIANTS) {
      const rows = db.prepare(`${invariant.sql} LIMIT 5`).all() as Array<{ id: unknown }>;
      if (rows.length) violations.push(`${invariant.name}: ${rows.map((row) => String(row.id)).join(', ')}`);
    }
  } else {
    violations.push(`schema version ${version} differs from this build (${SCHEMA_VERSION}); open it with GatePass to migrate before verifying invariants`);
  }
  const count = (table: string): number => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  return {
    ok: violations.length === 0,
    schemaVersion: version,
    counts: {
      events: count('events'),
      passes: count('passes'),
      redemptions: count('redemptions'),
      scans: count('scans'),
      auditEntries: count('audit_log'),
      users: version >= 3 ? count('users') : 0
    },
    violations
  };
}

/**
 * Restores `backup` into `target` while the server is stopped. The backup is
 * checked first (SQLite integrity); the current target, with its -wal and -shm
 * files, is kept as `<target>.replaced-<timestamp>` rather than deleted. The
 * restored file is then opened (applying pending migrations) and verified;
 * on any violation the previous files are put back and the restore fails.
 */
export function restoreDatabase(backup: string, target: string, now: Date = new Date()): IntegrityReport {
  if (!existsSync(backup)) throw new Error(`Backup not found: ${backup}`);
  const source = new DatabaseSync(backup, { readOnly: true });
  try {
    const integrity = source.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error(`Backup failed integrity check: ${JSON.stringify(integrity.slice(0, 5))}`);
    if (schemaVersion(source) > SCHEMA_VERSION) throw new Error(`Backup schema version ${schemaVersion(source)} is newer than this build (${SCHEMA_VERSION})`);
  } finally {
    source.close();
  }

  const suffix = `.replaced-${now.toISOString().replace(/[:.]/g, '-')}`;
  const moved: Array<[string, string]> = [];
  for (const extension of ['', '-wal', '-shm']) {
    const file = `${target}${extension}`;
    if (existsSync(file)) {
      renameSync(file, `${target}${suffix}${extension}`);
      moved.push([`${target}${suffix}${extension}`, file]);
    }
  }
  try {
    copyFileSync(backup, target);
    const db = openDatabase(target, { backupBeforeMigrate: false });
    try {
      const report = verifyDatabase(db);
      if (!report.ok) throw new Error(`Restored database violates invariants:\n  ${report.violations.join('\n  ')}`);
      return report;
    } finally {
      db.close();
    }
  } catch (error) {
    for (const extension of ['', '-wal', '-shm']) {
      if (existsSync(`${target}${extension}`)) renameSync(`${target}${extension}`, `${target}.failed-restore${suffix}${extension}`);
    }
    for (const [from, to] of moved) renameSync(from, to);
    throw error;
  }
}
