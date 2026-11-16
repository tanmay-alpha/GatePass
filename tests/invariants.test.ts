import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app';
import { migrate, MIGRATIONS, openDatabase, SCHEMA_VERSION, schemaVersion, type Database } from '../src/server/db';
import { GatePass, type AuthenticatedScanner } from '../src/server/gatepass';
import { verifyDatabase } from '../src/server/integrity';
import { ADMIN_TOKEN, createHarness, enroll, EVENT_INPUT, PUBLIC_URL, seedEvent, type Harness } from './helpers';

// Regression tests for admission conditions the engineering audit listed as
// fixed but unverified (docs/engineering-audit.md: DB-04, DB-05, DB-06,
// SEC-03, ORCH-03) and for failure atomicity of the redeem transaction. Each
// test checks the persisted rows and counters, not only the HTTP answer.

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let h: Harness | undefined;
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  h?.close();
  h = undefined;
});

function harness(options: Parameters<typeof createHarness>[0] = {}): Harness {
  h = createHarness(options);
  return h;
}

/** A second connection to the harness file, closed after the test (an open handle blocks temp-dir removal on Windows). */
function connection(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  cleanups.push(() => db.isOpen && db.close());
  return db;
}

function count(db: Database, sql: string, ...params: Array<string | number>): number {
  return Number((db.prepare(sql).get(...params) as { n: number }).n);
}

/** Everything a redemption may write, for "nothing changed" comparisons. */
function admissionState(db: Database, eventId: string) {
  const rows = (sql: string) => db.prepare(sql).all(eventId).map((row) => ({ ...row }));
  return {
    redemptions: rows('SELECT r.pass_id, r.scanner_id, r.redeemed_at FROM redemptions r JOIN passes p ON p.id = r.pass_id WHERE p.event_id = ? ORDER BY r.pass_id'),
    scans: rows('SELECT id, pass_id, outcome, request_id FROM scans WHERE event_id = ? ORDER BY id'),
    event: rows('SELECT admitted_count FROM events WHERE id = ?'),
    policies: rows('SELECT id, admitted_count FROM admission_policies WHERE event_id = ? ORDER BY id'),
    scanners: rows('SELECT id, revoked_at, last_used_at FROM scanners WHERE event_id = ? ORDER BY id')
  };
}

/** Admin-token POST through the in-process app; fails the test with the server's message on a non-2xx. */
async function post<T = Record<string, any>>(route: string, body: object = {}): Promise<T> {
  const response = await h!.admin(request(h!.app).post(route)).send(body);
  expect(response.status, `POST ${route}: ${JSON.stringify(response.body)}`).toBeLessThan(300);
  return response.body as T;
}

/** A scanner device created and enrolled through its one-time setup link. */
async function device(eventId: string, label: string, gateId: string | null): Promise<{ id: string; key: string }> {
  const created = await post<{ scanner: { id: string }; enrollment: { url: string } }>(`/api/events/${eventId}/scanners`, { label, gateId });
  return { id: created.scanner.id, key: await enroll(h!.app, created) };
}

function redeem(key: string, code: string, requestId?: string) {
  return request(h!.app)
    .post('/api/scanner/redeem')
    .set('Authorization', `Bearer ${key}`)
    .send(requestId ? { code, requestId } : { code });
}

// ------------------------------------------------------------------ DB-05

/**
 * Worker for the revocation race. Plain CommonJS evaluated in a worker thread
 * (tsx registered for the TypeScript sources), with its own SQLite connection,
 * released by the shared barrier together with its siblings. A redeemer works
 * through its codes with the scanner identity authenticated before the race
 * (stale once revoked); the organizer waits until `revokeAfter` admissions
 * have committed and then revokes the device.
 */
