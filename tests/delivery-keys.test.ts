import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { backupDatabase, openDatabase, type Database } from '../src/server/db';
import { deliveryWorkerFor, DeliveryWorker, LinkSealer } from '../src/server/deliveries';
import { GatePass } from '../src/server/gatepass';
import type { Mailer } from '../src/server/mailer';
import type { DeliveryList, IssuedPass } from '../src/shared/types';
import { FakeProvider, sealV1 } from './mail-fakes';
import { ADMIN_TOKEN, PUBLIC_URL, TestClock } from './helpers';

// PASS_DELIVERY_KEY rotation with a key ring (docs/decisions/0012-pass-email-outbox.md):
// links are sealed under the active key (seal version 2 names the key), the
// previous keys in PASS_DELIVERY_PREVIOUS_KEYS still open older links, and the
// worker re-seals waiting links under the active key when it starts.

const LINK = 'https://gate.example/p/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const A = randomBytes(32);
const B = randomBytes(32);
const C = randomBytes(32);
const UNREADABLE = /could not be decrypted with PASS_DELIVERY_KEY or PASS_DELIVERY_PREVIOUS_KEYS/;

/** The 8-byte key id of seal version 2. */
const keyId = (key: Buffer) => createHash('sha256').update('gatepass:pass-delivery-key-id\0').update(key).digest().subarray(0, 8);

const dirs: string[] = [];
const nodes: Node[] = [];
const clock = new TestClock();

afterEach(async () => {
  vi.restoreAllMocks();
  for (const node of nodes.splice(0)) await node.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function tempFile(name = 'gatepass.db'): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gatepass-keys-'));
  dirs.push(dir);
  return path.join(dir, name);
}

interface Node {
  db: Database;
  service: GatePass;
  provider: FakeProvider;
  logs: Array<Record<string, unknown>>;
  worker: DeliveryWorker;
  get: (route: string) => request.Test;
  post: (route: string, body: object) => request.Test;
  close: () => Promise<void>;
}

/** One server process on `file`: the keys it was started with, a fake provider (or none) and an unstarted worker. */
function boot(file: string, keys: { key: Buffer | null; previous?: Buffer[] }, mailer: 'provider' | 'none' = 'provider'): Node {
  const db = openDatabase(file, { backupBeforeMigrate: false });
  const provider = new FakeProvider(() => clock.current.getTime());
  const service = new GatePass(db, {
    publicUrl: PUBLIC_URL,
    now: clock.now,
    mailer: mailer === 'provider' ? provider : undefined,
    passDeliveryKey: keys.key,
    passDeliveryPreviousKeys: keys.previous
  });
  const app = createApp({ service, adminToken: ADMIN_TOKEN, publicUrl: PUBLIC_URL });
  const logs: Array<Record<string, unknown>> = [];
  const worker = new DeliveryWorker(service.deliveries, provider as Mailer, { perSecond: 1000, maxAttempts: 3, log: (entry) => logs.push(entry) });
  const node: Node = {
    db,
    service,
    provider,
    logs,
    worker,
    get: (route) => request(app).get(route).set('Authorization', `Bearer ${ADMIN_TOKEN}`),
    post: (route, body) => request(app).post(route).set('Authorization', `Bearer ${ADMIN_TOKEN}`).send(body),
    close: async () => {
      await worker.stop();
      if (db.isOpen) db.close();
      if (nodes.includes(node)) nodes.splice(nodes.indexOf(node), 1);
    }
  };
  nodes.push(node);
  return node;
}

let eventId = '';

function queue(node: Node, emails: string[]): IssuedPass[] {
  eventId ||= node.service.createEvent({ name: 'Rotation Night', startsAt: '2030-06-01T18:00:00.000Z', endsAt: '2030-06-02T23:00:00.000Z' }, 'operator').id;
  return node.service.issuePasses(eventId, { attendees: emails.map((email) => ({ email })), emailPasses: true }, 'operator');
}

function rows(db: Database): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM pass_deliveries ORDER BY created_at, rowid').all() as Array<Record<string, unknown>>;
}

/** Runs the worker until nothing is due. */
async function drain(node: Node): Promise<void> {
  while (await node.worker.runOnce());
}

/** A database with emails waiting under key A, written by a stopped server. */
async function waitingUnderA(emails: string[]): Promise<{ file: string; passes: IssuedPass[] }> {
  eventId = '';
  const file = tempFile();
  const first = boot(file, { key: A });
  const passes = queue(first, emails);
  await first.close();
  return { file, passes };
}

