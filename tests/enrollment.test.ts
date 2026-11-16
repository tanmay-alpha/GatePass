import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashPassword } from '../src/server/accounts';
import { migrate, MIGRATIONS, openDatabase, SCHEMA_VERSION, schemaVersion, type Database } from '../src/server/db';
import { ENROLLMENT_TTL_MS, GatePass } from '../src/server/gatepass';
import { verifyDatabase } from '../src/server/integrity';
import { generateToken, hashToken } from '../src/server/tokens';
import { createHarness, enroll, EVENT_INPUT, scan, seedEvent, setupCode, type Harness } from './helpers';

// Phase 2 audit of one-time scanner enrollment (ADR 0010, SEC-08): expiry
// boundary, single use under real concurrency, revoked devices, failed claims
// never touching a working key, no way to move a device to another event,
// legacy keys, and the upgrade of a populated schema-3 database.

let h: Harness;
const dirs: string[] = [];
const open: Database[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  h?.close();
  for (const db of open.splice(0)) if (db.isOpen) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

type Created = { scanner: { id: string }; enrollment: { url: string; expiresAt: string } };

const operator = (method: 'get' | 'post', url: string) => h.admin(request(h.app)[method](url));
const claim = (code: string) => request(h.app).post('/api/scanner/enroll').send({ code });
const session = (key: string) => request(h.app).get('/api/scanner/session').set('Authorization', `Bearer ${key}`);

async function newEvent(name = EVENT_INPUT.name) {
  return (await operator('post', '/api/events').send({ ...EVENT_INPUT, name }).expect(201)).body as { id: string };
}
async function newScanner(eventId: string, body: object = { label: 'Door' }): Promise<Created> {
  return (await operator('post', `/api/events/${eventId}/scanners`).send(body).expect(201)).body;
}
const storedKeyHash = (scannerId: string) => (h.db.prepare('SELECT key_hash FROM scanners WHERE id = ?').get(scannerId) as { key_hash: string }).key_hash;
const enrolledAudits = () => Number((h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'scanner.enrolled'").get() as { n: number }).n);

/** Cookie session by hand (the harness URL is https, so the cookie is `__Host-` and Secure). */
function browser(app: Express) {
  let cookie = '';
  const send = (method: 'get' | 'post' | 'delete', url: string, body?: object) => {
    const req = request(app)[method](url);
    if (cookie) req.set('Cookie', cookie);
    if (method !== 'get') req.set('X-GatePass-CSRF', '1');
    return body === undefined ? req : req.send(body);
  };
  const capture = (response: request.Response) => {
    const value = (response.headers['set-cookie'] as unknown as string[] | undefined)?.[0]?.split(';')[0];
    if (value) cookie = value.endsWith('=') ? '' : value;
    return response;
  };
  return { send, capture };
}

type EnrollOutcome = { outcome: 'enrolled' | 'refused' | 'busy'; key?: string; eventId?: string; error?: string };

/** Claims `code` from one worker thread per entry of `claims` (each with its own SQLite connection), released at the same instant. */
async function enrollInThreads(dbFile: string, code: string, claims: Array<string | undefined>): Promise<EnrollOutcome[]> {
  const barrier = new SharedArrayBuffer(4);
  const ready: Promise<void>[] = [];
  const results = claims.map((claim) => {
    const worker = new Worker(new URL('./fixtures/enroll-worker.mjs', import.meta.url), { workerData: { dbFile, barrier, code, claim } });
    const isReady = Promise.withResolvers<void>();
    const done = Promise.withResolvers<EnrollOutcome>();
    let result: EnrollOutcome | undefined;
    worker.on('message', (message: EnrollOutcome & { ready?: boolean }) => (message.ready ? isReady.resolve() : (result = message)));
    worker.once('error', (error) => {
      isReady.reject(error);
      done.reject(error);
    });
    worker.once('exit', (exitCode) => {
      const error = new Error(`Enroll worker exited with code ${exitCode} before reporting a result`);
      isReady.reject(error);
      if (result) done.resolve(result);
      else done.reject(error);
    });
    ready.push(isReady.promise);
    return done.promise;
  });
  await Promise.all(ready);
  const flags = new Int32Array(barrier);
  Atomics.store(flags, 0, 1);
  Atomics.notify(flags, 0);
  const outcomes = await Promise.all(results);
  const errors = outcomes.filter((outcome) => outcome.error);
  if (errors.length) throw new Error(`Worker errors: ${errors.map((outcome) => outcome.error).join('; ')}`);
  return outcomes;
}

describe('one-time scanner enrollment', () => {
  it('accepts a code until the last millisecond before its expiry and refuses it from the expiry instant on', async () => {
    h = createHarness();
    const event = await newEvent();
    const early = await newScanner(event.id, { label: 'Early' });
    const late = await newScanner(event.id, { label: 'Late' });
    expect(Date.parse(early.enrollment.expiresAt) - h.clock.current.getTime()).toBe(ENROLLMENT_TTL_MS);

    h.clock.current = new Date(Date.parse(early.enrollment.expiresAt) - 1);
    const key = (await claim(setupCode(early)).expect(201)).body.key as string;
    h.clock.current = new Date(late.enrollment.expiresAt);
    await claim(setupCode(late)).expect(410);
    await session(key).expect(200);
    expect((await operator('get', `/api/events/${event.id}/scanners`).expect(200)).body.map((s: { label: string; setup: string }) => [s.label, s.setup]).sort()).toEqual([
      ['Early', 'enrolled'],
      ['Late', 'expired']
    ]);
  });

  it('states the expiry the server enforces, even when the clock moves while the link is created', () => {
    let tick = Date.parse('2030-06-01T18:30:00.000Z');
    h = createHarness({ now: () => new Date((tick += 7)) });
    const event = h.service.createEvent(EVENT_INPUT, 'operator', null);
    const created = h.service.createScanner(event.id, 'Door', null, 'operator');
    const rotated = h.service.rotateScanner(created.scanner.id, 'operator');
    for (const link of [created, rotated]) {
      const stored = h.db.prepare('SELECT expires_at FROM scanner_enrollments WHERE token_hash = ?').get(hashToken(setupCode(link))) as { expires_at: string };
      expect(link.enrollment.expiresAt).toBe(stored.expires_at);
    }
  });

  it('works once: a retry of an accepted code (lost response) is refused and the minted key stays the only valid one', async () => {
    h = createHarness();
    const event = await newEvent();
    const created = await newScanner(event.id);
    const first = (await claim(setupCode(created)).expect(201)).body;
    expect(first.session.event.id).toBe(event.id);
    // The door phone did not see the answer and retries the same code.
    const retry = await claim(setupCode(created)).expect(410);
    expect(retry.body).toEqual({ error: 'This setup link is invalid, expired or already used. Ask an organizer for a new one.' });
    expect(storedKeyHash(created.scanner.id)).toBe(hashToken(first.key));
    await session(first.key).expect(200);
    expect(enrolledAudits()).toBe(1);
    // Recovery is an organizer action: a new link stops the lost key at once.
    const rotated = (await operator('post', `/api/scanners/${created.scanner.id}/rotate`).expect(200)).body;
    await session(first.key).expect(401);
    await session(await enroll(h.app, rotated)).expect(200);
  });

  it('mints exactly one key when one code is claimed from many connections at once', async () => {
    h = createHarness();
    const event = await newEvent();
    const created = await newScanner(event.id);
    const outcomes = await enrollInThreads(h.dbFile, setupCode(created), Array.from({ length: 6 }, () => undefined));
    const winners = outcomes.filter((outcome) => outcome.outcome === 'enrolled');
    expect(winners).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.outcome !== 'enrolled').every((outcome) => outcome.outcome === 'refused' || outcome.outcome === 'busy')).toBe(true);
    expect(winners[0].eventId).toBe(event.id);
    expect(storedKeyHash(created.scanner.id)).toBe(hashToken(winners[0].key!));
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM scanner_enrollments WHERE used_at IS NOT NULL').get()).toEqual({ n: 1 });
    expect(enrolledAudits()).toBe(1);
    await session(winners[0].key!).expect(200);
    expect(verifyDatabase(h.db).violations).toEqual([]);

    // The same race through HTTP on one process.
    const second = await newScanner(event.id);
    const statuses = (await Promise.all(Array.from({ length: 5 }, () => claim(setupCode(second))))).map((response) => response.status);
    expect(statuses.sort()).toEqual([201, 410, 410, 410, 410]);
  });

  it('refuses revoked scanners: no enrollment, no new link, not even through the database', async () => {
    h = createHarness();
    const event = await newEvent();
    const pending = await newScanner(event.id, { label: 'Pending' });
    await operator('post', `/api/scanners/${pending.scanner.id}/revoke`).expect(200);
    await claim(setupCode(pending)).expect(410);
    await operator('post', `/api/scanners/${pending.scanner.id}/rotate`).expect(409);
    expect(() =>
      h.db
        .prepare('INSERT INTO scanner_enrollments (token_hash, scanner_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run('a'.repeat(64), pending.scanner.id, 'operator', '2030-06-01T18:30:00.000Z', '2030-06-01T19:30:00.000Z')
    ).toThrow(/scanner is revoked/);

    const enrolled = await newScanner(event.id, { label: 'Enrolled' });
    const key = await enroll(h.app, enrolled);
    await operator('post', `/api/scanners/${enrolled.scanner.id}/revoke`).expect(200);
    await session(key).expect(401);
  });

  it('a link created by someone later removed from the team cannot be claimed (SR-03)', async () => {
    h = createHarness();
    const owner = browser(h.app);
    owner.capture(await owner.send('post', '/api/auth/register', { email: 'owner@example.com', name: 'Owner', password: 'owner password 1' }).expect(201));
    const event = (await owner.send('post', '/api/events', EVENT_INPUT).expect(201)).body;
    const invite = (await owner.send('post', `/api/events/${event.id}/invitations`, { email: 'manager@example.com' }).expect(201)).body;
    const manager = browser(h.app);
    const managerId = manager.capture(
      await manager.send('post', '/api/invitations/accept', { token: invite.url.split('/').at(-1), name: 'Manager', password: 'manager password 1' }).expect(200)
    ).body.user.id;
    const link = (await manager.send('post', `/api/events/${event.id}/scanners`, { label: 'Side door' }).expect(201)).body;
    await owner.send('delete', `/api/events/${event.id}/members/${managerId}`).expect(204);
    expect((await owner.send('get', `/api/events/${event.id}/scanners`).expect(200)).body[0]).toMatchObject({ id: link.scanner.id, revokedAt: expect.any(String) });
    await claim(setupCode(link)).expect(410);
  });

  it('failed claims (unknown, malformed, used, expired, superseded or revoked codes) never touch a working key', async () => {
    h = createHarness();
    const seeded = await seedEvent(h, 3);
    const working = seeded.scannerKey;
    const before = storedKeyHash(seeded.scannerId);

    const used = await newScanner(seeded.event.id, { label: 'Used' });
    const usedKey = await enroll(h.app, used);
    const superseded = await newScanner(seeded.event.id, { label: 'Superseded' });
    await operator('post', `/api/scanners/${superseded.scanner.id}/rotate`).expect(200);
    const revoked = await newScanner(seeded.event.id, { label: 'Revoked' });
    await operator('post', `/api/scanners/${revoked.scanner.id}/revoke`).expect(200);
    const expiring = await newScanner(seeded.event.id, { label: 'Expiring' });
    h.clock.advance(ENROLLMENT_TTL_MS);

    for (const code of ['x'.repeat(43), 'not-a-code', setupCode(used), setupCode(superseded), setupCode(revoked), setupCode(expiring)]) {
      await claim(code).expect(410);
    }
    await request(h.app).post('/api/scanner/enroll').send({ code: '' }).expect(400);
    await request(h.app).post('/api/scanner/enroll').set('Authorization', `Bearer ${working}`).send({ code: setupCode(used) }).expect(410);

    expect(storedKeyHash(seeded.scannerId)).toBe(before);
    await session(working).expect(200);
    await session(usedKey).expect(200);
    expect((await scan(h, working, seeded.passes[0].token).expect(200)).body.outcome).toBe('admitted');
  });

  it('a failure while building the answer does not spend the code: the device can retry', async () => {
    h = createHarness();
    const event = await newEvent();
    const created = await newScanner(event.id);
    const placeholder = storedKeyHash(created.scanner.id);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(h.service, 'scannerSession').mockImplementationOnce(() => {
      throw new Error('session lookup failed');
    });
    const failed = await claim(setupCode(created)).expect(500);
    expect(failed.body).toEqual({ error: 'Internal server error' });
    expect(storedKeyHash(created.scanner.id)).toBe(placeholder);
    expect(enrolledAudits()).toBe(0);

    const key = (await claim(setupCode(created)).expect(201)).body.key as string;
    await session(key).expect(200);
    expect(enrolledAudits()).toBe(1);
  });

  it('enrollment and rotation never move a device to another event or gate', async () => {
    h = createHarness();
    const owner = browser(h.app);
    owner.capture(await owner.send('post', '/api/auth/register', { email: 'a@example.com', name: 'A', password: 'owner password 1' }).expect(201));
    const other = browser(h.app);
    other.capture(await other.send('post', '/api/auth/register', { email: 'b@example.com', name: 'B', password: 'owner password 2' }).expect(201));
    const eventA = (await owner.send('post', '/api/events', EVENT_INPUT).expect(201)).body;
    const eventB = (await other.send('post', '/api/events', { ...EVENT_INPUT, name: 'Other' }).expect(201)).body;
    const gateA = (await owner.send('post', `/api/events/${eventA.id}/gates`, { name: 'Main' }).expect(201)).body;
    const gateB = (await other.send('post', `/api/events/${eventB.id}/gates`, { name: 'Main' }).expect(201)).body;

    // A gate of another event is refused when creating a device.
    await owner.send('post', `/api/events/${eventA.id}/scanners`, { label: 'Door', gateId: gateB.id }).expect(400);
    const created = (await owner.send('post', `/api/events/${eventA.id}/scanners`, { label: 'Door', gateId: gateA.id }).expect(201)).body;
    // The other event's owner cannot rotate, revoke or list it (not a member: 404).
    await other.send('post', `/api/scanners/${created.scanner.id}/rotate`).expect(404);
    await other.send('post', `/api/scanners/${created.scanner.id}/revoke`).expect(404);
    await other.send('get', `/api/events/${eventA.id}/scanners`).expect(404);

    const first = (await claim(setupCode(created)).expect(201)).body;
    expect(first.session).toMatchObject({ event: { id: eventA.id }, gate: { id: gateA.id } });
    const rotated = (await owner.send('post', `/api/scanners/${created.scanner.id}/rotate`).expect(200)).body;
    expect(rotated.scanner).toMatchObject({ id: created.scanner.id, eventId: eventA.id, gateId: gateA.id });
    const second = (await claim(setupCode(rotated)).expect(201)).body;
    expect(second.session).toMatchObject({ event: { id: eventA.id }, gate: { id: gateA.id } });

    // The database refuses a device on another event's gate, whatever the code path.
    expect(() => h.db.prepare('UPDATE scanners SET gate_id = ? WHERE id = ?').run(gateB.id, created.scanner.id)).toThrow(/another event/);
    // Its key admits nobody at another event and reveals nothing about the pass (reported as invalid).
    const passB = (await other.send('post', `/api/events/${eventB.id}/passes`, { count: 1 }).expect(201)).body[0];
    const verdict = (await scan(h, second.key, passB.token).expect(200)).body;
    expect(verdict.outcome).toBe('invalid');
    expect(verdict).not.toHaveProperty('pass');
    expect((await other.send('get', `/api/events/${eventB.id}/passes`).expect(200)).body[0]).toMatchObject({ id: passB.id, status: 'active' });
    // A scanner key is not an account credential.
    await request(h.app).get(`/api/events/${eventA.id}`).set('Authorization', `Bearer ${second.key}`).expect(401);
  });

  it('keeps keys issued before one-time links (enrolled_at NULL) working until they are rotated', async () => {
    h = createHarness();
    const event = await newEvent();
    const pass = (await operator('post', `/api/events/${event.id}/passes`).send({ count: 1 }).expect(201)).body[0];
    const legacyKey = `gps_${createHash('sha256').update('legacy device').digest('base64url')}`;
    h.db
      .prepare('INSERT INTO scanners (id, event_id, label, key_hash, created_at, key_issued_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run('legacy-scanner', event.id, 'Old phone', hashToken(legacyKey), '2030-05-01T10:00:00.000Z', 'operator');

    await session(legacyKey).expect(200);
    expect((await scan(h, legacyKey, pass.token).expect(200)).body.outcome).toBe('admitted');
    expect((await operator('get', `/api/events/${event.id}/scanners`).expect(200)).body[0]).toMatchObject({ id: 'legacy-scanner', setup: 'legacy', enrolledAt: null });
    expect((await operator('get', `/api/events/${event.id}`).expect(200)).body.readyScannerCount).toBe(1);

    const rotated = (await operator('post', '/api/scanners/legacy-scanner/rotate').expect(200)).body;
    await session(legacyKey).expect(401);
    expect(rotated.scanner.setup).toBe('pending');
    expect((await operator('get', `/api/events/${event.id}`).expect(200)).body.readyScannerCount).toBe(0);
    await session(await enroll(h.app, rotated)).expect(200);
  });
});

describe('retry-safe enrollment with a claim secret (SA2-3)', () => {
  const claimWith = (code: string, claim?: string) => request(h.app).post('/api/scanner/enroll').send(claim === undefined ? { code } : { code, claim });
  const audits = (action: string) => Number((h.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get(action) as { n: number }).n);

  it('a lost answer: resending the same code and claim gets a working replacement key and the first key stops', async () => {
    h = createHarness();
    const event = await newEvent();
    const created = await newScanner(event.id);
    const claim = generateToken();
    const lost = (await claimWith(setupCode(created), claim).expect(201)).body.key as string;
    const retried = (await claimWith(setupCode(created), claim).expect(201)).body;
    expect(retried.key).not.toBe(lost);
    expect(retried.session.event.id).toBe(event.id);
    await session(lost).expect(401);
    await session(retried.key).expect(200);
    // Several lost answers in a row are still recoverable while the link lasts.
    const again = (await claimWith(setupCode(created), claim).expect(201)).body.key as string;
    await session(retried.key).expect(401);
    await session(again).expect(200);
    expect([audits('scanner.enrolled'), audits('scanner.enroll_retried')]).toEqual([1, 2]);
    expect(h.db.prepare('SELECT claim_hash FROM scanner_enrollments').get()).toEqual({ claim_hash: hashToken(claim) });
    expect((await operator('get', `/api/events/${event.id}/scanners`).expect(200)).body[0]).toMatchObject({ setup: 'enrolled', revokedAt: null });
  });

  it('refuses a retry without the claim, with another claim, or after a first claim made without one; a malformed claim does not spend the code', async () => {
    h = createHarness();
    const event = await newEvent();
    const created = await newScanner(event.id);
    await claimWith(setupCode(created), 'not-a-claim').expect(410);
    const claim = generateToken();
    const key = (await claimWith(setupCode(created), claim).expect(201)).body.key as string;
    await claimWith(setupCode(created)).expect(410);
    await claimWith(setupCode(created), generateToken()).expect(410);
    await session(key).expect(200);

    const oldClient = await newScanner(event.id, { label: 'Old page' });
    const oldKey = (await claimWith(setupCode(oldClient)).expect(201)).body.key as string;
    await claimWith(setupCode(oldClient), generateToken()).expect(410);
    await session(oldKey).expect(200);
    expect(audits('scanner.enroll_retried')).toBe(0);
  });

  it('ends once the scanner is rotated or revoked, or the link expires', async () => {
    h = createHarness();
    const event = await newEvent();
    const claim = generateToken();

    const rotatedScanner = await newScanner(event.id, { label: 'Rotated' });
    await claimWith(setupCode(rotatedScanner), claim).expect(201);
    const rotated = (await operator('post', `/api/scanners/${rotatedScanner.scanner.id}/rotate`).expect(200)).body;
    await claimWith(setupCode(rotatedScanner), claim).expect(410);
    // Even after the new link has been claimed, at the same instant as the old one.
    const current = await enroll(h.app, rotated);
    await claimWith(setupCode(rotatedScanner), claim).expect(410);
    await session(current).expect(200);

    const revokedScanner = await newScanner(event.id, { label: 'Revoked' });
    await claimWith(setupCode(revokedScanner), claim).expect(201);
    await operator('post', `/api/scanners/${revokedScanner.scanner.id}/revoke`).expect(200);
    await claimWith(setupCode(revokedScanner), claim).expect(410);

    const expiringScanner = await newScanner(event.id, { label: 'Expiring' });
    const kept = (await claimWith(setupCode(expiringScanner), claim).expect(201)).body.key as string;
    h.clock.current = new Date(expiringScanner.enrollment.expiresAt);
    await claimWith(setupCode(expiringScanner), claim).expect(410);
    await session(kept).expect(200);
    expect(audits('scanner.enroll_retried')).toBe(0);
  });

  it('races from many connections leave exactly one working key', async () => {
    h = createHarness();
    const event = await newEvent();
    const working = async (outcomes: EnrollOutcome[]) => {
      const keys = outcomes.filter((outcome) => outcome.outcome === 'enrolled').map((outcome) => outcome.key!);
      const statuses = await Promise.all(keys.map(async (key) => (await session(key)).status));
      return keys.filter((_, index) => statuses[index] === 200);
    };

    // Different devices (different claims): one wins, the others are refused.
    const contested = await newScanner(event.id, { label: 'Contested' });
    const devices = await enrollInThreads(h.dbFile, setupCode(contested), Array.from({ length: 6 }, () => generateToken()));
    expect(devices.filter((outcome) => outcome.outcome === 'enrolled')).toHaveLength(1);
    expect(await working(devices)).toHaveLength(1);

    // One device whose claim and retries race each other: the last commit holds the only working key.
    const retrying = await newScanner(event.id, { label: 'Retrying' });
    const claim = generateToken();
    const retries = await enrollInThreads(h.dbFile, setupCode(retrying), Array.from({ length: 6 }, () => claim));
    expect(retries.every((outcome) => outcome.outcome === 'enrolled' || outcome.outcome === 'busy')).toBe(true);
    const [only] = await working(retries);
    expect(await working(retries)).toEqual([only]);
    expect(storedKeyHash(retrying.scanner.id)).toBe(hashToken(only));
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'scanner.enrolled' AND entity_id = ?").get(retrying.scanner.id)).toEqual({ n: 1 });
    expect(verifyDatabase(h.db).violations).toEqual([]);
  });
});

describe('migration 4 from a populated schema-3 database', () => {
  const NOW = new Date('2030-06-01T18:30:00.000Z');
  const T = '2030-05-20T10:00:00.000Z';
  const token = (id: string) => createHash('sha256').update(`token:${id}`).digest('base64url');
  const LEGACY_KEY = `gps_${createHash('sha256').update('key:s1').digest('base64url')}`;
  const SESSION = createHash('sha256').update('session:owner').digest('base64url');
  const RESET = createHash('sha256').update('reset:owner').digest('base64url');
  const INVITE = createHash('sha256').update('invite:new').digest('base64url');

  async function buildSchema3(): Promise<string> {
    const dir = mkdtempSync(path.join(tmpdir(), 'gatepass-schema3-'));
    dirs.push(dir);
    const file = path.join(dir, 'v3.db');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    migrate(db, MIGRATIONS.slice(0, 3));
    expect(schemaVersion(db)).toBe(3);
    const ownerHash = await hashPassword('owner password 1');
    const managerHash = await hashPassword('manager password 1');
    const run = (sql: string, ...params: Array<string | number | null>) => db.prepare(sql).run(...params);
    db.exec('BEGIN');
    const user = (id: string, email: string, role: string, hash: string, disabledAt: string | null = null) =>
      run('INSERT INTO users (id, email, name, password_hash, platform_role, created_at, password_changed_at, disabled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, email, id, hash, role, T, T, disabledAt);
    user('u-owner', 'owner@example.com', 'organizer', ownerHash);
    // Created from a manager invitation while sign-up was closed (before migration 4 existed).
    user('u-manager', 'manager@example.com', 'organizer', managerHash);
    user('u-admin', 'admin@example.com', 'platform_admin', ownerHash);
    user('u-gone', 'gone@example.com', 'organizer', ownerHash, T);
    run("INSERT INTO events (id, name, venue, starts_at, ends_at, status, admitted_count, created_at, updated_at) VALUES ('e1', 'Launch Night', 'Hall A', ?, ?, 'active', 2, ?, ?)", EVENT_INPUT.startsAt, EVENT_INPUT.endsAt, T, T);
    run("INSERT INTO events (id, name, starts_at, ends_at, status, created_at, updated_at) VALUES ('e2', 'Elsewhere', ?, ?, 'active', ?, ?)", EVENT_INPUT.startsAt, EVENT_INPUT.endsAt, T, T);
    run("INSERT INTO event_members (event_id, user_id, role, created_at) VALUES ('e1', 'u-owner', 'owner', ?), ('e1', 'u-manager', 'manager', ?), ('e2', 'u-admin', 'owner', ?)", T, T, T);
    run("INSERT INTO invitations (id, token_hash, role, email, event_id, created_by, created_at, expires_at, accepted_at, accepted_by) VALUES ('inv-done', ?, 'manager', 'manager@example.com', 'e1', 'user:u-owner', ?, '2030-05-27T10:00:00.000Z', ?, 'u-manager')", hashToken(token('inv-done')), T, T);
    run("INSERT INTO invitations (id, token_hash, role, email, event_id, created_by, created_at, expires_at) VALUES ('inv-new', ?, 'manager', 'new@example.com', 'e1', 'user:u-owner', ?, '2030-06-05T10:00:00.000Z')", hashToken(INVITE), T);
    run("INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, 'u-owner', ?, '2030-06-05T00:00:00.000Z', ?)", hashToken(SESSION), NOW.toISOString(), NOW.toISOString());
    run("INSERT INTO password_resets (token_hash, user_id, created_by, created_at, expires_at) VALUES (?, 'u-manager', 'user:u-manager', ?, '2030-06-01T19:00:00.000Z')", hashToken(RESET), NOW.toISOString());
    run("INSERT INTO gates (id, event_id, name, created_at) VALUES ('g1', 'e1', 'Main', ?)", T);
    run("INSERT INTO admission_policies (id, event_id, name, capacity, admitted_count, created_at, updated_at) VALUES ('pol', 'e1', 'General', 10, 2, ?, ?)", T, T);
    run("INSERT INTO policy_gates (policy_id, gate_id) VALUES ('pol', 'g1')");
    run("INSERT INTO scanners (id, event_id, gate_id, label, key_hash, created_at, key_issued_by) VALUES ('s1', 'e1', 'g1', 'Door 1', ?, ?, 'user:u-owner')", hashToken(LEGACY_KEY), T);
    run("INSERT INTO scanners (id, event_id, label, key_hash, created_at, revoked_at) VALUES ('s2', 'e1', 'Lost', ?, ?, ?)", hashToken('gps_lost'), T, T);
    for (const id of ['p1', 'p2', 'p3', 'p4']) {
      run("INSERT INTO passes (id, event_id, policy_id, token_hash, attendee_name, expires_at, created_at) VALUES (?, 'e1', 'pol', ?, ?, '2030-06-02T00:00:00.000Z', ?)", id, hashToken(token(id)), `Guest ${id}`, T);
    }
    for (const id of ['p1', 'p2']) {
      run("INSERT INTO redemptions (pass_id, scanner_id, redeemed_at, gate_id, policy_id) VALUES (?, 's1', '2030-06-01T18:10:00.000Z', 'g1', 'pol')", id);
      run("INSERT INTO scans (event_id, scanner_id, gate_id, pass_id, outcome, created_at, request_id) VALUES ('e1', 's1', 'g1', ?, 'admitted', '2030-06-01T18:10:00.000Z', ?)", id, `req-${id}-0001`);
    }
    run("INSERT INTO scans (event_id, scanner_id, gate_id, pass_id, outcome, created_at) VALUES ('e1', 's1', 'g1', 'p1', 'already_redeemed', '2030-06-01T18:12:00.000Z')");
    run("INSERT INTO audit_log (event_id, actor, action, entity_id, created_at) VALUES ('e1', 'user:u-owner', 'event.created', 'e1', ?)", T);
    db.exec('COMMIT');
    db.close();
    return file;
  }

  it('upgrades to the current schema without revoking anyone’s event-creation right, and every credential and admission survives', async () => {
    const file = await buildSchema3();
    const db = openDatabase(file);
    open.push(db);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(existsSync(`${file}.pre-v${SCHEMA_VERSION}.bak`)).toBe(true);
    expect(verifyDatabase(db)).toMatchObject({ ok: true, violations: [], counts: { events: 2, passes: 4, redemptions: 2, scans: 3, users: 4 } });

    // No silent revocation: every pre-existing account keeps the right to create events (ADR 0010, PR-F6).
    expect(db.prepare('SELECT id, can_create_events, password_set_by FROM users ORDER BY id').all()).toEqual(
      ['u-admin', 'u-gone', 'u-manager', 'u-owner'].map((id) => ({ id, can_create_events: 1, password_set_by: null }))
    );
    expect(db.prepare('SELECT id, issued_by FROM invitations ORDER BY id').all()).toEqual([
      { id: 'inv-done', issued_by: null },
      { id: 'inv-new', issued_by: null }
    ]);
    expect(db.prepare('SELECT id, enrolled_at FROM scanners ORDER BY id').all()).toEqual([
      { id: 's1', enrolled_at: null },
      { id: 's2', enrolled_at: null }
    ]);
    // Migration 5 columns: links made before it carry no claim and no delivery (treated as handed to their creator).
    expect(db.prepare('SELECT delivery FROM password_resets').all()).toEqual([{ delivery: null }]);
    expect(db.prepare("SELECT name FROM pragma_table_info('scanner_enrollments') WHERE name = 'claim_hash'").all()).toEqual([{ name: 'claim_hash' }]);

    const service = new GatePass(db, { publicUrl: 'https://gate.example', now: () => new Date(NOW) });
    // The legacy key still authenticates and the admissions it recorded still stand.
    const scanner = service.authenticateScanner(LEGACY_KEY)!;
    expect(scanner).toMatchObject({ id: 's1', eventId: 'e1', gateId: 'g1' });
    expect(service.authenticateScanner('gps_lost')).toBeNull();
    expect(service.redeem(scanner, token('p1')).outcome).toBe('already_redeemed');
    expect(service.redeem(scanner, token('p2'), 'req-p2-0001')).toMatchObject({ outcome: 'admitted', replayed: true });
    expect(service.redeem(scanner, token('p3')).outcome).toBe('admitted');
    expect(service.listScanners('e1').map((s) => [s.id, s.setup])).toEqual(expect.arrayContaining([['s1', 'legacy']]));
    expect(service.getEvent('e1')).toMatchObject({ readyScannerCount: 1, admittedCount: 3 });

    // Sessions, sign-in, pending reset links and invitations made before the upgrade still work.
    expect(service.accounts.authenticate(SESSION)?.user).toMatchObject({ id: 'u-owner', canCreateEvents: true });
    expect(await service.accounts.login('manager@example.com', 'manager password 1', { ip: 'test' })).toMatchObject({ user: { id: 'u-manager', canCreateEvents: true } });
    expect(await service.accounts.login('gone@example.com', 'owner password 1', { ip: 'test' })).toBeNull();
    expect(service.accounts.previewInvitation(INVITE)).toMatchObject({ email: 'new@example.com', role: 'manager' });
    await service.accounts.resetPassword(RESET, 'manager password 2');
    expect(service.accounts.securityNotice('u-manager')).toBeNull();

    // A recovered account still sees only its own events.
    expect(service.listEvents({ kind: 'user', user: service.accounts.getUser('u-manager') }).map((e) => e.id)).toEqual(['e1']);
    expect(() => service.authorize({ kind: 'user', user: service.accounts.getUser('u-manager') }, 'e2', 'view')).toThrow(/Event not found/);

    // Disabling the creator of a pre-upgrade invitation (issued_by NULL) still revokes it.
    service.accounts.setDisabled('u-owner', true, 'operator');
    expect(service.accounts.previewInvitation(INVITE)).toBeNull();
    expect(service.accounts.authenticate(SESSION)).toBeNull();
    expect(verifyDatabase(db).violations).toEqual([]);
  });
});