const RACE_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
require(workerData.tsx).register();
const clock = () => performance.timeOrigin + performance.now();
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
(async () => {
  // Runtime import: the TypeScript sources load only after tsx is registered above.
  const { openDatabase } = await import(workerData.dbModule);
  const { GatePass } = await import(workerData.serviceModule);
  const db = openDatabase(workerData.dbFile);
  const service = new GatePass(db, { publicUrl: 'https://gate.example' });
  parentPort.postMessage({ ready: true });
  Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
  const log = [];
  try {
    if (workerData.revokeAfter !== undefined) {
      const admitted = db.prepare('SELECT COUNT(*) AS n FROM redemptions WHERE scanner_id = ?');
      while (Number(admitted.get(workerData.scanner.id).n) < workerData.revokeAfter) pause(1);
      const invokedAt = clock();
      service.revokeScanner(workerData.scanner.id, 'test');
      log.push({ op: 'revoke', outcome: 'revoked', invokedAt, respondedAt: clock() });
    } else {
      for (const code of workerData.codes) {
        const invokedAt = clock();
        let outcome;
        try {
          outcome = service.redeem(workerData.scanner, code).outcome;
        } catch (error) {
          if (error && error.status === 401) outcome = 'unauthorized';
          else if (/database is locked/.test(String(error))) outcome = 'busy';
          else throw error;
        }
        log.push({ op: 'redeem', code, outcome, invokedAt, respondedAt: clock() });
        pause(1); // the next guest steps up
      }
    }
  } catch (error) {
    log.push({ op: 'error', outcome: String(error), invokedAt: 0, respondedAt: 0 });
  } finally {
    db.close(); // before reporting: no open handle once the main thread has every result
  }
  parentPort.postMessage({ log });
})();
`;

interface RaceJob {
  scanner: AuthenticatedScanner;
  codes?: string[];
  revokeAfter?: number;
}

interface RaceEntry {
  op: 'redeem' | 'revoke' | 'error';
  code?: string;
  outcome: string;
  invokedAt: number;
  respondedAt: number;
}

async function raceInThreads(dbFile: string, jobs: RaceJob[]): Promise<RaceEntry[]> {
  const barrier = new SharedArrayBuffer(4);
  const shared = {
    dbFile,
    barrier,
    tsx: createRequire(import.meta.url).resolve('tsx/esm/api'),
    dbModule: pathToFileURL(path.join(ROOT, 'src/server/db.ts')).href,
    serviceModule: pathToFileURL(path.join(ROOT, 'src/server/gatepass.ts')).href
  };
  const ready: Array<Promise<void>> = [];
  const finished = jobs.map((job) => {
    const worker = new Worker(RACE_WORKER, { eval: true, workerData: { ...shared, ...job } });
    const isReady = Promise.withResolvers<void>();
    const done = Promise.withResolvers<RaceEntry[]>();
    let log: RaceEntry[] | undefined;
    worker.on('message', (message: { ready?: boolean; log?: RaceEntry[] }) => (message.ready ? isReady.resolve() : (log = message.log)));
    worker.once('error', (error) => {
      isReady.reject(error);
      done.reject(error);
    });
    worker.once('exit', (code) => {
      const error = new Error(`Race worker exited with code ${code} before reporting`);
      isReady.reject(error);
      if (log) done.resolve(log);
      else done.reject(error);
    });
    ready.push(isReady.promise);
    return done.promise;
  });
  await Promise.all(ready);
  const flags = new Int32Array(barrier);
  Atomics.store(flags, 0, 1);
  Atomics.notify(flags, 0);
  return (await Promise.all(finished)).flat();
}

describe('scanner revoked after authentication (DB-05)', () => {
  it('refuses a redemption with a scanner identity that was revoked after the key check: 401, nothing written', async () => {
    const t = harness();
    const { event, scannerKey, scannerId, passes } = await seedEvent(t, 1);
    const stale = t.service.authenticateScanner(scannerKey)!;
    expect(stale).toMatchObject({ id: scannerId, eventId: event.id });

    // The organizer's revocation commits through another connection in the window.
    const other = openDatabase(t.dbFile);
    cleanups.push(() => other.isOpen && other.close());
    new GatePass(other, { publicUrl: PUBLIC_URL, now: t.clock.now }).revokeScanner(scannerId, 'test');

    const before = admissionState(t.db, event.id);
    let refusal: unknown;
    try {
      t.service.redeem(stale, passes[0].token, 'stale-auth-0001');
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ status: 401 });
    expect(admissionState(t.db, event.id)).toEqual(before);
    expect(before.redemptions).toEqual([]);
    expect(before.scans).toEqual([]);
    expect(before.event).toEqual([{ admitted_count: 0 }]);
    expect(before.scanners[0].last_used_at).toBeNull();
    expect(t.service.getPass(passes[0].id).status).toBe('active');
  });

  it('answers 401 over HTTP when the revocation commits between the key check and the redeem transaction', async () => {
    const t = harness();
    const { event, scannerKey, scannerId, passes } = await seedEvent(t, 1);
    const other = openDatabase(t.dbFile);
    cleanups.push(() => other.isOpen && other.close());
    const organizer = new GatePass(other, { publicUrl: PUBLIC_URL, now: t.clock.now });
    const authenticate = t.service.authenticateScanner.bind(t.service);
    // requireScanner accepts the key; the revocation then commits before redeem() takes the write lock.
    vi.spyOn(t.service, 'authenticateScanner').mockImplementationOnce((key) => {
      const scanner = authenticate(key);
      organizer.revokeScanner(scannerId, 'test');
      return scanner;
    });
    const before = admissionState(t.db, event.id);

    const reply = await redeem(scannerKey, passes[0].token, 'stale-http-0001');
    expect(reply.status).toBe(401);
    expect(reply.body).toEqual({ error: 'Scanner authentication required' });
    expect(reply.body).not.toHaveProperty('outcome');
    const after = admissionState(t.db, event.id);
    expect(after.scanners[0].revoked_at).not.toBeNull();
    expect({ ...after, scanners: after.scanners.map(({ last_used_at }) => last_used_at) }).toEqual({ ...before, scanners: [null] });
    expect(t.service.getPass(passes[0].id).status).toBe('active');
  });

  it('a revocation racing redemptions on other connections: no admission or scan by the device after its revocation', async () => {
    const t = harness({ now: () => new Date() }); // workers use the real clock
    const event = t.service.createEvent(
      { ...EVENT_INPUT, startsAt: new Date(Date.now() - 3_600_000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString(), capacity: 500 },
      'test'
    );
    const gate = t.service.access.createGate(event.id, 'Main', 'test');
    const policy = t.service.access.createPolicy(event.id, { name: 'General', capacity: 400, gateIds: [gate.id] }, 'test');
    const { scanner } = t.service.createScanner(event.id, 'Door', gate.id, 'test');
    const stale: AuthenticatedScanner = { id: scanner.id, eventId: event.id, gateId: gate.id, label: 'Door' };
    const WORKERS = 8;
    const PER_WORKER = 20;
    const REVOKE_AFTER = 10;
    const passes = t.service.issuePasses(event.id, { count: WORKERS * PER_WORKER, policyId: policy.id }, 'test');
    const jobs: RaceJob[] = Array.from({ length: WORKERS }, (_, w) => ({
      scanner: stale,
      codes: passes.slice(w * PER_WORKER, (w + 1) * PER_WORKER).map((pass) => pass.token)
    }));
    jobs.push({ scanner: stale, revokeAfter: REVOKE_AFTER });

    const entries = await raceInThreads(t.dbFile, jobs);
    expect(entries.filter((entry) => entry.op === 'error')).toEqual([]);
    const revoke = entries.find((entry) => entry.op === 'revoke')!;
    const redeems = entries.filter((entry) => entry.op === 'redeem');
    const admitted = redeems.filter((entry) => entry.outcome === 'admitted');
    const refused = redeems.filter((entry) => entry.outcome === 'unauthorized');
    console.info(`revocation race: ${admitted.length} admitted, ${refused.length} refused, ${redeems.length - admitted.length - refused.length} busy`);
    expect(revoke).toBeDefined();
    expect(redeems.filter((entry) => !['admitted', 'unauthorized', 'busy'].includes(entry.outcome))).toEqual([]);
    // The race really happened: admissions before the revocation, refusals after it.
    expect(admitted.length).toBeGreaterThanOrEqual(REVOKE_AFTER);
    expect(refused.length).toBeGreaterThan(0);
    // Real-time order: nothing invoked after the revocation returned may admit;
    // every admission was invoked before the revocation returned.
    expect(redeems.filter((entry) => entry.invokedAt > revoke.respondedAt && entry.outcome === 'admitted')).toEqual([]);
    expect(refused.filter((entry) => entry.respondedAt < revoke.invokedAt)).toEqual([]);

    // Persisted state agrees with the answers.
    const revokedAt = (t.db.prepare('SELECT revoked_at FROM scanners WHERE id = ?').get(scanner.id) as { revoked_at: string | null }).revoked_at;
    expect(revokedAt).not.toBeNull();
    expect(t.db.prepare('SELECT pass_id, redeemed_at FROM redemptions WHERE scanner_id = ? AND redeemed_at > ?').all(scanner.id, revokedAt!)).toEqual([]);
    expect(t.db.prepare('SELECT id, created_at FROM scans WHERE scanner_id = ? AND created_at > ?').all(scanner.id, revokedAt!)).toEqual([]);
    const redeemedTokens = new Set(admitted.map((entry) => entry.code));
    const persisted = (t.db.prepare('SELECT pass_id FROM redemptions WHERE scanner_id = ? ORDER BY pass_id').all(scanner.id) as Array<{ pass_id: string }>).map((row) => row.pass_id);
    expect(persisted).toEqual(passes.filter((pass) => redeemedTokens.has(pass.token)).map((pass) => pass.id).sort());
    // Refused and busy attempts leave no scan row; each admission exactly one.
    expect(count(t.db, 'SELECT COUNT(*) AS n FROM scans WHERE scanner_id = ?', scanner.id)).toBe(admitted.length);
    expect(t.service.access.getPolicy(policy.id).admittedCount).toBe(admitted.length);
    expect(t.service.getEvent(event.id).admittedCount).toBe(admitted.length);
    expect(verifyDatabase(t.db).violations).toEqual([]);
  }, 60_000);
});

// ------------------------------------------------------------------ DB-04

describe('cross-event and immutability triggers on redemptions and policy gates (DB-04)', () => {
  function twoEvents() {
    const t = harness();
    const a = t.service.createEvent(EVENT_INPUT, 'test');
    const b = t.service.createEvent({ ...EVENT_INPUT, name: 'Other event' }, 'test');
    const gateA = t.service.access.createGate(a.id, 'A door', 'test');
    const gateA2 = t.service.access.createGate(a.id, 'A side door', 'test');
    const gateB = t.service.access.createGate(b.id, 'B door', 'test');
    const policyA = t.service.access.createPolicy(a.id, { name: 'A policy', gateIds: [gateA.id] }, 'test');
    const policyB = t.service.access.createPolicy(b.id, { name: 'B policy' }, 'test');
    const scannerA = t.service.createScanner(a.id, 'A scanner', gateA.id, 'test').scanner;
    const scannerB = t.service.createScanner(b.id, 'B scanner', gateB.id, 'test').scanner;
    const [passA] = t.service.issuePasses(a.id, { count: 1, policyId: policyA.id }, 'test');
    return { t, a, gateA, gateA2, gateB, policyA, policyB, scannerA, scannerB, passA };
  }

  it('refuses a redemption row whose scanner, gate or policy belongs to another event', () => {
    const { t, gateA, gateB, policyA, policyB, scannerA, scannerB, passA } = twoEvents();
    const insert = t.db.prepare('INSERT INTO redemptions (pass_id, scanner_id, gate_id, policy_id, redeemed_at) VALUES (?, ?, ?, ?, ?)');
    const at = t.clock.now().toISOString();
    expect(() => insert.run(passA.id, scannerB.id, gateA.id, policyA.id, at)).toThrow(/redemption references another event/);
    expect(() => insert.run(passA.id, scannerA.id, gateB.id, policyA.id, at)).toThrow(/redemption references another event/);
    expect(() => insert.run(passA.id, scannerA.id, gateA.id, policyB.id, at)).toThrow(/redemption references another event/);
    expect(() => insert.run(passA.id, scannerB.id, null, null, at)).toThrow(/redemption references another event/);
    expect(count(t.db, 'SELECT COUNT(*) AS n FROM redemptions')).toBe(0);

    // Control: the same row with this event's references passes the trigger (rolled back again).
    t.db.exec('SAVEPOINT control');
    insert.run(passA.id, scannerA.id, gateA.id, policyA.id, at);
    expect(count(t.db, 'SELECT COUNT(*) AS n FROM redemptions')).toBe(1);
    t.db.exec('ROLLBACK TO control; RELEASE control');
    expect(count(t.db, 'SELECT COUNT(*) AS n FROM redemptions')).toBe(0);
    expect(verifyDatabase(t.db).violations).toEqual([]);
  });

  it('makes an admission permanent: UPDATE and DELETE on redemptions abort and leave the row as it was', () => {
    const { t, a, gateA, scannerA, scannerB, passA } = twoEvents();
    const auth = { id: scannerA.id, eventId: a.id, gateId: gateA.id, label: scannerA.label };
    expect(t.service.redeem(auth, passA.token).outcome).toBe('admitted');
    const row = () => ({ ...(t.db.prepare('SELECT * FROM redemptions WHERE pass_id = ?').get(passA.id) as object) });
    const before = row();

    for (const sql of [
      'UPDATE redemptions SET redeemed_at = ? WHERE pass_id = ?',
      'UPDATE redemptions SET scanner_id = ? WHERE pass_id = ?',
      'UPDATE redemptions SET gate_id = NULL, policy_id = NULL WHERE pass_id = ? AND ? IS NOT NULL'
    ]) {
      const params = sql.includes('scanner_id = ?') ? [scannerB.id, passA.id] : sql.includes('redeemed_at = ?') ? ['2000-01-01T00:00:00.000Z', passA.id] : [passA.id, 'x'];
      expect(() => t.db.prepare(sql).run(...params), sql).toThrow(/redemptions are immutable/);
    }
    expect(() => t.db.prepare('DELETE FROM redemptions WHERE pass_id = ?').run(passA.id)).toThrow(/redemptions are immutable/);
    expect(() => t.db.prepare('DELETE FROM redemptions').run()).toThrow(/redemptions are immutable/);
    expect(row()).toEqual(before);
    expect(t.service.getPass(passA.id).status).toBe('redeemed');
    expect(verifyDatabase(t.db).violations).toEqual([]);
  });

  it("refuses re-pointing a policy gate at another event's gate or policy (UPDATE policy_gates)", () => {
    const { t, gateA, gateA2, gateB, policyA, policyB } = twoEvents();
    const gatesOf = (policyId: string) => (t.db.prepare('SELECT gate_id FROM policy_gates WHERE policy_id = ? ORDER BY gate_id').all(policyId) as Array<{ gate_id: string }>).map((row) => row.gate_id);
    expect(() => t.db.prepare('UPDATE policy_gates SET gate_id = ? WHERE policy_id = ?').run(gateB.id, policyA.id)).toThrow(/gate belongs to another event/);
    expect(() => t.db.prepare('UPDATE policy_gates SET policy_id = ? WHERE policy_id = ?').run(policyB.id, policyA.id)).toThrow(/gate belongs to another event/);
    expect(gatesOf(policyA.id)).toEqual([gateA.id]);
    expect(gatesOf(policyB.id)).toEqual([]);
    // Control: moving the binding to another gate of the same event is allowed.
    t.db.prepare('UPDATE policy_gates SET gate_id = ? WHERE policy_id = ?').run(gateA2.id, policyA.id);
    expect(gatesOf(policyA.id)).toEqual([gateA2.id]);
  });
});

// ------------------------------------------------------------------ DB-06

describe('write-lock contention over HTTP (DB-06)', () => {
  it('answers 503 with Retry-After while another connection holds the write lock; the same requestId then admits exactly once', async () => {
    const t = harness();
    const { event, scannerKey, passes } = await seedEvent(t, 1);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    t.db.exec('PRAGMA busy_timeout = 50');
    const blocker = connection(t.dbFile);
    blocker.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');

    const busy = await redeem(scannerKey, passes[0].token, 'busy-retry-0001');
    expect(busy.status).toBe(503);
    expect(busy.headers['retry-after']).toBe('1');
    expect(busy.body).toEqual({ error: 'The server is busy. Try again.' });
    expect(errors.mock.calls.map((call) => String(call[0]))).toEqual([expect.stringContaining('"msg":"database busy"')]);
    expect(admissionState(t.db, event.id)).toMatchObject({ redemptions: [], scans: [], event: [{ admitted_count: 0 }] });

    blocker.exec('ROLLBACK');
    const admitted = await redeem(scannerKey, passes[0].token, 'busy-retry-0001');
    expect(admitted.status).toBe(200);
    expect(admitted.body.outcome).toBe('admitted');
    expect(admitted.body.replayed).toBeUndefined(); // judged now: the 503 attempt left nothing to replay
    const replayed = await redeem(scannerKey, passes[0].token, 'busy-retry-0001');
    expect(replayed.body).toMatchObject({ outcome: 'admitted', replayed: true, scanId: admitted.body.scanId });

    const state = admissionState(t.db, event.id);
    expect(state.redemptions).toHaveLength(1);
    expect(state.scans).toEqual([{ id: admitted.body.scanId, pass_id: passes[0].id, outcome: 'admitted', request_id: 'busy-retry-0001' }]);
    expect(state.event).toEqual([{ admitted_count: 1 }]);
    expect(verifyDatabase(t.db).violations).toEqual([]);
  });
});

// ------------------------------------------------------------------ failure atomicity

describe('a redeem transaction that fails after claiming capacity', () => {
  it.each([
    ['inserting the redemption', 'BEFORE INSERT ON redemptions'],
    ['inserting the scan row', 'BEFORE INSERT ON scans'],
    ["recording the device's last use", 'BEFORE UPDATE OF last_used_at ON scanners']
  ])('fails closed when %s fails: 5xx, never admitted, no counter or row changed', async (_step, when) => {
    const t = harness();
    const event = await post('/api/events', { ...EVENT_INPUT, capacity: 10 });
    const gate = await post(`/api/events/${event.id}/gates`, { name: 'Main' });
    const policy = await post(`/api/events/${event.id}/policies`, { name: 'Members', capacity: 5, gateIds: [gate.id] });
    const [pass] = await post<Array<{ id: string; token: string }>>(`/api/events/${event.id}/passes`, { count: 1, policyId: policy.id });
    const door = await device(event.id, 'Main door', gate.id);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Connection-local trigger: the failure strikes after the policy and event claims inside the transaction.
    t.db.exec(`CREATE TEMP TRIGGER inject_failure ${when} BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    const before = admissionState(t.db, event.id);

    const failed = await redeem(door.key, pass.token, 'inject-fail-0001');
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: 'Internal server error' });
    expect(errors).toHaveBeenCalled();
    expect(admissionState(t.db, event.id)).toEqual(before);
    expect(before.policies).toEqual([{ id: policy.id, admitted_count: 0 }]);
    expect(before.event).toEqual([{ admitted_count: 0 }]);
    expect(t.service.getPass(pass.id).status).toBe('active');
    expect(verifyDatabase(t.db).ok).toBe(true);

    // Once the fault is gone the same request is judged afresh and admits once.
    t.db.exec('DROP TRIGGER temp.inject_failure');
    const admitted = await redeem(door.key, pass.token, 'inject-fail-0001');
    expect(admitted.body).toMatchObject({ outcome: 'admitted' });
    expect(admitted.body.replayed).toBeUndefined();
    const after = admissionState(t.db, event.id);
    expect(after.policies).toEqual([{ id: policy.id, admitted_count: 1 }]);
    expect(after.event).toEqual([{ admitted_count: 1 }]);
    expect(after.redemptions).toHaveLength(1);
    expect(after.scans).toHaveLength(1);
    expect(verifyDatabase(t.db).violations).toEqual([]);
  });
});