describe('LinkSealer key ring', () => {
  it('seals with version 2 and the active key id; tampering anywhere or another row’s ids do not open', () => {
    const sealer = new LinkSealer(A);
    const sealed = sealer.seal(LINK, 'delivery-1', 'pass-1');
    expect(sealed[0]).toBe(2);
    expect(sealed.subarray(1, 9).equals(keyId(A))).toBe(true);
    expect(sealed.includes(Buffer.from('abcdefghijklmnop'))).toBe(false);
    expect(sealer.open(sealed, 'delivery-1', 'pass-1')).toBe(LINK);
    expect(sealer.open(sealed, 'delivery-2', 'pass-1')).toBeNull();
    expect(sealer.open(sealed, 'delivery-1', 'pass-2')).toBeNull();
    for (const offset of [0, 1, 8, 9, 20, 21, 36, 37, sealed.length - 1]) {
      const tampered = Buffer.from(sealed);
      tampered[offset] ^= 1;
      expect({ offset, opened: sealer.open(tampered, 'delivery-1', 'pass-1') }).toEqual({ offset, opened: null });
    }
    expect(sealer.open(sealed.subarray(0, 37), 'delivery-1', 'pass-1')).toBeNull();
    expect(sealed.subarray(0, 9).equals(sealer.header)).toBe(true);
  });

  it('opens links sealed under a previous key or with seal version 1, and only those', () => {
    const underA = new LinkSealer(A).seal(LINK, 'delivery-1', 'pass-1');
    const v1 = sealV1(A, LINK, 'delivery-1', 'pass-1');
    const rotated = new LinkSealer(B, [A]);
    expect(rotated.open(underA, 'delivery-1', 'pass-1')).toBe(LINK);
    expect(rotated.open(v1, 'delivery-1', 'pass-1')).toBe(LINK);
    expect(underA.subarray(0, 9).equals(rotated.header)).toBe(false); // re-sealed on start
    expect(new LinkSealer(A).open(v1, 'delivery-1', 'pass-1')).toBe(LINK);
    expect(new LinkSealer(A).open(v1, 'delivery-1', 'pass-2')).toBeNull();
    expect(new LinkSealer(B).open(underA, 'delivery-1', 'pass-1')).toBeNull();
    expect(new LinkSealer(B, [C]).open(v1, 'delivery-1', 'pass-1')).toBeNull();
  });
});

describe('PASS_DELIVERY_PREVIOUS_KEYS', () => {
  const base = { ADMIN_TOKEN: 'x'.repeat(32), PASS_DELIVERY_KEY: A.toString('base64') };

  it('accepts up to four other 32-byte keys, comma-separated, in base64 or base64url', () => {
    expect(loadConfig(base).PASS_DELIVERY_PREVIOUS_KEYS).toBeUndefined();
    expect(loadConfig({ ...base, PASS_DELIVERY_PREVIOUS_KEYS: `${B.toString('base64')}, ${C.toString('base64url')} ,` }).PASS_DELIVERY_PREVIOUS_KEYS).toEqual([B, C]);
  });

  it('refuses malformed, short, repeated, active or too many keys, and previous keys without an active one', () => {
    const fails = (value: string, env: Record<string, string> = base) => expect(() => loadConfig({ ...env, PASS_DELIVERY_PREVIOUS_KEYS: value })).toThrow(/PASS_DELIVERY_PREVIOUS_KEYS/);
    fails('not a key');
    fails(randomBytes(16).toString('base64'));
    fails(`${B.toString('base64')},${randomBytes(31).toString('base64')}`);
    expect(() => loadConfig({ ...base, PASS_DELIVERY_PREVIOUS_KEYS: A.toString('base64url') })).toThrow(/must not contain PASS_DELIVERY_KEY/);
    expect(() => loadConfig({ ...base, PASS_DELIVERY_PREVIOUS_KEYS: `${B.toString('base64')},${B.toString('base64url')}` })).toThrow(/more than once/);
    expect(() => loadConfig({ ...base, PASS_DELIVERY_PREVIOUS_KEYS: Array.from({ length: 5 }, () => randomBytes(32).toString('base64')).join(',') })).toThrow(/at most 4/);
    expect(() => loadConfig({ ADMIN_TOKEN: base.ADMIN_TOKEN, PASS_DELIVERY_PREVIOUS_KEYS: B.toString('base64') })).toThrow(/needs PASS_DELIVERY_KEY/);
  });
});

