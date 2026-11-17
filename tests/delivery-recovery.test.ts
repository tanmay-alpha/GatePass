import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeliveryWorker, type DeliveryWorkerOptions } from '../src/server/deliveries';
import { resendMailer, type MailAttempt, type MailMessage, type Mailer } from '../src/server/mailer';
import type { DeliveryList, EmailReport } from '../src/shared/types';
import { FakeProvider } from './mail-fakes';
import { createHarness, type Harness } from './helpers';

// Ambiguous provider answers beyond the provider's de-duplication window
// (docs/decisions/0012-pass-email-outbox.md): the outbox reuses the delivery
// id as idempotency key, which Resend honours for 24 hours only. An attempt
// that may have reached the provider is repeated only within 23 hours of the
// first such attempt; after that, or when retries run out, the email ends
// `unconfirmed` instead of `failed` (it may have been sent).

const HOUR = 3_600_000;
const KEY = randomBytes(32);
const TIMEOUT: MailAttempt = { status: 'retry', error: 'The email provider did not answer in time.', ambiguous: true };
const SERVER_ERROR: MailAttempt = { status: 'retry', error: 'The email provider refused the message (internal_server_error).', ambiguous: true };
const BAD_KEY: MailAttempt = { status: 'retry', error: 'The email provider refused the message (invalid_api_key).', ambiguous: false };
const THROTTLED: MailAttempt = { status: 'retry', error: 'The email provider refused the message (daily_quota_exceeded).', ambiguous: false, throttled: true };

let h: Harness;
let workers: DeliveryWorker[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(workers.map((worker) => worker.stop()));
  workers = [];
  h?.close();
});

function setup(mailer?: Mailer): FakeProvider {
  h = createHarness({ mailer: mailer ?? new FakeProvider(() => h.clock.current.getTime()), passDeliveryKey: KEY });
  return h.service.accounts.mailer as FakeProvider;
}

function worker(mailer: Mailer, options: Partial<DeliveryWorkerOptions> = {}, logs: Array<Record<string, unknown>> = []) {
  const created = new DeliveryWorker(h.service.deliveries, mailer, { perSecond: 1000, maxAttempts: 3, log: (entry) => logs.push(entry), ...options });
  workers.push(created);
  return created;
}

/** An event running for ten days, so passes outlive a day-long outage, with one queued email per address. */
function queue(emails: string[]): { eventId: string } {
  const event = h.service.createEvent({ name: 'Long Weekend', startsAt: '2030-06-01T18:00:00.000Z', endsAt: '2030-06-10T23:00:00.000Z' }, 'operator');
  h.service.issuePasses(event.id, { attendees: emails.map((email) => ({ email })), emailPasses: true }, 'operator');
  return { eventId: event.id };
}

function rows(): Array<Record<string, unknown>> {
  return h.db.prepare('SELECT * FROM pass_deliveries ORDER BY created_at, rowid').all() as Array<Record<string, unknown>>;
}

