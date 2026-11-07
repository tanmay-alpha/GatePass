import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/server/db';
import { GatePass } from '../src/server/gatepass';
import { hashToken } from '../src/server/tokens';
import { createHarness, EVENT_INPUT, PUBLIC_URL, type Harness } from './helpers';

let h: Harness;
afterEach(() => h?.close());

function setup() {
  h = createHarness();
  const event = h.service.createEvent(EVENT_INPUT, 'admin');
  const { scanner } = h.service.createScanner(event.id, 'Door', 'admin');
  const [pass] = h.service.issuePasses(event.id, { count: 1 }, 'admin');
  return { event, scanner: { id: scanner.id, eventId: event.id, label: scanner.label }, pass };
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

describe('persistence and recovery', () => {
  it('runs migrations once and keeps data across reopen', () => {
    const { event } = setup();
    h.db.close();
    const reopened = openDatabase(h.dbFile);
    expect((reopened.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
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
    // The connection is not left inside a transaction.
    expect(h.service.issuePasses(event.id, { count: 1 }, 'admin')).toHaveLength(1);
  });
});

describe('atomic redemption across connections', () => {
  it('admits a pass once when a second connection redeems it too', () => {
    const { scanner, pass } = setup();
    const other = openDatabase(h.dbFile);
    const otherService = new GatePass(other, { publicUrl: PUBLIC_URL, now: h.clock.now });
    expect(h.service.redeem(scanner, pass.token).outcome).toBe('admitted');
    expect(otherService.redeem(scanner, pass.token).outcome).toBe('already_redeemed');
    other.close();
  });

  it('admits exactly one of many simultaneous redemptions from separate threads', async () => {
    h = createHarness({ now: () => new Date() }); // workers use the real clock
    const event = h.service.createEvent({ ...EVENT_INPUT, startsAt: new Date(Date.now() - 3_600_000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString() }, 'admin');
    const { scanner } = h.service.createScanner(event.id, 'Door', 'admin');
    const [pass] = h.service.issuePasses(event.id, { count: 1 }, 'admin');
    const workers = 8;
    const barrier = new SharedArrayBuffer(4);
    const ready: Promise<unknown>[] = [];
    const results = Array.from({ length: workers }, () => {
      const worker = new Worker(new URL('./fixtures/redeem-worker.mjs', import.meta.url), {
        workerData: { dbFile: h.dbFile, barrier, code: pass.passUrl, scanner: { id: scanner.id, eventId: event.id, label: scanner.label } }
      });
      const isReady = Promise.withResolvers<void>();
      const done = Promise.withResolvers<{ outcome?: string; error?: string }>();
      worker.on('message', (message: { ready?: boolean; outcome?: string; error?: string }) => (message.ready ? isReady.resolve() : done.resolve(message)));
      worker.once('error', (error) => {
        isReady.reject(error);
        done.reject(error);
      });
      ready.push(isReady.promise);
      return done.promise;
    });
    // Release every worker at once so their transactions genuinely contend.
    await Promise.all(ready);
    const flags = new Int32Array(barrier);
    Atomics.store(flags, 0, 1);
    Atomics.notify(flags, 0);
    const outcomes = await Promise.all(results);
    expect(outcomes.filter((result) => result.error)).toEqual([]);
    expect(outcomes.filter((result) => result.outcome === 'admitted')).toHaveLength(1);
    expect(outcomes.filter((result) => result.outcome === 'already_redeemed')).toHaveLength(workers - 1);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM redemptions').get()).toEqual({ n: 1 });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM scans').get()).toEqual({ n: workers });
  }, 30_000);
});
