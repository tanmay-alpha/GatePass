import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, MIGRATIONS, openDatabase, SCHEMA_VERSION, schemaVersion, type Database } from '../src/server/db';
import { GatePass } from '../src/server/gatepass';
import { verifyDatabase } from '../src/server/integrity';
import { hashToken } from '../src/server/tokens';

// Upgrades a populated schema-version-2 database (the last shipped schema)
// built with raw SQL, the way an existing deployment's file looks, and checks
// that nothing is lost or loosened by the migration to the current schema.

const LEGACY_VERSION = 2;
const NOW = new Date('2030-06-01T18:30:00.000Z');
const E1 = { start: '2030-06-01T18:00:00.000Z', end: '2030-06-01T23:00:00.000Z' };
const E2 = { start: '2030-05-01T18:00:00.000Z', end: '2030-05-01T23:00:00.000Z' };

/** Deterministic 43-character base64url pass token. */
const token = (id: string) => createHash('sha256').update(`token:${id}`).digest('base64url');
const scannerKey = (id: string) => `gps_${createHash('sha256').update(`key:${id}`).digest('base64url')}`;

const dirs: string[] = [];
const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) if (db.isOpen) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function tempFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gatepass-migration-'));
  dirs.push(dir);
  return path.join(dir, 'legacy.db');
}

function track<T extends Database>(db: T): T {
  open.push(db);
  return db;
}

interface Legacy {
  file: string;
  passIds: { e1: string[]; e2: string[] };
}

/**
 * Event e1 (active, 18:00–23:00) with gates Main/VIP, policies General
 * (capacity 100, Main+VIP) and VIP (capacity 10, VIP); 40 passes incl. 3
 * revoked, 2 expired. Event e2 (archived) with gate Old Main, uncapped policy
 * Old, 10 passes. Scanners: s1 @Main, s2 @VIP, s3 revoked, s4 @Old Main (e2),
 * s5 roaming (no gate). Redemptions with matching admitted scans and policy
 * counters, scans of every outcome, audit rows incl. pass.revoked.
 */