// ------------------------------------------------------------------ boundaries

describe('policy gates and entry windows at the exact boundary instants', () => {
  it('opensAt is inclusive, closesAt exclusive, time is judged before the gate, and an open-ended policy closes with the event', async () => {
    const t = harness();
    const event = await post('/api/events', EVENT_INPUT); // 18:00–23:00 UTC
    const north = await post(`/api/events/${event.id}/gates`, { name: 'North' });
    const south = await post(`/api/events/${event.id}/gates`, { name: 'South' });
    const wave = await post(`/api/events/${event.id}/policies`, { name: '19:00 wave', opensAt: '2030-06-01T19:00:00.000Z', closesAt: '2030-06-01T19:30:00.000Z', gateIds: [north.id] });
    const late = await post(`/api/events/${event.id}/policies`, { name: 'Late entry', opensAt: '2030-06-01T22:00:00.000Z', gateIds: [north.id] });
    const passes = await post<Array<{ id: string; token: string }>>(`/api/events/${event.id}/passes`, { count: 4, policyId: wave.id });
    // Valid beyond the event end, so at 23:00 the window (not the pass expiry) decides.
    const latePasses = await post<Array<{ id: string; token: string }>>(`/api/events/${event.id}/passes`, { count: 2, policyId: late.id, expiresAt: '2030-06-02T02:00:00.000Z' });
    const northDoor = await device(event.id, 'North door', north.id);
    const southDoor = await device(event.id, 'South door', south.id);
    const roaming = await device(event.id, 'Roaming', null);
    const at = (iso: string) => (t.clock.current = new Date(iso));
    const judge = async (key: string, code: string) => (await redeem(key, code)).body;

    at('2030-06-01T18:59:59.999Z');
    expect(await judge(northDoor.key, passes[0].token)).toMatchObject({ outcome: 'too_early', detail: { policyName: '19:00 wave', opensAt: '2030-06-01T19:00:00.000Z' } });
    at('2030-06-01T19:00:00.000Z');
    expect(await judge(southDoor.key, passes[0].token)).toMatchObject({ outcome: 'wrong_gate', detail: { policyName: '19:00 wave', allowedGates: ['North'] } });
    expect(await judge(northDoor.key, passes[0].token)).toMatchObject({ outcome: 'admitted' });
    at('2030-06-01T19:29:59.999Z');
    expect(await judge(northDoor.key, passes[1].token)).toMatchObject({ outcome: 'admitted' });
    expect(await judge(roaming.key, passes[2].token)).toMatchObject({ outcome: 'admitted' }); // a device without a gate may admit anywhere
    at('2030-06-01T19:30:00.000Z');
    expect(await judge(northDoor.key, passes[3].token)).toMatchObject({ outcome: 'too_late', detail: { closesAt: '2030-06-01T19:30:00.000Z' } });
    expect(await judge(southDoor.key, passes[3].token)).toMatchObject({ outcome: 'too_late' });
    at('2030-06-01T22:59:59.999Z');
    expect(await judge(northDoor.key, latePasses[0].token)).toMatchObject({ outcome: 'admitted' });
    at('2030-06-01T23:00:00.000Z');
    expect(await judge(northDoor.key, latePasses[1].token)).toMatchObject({ outcome: 'too_late', detail: { policyName: 'Late entry', closesAt: '2030-06-01T23:00:00.000Z' } });

    // Persisted at the judged instants, with the judging gate.
    const scans = t.db.prepare('SELECT outcome, gate_id, created_at FROM scans ORDER BY id').all().map((row) => ({ ...row }));
    expect(scans).toEqual([
      { outcome: 'too_early', gate_id: north.id, created_at: '2030-06-01T18:59:59.999Z' },
      { outcome: 'wrong_gate', gate_id: south.id, created_at: '2030-06-01T19:00:00.000Z' },
      { outcome: 'admitted', gate_id: north.id, created_at: '2030-06-01T19:00:00.000Z' },
      { outcome: 'admitted', gate_id: north.id, created_at: '2030-06-01T19:29:59.999Z' },
      { outcome: 'admitted', gate_id: null, created_at: '2030-06-01T19:29:59.999Z' },
      { outcome: 'too_late', gate_id: north.id, created_at: '2030-06-01T19:30:00.000Z' },
      { outcome: 'too_late', gate_id: south.id, created_at: '2030-06-01T19:30:00.000Z' },
      { outcome: 'admitted', gate_id: north.id, created_at: '2030-06-01T22:59:59.999Z' },
      { outcome: 'too_late', gate_id: north.id, created_at: '2030-06-01T23:00:00.000Z' }
    ]);
    const redemptions = t.db.prepare('SELECT pass_id, gate_id, policy_id, redeemed_at FROM redemptions ORDER BY redeemed_at, pass_id').all().map((row) => ({ ...row }));
    expect(redemptions).toEqual(
      [
        { pass_id: passes[0].id, gate_id: north.id, policy_id: wave.id, redeemed_at: '2030-06-01T19:00:00.000Z' },
        { pass_id: passes[1].id, gate_id: north.id, policy_id: wave.id, redeemed_at: '2030-06-01T19:29:59.999Z' },
        { pass_id: passes[2].id, gate_id: null, policy_id: wave.id, redeemed_at: '2030-06-01T19:29:59.999Z' },
        { pass_id: latePasses[0].id, gate_id: north.id, policy_id: late.id, redeemed_at: '2030-06-01T22:59:59.999Z' }
      ].sort((x, y) => x.redeemed_at.localeCompare(y.redeemed_at) || x.pass_id.localeCompare(y.pass_id))
    );
    expect(verifyDatabase(t.db).violations).toEqual([]);
  });
});

