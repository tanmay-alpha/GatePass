import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/server/config';
import { DeliveryWorker, LinkSealer, RECIPIENT_DAILY_LIMIT, type DeliveryWorkerOptions } from '../src/server/deliveries';
import { composeEmail, resendMailer, type MailAttempt, type Mailer } from '../src/server/mailer';
import type { IssuedPass, PassDelivery } from '../src/shared/types';
import { FakeProvider } from './mail-fakes';
import { createHarness, EVENT_INPUT, type Harness } from './helpers';

const PASSWORD = 'correct horse battery';

const KEY = randomBytes(32);
let h: Harness;
let workers: DeliveryWorker[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(workers.map((worker) => worker.stop()));
  workers = [];
  h?.close();
});

function setup(options: { key?: Buffer | null; provider?: Mailer | null } = {}) {
  const provider = options.provider === undefined ? new FakeProvider() : options.provider;
  h = createHarness({ mailer: provider ?? undefined, passDeliveryKey: options.key === undefined ? KEY : options.key });
  return provider as FakeProvider;
}

function worker(provider: Mailer, options: Partial<DeliveryWorkerOptions> = {}, logs: Array<Record<string, unknown>> = []) {
  const created = new DeliveryWorker(h.service.deliveries, provider, { perSecond: 1000, maxAttempts: 3, log: (entry) => logs.push(entry), ...options });
  workers.push(created);
  return created;
}

async function createEvent(): Promise<{ id: string }> {
  return (await h.admin(request(h.app).post('/api/events')).send(EVENT_INPUT).expect(201)).body;
}

async function issue(eventId: string, attendees: Array<{ name?: string; email?: string }>, emailPasses = true): Promise<IssuedPass[]> {
  return (await h.admin(request(h.app).post(`/api/events/${eventId}/passes`)).send({ attendees, emailPasses }).expect(201)).body;
}

function rows(): Array<Record<string, unknown>> {
  return h.db.prepare('SELECT * FROM pass_deliveries ORDER BY created_at, rowid').all() as Array<Record<string, unknown>>;
}

function auditActions(prefix = 'pass.email_'): string[] {
  return (h.db.prepare("SELECT action FROM audit_log WHERE action LIKE ? || '%' ORDER BY id").all(prefix) as Array<{ action: string }>).map((row) => row.action);
}

function count(sql: string): number {
  const row = h.db.prepare(sql).get();
  return Number(row?.n);
}

function passCount(): number {
  return count('SELECT COUNT(*) AS n FROM passes');
}