function buildLegacyDatabase(): Legacy {
  const file = tempFile();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db, MIGRATIONS.slice(0, LEGACY_VERSION));
  expect(schemaVersion(db)).toBe(LEGACY_VERSION);

  const run = (sql: string, ...params: Array<string | number | null>) => db.prepare(sql).run(...params);
  db.exec('BEGIN');
  run("INSERT INTO events (id, name, venue, starts_at, ends_at, status, design_json, created_at, updated_at) VALUES ('e1', 'Launch Night', 'Hall A', ?, ?, 'active', '{\"accent\":\"#0f766e\"}', '2030-05-20T10:00:00.000Z', '2030-05-20T10:00:00.000Z')", E1.start, E1.end);
  run("INSERT INTO events (id, name, venue, starts_at, ends_at, status, created_at, updated_at) VALUES ('e2', 'Spring Gala', NULL, ?, ?, 'archived', '2030-04-01T10:00:00.000Z', '2030-05-02T10:00:00.000Z')", E2.start, E2.end);

  const gate = (id: string, event: string, name: string) => run('INSERT INTO gates (id, event_id, name, created_at) VALUES (?, ?, ?, ?)', id, event, name, '2030-05-20T10:01:00.000Z');
  gate('g1', 'e1', 'Main');
  gate('g2', 'e1', 'VIP');
  gate('g3', 'e2', 'Old Main');

  const policy = (id: string, event: string, name: string, capacity: number | null, admitted: number, opensAt: string | null = null, closesAt: string | null = null) =>
    run(
      'INSERT INTO admission_policies (id, event_id, name, opens_at, closes_at, capacity, admitted_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, event, name, opensAt, closesAt, capacity, admitted, '2030-05-20T10:02:00.000Z', '2030-05-20T10:02:00.000Z'
    );
  policy('pol-ga', 'e1', 'General', 100, 8);
  policy('pol-vip', 'e1', 'VIP', 10, 2, '2030-06-01T17:30:00.000Z', '2030-06-01T22:00:00.000Z');
  policy('pol-old', 'e2', 'Old', null, 6);
  for (const [p, g] of [['pol-ga', 'g1'], ['pol-ga', 'g2'], ['pol-vip', 'g2'], ['pol-old', 'g3']]) run('INSERT INTO policy_gates (policy_id, gate_id) VALUES (?, ?)', p, g);

  const scanner = (id: string, event: string, label: string, gateId: string | null, revokedAt: string | null = null) =>
    run('INSERT INTO scanners (id, event_id, label, key_hash, created_at, revoked_at, gate_id) VALUES (?, ?, ?, ?, ?, ?, ?)', id, event, label, hashToken(scannerKey(id)), '2030-05-20T10:03:00.000Z', revokedAt, gateId);
  scanner('s1', 'e1', 'Main door', 'g1');
  scanner('s2', 'e1', 'VIP door', 'g2');
  scanner('s3', 'e1', 'Lost phone', null, '2030-05-25T09:00:00.000Z');
  scanner('s4', 'e2', 'Gala door', 'g3');
  scanner('s5', 'e1', 'Roaming', null);

  const e1 = Array.from({ length: 40 }, (_, i) => `p${String(i + 1).padStart(2, '0')}`);
  const e2 = Array.from({ length: 10 }, (_, i) => `q${String(i + 1).padStart(2, '0')}`);
  const insertPass = db.prepare(
    'INSERT INTO passes (id, event_id, token_hash, attendee_name, attendee_email, expires_at, created_at, revoked_at, policy_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  e1.forEach((id, i) => {
    const n = i + 1;
    const policyId = n <= 15 ? 'pol-ga' : n <= 20 ? 'pol-vip' : null;
    const expiresAt = n >= 39 ? '2030-06-01T18:15:00.000Z' : E1.end; // p39, p40 expired before NOW
    const revokedAt = n >= 36 && n <= 38 ? '2030-05-28T12:00:00.000Z' : null; // p36–p38 revoked
    insertPass.run(id, 'e1', hashToken(token(id)), `Guest ${n}`, n % 3 ? `guest${n}@example.com` : null, expiresAt, '2030-05-21T09:00:00.000Z', revokedAt, policyId);
  });
  e2.forEach((id, i) => insertPass.run(id, 'e2', hashToken(token(id)), `Gala ${i + 1}`, null, E2.end, '2030-04-02T09:00:00.000Z', null, 'pol-old'));

  let minute = 0;
  const at = (base: string) => new Date(Date.parse(base) + 600_000 + (minute += 1) * 1000).toISOString();
  const scan = (event: string, scannerId: string, gateId: string | null, passId: string | null, outcome: string, createdAt: string) =>
    run('INSERT INTO scans (event_id, scanner_id, gate_id, pass_id, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?)', event, scannerId, gateId, passId, outcome, createdAt);
  const redeem = (event: string, passId: string, scannerId: string, gateId: string | null, policyId: string | null, base: string) => {
    const when = at(base);
    run('INSERT INTO redemptions (pass_id, scanner_id, redeemed_at, gate_id, policy_id) VALUES (?, ?, ?, ?, ?)', passId, scannerId, when, gateId, policyId);
    scan(event, scannerId, gateId, passId, 'admitted', when);
  };
  for (const id of e1.slice(0, 8)) redeem('e1', id, 's1', 'g1', 'pol-ga', E1.start); // p01–p08 General @Main
  for (const id of ['p16', 'p17']) redeem('e1', id, 's2', 'g2', 'pol-vip', E1.start); // VIP @VIP
  for (const id of e1.slice(20, 25)) redeem('e1', id, 's5', null, null, E1.start); // p21–p25 roaming, no policy
  for (const id of e2.slice(0, 6)) redeem('e2', id, 's4', 'g3', 'pol-old', E2.start); // q01–q06

  // Every non-admitted outcome, in both events.
  scan('e1', 's1', 'g1', 'p01', 'already_redeemed', at(E1.start));
  scan('e1', 's1', 'g1', 'p39', 'expired', at(E1.start));
  scan('e1', 's5', null, 'p36', 'revoked', at(E1.start));
  scan('e1', 's5', null, null, 'invalid', at(E1.start));
  scan('e1', 's1', 'g1', null, 'wrong_event', at(E1.start));
  scan('e1', 's2', 'g2', 'p18', 'too_early', '2030-06-01T17:10:00.000Z');
  scan('e1', 's2', 'g2', 'p19', 'too_late', '2030-06-01T22:10:00.000Z');
  scan('e1', 's1', 'g1', 'p20', 'wrong_gate', at(E1.start));
  scan('e1', 's2', 'g2', 'p10', 'capacity_full', at(E1.start));
  scan('e2', 's4', 'g3', 'q07', 'event_closed', '2030-05-02T08:00:00.000Z');
  scan('e2', 's4', 'g3', 'q01', 'already_redeemed', at(E2.start));

  const audit = (event: string | null, actor: string, action: string, entityId: string | null, details: object, createdAt: string) =>
    run('INSERT INTO audit_log (event_id, actor, action, entity_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)', event, actor, action, entityId, JSON.stringify(details), createdAt);
  audit('e1', 'admin', 'event.created', 'e1', {}, '2030-05-20T10:00:00.000Z');
  audit('e1', 'admin', 'passes.issued', null, { count: 40 }, '2030-05-21T09:00:00.000Z');
  for (const s of ['s1', 's2', 's3', 's5']) audit('e1', 'admin', 'scanner.created', s, {}, '2030-05-20T10:03:00.000Z');
  audit('e1', 'admin', 'scanner.revoked', 's3', {}, '2030-05-25T09:00:00.000Z');
  for (const p of ['p36', 'p37', 'p38']) audit('e1', 'admin', 'pass.revoked', p, {}, '2030-05-28T12:00:00.000Z');
  audit('e2', 'admin', 'event.created', 'e2', {}, '2030-04-01T10:00:00.000Z');
  audit('e2', 'admin', 'passes.issued', null, { count: 10 }, '2030-04-02T09:00:00.000Z');
  audit('e2', 'admin', 'event.archived', 'e2', {}, '2030-05-02T10:00:00.000Z');
  db.exec('COMMIT');

  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  db.close();
  return { file, passIds: { e1, e2 } };
}