// ------------------------------------------------------------------ SEC-03

describe('client IP from a comma-separated CDN header (SEC-03)', () => {
  it('throttles failed authentication by the last x-vercel-forwarded-for entry, which the CDN appended', async () => {
    const t = harness();
    vi.spyOn(console, 'error').mockImplementation(() => {}); // express-rate-limit warns about the forwarding headers, as intended
    const secret = 'o'.repeat(40);
    const app = createApp({ service: t.service, adminToken: ADMIN_TOKEN, originSecret: secret, clientIpHeader: 'x-vercel-forwarded-for' });
    const attempt = (chain: string, credential = 'Bearer wrong') =>
      request(app).get('/api/events').set('X-Origin-Secret', secret).set('x-vercel-forwarded-for', chain).set('Authorization', credential);

    // 60 failures from one real client that claims a different address each time in the client-controlled part.
    const statuses: number[] = [];
    for (let i = 0; i < 60; i += 1) statuses.push((await attempt(`198.51.100.${i}, 203.0.113.7`)).status);
    expect(statuses.filter((status) => status !== 401)).toEqual([]);
    const blocked = await attempt('192.0.2.1, 203.0.113.7');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // Whitespace around entries does not create a new bucket.
    expect((await attempt('192.0.2.2 ,   203.0.113.7  ')).status).toBe(429);
    // Claiming the throttled address in a spoofable position does not inherit (or escape) its bucket.
    expect((await attempt('203.0.113.7, 203.0.113.9')).status).toBe(401);
    // Valid credentials from the throttled client are not locked out.
    expect((await attempt('198.51.100.1, 203.0.113.7', `Bearer ${ADMIN_TOKEN}`)).status).toBe(200);
  });
});