function auditActions(): string[] {
  return (h.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'pass.email_%' ORDER BY id").all() as Array<{ action: string }>).map((row) => row.action);
}

/** The previous process claimed the email, the provider accepted it, and the process died before recording the answer. */
async function acceptThenCrash(provider: FakeProvider): Promise<MailMessage> {
  const job = h.service.deliveries.claim()!;
  expect(await provider.attempt(job.message)).toMatchObject({ status: 'accepted' });
  expect(rows()[0]).toMatchObject({ status: 'sending', attempts: 1 });
  return job.message;
}

describe('crash after the provider accepted, before the answer was recorded', () => {
  it('resumed within the window: retried with the same idempotency key, the provider sends it once', async () => {
    const provider = setup();
    queue(['ada@example.com']);
    const first = await acceptThenCrash(provider);
    h.clock.advance(22 * HOUR); // offline for 22 hours

    const logs: Array<Record<string, unknown>> = [];
    const restarted = worker(provider, {}, logs);
    restarted.start();
    await provider.callsReached(2);
    await restarted.stop();
    expect(provider.calls.map((call) => call.message.idempotencyKey)).toEqual([first.idempotencyKey, first.idempotencyKey]);
    expect(provider.sent).toBe(1);
    expect(rows()[0]).toMatchObject({ status: 'accepted', attempts: 2, provider_id: 'msg_1', sealed_link: null });
    expect(logs).toContainEqual(expect.objectContaining({ msg: 'pass emails interrupted by a restart were queued again', count: 1 }));
  });

  it('resumed after more than 23 hours offline: closed as unconfirmed without calling the provider again', async () => {
    const provider = setup();
    const { eventId } = queue(['ada@example.com']);
    await acceptThenCrash(provider);
    const claimedAt = h.clock.current.toISOString();
    h.clock.advance(23 * HOUR + 60_000);

    expect(h.service.deliveries.recoverInterrupted()).toBe(1);
    expect(rows()[0]).toMatchObject({ status: 'queued', uncertain_since: claimedAt, last_attempt_at: claimedAt });
    expect(await worker(provider).runOnce()).toBe(false);
    expect(provider.calls).toHaveLength(1); // only the request before the crash
    expect(provider.sent).toBe(1);
    const [row] = rows();
    expect(row).toMatchObject({ status: 'unconfirmed', sealed_link: null, next_attempt_at: null, attempts: 1 });
    expect(row.last_error).toMatch(/may already have sent/);
    expect(row.last_error).toMatch(/new link/);
    expect(auditActions()).toEqual(['pass.email_queued', 'pass.email_unconfirmed']);

    const list = (await h.admin(request(h.app).get(`/api/events/${eventId}/deliveries`)).expect(200)).body as DeliveryList;
    expect(list.counts).toMatchObject({ queued: 0, failed: 0, unconfirmed: 1 });
    expect(list.deliveries[0]).toMatchObject({ status: 'unconfirmed', uncertainSince: claimedAt, lastAttemptAt: claimedAt });
  });

  it('measures the window from the interrupted attempt, not from the restart', async () => {
    const provider = setup();
    queue(['ada@example.com']);
    await acceptThenCrash(provider);
    const claimedAt = h.clock.current.toISOString();
    h.clock.advance(HOUR);
    h.service.deliveries.recoverInterrupted();
    provider.script = [TIMEOUT];
    const sender = worker(provider);
    expect(await sender.runOnce()).toBe(true); // retried an hour later; the answer is lost again
    expect(rows()[0]).toMatchObject({ status: 'queued', uncertain_since: claimedAt });

    h.clock.advance(22 * HOUR + 60_000); // 23 h 01 min after the first attempt, 22 h 01 min after the second
    expect(await sender.runOnce()).toBe(false);
    expect(provider.calls).toHaveLength(2);
    expect(rows()[0]).toMatchObject({ status: 'unconfirmed', attempts: 2 });
  });
});

describe('retry policy by kind of failure', () => {
  it('keeps retrying an email whose attempts all failed definitely, however old (nothing can have been sent)', async () => {
    const provider = setup();
    provider.script = [BAD_KEY, THROTTLED];
    queue(['ada@example.com']);
    const sender = worker(provider);
    expect(await sender.runOnce()).toBe(true); // 401: the operator fixes the key later
    expect(rows()[0]).toMatchObject({ status: 'queued', attempts: 1, uncertain_since: null });
    h.clock.advance(25 * HOUR);
    expect(await sender.runOnce()).toBe(true); // rate limited
    expect(rows()[0]).toMatchObject({ status: 'queued', attempts: 1, uncertain_since: null });
    h.clock.advance(25 * HOUR);
    expect(await sender.runOnce()).toBe(true);
    expect(rows()[0]).toMatchObject({ status: 'accepted', attempts: 2 });
    expect(provider.sent).toBe(1);
  });

  it('closes an email as unconfirmed, not failed, when retries run out after an ambiguous attempt', async () => {
    const provider = setup();
    provider.script = [TIMEOUT, BAD_KEY, SERVER_ERROR];
    queue(['ada@example.com']);
    const sender = worker(provider, { maxAttempts: 3 });
    const firstAttempt = h.clock.current.toISOString();
    await sender.runOnce();
    h.clock.advance(30_000);
    await sender.runOnce();
    h.clock.advance(60_000);
    await sender.runOnce();
    const [row] = rows();
    expect(row).toMatchObject({ status: 'unconfirmed', attempts: 3, sealed_link: null, uncertain_since: firstAttempt });
    expect(row.last_error).toMatch(/^The email provider refused the message \(internal_server_error\)\. Gave up after 3 attempts\./);
    expect(row.last_error).toMatch(/may already have sent/);
    expect(auditActions()).toEqual(['pass.email_queued', 'pass.email_unconfirmed']);
  });

  it('closes an email as failed when retries run out and no attempt could have been sent', async () => {
    const provider = setup();
    const concurrent: MailAttempt = { status: 'retry', error: 'The email provider refused the message (concurrent_idempotent_requests).', ambiguous: false };
    provider.script = [BAD_KEY, concurrent, BAD_KEY];
    queue(['ada@example.com']);
    const sender = worker(provider, { maxAttempts: 3 });
    await sender.runOnce();
    h.clock.advance(30_000);
    await sender.runOnce();
    h.clock.advance(60_000);
    await sender.runOnce();
    expect(rows()[0]).toMatchObject({
      status: 'failed',
      attempts: 3,
      sealed_link: null,
      uncertain_since: null,
      last_error: 'The email provider refused the message (invalid_api_key). Gave up after 3 attempts.'
    });
    expect(auditActions()).toEqual(['pass.email_queued', 'pass.email_failed']);
  });

  it('treats a refusal after an ambiguous attempt as unconfirmed (the provider recognised the request id)', async () => {
    const provider = setup();
    provider.script = ['accept-but-time-out', { status: 'refused', error: 'The email provider refused the message (invalid_idempotent_request).' }];
    queue(['ada@example.com']);
    const sender = worker(provider);
    await sender.runOnce();
    h.clock.advance(30_000);
    await sender.runOnce();
    expect(provider.sent).toBe(1);
    const [row] = rows();
    expect(row).toMatchObject({ status: 'unconfirmed', attempts: 2 });
    expect(row.last_error).toMatch(/^The email provider refused the message \(invalid_idempotent_request\)\./);
  });

  it('counts a failed send through a mailer without attempt() as ambiguous', async () => {
    let sends = 0;
    const plain: Mailer = {
      enabled: true,
      async send(): Promise<EmailReport> {
        sends += 1;
        return { status: 'failed', error: 'The email provider did not answer in time.' };
      }
    };
    setup(plain);
    queue(['ada@example.com']);
    const sender = worker(plain, { maxAttempts: 2 });
    await sender.runOnce();
    h.clock.advance(30_000);
    await sender.runOnce();
    expect(sends).toBe(2);
    expect(rows()[0]).toMatchObject({ status: 'unconfirmed', attempts: 2 });
  });

  it('backs off worker-wide on consecutive rate-limit answers without Retry-After (an exhausted quota), instead of asking every second', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const provider = setup();
    provider.script = Array.from({ length: 5 }, () => THROTTLED);
    queue(['ada@example.com']);
    const sender = worker(provider);
    const waits: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const run = sender.runOnce();
      await vi.advanceTimersByTimeAsync(waits.at(-1) ?? 0);
      expect(await run).toBe(true);
      const [row] = rows();
      if (row.status !== 'queued') break;
      expect(row.attempts).toBe(0);
      waits.push(Date.parse(row.next_attempt_at as string) - h.clock.current.getTime());
      h.clock.advance(waits.at(-1)!);
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(rows()[0]).toMatchObject({ status: 'accepted', attempts: 1 });
  });
});