function tables(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
}

function snapshot(db: DatabaseSync) {
  const counts = Object.fromEntries(tables(db).map((name) => [name, Number((db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n)]));
  const all = (sql: string) => db.prepare(sql).all().map((row) => ({ ...row }));
  return {
    counts,
    tokenHashes: all('SELECT id, token_hash, revoked_at, expires_at, policy_id FROM passes ORDER BY id'),
    keyHashes: all('SELECT id, key_hash, revoked_at, gate_id FROM scanners ORDER BY id'),
    redemptions: all('SELECT pass_id, scanner_id, gate_id, policy_id, redeemed_at FROM redemptions ORDER BY pass_id'),
    scans: all('SELECT id, event_id, scanner_id, gate_id, pass_id, outcome, created_at FROM scans ORDER BY id'),
    audit: all('SELECT id, event_id, actor, action, entity_id, details_json, created_at FROM audit_log ORDER BY id'),
    policies: all('SELECT id, event_id, capacity, admitted_count FROM admission_policies ORDER BY id'),
    events: all('SELECT id, name, status, starts_at, ends_at, design_json FROM events ORDER BY id')
  };
}

function readSnapshot(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return { version: schemaVersion(db), ...snapshot(db) };
  } finally {
    db.close();
  }
}

describe('migrating a populated version 2 database', () => {
  it('preserves every row, hash, constraint and invariant, and keeps legacy passes and keys working', () => {
    const { file } = buildLegacyDatabase();
    const before = readSnapshot(file);
    expect(before.version).toBe(LEGACY_VERSION);
    expect(before.counts).toMatchObject({ events: 2, gates: 3, admission_policies: 3, policy_gates: 4, scanners: 5, passes: 50, redemptions: 21, audit_log: 13 });
    expect(new Set(before.scans.map((row) => row.outcome))).toEqual(
      new Set(['admitted', 'already_redeemed', 'expired', 'revoked', 'invalid', 'wrong_event', 'too_early', 'too_late', 'wrong_gate', 'capacity_full', 'event_closed'])
    );

    const db = track(openDatabase(file));
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);

    // Pre-migration backup: a version 2 copy of the original.
    const backupFile = `${file}.pre-v${SCHEMA_VERSION}.bak`;
    expect(existsSync(backupFile)).toBe(true);
    const backup = readSnapshot(backupFile);
    expect(backup.version).toBe(LEGACY_VERSION);
    expect(backup.counts).toEqual(before.counts);

    // Every pre-existing table keeps its rows; tables added by the migration start empty.
    const after = snapshot(db);
    for (const [table, n] of Object.entries(before.counts)) expect({ table, n: after.counts[table] }).toEqual({ table, n });
    for (const table of Object.keys(after.counts).filter((name) => !(name in before.counts))) expect({ table, n: after.counts[table] }).toEqual({ table, n: 0 });
    expect(after.tokenHashes).toEqual(before.tokenHashes);
    expect(after.keyHashes).toEqual(before.keyHashes);
    expect(after.redemptions).toEqual(before.redemptions);
    expect(after.scans).toEqual(before.scans);
    expect(after.audit).toEqual(before.audit);
    expect(after.policies).toEqual(before.policies);
    expect(after.events).toEqual(before.events);

    // events.admitted_count backfilled from redemptions per event.
    const admitted = db.prepare('SELECT id, admitted_count, capacity, time_zone FROM events ORDER BY id').all().map((row) => ({ ...row }));
    expect(admitted).toEqual([
      { id: 'e1', admitted_count: 15, capacity: null, time_zone: 'UTC' },
      { id: 'e2', admitted_count: 6, capacity: null, time_zone: 'UTC' }
    ]);
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);

    const report = verifyDatabase(db);
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);

    // Uniqueness still enforced after the table rebuilds.
    expect(() =>
      db.prepare("INSERT INTO passes (id, event_id, token_hash, expires_at, created_at) VALUES ('dup', 'e1', ?, ?, 'x')").run(hashToken(token('p30')), E1.end)
    ).toThrow(/UNIQUE constraint failed: passes.token_hash/);
    expect(() => db.prepare("INSERT INTO redemptions (pass_id, scanner_id, redeemed_at) VALUES ('p21', 's5', 'x')").run()).toThrow(
      /UNIQUE constraint failed: redemptions.pass_id|PRIMARY KEY/
    );
    expect(() =>
      db.prepare("INSERT INTO scanners (id, event_id, label, key_hash, created_at) VALUES ('dup', 'e1', 'Copy', ?, 'x')").run(hashToken(scannerKey('s1')))
    ).toThrow(/UNIQUE constraint failed: scanners.key_hash/);
    expect(() => db.prepare("INSERT INTO passes (id, event_id, token_hash, expires_at, created_at) VALUES ('orphan', 'nope', ?, ?, 'x')").run('a'.repeat(64), E1.end)).toThrow(
      /FOREIGN KEY/
    );

    // The service on the migrated file: legacy keys, legacy passes, legacy redemptions.
    const service = new GatePass(db, { publicUrl: 'https://gate.example', now: () => new Date(NOW) });
    const main = service.authenticateScanner(scannerKey('s1'));
    expect(main).toMatchObject({ id: 's1', eventId: 'e1', gateId: 'g1' });
    const roaming = service.authenticateScanner(scannerKey('s5'))!;
    expect(roaming).toMatchObject({ id: 's5', gateId: null });
    expect(service.authenticateScanner(scannerKey('s3'))).toBeNull();

    expect(service.redeem(roaming, token('p26')).outcome).toBe('admitted');
    expect(service.redeem(roaming, token('p26')).outcome).toBe('already_redeemed');
    const legacyRedeemed = service.redeem(main!, token('p21'));
    expect(legacyRedeemed.outcome).toBe('already_redeemed');
    expect(legacyRedeemed.detail).toMatchObject({ redeemedAtGate: null, sameDevice: false });
    expect(service.redeem(main!, token('p09')).outcome).toBe('admitted'); // General policy, gate Main
    expect(service.redeem(main!, token('p36')).outcome).toBe('revoked');
    expect(service.redeem(main!, token('p40')).outcome).toBe('expired');
    expect(service.getEvent('e1')).toMatchObject({ status: 'active', admittedCount: 17 });
    expect(service.getEvent('e2')).toMatchObject({ status: 'archived', admittedCount: 6 });
    expect(service.access.getPolicy('pol-ga').admittedCount).toBe(9);
    expect(verifyDatabase(db).violations).toEqual([]);
  });

  it('rolls back a migration that would leave a foreign-key violation, leaving the version unchanged', () => {
    const { file } = buildLegacyDatabase();
    const db = track(openDatabase(file));
    const before = snapshot(db);
    const bad = `
      CREATE TABLE half_done (x INTEGER);
      INSERT INTO passes (id, event_id, token_hash, expires_at, created_at) VALUES ('orphan', 'no-such-event', '${'b'.repeat(64)}', '${E1.end}', 'x');
    `;
    expect(() => migrate(db, [...MIGRATIONS, bad])).toThrow(/foreign key violations/);
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").get()).toBeUndefined();
    expect(db.prepare("SELECT id FROM passes WHERE id = 'orphan'").get()).toBeUndefined();
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
    expect(snapshot(db)).toEqual(before);
    expect(verifyDatabase(db).ok).toBe(true);
  });

  it('commits each migration on its own: a failing later migration leaves the upgrade from version 2 intact and itself fully rolled back', () => {
    const { file } = buildLegacyDatabase();
    const db = track(new DatabaseSync(file));
    db.exec('PRAGMA foreign_keys = ON');
    // scans has no cross-event trigger, so only the foreign-key check can catch this orphan.
    const bad = `INSERT INTO scans (event_id, scanner_id, outcome, created_at) VALUES ('e1', 'ghost-scanner', 'invalid', 'x');`;
    const scansBefore = Number((db.prepare('SELECT COUNT(*) AS n FROM scans').get() as { n: number }).n);
    expect(() => migrate(db, [...MIGRATIONS, bad])).toThrow(/foreign key violations/);
    // Migration 3 committed on its own; the failing one left nothing behind.
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'users'").get()).toBeDefined();
    expect(Number((db.prepare('SELECT COUNT(*) AS n FROM scans').get() as { n: number }).n)).toBe(scansBefore);
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
    expect(verifyDatabase(db).ok).toBe(true);
  });

  it('opens and migrates when a pre-migration backup from an earlier failed attempt already exists (DB-03)', () => {
    const { file } = buildLegacyDatabase();
    const backupFile = `${file}.pre-v${SCHEMA_VERSION}.bak`;
    copyFileSync(file, backupFile);
    const stale = readFileSync(backupFile);

    const db = track(openDatabase(file));
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(verifyDatabase(db).ok).toBe(true);
    // The earlier backup is kept untouched and a second, timestamped one is written.
    expect(readFileSync(backupFile).equals(stale)).toBe(true);
    const extra = readdirSync(path.dirname(file)).filter((name) => name.startsWith(`legacy.db.pre-v${SCHEMA_VERSION}.`) && name !== path.basename(backupFile));
    expect(extra).toHaveLength(1);
    expect(extra[0]).toMatch(new RegExp(`^legacy\\.db\\.pre-v${SCHEMA_VERSION}\\.\\d+\\.bak$`));
    expect(readSnapshot(path.join(path.dirname(file), extra[0])).version).toBe(LEGACY_VERSION);
    db.close();

    // A third open (already current) neither migrates nor writes another backup.
    const again = track(openDatabase(file));
    expect(schemaVersion(again)).toBe(SCHEMA_VERSION);
    expect(readdirSync(path.dirname(file)).filter((name) => name.includes('.pre-v'))).toHaveLength(2);
  });
});