// ------------------------------------------------------------------ ORCH-03

describe('maintenance CLI on an older schema (ORCH-03)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  function cli(env: Record<string, string>, ...args: string[]): Promise<{ code: number | null; output: string }> {
    const child = spawn(process.execPath, ['--import', 'tsx', '--disable-warning=ExperimentalWarning', 'src/server/index.ts', ...args], {
      cwd: ROOT,
      env: { ...process.env, ORIGIN_SECRET: '', CLIENT_IP_HEADER: '', TRUST_PROXY: '', NODE_ENV: 'test', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    const output: string[] = [];
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    const exited = Promise.withResolvers<{ code: number | null; output: string }>();
    child.once('exit', (code) => exited.resolve({ code, output: output.join('') }));
    return exited.promise;
  }

  const versionOf = (file: string) => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return schemaVersion(db);
    } finally {
      db.close();
    }
  };
  const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

  it('verify reports a schema-3 rollback copy as not current and leaves it at version 3, byte for byte; backup copies it without migrating', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gatepass-orch03-'));
    dirs.push(dir);
    const file = path.join(dir, 'gatepass.db');
    const legacy = new DatabaseSync(file);
    legacy.exec('PRAGMA foreign_keys = ON');
    migrate(legacy, MIGRATIONS.slice(0, 3));
    legacy.prepare("INSERT INTO events (id, name, starts_at, ends_at, created_at, updated_at) VALUES ('e1', 'Legacy', ?, ?, 'x', 'x')").run(EVENT_INPUT.startsAt, EVENT_INPUT.endsAt);
    legacy.close();
    // Opening it with GatePass migrates it and leaves the schema-3 rollback copy an operator would verify.
    const upgraded = openDatabase(file);
    expect(schemaVersion(upgraded)).toBe(SCHEMA_VERSION);
    upgraded.close();
    const rollback = `${file}.pre-v${SCHEMA_VERSION}.bak`;
    expect(versionOf(rollback)).toBe(3);
    const before = { hash: sha256(rollback), files: readdirSync(dir).sort() };

    const verified = await cli({ DATABASE_FILE: file }, 'verify', rollback);
    expect(verified.code, verified.output).toBe(1);
    expect(verified.output).toContain(`schema version 3 differs from this build (${SCHEMA_VERSION})`);
    expect({ hash: sha256(rollback), files: readdirSync(dir).sort() }).toEqual(before);
    expect(versionOf(rollback)).toBe(3);

    const copy = path.join(dir, 'copy-of-rollback.db');
    const backedUp = await cli({ DATABASE_FILE: rollback }, 'backup', copy);
    expect(backedUp.code, backedUp.output).toBe(0);
    expect(sha256(rollback)).toBe(before.hash);
    expect(versionOf(rollback)).toBe(3);
    expect(versionOf(copy)).toBe(3);

    // The migrated file itself verifies cleanly.
    const current = await cli({ DATABASE_FILE: file }, 'verify');
    expect(current.code, current.output).toBe(0);
    expect(current.output).toContain(`"schemaVersion": ${SCHEMA_VERSION}`);
  }, 120_000);
});