describe('organizer view and actions on unconfirmed emails', () => {
  it('lists unconfirmed emails as needing attention until a new link is sent, which supersedes them', async () => {
    const provider = setup();
    provider.script = [TIMEOUT, TIMEOUT];
    const { eventId } = queue(['ada@example.com', 'grace@example.com']);
    const sender = worker(provider, { maxAttempts: 1 });
    await sender.runOnce();
    await sender.runOnce();
    const [ada, grace] = rows();
    expect([ada.status, grace.status]).toEqual(['unconfirmed', 'unconfirmed']);

    const filtered = (await h.admin(request(h.app).get(`/api/events/${eventId}/deliveries?status=unconfirmed`)).expect(200)).body as DeliveryList;
    expect(filtered.total).toBe(2);
    expect(filtered.counts).toMatchObject({ unconfirmed: 2, failed: 0 });

    const plain = (await h.admin(request(h.app).post(`/api/events/${eventId}/deliveries/retry`)).send({ deliveryIds: [ada.id] }).expect(200)).body;
    expect(plain).toEqual({ done: 0, reissued: 0, skipped: [{ id: ada.id, reason: 'needs_reissue' }] });
    const cancel = (await h.admin(request(h.app).post(`/api/events/${eventId}/deliveries/cancel`)).send({ deliveryIds: [ada.id] }).expect(200)).body;
    expect(cancel.skipped).toEqual([{ id: ada.id, reason: 'not_queued' }]);

    const reissued = (await h.admin(request(h.app).post(`/api/events/${eventId}/deliveries/retry`)).send({ deliveryIds: [ada.id], reissue: true }).expect(200)).body;
    expect(reissued).toEqual({ done: 1, reissued: 1, skipped: [] });
    await sender.runOnce();
    const after = (await h.admin(request(h.app).get(`/api/events/${eventId}/deliveries`)).expect(200)).body as DeliveryList;
    expect(after.counts).toMatchObject({ unconfirmed: 1, accepted: 1 });
    expect(after.deliveries.map((delivery) => [delivery.id === ada.id ? 'ada' : delivery.id === grace.id ? 'grace' : 'new', delivery.status, delivery.superseded])).toEqual([
      ['new', 'accepted', false],
      ['grace', 'unconfirmed', false],
      ['ada', 'unconfirmed', true]
    ]);
    // The new email carries a new link and a new idempotency key.
    expect(provider.calls[2].message.idempotencyKey).not.toBe(ada.id);
    expect(provider.calls[2].message.text).not.toBe(provider.calls[0].message.text);
  });
});