describe('pass email outbox', () => {
  it('queues one email per attendee with an address inside the issuance; the worker hands each to the provider once', async () => {
    const provider = setup();
    const event = await createEvent();
    const issued = await issue(event.id, [{ name: 'Ada', email: 'ada@example.com' }, { name: 'Grace' }, { name: 'Linus', email: 'linus@example.com' }]);

    const queued = rows();
    expect(queued.map((row) => [row.pass_id, row.status, row.recipient])).toEqual([
      [issued[0].id, 'queued', 'ada@example.com'],
      [issued[2].id, 'queued', 'linus@example.com']
    ]);
    expect(queued.every((row) => row.sealed_link instanceof Uint8Array)).toBe(true);
    expect(auditActions()).toEqual(['pass.email_queued']);

    const sender = worker(provider);
    expect(await sender.runOnce()).toBe(true);
    expect(await sender.runOnce()).toBe(true);
    expect(await sender.runOnce()).toBe(false);

    const [first] = provider.calls.map((call) => call.message);
    expect(first).toMatchObject({ to: 'ada@example.com', subject: 'Your entry pass', idempotencyKey: queued[0].id });
    expect(first.text).toContain(issued[0].passUrl);
    expect(first.html).toContain(issued[0].passUrl);
    expect(first.text).toContain('Launch Night');

    const done = rows();
    expect(done.map((row) => [row.status, row.provider_id, row.sealed_link, row.attempts])).toEqual([
      ['accepted', 'msg_1', null, 1],
      ['accepted', 'msg_2', null, 1]
    ]);
    expect(auditActions()).toEqual(['pass.email_queued', 'pass.email_accepted', 'pass.email_accepted']);

    const list = (await h.admin(request(h.app).get(`/api/events/${event.id}/deliveries`)).expect(200)).body;
    expect(list.counts).toEqual({ queued: 0, sending: 0, accepted: 2, failed: 0, cancelled: 0, unconfirmed: 0, retrying: 0 });
    expect(list.paused).toBeNull();
    expect(list.deliveries.map((d: PassDelivery) => [d.attendeeName, d.status])).toEqual([
      ['Linus', 'accepted'],
      ['Ada', 'accepted']
    ]);
  });

  it('retries an ambiguous timeout with the same idempotency key: the provider sends once and no pass is duplicated', async () => {
    const provider = setup();
    provider.script = ['accept-but-time-out'];
    const event = await createEvent();
    await issue(event.id, [{ name: 'Ada', email: 'ada@example.com' }]);
    const sender = worker(provider);

    expect(await sender.runOnce()).toBe(true);
    const [waiting] = rows();
    expect(waiting).toMatchObject({ status: 'queued', attempts: 1, last_error: 'The email provider did not answer in time.' });
    expect(waiting.sealed_link).toBeInstanceOf(Uint8Array);
    expect(waiting.next_attempt_at).toBe(new Date(h.clock.current.getTime() + 30_000).toISOString());
    expect(await sender.runOnce()).toBe(false); // backing off

    h.clock.advance(30_000);
    expect(await sender.runOnce()).toBe(true);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].message.idempotencyKey).toBe(provider.calls[0].message.idempotencyKey);
    expect(provider.accepted.size).toBe(1);
    expect(rows()[0]).toMatchObject({ status: 'accepted', provider_id: 'msg_1', attempts: 2, sealed_link: null, last_error: null });
    expect(passCount()).toBe(1);
  });

  it('marks a refused email failed, erases its link, and sends again only with an explicit reissue', async () => {
    const provider = setup();
    provider.script = [{ status: 'refused', error: 'The email provider refused the message (validation_error).' }];
    const event = await createEvent();
    const [pass] = await issue(event.id, [{ name: 'Ada', email: 'ada@example.com' }]);
    const sender = worker(provider);

    await sender.runOnce();
    const [failed] = rows();
    expect(failed).toMatchObject({ status: 'failed', sealed_link: null, last_error: 'The email provider refused the message (validation_error).' });
    expect(auditActions()).toEqual(['pass.email_queued', 'pass.email_failed']);

    const plain = (await h.admin(request(h.app).post(`/api/events/${event.id}/deliveries/retry`)).send({ deliveryIds: [failed.id] }).expect(200)).body;
    expect(plain).toEqual({ done: 0, reissued: 0, skipped: [{ id: failed.id, reason: 'needs_reissue' }] });
    expect(h.service.viewPass(pass.token)).not.toBeNull();

    const reissued = (await h.admin(request(h.app).post(`/api/events/${event.id}/deliveries/retry`)).send({ deliveryIds: [failed.id], reissue: true }).expect(200)).body;
    expect(reissued).toEqual({ done: 1, reissued: 1, skipped: [] });
    expect(h.service.viewPass(pass.token)).toBeNull(); // the old link stopped working
    await sender.runOnce();
    expect(rows().map((row) => row.status)).toEqual(['failed', 'accepted']);
    // The failed email was replaced: it no longer counts as failed and cannot trigger another reissue.
    const list = (await h.admin(request(h.app).get(`/api/events/${event.id}/deliveries`)).expect(200)).body;
    expect(list.counts).toMatchObject({ failed: 0, accepted: 1 });
    expect(list.deliveries.map((d: PassDelivery) => [d.status, d.superseded])).toEqual([
      ['accepted', false],
      ['failed', true]
    ]);
    const again = (await h.admin(request(h.app).post(`/api/events/${event.id}/deliveries/retry`)).send({ deliveryIds: [failed.id], reissue: true }).expect(200)).body;
    expect(again).toEqual({ done: 0, reissued: 0, skipped: [{ id: failed.id, reason: 'superseded' }] });
    const resent = provider.calls[1].message;
    expect(resent.text).not.toContain(pass.token);
    const token = /\/p\/([A-Za-z0-9_-]{43})/.exec(resent.text)![1];
    expect(h.service.viewPass(token)?.pass.id).toBe(pass.id);
    expect(passCount()).toBe(1);
  });

  it('gives up after the attempt limit with exponential backoff, then reports the failure', async () => {
    const provider = setup();
    // Definite failures (the provider refused the credentials): nothing can have been sent, so the email ends `failed`.
    const badKey: MailAttempt = { status: 'retry', error: 'The email provider refused the message (invalid_api_key).', ambiguous: false };
    provider.script = [badKey, badKey, badKey];
    const event = await createEvent();
    await issue(event.id, [{ email: 'ada@example.com' }]);
    const sender = worker(provider, { maxAttempts: 3 });

    await sender.runOnce();
    expect(rows()[0].next_attempt_at).toBe(new Date(h.clock.current.getTime() + 30_000).toISOString());
    h.clock.advance(30_000);
    await sender.runOnce();
    expect(rows()[0].next_attempt_at).toBe(new Date(h.clock.current.getTime() + 60_000).toISOString());
    h.clock.advance(60_000);
    await sender.runOnce();
    expect(rows()[0]).toMatchObject({ status: 'failed', attempts: 3, sealed_link: null, last_error: 'The email provider refused the message (invalid_api_key). Gave up after 3 attempts.' });
    expect(new Set(provider.calls.map((call) => call.message.idempotencyKey)).size).toBe(1);
  });

  it('does not count a rate-limited attempt and waits for the provider’s Retry-After', async () => {
    const provider = setup();
    provider.script = [{ status: 'retry', error: 'The email provider refused the message (rate_limit_exceeded).', ambiguous: false, throttled: true, retryAfterMs: 2_000 }];
    const event = await createEvent();
    await issue(event.id, [{ email: 'ada@example.com' }]);
    const sender = worker(provider);
    await sender.runOnce();
    expect(rows()[0]).toMatchObject({ status: 'queued', attempts: 0, next_attempt_at: new Date(h.clock.current.getTime() + 2_000).toISOString() });
  });

  it('cancels a queued email when its pass is reissued, revoked, used or expires, without contacting the provider', async () => {
    const provider = setup();
    const event = await createEvent();
    const issued = await issue(event.id, [{ email: 'a@example.com' }, { email: 'b@example.com' }, { email: 'c@example.com' }]);
    await h.admin(request(h.app).post(`/api/passes/${issued[0].id}/reissue`)).expect(200);
    await h.admin(request(h.app).post(`/api/passes/${issued[1].id}/revoke`)).expect(200);

    expect(await worker(provider).runOnce()).toBe(true); // the third pass is still valid
    expect(rows().map((row) => [row.status, row.sealed_link, row.last_error])).toEqual([
      ['cancelled', null, 'Not sent: the pass was reissued, so this email carried a link that no longer works.'],
      ['cancelled', null, 'Not sent: the pass was revoked.'],
      ['accepted', null, null]
    ]);
    expect(provider.calls.map((call) => call.message.to)).toEqual(['c@example.com']);

    // Expiry: the sweep erases links of emails that can no longer be useful, even while they back off.
    const [late] = await issue(event.id, [{ email: 'd@example.com' }]);
    h.clock.current = new Date(Date.parse(late.expiresAt) + 1);
    expect(h.service.deliveries.sweep()).toBe(1);
    expect(rows().at(-1)).toMatchObject({ status: 'cancelled', sealed_link: null, last_error: 'Not sent: the pass expired first.' });
    expect(auditActions().filter((action) => action === 'pass.email_cancelled')).toHaveLength(3);
  });

  it('requeues an email a crash left in sending and sends it with the same idempotency key', async () => {
    const provider = setup();
    const event = await createEvent();
    await issue(event.id, [{ email: 'ada@example.com' }]);
    // The previous process claimed it and died before recording the answer.
    const claimed = h.service.deliveries.claim()!;
    expect(rows()[0]).toMatchObject({ status: 'sending', attempts: 1 });

    const logs: Array<Record<string, unknown>> = [];
    const restarted = worker(provider, {}, logs);
    restarted.start();
    await provider.callsReached(1);
    await restarted.stop(); // resolves once the answer is recorded
    expect(logs[0]).toMatchObject({ msg: 'pass emails interrupted by a restart were queued again', count: 1 });
    expect(provider.calls.map((call) => call.message.idempotencyKey)).toEqual([claimed.message.idempotencyKey]);
    expect(rows()[0]).toMatchObject({ attempts: 2, provider_id: 'msg_1' });
  });

  it('sends at most perSecond emails a second', async () => {
    const provider = setup();
    const event = await createEvent();
    await issue(event.id, Array.from({ length: 5 }, (_, i) => ({ email: `guest${i}@example.com` })));
    const sender = worker(provider, { perSecond: 20 });
    const started = performance.now();
    // Real clock on purpose: the limit is enforced with real timers between provider requests.
    sender.start();
    await provider.callsReached(5);
    await sender.stop();
    expect(rows().every((row) => row.status === 'accepted')).toBe(true);
    const gaps = provider.calls.slice(1).map((call, i) => call.at - provider.calls[i].at);
    // 20 a second = one every 50 ms (timers may fire a millisecond early).
    expect(gaps.every((gap) => gap >= 48)).toBe(true);
    expect(performance.now() - started).toBeGreaterThanOrEqual(4 * 48);
  });

  it('stores links only sealed and never logs or audits the token or the recipient', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const infos = vi.spyOn(console, 'log').mockImplementation(() => {});
    const provider = setup();
    provider.script = [{ status: 'retry', error: 'The email provider could not be reached.', ambiguous: true }];
    const event = await createEvent();
    const [pass] = await issue(event.id, [{ name: 'Ada', email: 'ada.private@example.com' }]);
    h.db.exec('PRAGMA wal_checkpoint(FULL)');

    const bytes = Buffer.concat([readFileSync(h.dbFile), existsSync(`${h.dbFile}-wal`) ? readFileSync(`${h.dbFile}-wal`) : Buffer.alloc(0)]);
    expect(bytes.includes(Buffer.from(pass.token))).toBe(false);
    expect(JSON.stringify(rows(), (_key, value: unknown) => (value instanceof Uint8Array ? Buffer.from(value).toString('latin1') : value))).not.toContain(pass.token);

    const logs: Array<Record<string, unknown>> = [];
    const sender = worker(provider, {}, logs);
    await sender.runOnce();
    h.clock.advance(30_000);
    await sender.runOnce();
    const logged = JSON.stringify([logs, errors.mock.calls, infos.mock.calls]);
    const audit = JSON.stringify(h.db.prepare('SELECT * FROM audit_log').all());
    for (const secret of [pass.token, 'ada.private@example.com']) {
      expect(logged).not.toContain(secret);
      expect(audit).not.toContain(secret);
    }
  });

  it('cancels only waiting emails and makes a backing-off email due now on retry', async () => {
    const provider = setup();
    provider.script = [{ status: 'retry', error: 'The email provider could not be reached.', ambiguous: true }];
    const event = await createEvent();
    await issue(event.id, [{ email: 'a@example.com' }, { email: 'b@example.com' }]);
    const sender = worker(provider);
    await sender.runOnce(); // a: backing off
    await sender.runOnce(); // b: accepted
    const [a, b] = rows();
    expect([a.status, b.status]).toEqual(['queued', 'accepted']);

    const retry = (await h.admin(request(h.app).post(`/api/events/${event.id}/deliveries/retry`)).send({ deliveryIds: [a.id] }).expect(200)).body;
    expect(retry).toEqual({ done: 1, reissued: 0, skipped: [] });
    expect(rows()[0].next_attempt_at).toBe(h.clock.current.toISOString());

    const cancel = (await h.admin(request(h.app).post(`/api/events/${event.id}/deliveries/cancel`)).send({ deliveryIds: [a.id, b.id] }).expect(200)).body;
    expect(cancel).toEqual({ done: 1, reissued: 0, skipped: [{ id: b.id, reason: 'not_queued' }] });
    expect(rows()[0]).toMatchObject({ status: 'cancelled', sealed_link: null, last_error: 'Cancelled by an organizer.' });
    expect(await sender.runOnce()).toBe(false);
  });

  it('emails passes issued without email: with the link still on screen (no reissue) or with a new link', async () => {
    const provider = setup();
    const event = await createEvent();
    const [ada, grace, linus] = await issue(event.id, [{ email: 'ada@example.com' }, { email: 'grace@example.com' }, { name: 'Linus' }], false);
    expect(rows()).toEqual([]);

    const bulk = (await h.admin(request(h.app).post(`/api/events/${event.id}/deliveries`))
      .send({ passes: [{ passId: ada.id, token: ada.token }, { passId: grace.id, token: ada.token }, { passId: linus.id, token: linus.token }] })
      .expect(200)).body;
    expect(bulk).toEqual({
      done: 1,
      reissued: 0,
      skipped: [
        { id: grace.id, reason: 'link_changed' },
        { id: linus.id, reason: 'no_email' }
      ]
    });
    expect(h.service.viewPass(ada.token)).not.toBeNull();

    const needsReissue = await h.admin(request(h.app).post(`/api/events/${event.id}/passes/${grace.id}/deliveries`)).send({}).expect(409);
    expect(needsReissue.body.error).toMatch(/new link/);
    const single = (await h.admin(request(h.app).post(`/api/events/${event.id}/passes/${grace.id}/deliveries`)).send({ reissue: true }).expect(201)).body;
    expect(single).toMatchObject({ passId: grace.id, status: 'queued', recipient: 'grace@example.com' });
    expect(h.service.viewPass(grace.token)).toBeNull();
    await h.admin(request(h.app).post(`/api/events/${event.id}/passes/${grace.id}/deliveries`)).send({ reissue: true }).expect(409);

    const sender = worker(provider);
    await sender.runOnce();
    await sender.runOnce();
    expect(provider.calls[0].message.text).toContain(ada.passUrl);
    expect(rows().map((row) => row.status)).toEqual(['accepted', 'accepted']);
  });

  it('queues emails for imported rows only when asked, and never on a dry run', async () => {
    setup();
    const event = await createEvent();
    const csvRows = [{ name: 'Ada', email: 'ada@example.com' }, { name: 'No email' }, { name: 'Bad', email: 'not-an-email' }];
    await h.admin(request(h.app).post(`/api/events/${event.id}/passes/import`)).send({ rows: csvRows, dryRun: true, emailPasses: true }).expect(200);
    expect(rows()).toEqual([]);
    const report = (await h.admin(request(h.app).post(`/api/events/${event.id}/passes/import`)).send({ rows: csvRows, dryRun: false, emailPasses: true }).expect(201)).body;
    expect(report.issued).toHaveLength(2);
    expect(rows().map((row) => row.recipient)).toEqual(['ada@example.com']);
  });

  it('refuses to queue without PASS_DELIVERY_KEY or without a mail provider, before issuing anything', async () => {
    setup({ key: null });
    let event = await createEvent();
    const noKey = await h.admin(request(h.app).post(`/api/events/${event.id}/passes`)).send({ attendees: [{ email: 'ada@example.com' }], emailPasses: true }).expect(409);
    expect(noKey.body.error).toMatch(/PASS_DELIVERY_KEY/);
    expect(passCount()).toBe(0);
    expect((await request(h.app).get('/api/health').expect(200)).body).toMatchObject({ email: true, passEmail: false });
    h.close();

    setup({ provider: null });
    event = await createEvent();
    const noMail = await h.admin(request(h.app).post(`/api/events/${event.id}/passes/import`)).send({ rows: [{ email: 'ada@example.com' }], dryRun: true, emailPasses: true }).expect(409);
    expect(noMail.body.error).toMatch(/Email is not configured/);
    const health = (await request(h.app).get('/api/health').expect(200)).body;
    expect(health.email).toBe(false);
    expect(health).not.toHaveProperty('passEmail');
    // Without the flag nothing changes.
    await h.admin(request(h.app).post(`/api/events/${event.id}/passes`)).send({ attendees: [{ email: 'ada@example.com' }] }).expect(201);
    expect(rows()).toEqual([]);
  });

  it('caps pass emails per address per day and refuses the whole issuance rather than issuing without the promised email', async () => {
    setup();
    const event = await createEvent();
    const many = Array.from({ length: RECIPIENT_DAILY_LIMIT + 1 }, (_, i) => ({ name: `Guest ${i}`, email: 'Group@Example.com' }));
    const refused = await h.admin(request(h.app).post(`/api/events/${event.id}/passes`)).send({ attendees: many, emailPasses: true }).expect(429);
    expect(refused.body.error).toMatch(/Issue without email/);
    expect(passCount()).toBe(0);
    await issue(event.id, many.slice(0, RECIPIENT_DAILY_LIMIT));
    expect(rows()).toHaveLength(RECIPIENT_DAILY_LIMIT);
    const [extra] = await issue(event.id, [{ email: 'group@example.com' }], false);
    await h.admin(request(h.app).post(`/api/events/${event.id}/passes/${extra.id}/deliveries`)).send({ token: extra.token }).expect(429);
  });

  it('counts an address with non-ASCII capitals against the daily cap like the database does (imports accept such addresses)', async () => {
    setup();
    const address = 'Ärzte.Team@Example.com';
    for (let i = 0; i < RECIPIENT_DAILY_LIMIT; i += 1) {
      const event = await createEvent();
      await h.admin(request(h.app).post(`/api/events/${event.id}/passes/import`)).send({ rows: [{ email: address }], dryRun: false, emailPasses: true }).expect(201);
    }
    expect(rows()).toHaveLength(RECIPIENT_DAILY_LIMIT);
    const event = await createEvent();
    const refused = await h.admin(request(h.app).post(`/api/events/${event.id}/passes/import`)).send({ rows: [{ email: address }], dryRun: false, emailPasses: true }).expect(429);
    expect(refused.body.error).toMatch(/Issue without email/);
    expect(rows()).toHaveLength(RECIPIENT_DAILY_LIMIT);
  });

  it('never duplicates passes when email fails', async () => {
    const provider = setup();
    provider.script = Array.from({ length: 6 }, () => ({ status: 'refused', error: 'The email provider refused the message (validation_error).' }) as const);
    const event = await createEvent();
    await issue(event.id, [{ email: 'a@example.com' }, { email: 'b@example.com' }]);
    const sender = worker(provider);
    await sender.runOnce();
    await sender.runOnce();
    const failed = rows().map((row) => row.id as string);
    await h.admin(request(h.app).post(`/api/events/${event.id}/deliveries/retry`)).send({ deliveryIds: failed, reissue: true }).expect(200);
    await sender.runOnce();
    await sender.runOnce();
    expect(passCount()).toBe(2);
    expect(rows().map((row) => row.status)).toEqual(['failed', 'failed', 'failed', 'failed']);
    expect(count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'passes.issued'")).toBe(1);
  });
});

