import type { Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCommit, loadConfig } from '../src/server/config';
import { createApp } from '../src/server/app';
import { resendMailer, type MailMessage, type Mailer } from '../src/server/mailer';
import type { EmailReport } from '../src/shared/types';
import { ADMIN_TOKEN, createHarness, EVENT_INPUT, PUBLIC_URL, type Harness } from './helpers';

const PASSWORD = 'correct horse battery';

/** Records every message; answers `sent` unless told to fail. */
class FakeMailer implements Mailer {
  readonly enabled = true;
  readonly sent: MailMessage[] = [];
  fail = false;
  async send(message: MailMessage): Promise<EmailReport> {
    if (this.fail) return { status: 'failed', error: 'The email provider refused the message (validation_error).' };
    this.sent.push(message);
    return { status: 'sent', providerId: `msg_${this.sent.length}` };
  }
}

let h: Harness;
afterEach(() => {
  vi.restoreAllMocks();
  h?.close();
});

function setup(options: { mailer?: Mailer; allowSignup?: boolean } = {}) {
  h = createHarness({ mailer: options.mailer });
  const app = createApp({ service: h.service, adminToken: ADMIN_TOKEN, publicUrl: PUBLIC_URL, allowSignup: options.allowSignup ?? true });
  const operator = (method: 'get' | 'post', path: string) => request(app)[method](path).set('Authorization', `Bearer ${ADMIN_TOKEN}`);
  return { app, operator };
}