describe('rotating PASS_DELIVERY_KEY with emails waiting', () => {
  it('with the old key in PREVIOUS: waiting links are re-sealed under the new key on start and still sent', async () => {
    const { file, passes } = await waitingUnderA(['ada@example.com', 'grace@example.com']);
    // A row from a schema-5 server (seal version 1) waits as well.
    const legacy = boot(file, { key: A });
    const [row] = rows(legacy.db);
    legacy.db.prepare('UPDATE pass_deliveries SET sealed_link = ? WHERE id = ?').run(sealV1(A, passes[0].passUrl, row.id as string, row.pass_id as string), row.id as string);
    const before = rows(legacy.db).map((r) => Buffer.from(r.sealed_link as Uint8Array));
    await legacy.close();

    const rotated = boot(file, { key: B, previous: [A] });
    rotated.worker.start();
    await rotated.provider.callsReached(2);
    await rotated.close();
    expect(rotated.logs).toContainEqual({ level: 'info', msg: 'pass email links re-sealed under the active key', resealed: 2, unreadable: 0 });
    expect(rotated.provider.calls.map((call) => call.message.text.includes(passes[0].passUrl) || call.message.text.includes(passes[1].passUrl))).toEqual([true, true]);
    expect(JSON.stringify(rotated.logs)).not.toMatch(/example\.com|\/p\//);

    // Re-sealed rows no longer need key A: the next deploy can drop PREVIOUS.
    const { file: second } = await waitingUnderA(['linus@example.com']);
    const resealing = boot(second, { key: B, previous: [A] });
    expect(resealing.service.deliveries.resealWaiting()).toEqual({ resealed: 1, unreadable: 0 });
    expect(resealing.service.deliveries.resealWaiting()).toEqual({ resealed: 0, unreadable: 0 });
    const [resealed] = rows(resealing.db);
    expect(Buffer.from(resealed.sealed_link as Uint8Array).subarray(0, 9).equals(Buffer.concat([Buffer.from([2]), keyId(B)]))).toBe(true);
    expect(before.some((blob) => blob.equals(Buffer.from(resealed.sealed_link as Uint8Array)))).toBe(false);
    await resealing.close();
    const withoutPrevious = boot(second, { key: B });
    await drain(withoutPrevious);
    expect(rows(withoutPrevious.db).map((r) => r.status)).toEqual(['accepted']);
    expect(withoutPrevious.provider.calls).toHaveLength(1);
  });

  it('without the old key: those emails fail with the decryption message and are never sent; newer ones are unaffected', async () => {
    const { file } = await waitingUnderA(['ada@example.com', 'grace@example.com']);
    const rotated = boot(file, { key: B });
    expect(rotated.service.deliveries.resealWaiting()).toEqual({ resealed: 0, unreadable: 2 });
    const [linus] = queue(rotated, ['linus@example.com']);
    await drain(rotated);
    const [ada, grace, newer] = rows(rotated.db);
    for (const lost of [ada, grace]) {
      expect(lost).toMatchObject({ status: 'failed', sealed_link: null, attempts: 0 });
      expect(lost.last_error).toMatch(UNREADABLE);
    }
    expect(newer).toMatchObject({ status: 'accepted', recipient: 'linus@example.com' });
    expect(rotated.provider.calls.map((call) => call.message.text.includes(linus.passUrl))).toEqual([true]);
  });

  it('without the old key, an email whose earlier attempt may have reached the provider ends unconfirmed, not failed', async () => {
    const { file } = await waitingUnderA(['ada@example.com']);
    const first = boot(file, { key: A });
    // The provider took the message but its answer was lost: the email waits for a retry with the same request id.
    first.provider.script = ['accept-but-time-out'];
    await first.worker.runOnce();
    expect(rows(first.db)[0]).toMatchObject({ status: 'queued', attempts: 1 });
    expect(first.provider.sent).toBe(1);
    await first.close();

    clock.advance(60_000); // past the 30 s backoff
    const rotated = boot(file, { key: B });
    await drain(rotated);
    const [row] = rows(rotated.db);
    expect(row).toMatchObject({ status: 'unconfirmed', sealed_link: null });
    expect(row.last_error).toMatch(UNREADABLE);
    expect(row.last_error).toMatch(/may already have sent it/);
    expect(rotated.provider.calls).toEqual([]);
    const list = (await rotated.get(`/api/events/${eventId}/deliveries`).expect(200)).body as DeliveryList;
    expect(list.counts).toMatchObject({ failed: 0, unconfirmed: 1 });
  });
});

describe('restoring a backup with emails waiting', () => {
  async function restored(keys: { key: Buffer; previous?: Buffer[] }): Promise<{ node: Node; passes: IssuedPass[] }> {
    const { file, passes } = await waitingUnderA(['ada@example.com', 'grace@example.com']);
    const live = boot(file, { key: A });
    const backup = tempFile('backup.db');
    backupDatabase(live.db, backup);
    await live.close();
    const copy = tempFile('restored.db');
    copyFileSync(backup, copy);
    return { node: boot(copy, keys), passes };
  }

  it('sends the waiting emails with the same key', async () => {
    const { node, passes } = await restored({ key: A });
    await drain(node);
    expect(rows(node.db).map((row) => row.status)).toEqual(['accepted', 'accepted']);
    expect(node.provider.calls.map((call) => call.message.text.includes(passes[0].passUrl) || call.message.text.includes(passes[1].passUrl))).toEqual([true, true]);
  });

  it('sends them after a rotation that kept the old key in PREVIOUS', async () => {
    const { node } = await restored({ key: B, previous: [A] });
    node.worker.start();
    await node.provider.callsReached(2);
    await node.worker.stop(); // resolves once the email in flight is recorded
    expect(node.logs).toContainEqual({ level: 'info', msg: 'pass email links re-sealed under the active key', resealed: 2, unreadable: 0 });
    expect(rows(node.db).map((row) => row.status)).toEqual(['accepted', 'accepted']);
  });

  it('fails them with a clear reason when only a different key is configured', async () => {
    const { node } = await restored({ key: C });
    await drain(node);
    const failed = rows(node.db);
    expect(failed.map((row) => row.status)).toEqual(['failed', 'failed']);
    for (const row of failed) expect(row.last_error).toMatch(UNREADABLE);
    expect(node.provider.calls).toEqual([]);
  });
});

describe('sending paused by configuration', () => {
  it('says why waiting emails are not sent: no PASS_DELIVERY_KEY, or no mail provider; cancelling still works', async () => {
    const { file } = await waitingUnderA(['ada@example.com', 'grace@example.com']);
    const noKey = boot(file, { key: null });
    const list = (await noKey.get(`/api/events/${eventId}/deliveries`).expect(200)).body as DeliveryList;
    expect(list.paused).toBe('no_key');
    expect(list.counts.queued).toBe(2);
    const [ada] = list.deliveries.slice(-1);
    expect((await noKey.post(`/api/events/${eventId}/deliveries/cancel`, { deliveryIds: [ada.id] }).expect(200)).body).toMatchObject({ done: 1 });
    await noKey.close();

    const noProvider = boot(file, { key: A }, 'none');
    expect(((await noProvider.get(`/api/events/${eventId}/deliveries`).expect(200)).body as DeliveryList).paused).toBe('no_provider');
    await noProvider.close();

    const running = boot(file, { key: A });
    expect(((await running.get(`/api/events/${eventId}/deliveries`).expect(200)).body as DeliveryList).paused).toBeNull();
    await drain(running);
    await running.close();

    // Nothing waiting: nothing is paused, whatever the configuration.
    const idle = boot(file, { key: null });
    expect(((await idle.get(`/api/events/${eventId}/deliveries`).expect(200)).body as DeliveryList).paused).toBeNull();
  });

  it('re-queues an email a crash left in sending when the restarted server cannot send, so it reads as paused and can be cancelled', async () => {
    const { file } = await waitingUnderA(['ada@example.com']);
    const crashed = boot(file, { key: A });
    const claimedAt = clock.current.toISOString();
    crashed.service.deliveries.claim(); // the process died during this send
    await crashed.close();

    const restarted = boot(file, { key: null }); // e.g. the key was removed while investigating
    expect(deliveryWorkerFor(restarted.service.deliveries, restarted.provider, { perSecond: 2, maxAttempts: 8 })).toBeNull();
    const [row] = rows(restarted.db);
    expect(row).toMatchObject({ status: 'queued', uncertain_since: claimedAt });
    expect(((await restarted.get(`/api/events/${eventId}/deliveries`).expect(200)).body as DeliveryList).paused).toBe('no_key');
    expect((await restarted.post(`/api/events/${eventId}/deliveries/cancel`, { deliveryIds: [row.id] }).expect(200)).body).toMatchObject({ done: 1, skipped: [] });
    await restarted.close();

    // With the key, start-up returns the worker and leaves recovery to its start().
    const { file: other } = await waitingUnderA(['grace@example.com']);
    const configured = boot(other, { key: A });
    expect(deliveryWorkerFor(configured.service.deliveries, configured.provider, { perSecond: 2, maxAttempts: 8 })).toBeInstanceOf(DeliveryWorker);
  });
});