describe('delivery endpoints: event isolation and permissions', () => {
  /** Cookie session by hand (the harness URL is https, so the cookie is Secure). */
  function browser() {
    let cookie = '';
    const send = (method: 'get' | 'post', path: string, body?: object, csrf = true) => {
      const req = request(h.app)[method](path);
      if (cookie) req.set('Cookie', cookie);
      if (csrf && method === 'post') req.set('X-GatePass-CSRF', '1');
      return body === undefined ? req : req.send(body);
    };
    return {
      send,
      async signUp(email: string) {
        const response = await send('post', '/api/auth/register', { email, name: email.split('@')[0], password: PASSWORD }).expect(201);
        cookie = (response.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
      }
    };
  }

  it('answers 404 for other events’ deliveries and passes, skips their ids, requires a session and the CSRF header', async () => {
    setup();
    const alice = browser();
    const bob = browser();
    await alice.signUp('alice@example.com');
    await bob.signUp('bob@example.com');
    const aliceEvent = (await alice.send('post', '/api/events', EVENT_INPUT).expect(201)).body;
    const bobEvent = (await bob.send('post', '/api/events', { ...EVENT_INPUT, name: 'Bob' }).expect(201)).body;
    const [alicePass] = (await alice.send('post', `/api/events/${aliceEvent.id}/passes`, { attendees: [{ email: 'guest@example.com' }], emailPasses: true }).expect(201))
      .body as IssuedPass[];
    const [delivery] = rows();

    await request(h.app).get(`/api/events/${aliceEvent.id}/deliveries`).expect(401);
    await bob.send('get', `/api/events/${aliceEvent.id}/deliveries`).expect(404);
    await bob.send('post', `/api/events/${aliceEvent.id}/deliveries/cancel`, { deliveryIds: [delivery.id] }).expect(404);
    await bob.send('post', `/api/events/${aliceEvent.id}/passes/${alicePass.id}/deliveries`, { reissue: true }).expect(404);
    // Bob's own event: Alice's ids are unknown there.
    await bob.send('post', `/api/events/${bobEvent.id}/passes/${alicePass.id}/deliveries`, { reissue: true }).expect(404);
    expect((await bob.send('post', `/api/events/${bobEvent.id}/deliveries/cancel`, { deliveryIds: [delivery.id] }).expect(200)).body).toEqual({
      done: 0,
      reissued: 0,
      skipped: [{ id: delivery.id, reason: 'not_found' }]
    });
    expect((await bob.send('post', `/api/events/${bobEvent.id}/deliveries/retry`, { deliveryIds: [delivery.id], reissue: true }).expect(200)).body.skipped).toEqual([
      { id: delivery.id, reason: 'not_found' }
    ]);
    expect((await bob.send('post', `/api/events/${bobEvent.id}/deliveries`, { passes: [{ passId: alicePass.id, token: alicePass.token }] }).expect(200)).body.skipped).toEqual([
      { id: alicePass.id, reason: 'not_found' }
    ]);
    expect((await bob.send('get', `/api/events/${bobEvent.id}/deliveries`).expect(200)).body.total).toBe(0);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].status).toBe('queued');
    expect(h.service.viewPass(alicePass.token)).not.toBeNull();

    await alice.send('post', `/api/events/${aliceEvent.id}/deliveries/cancel`, { deliveryIds: [delivery.id] }, false).expect(403);
    const own = (await alice.send('get', `/api/events/${aliceEvent.id}/deliveries`).expect(200)).body;
    expect(own.deliveries.map((d: PassDelivery) => d.id)).toEqual([delivery.id]);
    expect(own.deliveries[0]).not.toHaveProperty('sealedLink');
    expect(JSON.stringify(own)).not.toContain(alicePass.token);
  });
});