describe('Resend adapter: which answers are ambiguous', () => {
  const message = { to: 'a@example.com', subject: 'S', text: 'T', html: 'T', idempotencyKey: 'd-1' };
  const answer = (respond: () => Response | Promise<Response>) =>
    resendMailer({ apiKey: 're_test_value', from: 'x@example.com', fetch: (async () => respond()) as unknown as typeof fetch }).attempt!(message);

  it('classifies every non-accepted answer as ambiguous (may have been sent) or definite', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const json = (status: number, body: object, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers });
    expect(await answer(json(503, { name: 'application_error' }))).toMatchObject({ status: 'retry', ambiguous: true });
    expect(await answer(json(500, {}))).toMatchObject({ status: 'retry', ambiguous: true });
    expect(await answer(json(429, { name: 'rate_limit_exceeded' }, { 'retry-after': '2' }))).toMatchObject({ status: 'retry', ambiguous: false, throttled: true, retryAfterMs: 2000 });
    expect(await answer(json(429, { name: 'daily_quota_exceeded' }))).toMatchObject({ status: 'retry', ambiguous: false, throttled: true });
    expect(await answer(json(401, { name: 'missing_api_key' }))).toMatchObject({ status: 'retry', ambiguous: false });
    expect(await answer(json(403, { name: 'invalid_api_key' }))).toMatchObject({ status: 'retry', ambiguous: false });
    expect(await answer(json(409, { name: 'concurrent_idempotent_requests' }))).toMatchObject({ status: 'retry', ambiguous: false });
    expect(await answer(json(422, { name: 'validation_error' }))).toMatchObject({ status: 'refused' });
    expect(await answer(() => Promise.reject(new TypeError('fetch failed')))).toMatchObject({ status: 'retry', ambiguous: true });
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(await answer(() => Promise.reject(timeout))).toEqual({ status: 'retry', ambiguous: true, error: 'The email provider did not answer in time.' });
  });

  it('treats a success answer without a readable message id as ambiguous, not as a refusal', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await answer(() => new Response('{"id": "re_1"', { status: 200 }))).toMatchObject({ status: 'retry', ambiguous: true });
    expect(await answer(() => new Response(JSON.stringify({}), { status: 200 }))).toMatchObject({ status: 'retry', ambiguous: true });
  });
});
