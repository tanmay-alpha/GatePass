import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { backupDatabase, migrate, MIGRATIONS, openDatabase, SCHEMA_VERSION, schemaVersion } from '../src/server/db';
import { GatePass } from '../src/server/gatepass';
import { hashToken } from '../src/server/tokens';
import { createHarness, EVENT_INPUT, PUBLIC_URL, type Harness } from './helpers';
import { count, redeemInThreads } from './threads';

let h: Harness;
afterEach(() => h?.close());

function setup() {
  h = createHarness();
  const event = h.service.createEvent(EVENT_INPUT, 'admin');
  const { scanner } = h.service.createScanner(event.id, 'Door', null, 'admin');
  const [pass] = h.service.issuePasses(event.id, { count: 1 }, 'admin');
  return { event, scanner: { id: scanner.id, eventId: event.id, gateId: null, label: scanner.label }, pass };
}

/** Event whose window contains the real current time, for tests where workers use the real clock. */
function liveEvent() {
  h = createHarness({ now: () => new Date() });
  return h.service.createEvent(
    { ...EVENT_INPUT, startsAt: new Date(Date.now() - 3_600_000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString() },
    'admin'
  );
}

describe('schema constraints', () => {
  it('enforces foreign keys, uniqueness and checks at the database level', () => {
    const { event, pass } = setup();
    const now = new Date().toISOString();
    const insertPass = h.db.prepare('INSERT INTO passes (id, event_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)');
    expect(() => insertPass.run('p-orphan', 'missing-event', hashToken('x'), now, now)).toThrow(/FOREIGN KEY/);
    const existingHash = (h.db.prepare('SELECT token_hash FROM passes WHERE id = ?').get(pass.id) as { token_hash: string }).token_hash;
    expect(() => insertPass.run('p-dup', event.id, existingHash, now, now)).toThrow(/UNIQUE/);
    expect(() => insertPass.run('p-short', event.id, 'abc', now, now)).toThrow(/CHECK/);
    expect(() => h.db.prepare("UPDATE events SET status = 'deleted' WHERE id = ?").run(event.id)).toThrow(/CHECK/);
    expect(() => h.db.prepare('UPDATE events SET ends_at = starts_at WHERE id = ?').run(event.id)).toThrow(/CHECK/);
  });

  it('allows at most one redemption row per pass', () => {
    const { scanner, pass } = setup();
    const insert = h.db.prepare('INSERT INTO redemptions (pass_id, scanner_id, redeemed_at) VALUES (?, ?, ?)');
    insert.run(pass.id, scanner.id, new Date().toISOString());
    expect(() => insert.run(pass.id, scanner.id, new Date().toISOString())).toThrow(/UNIQUE|PRIMARY KEY/);
  });

  it('makes over-admitting a capacity-limited policy impossible even with direct SQL', () => {
    const { event } = setup();
    const policy = h.service.access.createPolicy(event.id, { name: 'Wave 1', capacity: 1 }, 'admin');
    const bump = h.db.prepare('UPDATE admission_policies SET admitted_count = admitted_count + 1 WHERE id = ?');
    bump.run(policy.id);
    expect(() => bump.run(policy.id)).toThrow(/CHECK/);
  });

  it('rejects cross-event references through triggers', () => {
    const { event, pass } = setup();
    const other = h.service.createEvent({ ...EVENT_INPUT, name: 'Other' }, 'admin');
    const foreignPolicy = h.service.access.createPolicy(other.id, { name: 'Foreign' }, 'admin');
    const foreignGate = h.service.access.createGate(other.id, 'Foreign door', 'admin');
    expect(() => h.db.prepare('UPDATE passes SET policy_id = ? WHERE id = ?').run(foreignPolicy.id, pass.id)).toThrow(/another event/);
    expect(() =>
      h.db.prepare('INSERT INTO scanners (id, event_id, gate_id, label, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('s-x', event.id, foreignGate.id, 'x', hashToken('k'), 'now')
    ).toThrow(/another event/);
    const localPolicy = h.service.access.createPolicy(event.id, { name: 'Local' }, 'admin');
    expect(() => h.db.prepare('INSERT INTO policy_gates (policy_id, gate_id) VALUES (?, ?)').run(localPolicy.id, foreignGate.id)).toThrow(/another event/);
  });

  it('refuses to delete events that have passes', () => {
    const { event } = setup();
    expect(() => h.db.prepare('DELETE FROM events WHERE id = ?').run(event.id)).toThrow(/FOREIGN KEY/);
  });

  it('never stores raw tokens', () => {
    const { pass } = setup();
    const dump = JSON.stringify(h.db.prepare('SELECT * FROM passes').all());
    expect(dump).not.toContain(pass.token);
    expect(dump).toContain(hashToken(pass.token));
  });
});

describe('migrations', () => {
  it('upgrades a version 1 database with data, keeps old passes valid and backs it up first', () => {
    h = createHarness();
    h.db.close();
    const file = path.join(h.dir, 'legacy.db');
    const legacy = new DatabaseSync(file);
    legacy.exec('PRAGMA foreign_keys = ON');
    migrate(legacy, MIGRATIONS.slice(0, 1));
    const token = 'L'.repeat(43);
    legacy.exec(`
      INSERT INTO events (id, name, starts_at, ends_at, created_at, updated_at) VALUES ('e1', 'Legacy', '${EVENT_INPUT.startsAt}', '${EVENT_INPUT.endsAt}', 'x', 'x');
      INSERT INTO scanners (id, event_id, label, key_hash, created_at) VALUES ('s1', 'e1', 'Old door', '${hashToken('gps_legacy')}', 'x');
      INSERT INTO passes (id, event_id, token_hash, expires_at, created_at) VALUES ('p1', 'e1', '${hashToken(token)}', '${EVENT_INPUT.endsAt}', 'x');
      INSERT INTO passes (id, event_id, token_hash, expires_at, created_at) VALUES ('p2', 'e1', '${hashToken('M'.repeat(43))}', '${EVENT_INPUT.endsAt}', 'x');
      INSERT INTO redemptions (pass_id, scanner_id, redeemed_at) VALUES ('p2', 's1', '2030-06-01T18:10:00.000Z');
      INSERT INTO scans (event_id, scanner_id, pass_id, outcome, created_at) VALUES ('e1', 's1', 'p2', 'admitted', '2030-06-01T18:10:00.000Z');
    `);
    expect(schemaVersion(legacy)).toBe(1);
    legacy.close();

    const upgraded = openDatabase(file);
    expect(schemaVersion(upgraded)).toBe(SCHEMA_VERSION);
    expect(existsSync(`${file}.pre-v${SCHEMA_VERSION}.bak`)).toBe(true);
    const service = new GatePass(upgraded, { publicUrl: PUBLIC_URL, now: h.clock.now });
    const scanner = service.authenticateScanner('gps_legacy')!;
    expect(scanner).toMatchObject({ id: 's1', gateId: null });
    expect(service.listScans('e1')).toHaveLength(1);
    expect(service.redeem(scanner, token).outcome).toBe('admitted');
    expect(service.redeem(scanner, 'M'.repeat(43)).outcome).toBe('already_redeemed');
    upgraded.close();

    const backup = new DatabaseSync(`${file}.pre-v${SCHEMA_VERSION}.bak`, { readOnly: true });
    expect(schemaVersion(backup)).toBe(1);
    backup.close();
  });

  it('rolls back a failing migration completely', () => {
    const { event } = setup();
    const broken = [...MIGRATIONS, 'CREATE TABLE half_done (x INTEGER); INSERT INTO table_that_does_not_exist VALUES (1);'];
    expect(() => migrate(h.db, broken)).toThrow(/no such table/);
    expect(schemaVersion(h.db)).toBe(SCHEMA_VERSION);
    expect(h.db.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").get()).toBeUndefined();
    expect(h.service.getEvent(event.id).name).toBe(EVENT_INPUT.name);
  });

  it('refuses to open a database written by a newer schema', () => {
    const { event } = setup();
    expect(event).toBeTruthy();
    h.db.exec('PRAGMA user_version = 99');
    h.db.close();
    expect(() => openDatabase(h.dbFile)).toThrow(/newer than this build/);
  });
});

describe('persistence, backup and recovery', () => {
  it('keeps data across reopen without re-running migrations', () => {
    const { event } = setup();
    h.db.close();
    const reopened = openDatabase(h.dbFile);
    expect(schemaVersion(reopened)).toBe(SCHEMA_VERSION);
    expect(existsSync(`${h.dbFile}.pre-v${SCHEMA_VERSION}.bak`)).toBe(false);
    expect(new GatePass(reopened, { publicUrl: PUBLIC_URL }).getEvent(event.id).name).toBe(EVENT_INPUT.name);
    reopened.close();
  });

  it('fails loudly on a corrupt database file instead of replacing it', () => {
    h = createHarness();
    h.db.close();
    const corrupt = path.join(h.dir, 'corrupt.db');
    writeFileSync(corrupt, 'this is not a sqlite database'.repeat(200));
    expect(() => openDatabase(corrupt)).toThrow(/not a database/);
    expect(readFileSync(corrupt, 'utf8')).toContain('this is not a sqlite database');
  });

  it('rolls back a failed batch issuance completely and keeps serving', () => {
    h = createHarness({ generateToken: () => 'B'.repeat(43) }); // every token collides
    const event = h.service.createEvent(EVENT_INPUT, 'admin');
    expect(() => h.service.issuePasses(event.id, { count: 3 }, 'admin')).toThrow(/UNIQUE/);
    expect(h.service.listPasses(event.id)).toHaveLength(0);
    expect(h.service.listAudit(event.id).map((entry) => entry.action)).toEqual(['event.created']);
    expect(h.service.issuePasses(event.id, { count: 1 }, 'admin')).toHaveLength(1);
  });

  it('backs up a live database, verifies it, and restores it', () => {
    const { scanner, pass } = setup();
    const backup = path.join(h.dir, 'backups', 'gatepass.bak');
    backupDatabase(h.db, backup);
    expect(() => backupDatabase(h.db, backup)).toThrow(/already exists/);

    // Changes after the backup are lost on restore: the redeemed pass becomes valid again.
    expect(h.service.redeem(scanner, pass.token).outcome).toBe('admitted');
    h.db.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${h.dbFile}${suffix}`, { force: true });
    copyFileSync(backup, h.dbFile);

    const restored = openDatabase(h.dbFile);
    const service = new GatePass(restored, { publicUrl: PUBLIC_URL, now: h.clock.now });
    expect(service.getPass(pass.id).status).toBe('active');
    expect(service.redeem(scanner, pass.token).outcome).toBe('admitted');
    restored.close();
  });
});

describe('atomic redemption across connections and threads', () => {
  it('admits a pass once when a second connection redeems it too', () => {
    const { scanner, pass } = setup();
    const other = openDatabase(h.dbFile);
    const otherService = new GatePass(other, { publicUrl: PUBLIC_URL, now: h.clock.now });
    expect(h.service.redeem(scanner, pass.token).outcome).toBe('admitted');
    expect(otherService.redeem(scanner, pass.token).outcome).toBe('already_redeemed');
    other.close();
  });

  it('admits exactly one of 8 simultaneous redemptions of one pass', async () => {
    const event = liveEvent();
    const { scanner } = h.service.createScanner(event.id, 'Door', null, 'admin');
    const [pass] = h.service.issuePasses(event.id, { count: 1 }, 'admin');
    const auth = { id: scanner.id, eventId: event.id, gateId: null, label: scanner.label };
    const outcomes = await redeemInThreads(h.dbFile, Array.from({ length: 8 }, () => ({ code: pass.passUrl, scanner: auth })));
    expect(count(outcomes, 'admitted')).toBe(1);
    expect(count(outcomes, 'already_redeemed')).toBe(7);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM redemptions').get()).toEqual({ n: 1 });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM scans').get()).toEqual({ n: 8 });
  }, 30_000);

  it('never exceeds slot capacity when 12 different passes race for 5 places', async () => {
    const event = liveEvent();
    const policy = h.service.access.createPolicy(event.id, { name: 'Wave 1', capacity: 5 }, 'admin');
    const { scanner } = h.service.createScanner(event.id, 'Door', null, 'admin');
    const passes = h.service.issuePasses(event.id, { count: 12, policyId: policy.id }, 'admin');
    const auth = { id: scanner.id, eventId: event.id, gateId: null, label: scanner.label };
    const outcomes = await redeemInThreads(h.dbFile, passes.map((pass) => ({ code: pass.token, scanner: auth })));
    expect(count(outcomes, 'admitted')).toBe(5);
    expect(count(outcomes, 'capacity_full')).toBe(7);
    expect(h.service.access.getPolicy(policy.id).admittedCount).toBe(5);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM redemptions WHERE policy_id = ?').get(policy.id)).toEqual({ n: 5 });
  }, 30_000);
});