describe('link sealing', () => {
  it('opens only with the same key, delivery and pass, and detects tampering', () => {
    const sealer = new LinkSealer(KEY);
    const link = 'https://gate.example/p/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
    const sealed = sealer.seal(link, 'delivery-1', 'pass-1');
    expect(sealed.includes(Buffer.from('abcdefghijklmnop'))).toBe(false);
    expect(sealer.open(sealed, 'delivery-1', 'pass-1')).toBe(link);
    expect(sealer.open(sealed, 'delivery-2', 'pass-1')).toBeNull();
    expect(sealer.open(sealed, 'delivery-1', 'pass-2')).toBeNull();
    expect(new LinkSealer(randomBytes(32)).open(sealed, 'delivery-1', 'pass-1')).toBeNull();
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] ^= 1;
    expect(sealer.open(tampered, 'delivery-1', 'pass-1')).toBeNull();
    expect(sealer.seal(link, 'delivery-1', 'pass-1').equals(sealed)).toBe(false); // random IV per seal
  });

  it('fails an email whose link was sealed with another key instead of sending it', async () => {
    const provider = setup();
    const event = await createEvent();
    await issue(event.id, [{ email: 'ada@example.com' }]);
    const other = new LinkSealer(randomBytes(32));
    const [row] = rows();
    h.db.prepare('UPDATE pass_deliveries SET sealed_link = ? WHERE id = ?').run(other.seal('https://gate.example/p/x', row.id as string, row.pass_id as string), row.id as string);
    expect(await worker(provider).runOnce()).toBe(false);
    expect(rows()[0]).toMatchObject({ status: 'failed', sealed_link: null });
    expect(rows()[0].last_error).toMatch(/PASS_DELIVERY_KEY/);
    expect(provider.calls).toEqual([]);
  });
});