/** Cookie session by hand (the harness URL is https, so the cookie is Secure). */
function browser(app: Express) {
  let cookie = '';
  const send = (method: 'get' | 'post', path: string, body?: object) => {
    const req = request(app)[method](path);
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

const tokenOf = (url: string) => url.split('/').at(-1)!;
const linkIn = (message: MailMessage) => /https:\/\/gate\.example\/#\/(?:reset|invite)\/[A-Za-z0-9_-]{43}/.exec(message.text)![0];

describe('administrator password reset (security review R2)', () => {
  it('without email: needs a written reason, is audited with it, and leaves a notice that a password change cannot hide', async () => {
    const { app, operator } = setup();
    const owner = browser(app);
    const userId = owner.capture(await owner.send('post', '/api/auth/register', { email: 'owner@example.com', name: 'Owner', password: PASSWORD }).expect(201)).body.user.id;

    await operator('post', `/api/platform/users/${userId}/reset-link`).send({}).expect(400);
    await operator('post', `/api/platform/users/${userId}/reset-link`).send({ reason: 'too short' }).expect(400);
    const result = (await operator('post', `/api/platform/users/${userId}/reset-link`).send({ reason: 'Lost access; identity checked by call-back' }).expect(200)).body;
    expect(result).toMatchObject({ delivery: 'link', url: expect.stringMatching(/#\/reset\//) });

    await browser(app).send('post', '/api/auth/reset', { token: tokenOf(result.url), password: 'chosen by the operator' }).expect(204);
    const signedIn = browser(app);
    const session = signedIn.capture(await signedIn.send('post', '/api/auth/login', { email: 'owner@example.com', password: 'chosen by the operator' }).expect(200)).body;
    expect(session.securityNotice).toMatchObject({ kind: 'password_reset_by_admin', by: 'operator' });

    const created = h.db.prepare("SELECT details_json FROM audit_log WHERE action = 'user.password_reset_created'").get() as { details_json: string };
    expect(JSON.parse(created.details_json)).toMatchObject({ delivery: 'link', reason: 'Lost access; identity checked by call-back' });

    // Whoever holds the administrator-set password cannot make the notice go away by changing the password…
    signedIn.capture(await signedIn.send('post', '/api/auth/password', { currentPassword: 'chosen by the operator', newPassword: 'a different password' }).expect(200));
    expect((await signedIn.send('get', '/api/auth/session').expect(200)).body.securityNotice).toMatchObject({ by: 'operator' });
    // …only by an explicit acknowledgement, which is itself audited.
    await signedIn.send('post', '/api/auth/security-notice/acknowledge').expect(204);
    expect((await signedIn.send('get', '/api/auth/session').expect(200)).body.securityNotice).toBeNull();
    expect(h.db.prepare("SELECT actor FROM audit_log WHERE action = 'user.security_notice_acknowledged'").all()).toEqual([{ actor: `user:${userId}` }]);
  });

  it('with email: using a link someone else created notifies the owner’s own mailbox', async () => {
    const mailer = new FakeMailer();
    const { app, operator } = setup({ mailer });
    const owner = browser(app);
    const userId = owner.capture(await owner.send('post', '/api/auth/register', { email: 'owner@example.com', name: 'Owner', password: PASSWORD }).expect(201)).body.user.id;
    const { url } = (await operator('post', `/api/platform/users/${userId}/reset-link`).send({ delivery: 'link', reason: 'Mailbox lost; verified in person' }).expect(200)).body;
    expect(mailer.sent).toHaveLength(0); // the operator took the link; nothing was emailed yet
    await browser(app).send('post', '/api/auth/reset', { token: tokenOf(url), password: 'set through the link' }).expect(204);
    expect(mailer.sent.map((message) => [message.to, message.subject])).toEqual([['owner@example.com', 'Your GatePass password was changed']]);
    expect(mailer.sent[0].text).not.toContain(tokenOf(url));
  });

  it('disabling an administrator cancels the reset links, renewed invitations and scanner setup links they still hold (SR-03)', async () => {
    const { app, operator } = setup();
    const invite = (await operator('post', '/api/platform/invitations').send({ email: 'root@example.com', role: 'platform_admin' }).expect(201)).body;
    const root = browser(app);
    const rootId = root.capture(await root.send('post', '/api/invitations/accept', { token: tokenOf(invite.url), name: 'Root', password: PASSWORD }).expect(200)).body.user.id;
    const victim = browser(app);
    const victimId = victim.capture(await victim.send('post', '/api/auth/register', { email: 'victim@example.com', name: 'Victim', password: PASSWORD }).expect(201)).body.user.id;

    // Root holds: a reset link for someone else, a renewed invitation the operator created, and a scanner setup link.
    const reset = (await root.send('post', `/api/platform/users/${victimId}/reset-link`, { reason: 'Asked by phone, called back' }).expect(200)).body;
    const pending = (await operator('post', '/api/platform/invitations').send({ email: 'sleeper@example.com', role: 'platform_admin' }).expect(201)).body;
    const renewed = (await root.send('post', `/api/invitations/${pending.invitation.id}/resend`).expect(200)).body;
    const event = (await root.send('post', '/api/events', EVENT_INPUT).expect(201)).body;
    const scanner = (await root.send('post', `/api/events/${event.id}/scanners`, { label: 'Door' }).expect(201)).body;

    await operator('post', `/api/platform/users/${rootId}/disable`).expect(200);
    await browser(app).send('post', '/api/auth/reset', { token: tokenOf(reset.url), password: 'taken over anyway' }).expect(410);
    await browser(app).send('post', '/api/invitations/accept', { token: tokenOf(renewed.url), name: 'Sleeper', password: PASSWORD }).expect(410);
    await request(app).post('/api/scanner/enroll').send({ code: scanner.enrollment.url.split('#enroll=')[1] }).expect(410);
    // The victim's own password still works.
    expect((await browser(app).send('post', '/api/auth/login', { email: 'victim@example.com', password: PASSWORD })).status).toBe(200);
  });

  it('with email: the link goes only to the account address, never to the administrator', async () => {
    const mailer = new FakeMailer();
    const { app, operator } = setup({ mailer });
    const owner = browser(app);
    const userId = owner.capture(await owner.send('post', '/api/auth/register', { email: 'owner@example.com', name: 'Owner', password: PASSWORD }).expect(201)).body.user.id;
    const invite = (await operator('post', '/api/platform/invitations').send({ email: 'root@example.com', role: 'platform_admin' }).expect(201)).body;
    expect(invite).not.toHaveProperty('url');
    const root = browser(app);
    root.capture(await root.send('post', '/api/invitations/accept', { token: tokenOf(linkIn(mailer.sent[0])), name: 'Root', password: PASSWORD }).expect(200));

    const result = (await root.send('post', `/api/platform/users/${userId}/reset-link`, {}).expect(200)).body;
    expect(result).toEqual({ delivery: 'email', email: { status: 'sent', providerId: 'msg_2' }, expiresAt: expect.any(String) });
    expect(JSON.stringify(result)).not.toMatch(/#\/reset\//);
    expect(mailer.sent[1].to).toBe('owner@example.com');
    // A platform admin cannot ask for the link instead; only the operator can.
    await root.send('post', `/api/platform/users/${userId}/reset-link`, { delivery: 'link', reason: 'I would like to see it' }).expect(403);
    expect((await operator('post', `/api/platform/users/${userId}/reset-link`).send({ delivery: 'link', reason: 'Mailbox lost; verified in person' }).expect(200)).body.delivery).toBe('link');
  });

  it('cancels a reset link the provider did not accept', async () => {
    const mailer = new FakeMailer();
    const { app, operator } = setup({ mailer });
    const owner = browser(app);
    const userId = owner.capture(await owner.send('post', '/api/auth/register', { email: 'owner@example.com', name: 'Owner', password: PASSWORD }).expect(201)).body.user.id;
    mailer.fail = true;
    const result = (await operator('post', `/api/platform/users/${userId}/reset-link`).send({}).expect(200)).body;
    expect(result.email).toMatchObject({ status: 'failed' });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM password_resets WHERE used_at IS NULL').get()).toEqual({ n: 0 });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'email.failed'").get()).toEqual({ n: 1 });
  });
});

describe('self-service password reset', () => {
  // The route answers before emailing; the reset link and the provider call happen in the same tick
  // (the fake mailer records synchronously), so the assertions below need no waiting.
  it('answers the same for known and unknown addresses, emails only real active accounts, and limits requests per address', async () => {
    const mailer = new FakeMailer();
    const { app, operator } = setup({ mailer });
    const owner = browser(app);
    owner.capture(await owner.send('post', '/api/auth/register', { email: 'owner@example.com', name: 'Owner', password: PASSWORD }).expect(201));
    const gone = browser(app);
    const goneId = gone.capture(await gone.send('post', '/api/auth/register', { email: 'gone@example.com', name: 'Gone', password: PASSWORD }).expect(201)).body.user.id;
    await operator('post', `/api/platform/users/${goneId}/disable`).expect(200);

    const known = await browser(app).send('post', '/api/auth/forgot', { email: 'OWNER@example.com' }).expect(202);
    const unknown = await browser(app).send('post', '/api/auth/forgot', { email: 'nobody@example.com' }).expect(202);
    const disabled = await browser(app).send('post', '/api/auth/forgot', { email: 'gone@example.com' }).expect(202);
    expect(known.body).toEqual(unknown.body);
    expect(disabled.body).toEqual(unknown.body);
    expect(mailer.sent.map((message) => message.to)).toEqual(['owner@example.com']);

    // The emailed link works once; the owner chose the password, so no notice.
    await browser(app).send('post', '/api/auth/reset', { token: tokenOf(linkIn(mailer.sent[0])), password: 'remembered it now' }).expect(204);
    const again = browser(app);
    expect(again.capture(await again.send('post', '/api/auth/login', { email: 'owner@example.com', password: 'remembered it now' }).expect(200)).body.securityNotice).toBeNull();

    for (let i = 0; i < 4; i += 1) await browser(app).send('post', '/api/auth/forgot', { email: 'owner@example.com' }).expect(202);
    expect(mailer.sent).toHaveLength(3); // 1 + 2 more within the hourly limit of 3 per address and requester

    // A later request does not cancel an earlier link (nobody can lock the owner out by re-requesting)…
    await browser(app).send('post', '/api/auth/reset', { token: tokenOf(linkIn(mailer.sent[1])), password: 'second link still works' }).expect(204);
    // …but using one ends the others.
    await browser(app).send('post', '/api/auth/reset', { token: tokenOf(linkIn(mailer.sent[2])), password: 'third link is now dead' }).expect(410);
  });

  it('sends nothing and says so when email is not configured', async () => {
    const { app } = setup();
    expect((await browser(app).send('post', '/api/auth/forgot', { email: 'x@example.com' }).expect(202)).body).toEqual({ ok: true, email: false });
    expect((await request(app).get('/api/health').expect(200)).body.email).toBe(false);
  });
});

describe('emailed invitations', () => {
  it('omits the link when the provider accepted the email, and a new link replaces the old one', async () => {
    const mailer = new FakeMailer();
    const { app } = setup({ mailer });
    const owner = browser(app);
    owner.capture(await owner.send('post', '/api/auth/register', { email: 'owner@example.com', name: 'Owner', password: PASSWORD }).expect(201));
    const event = (await owner.send('post', '/api/events', EVENT_INPUT).expect(201)).body;

    const created = (await owner.send('post', `/api/events/${event.id}/invitations`, { email: 'manager@example.com' }).expect(201)).body;
    expect(created).toMatchObject({ email: { status: 'sent' } });
    expect(created).not.toHaveProperty('url');
    // The organiser-chosen event name stays out of the subject line.
    expect(mailer.sent[0]).toMatchObject({ to: 'manager@example.com', subject: "You're invited to help run an event on GatePass", text: expect.stringContaining('Launch Night') });
    const firstLink = linkIn(mailer.sent[0]);

    const renewed = (await owner.send('post', `/api/invitations/${created.invitation.id}/resend`).expect(200)).body;
    expect(renewed.email.status).toBe('sent');
    await browser(app).send('post', '/api/invitations/preview', { token: tokenOf(firstLink) }).expect(410);
    await browser(app).send('post', '/api/invitations/accept', { token: tokenOf(linkIn(mailer.sent[1])), name: 'Manager', password: PASSWORD }).expect(200);
    await owner.send('post', `/api/invitations/${created.invitation.id}/resend`).expect(409); // already accepted
  });

  it('falls back to a link to share by hand when the provider refuses the message', async () => {
    const mailer = new FakeMailer();
    mailer.fail = true;
    const { app } = setup({ mailer });
    const owner = browser(app);
    owner.capture(await owner.send('post', '/api/auth/register', { email: 'owner@example.com', name: 'Owner', password: PASSWORD }).expect(201));
    const event = (await owner.send('post', '/api/events', EVENT_INPUT).expect(201)).body;
    const created = (await owner.send('post', `/api/events/${event.id}/invitations`, { email: 'manager@example.com' }).expect(201)).body;
    expect(created).toMatchObject({ email: { status: 'failed' }, url: expect.stringMatching(/#\/invite\//) });
  });

  it('re-inviting an address renews its pending invitation instead of adding one, and caps emails per recipient', async () => {
    const mailer = new FakeMailer();
    const { app } = setup({ mailer });
    const owner = browser(app);
    owner.capture(await owner.send('post', '/api/auth/register', { email: 'owner@example.com', name: 'Owner', password: PASSWORD }).expect(201));
    const event = (await owner.send('post', '/api/events', EVENT_INPUT).expect(201)).body;
    const invite = () => owner.send('post', `/api/events/${event.id}/invitations`, { email: 'Target@example.com' });

    const first = (await invite().expect(201)).body;
    for (let i = 0; i < 4; i += 1) expect((await invite().expect(201)).body.invitation.id).toBe(first.invitation.id);
    expect((await owner.send('get', `/api/events/${event.id}/invitations`).expect(200)).body).toHaveLength(1);
    // Only the newest of the five links works.
    await browser(app).send('post', '/api/invitations/preview', { token: tokenOf(linkIn(mailer.sent[0])) }).expect(410);
    await browser(app).send('post', '/api/invitations/preview', { token: tokenOf(linkIn(mailer.sent[4])) }).expect(200);

    await invite().expect(429); // sixth email to one address within the hour
    await owner.send('post', `/api/invitations/${first.invitation.id}/resend`).expect(429);
    expect(mailer.sent).toHaveLength(5);
  });

  it('only lets people who manage the invitation renew it', async () => {
    const { app } = setup();
    const owner = browser(app);
    owner.capture(await owner.send('post', '/api/auth/register', { email: 'owner@example.com', name: 'Owner', password: PASSWORD }).expect(201));
    const stranger = browser(app);
    stranger.capture(await stranger.send('post', '/api/auth/register', { email: 'stranger@example.com', name: 'Stranger', password: PASSWORD }).expect(201));
    const event = (await owner.send('post', '/api/events', EVENT_INPUT).expect(201)).body;
    const created = (await owner.send('post', `/api/events/${event.id}/invitations`, { email: 'manager@example.com' }).expect(201)).body;
    await stranger.send('post', `/api/invitations/${created.invitation.id}/resend`).expect(404);
  });
});

describe('closed sign-up (security review R6)', () => {
  it('accounts created from a manager invitation cannot create or clone events until a platform admin allows it', async () => {
    const { app, operator } = setup({ allowSignup: false });
    const organizerInvite = (await operator('post', '/api/platform/invitations').send({ email: 'owner@example.com', role: 'organizer' }).expect(201)).body;
    const owner = browser(app);
    owner.capture(await owner.send('post', '/api/invitations/accept', { token: tokenOf(organizerInvite.url), name: 'Owner', password: PASSWORD }).expect(200));
    const event = (await owner.send('post', '/api/events', EVENT_INPUT).expect(201)).body;

    const managerInvite = (await owner.send('post', `/api/events/${event.id}/invitations`, { email: 'manager@example.com' }).expect(201)).body;
    const manager = browser(app);
    const accepted = manager.capture(await manager.send('post', '/api/invitations/accept', { token: tokenOf(managerInvite.url), name: 'Manager', password: PASSWORD }).expect(200)).body;
    expect(accepted.user.canCreateEvents).toBe(false);
    await manager.send('get', `/api/events/${event.id}`).expect(200); // works on the invited event
    await manager.send('post', `/api/events/${event.id}/passes`, { count: 1 }).expect(201);
    await manager.send('post', '/api/events', EVENT_INPUT).expect(403);
    await manager.send('post', `/api/events/${event.id}/clone`, { name: 'Copy', startsAt: EVENT_INPUT.startsAt, endsAt: EVENT_INPUT.endsAt }).expect(403);

    await operator('post', `/api/platform/users/${accepted.user.id}/event-creation`).send({ allowed: true }).expect(200);
    await manager.send('post', '/api/events', EVENT_INPUT).expect(201);
    const audit = h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'user.event_creation_granted'").get();
    expect(audit).toEqual({ n: 1 });
  });

  it('keeps the old behaviour while sign-up is open', async () => {
    const { app } = setup({ allowSignup: true });
    const owner = browser(app);
    owner.capture(await owner.send('post', '/api/auth/register', { email: 'owner@example.com', name: 'Owner', password: PASSWORD }).expect(201));
    const event = (await owner.send('post', '/api/events', EVENT_INPUT).expect(201)).body;
    const invite = (await owner.send('post', `/api/events/${event.id}/invitations`, { email: 'manager@example.com' }).expect(201)).body;
    const manager = browser(app);
    expect(manager.capture(await manager.send('post', '/api/invitations/accept', { token: tokenOf(invite.url), name: 'Manager', password: PASSWORD }).expect(200)).body.user.canCreateEvents).toBe(true);
  });
});

describe('Resend adapter', () => {
  it('sends one message with an idempotency key and reports the provider id', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 're_123' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const mailer = resendMailer({ apiKey: 're_test_key', from: 'GatePass <no-reply@example.com>', fetch: fetchMock as unknown as typeof fetch });
    const report = await mailer.send({ to: 'a@example.com', subject: 'S', text: 'T', html: '<p>T</p>', idempotencyKey: 'k-1' });
    expect(report).toEqual({ status: 'sent', providerId: 're_123' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer re_test_key', 'Idempotency-Key': 'k-1' });
    expect(JSON.parse(init.body as string)).toMatchObject({ from: 'GatePass <no-reply@example.com>', to: ['a@example.com'] });
  });

  it('reports refusals and timeouts as failures without logging the recipient or key', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refusing = resendMailer({
      apiKey: 're_secret_value',
      from: 'x@example.com',
      fetch: (async () => new Response(JSON.stringify({ name: 'validation_error', message: 'bad' }), { status: 422 })) as unknown as typeof fetch
    });
    expect(await refusing.send({ to: 'private@example.com', subject: 'S', text: 'T', html: 'T' })).toMatchObject({ status: 'failed' });
    const hanging = resendMailer({
      apiKey: 're_secret_value',
      from: 'x@example.com',
      timeoutMs: 20,
      // Real (20 ms) timer on purpose: this checks the adapter's own AbortSignal.timeout deadline.
      fetch: ((_url: string, init: RequestInit) => {
        const { promise, reject } = Promise.withResolvers<Response>();
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        return promise;
      }) as unknown as typeof fetch
    });
    expect(await hanging.send({ to: 'private@example.com', subject: 'S', text: 'T', html: 'T' })).toEqual({ status: 'failed', error: 'The email provider did not answer in time.' });
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).not.toContain('private@example.com');
    expect(logged).not.toContain('re_secret_value');
  });
});

describe('configuration', () => {
  const base = { ADMIN_TOKEN: 'x'.repeat(32) };
  it('needs a sender address with a Resend key, and never fails start-up over the commit value', () => {
    expect(() => loadConfig({ ...base, RESEND_API_KEY: 're_0123456789' })).toThrow(/MAIL_FROM/);
    expect(loadConfig({ ...base, RESEND_API_KEY: 're_0123456789', MAIL_FROM: 'GatePass <no-reply@example.com>' }).MAIL_FROM).toBeDefined();
    expect(buildCommit(loadConfig({ ...base, RENDER_GIT_COMMIT: '4A6BA5CB88FF2434F0A9045551FEF15382F8EFEB' }))).toBe('4a6ba5cb88ff2434f0a9045551fef15382f8efeb');
    expect(buildCommit(loadConfig({ ...base, GATEPASS_COMMIT: 'dev build' }))).toBeNull();
  });
});