describe('mail adapter and configuration', () => {
  it('refuses action links that are not http(s) (SA2-4)', () => {
    const base = { to: 'a@example.com', subject: 'S', lines: ['L'], footer: 'F' };
    expect(() => composeEmail({ ...base, action: { label: 'Open', url: 'javascript:alert(1)' } })).toThrow('Email action links must be http(s) URLs.');
    expect(() => composeEmail({ ...base, action: { label: 'Open', url: 'data:text/html,<b>x</b>' } })).toThrow('Email action links must be http(s) URLs.');
    expect(composeEmail({ ...base, action: { label: 'Open', url: 'https://gate.example/p/x' } }).html).toContain('href="https://gate.example/p/x"');
  });

  it('classifies provider answers for retries and honours the endpoint override', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const answer = (status: number, body: object, headers: Record<string, string> = {}) =>
      resendMailer({
        apiKey: 're_test_value',
        from: 'x@example.com',
        url: 'http://127.0.0.1:9/emails',
        fetch: (async (url: string) => {
          expect(url).toBe('http://127.0.0.1:9/emails');
          return new Response(JSON.stringify(body), { status, headers });
        }) as unknown as typeof fetch
      });
    const message = { to: 'a@example.com', subject: 'S', text: 'T', html: 'T', idempotencyKey: 'd-1' };
    expect(await answer(200, { id: 're_1' }).attempt!(message)).toEqual({ status: 'accepted', providerId: 're_1' });
    expect(await answer(429, { name: 'rate_limit_exceeded' }, { 'retry-after': '3' }).attempt!(message)).toMatchObject({ status: 'retry', throttled: true, retryAfterMs: 3000 });
    expect(await answer(503, {}).attempt!(message)).toMatchObject({ status: 'retry' });
    expect(await answer(403, { name: 'validation_error' }).attempt!(message)).toMatchObject({ status: 'retry' });
    expect(await answer(422, { name: 'validation_error' }).attempt!(message)).toMatchObject({ status: 'refused' });
    expect(await answer(409, { name: 'invalid_idempotent_request' }).attempt!(message)).toMatchObject({ status: 'refused' });

    const hanging = resendMailer({
      apiKey: 're_test_value',
      from: 'x@example.com',
      fetch: ((_url: string, init: RequestInit) => {
        const { promise, reject } = Promise.withResolvers<Response>();
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        return promise;
      }) as unknown as typeof fetch
    });
    const controller = new AbortController();
    const pending = hanging.attempt!(message, controller.signal);
    controller.abort();
    expect(await pending).toEqual({ status: 'retry', ambiguous: true, error: 'Sending was interrupted by a server shutdown; the provider may have accepted it.' });
  });

  it('validates PASS_DELIVERY_KEY and RESEND_API_URL', () => {
    const base = { ADMIN_TOKEN: 'x'.repeat(32) };
    const key = randomBytes(32);
    expect(loadConfig({ ...base, PASS_DELIVERY_KEY: key.toString('base64') }).PASS_DELIVERY_KEY).toEqual(key);
    expect(loadConfig({ ...base, PASS_DELIVERY_KEY: key.toString('base64url') }).PASS_DELIVERY_KEY).toEqual(key);
    expect(() => loadConfig({ ...base, PASS_DELIVERY_KEY: randomBytes(16).toString('base64') })).toThrow(/PASS_DELIVERY_KEY/);
    expect(() => loadConfig({ ...base, PASS_DELIVERY_KEY: 'not a key' })).toThrow(/PASS_DELIVERY_KEY/);
    expect(loadConfig(base)).toMatchObject({ PASS_EMAIL_PER_SECOND: 2, PASS_EMAIL_MAX_ATTEMPTS: 8 });
    expect(loadConfig({ ...base, RESEND_API_URL: 'http://127.0.0.1:4000/emails' }).RESEND_API_URL).toBe('http://127.0.0.1:4000/emails');
    expect(() => loadConfig({ ...base, RESEND_API_URL: 'http://mail.example.com/emails' })).toThrow(/RESEND_API_URL/);
  });
});
