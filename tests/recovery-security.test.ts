import type { Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app';
import { RESET_TTL_MS } from '../src/server/accounts';
import type { MailMessage, Mailer } from '../src/server/mailer';
import type { EmailReport } from '../src/shared/types';
import { ADMIN_TOKEN, createHarness, EVENT_INPUT, PUBLIC_URL, type Harness } from './helpers';

// Phase 2 audit of account recovery (ADR 0010): enumeration resistance,
// expiry and replay of reset links, request limits, disabled accounts, the
// administrator emergency path, session and link invalidation, and event
// isolation after recovery.

const PASSWORD = 'correct horse battery';

class FakeMailer implements Mailer {
  readonly enabled = true;
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<EmailReport> {
    this.sent.push(message);
    return { status: 'sent', providerId: `msg_${this.sent.length}` };
  }
}

let h: Harness;
afterEach(() => {
  vi.restoreAllMocks();
  h?.close();
});

function setup(options: { mailer?: Mailer; allowSignup?: boolean; trustProxy?: boolean } = {}) {
  h = createHarness({ mailer: options.mailer });
  const app = createApp({ service: h.service, adminToken: ADMIN_TOKEN, publicUrl: PUBLIC_URL, allowSignup: options.allowSignup ?? true, trustProxy: options.trustProxy ?? false });
  const operator = (method: 'get' | 'post', path: string) => request(app)[method](path).set('Authorization', `Bearer ${ADMIN_TOKEN}`);
  return { app, operator };
}

/** Cookie session by hand (the harness URL is https, so the cookie is `__Host-` and Secure). */
function browser(app: Express) {
  let cookie = '';
  const send = (method: 'get' | 'post' | 'delete', path: string, body?: object) => {
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
const resetTokenIn = (message: MailMessage) => /https:\/\/gate\.example\/#\/reset\/([A-Za-z0-9_-]{43})/.exec(message.text)![1];

async function register(app: Express, email: string, password = PASSWORD) {
  const person = browser(app);
  const id = person.capture(await person.send('post', '/api/auth/register', { email, name: email.split('@')[0], password }).expect(201)).body.user.id as string;
  return { ...person, id };
}

async function signIn(app: Express, email: string, password: string) {
  const person = browser(app);
  person.capture(await person.send('post', '/api/auth/login', { email, password }).expect(200));
  return person;
}

/** Status, body and the headers that could differ between a real and an unknown address. */
const shape = (response: request.Response) => ({ status: response.status, body: response.body, type: response.headers['content-type'], cookie: response.headers['set-cookie'] ?? null });

describe('self-service reset requests', () => {
  it('answers identically for active, unknown, disabled, malformed and throttled addresses', async () => {
    const mailer = new FakeMailer();
    const { app, operator } = setup({ mailer });
    await register(app, 'owner@example.com');
    const gone = await register(app, 'gone@example.com');
    await operator('post', `/api/platform/users/${gone.id}/disable`).expect(200);

    const forgot = (email: string) => browser(app).send('post', '/api/auth/forgot', { email });
    const reference = shape(await forgot('nobody@example.com'));
    expect(reference).toEqual({ status: 202, body: { ok: true, email: true }, type: 'application/json; charset=utf-8', cookie: null });
    for (const email of ['owner@example.com', 'OWNER@EXAMPLE.COM', 'gone@example.com', 'not an address', 'owner@example.com', 'owner@example.com', 'owner@example.com']) {
      expect(shape(await forgot(email))).toEqual(reference);
    }
    await h.service.accounts.idle();
    // Only the active account is emailed, and only up to 3 times per address and requester.
    expect(mailer.sent.map((message) => message.to)).toEqual(['owner@example.com', 'owner@example.com', 'owner@example.com']);
    // Empty input is a validation error for every caller alike.
    await forgot('').expect(400);
  });

  it('answers the same without email, and creates no link', async () => {
    const { app } = setup();
    await register(app, 'owner@example.com');
    const known = shape(await browser(app).send('post', '/api/auth/forgot', { email: 'owner@example.com' }));
    expect(known).toEqual(shape(await browser(app).send('post', '/api/auth/forgot', { email: 'nobody@example.com' })));
    expect(known.body).toEqual({ ok: true, email: false });
    await h.service.accounts.idle();
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM password_resets').get()).toEqual({ n: 0 });
  });

  it('caps reset emails per address at 10 an hour however many requesters ask', async () => {
    const mailer = new FakeMailer();
    const { app } = setup({ mailer, trustProxy: true });
    await register(app, 'owner@example.com');
    const forgotFrom = (ip: string) => browser(app).send('post', '/api/auth/forgot', { email: 'owner@example.com' }).set('X-Forwarded-For', ip).expect(202);
    for (let i = 0; i < 4; i += 1) await forgotFrom('198.51.100.1');
    for (let ip = 2; ip <= 12; ip += 1) await forgotFrom(`198.51.100.${ip}`);
    await h.service.accounts.idle();
    expect(mailer.sent).toHaveLength(10);
    // An unrelated address is not affected by someone else's ceiling.
    await register(app, 'other@example.com');
    await browser(app).send('post', '/api/auth/forgot', { email: 'other@example.com' }).set('X-Forwarded-For', '198.51.100.13').expect(202);
    await h.service.accounts.idle();
    expect(mailer.sent.at(-1)!.to).toBe('other@example.com');
  });
});

describe('reset links', () => {
  it('work until the last millisecond before expiry, never at or after it, and only once', async () => {
    const { app, operator } = setup();
    const owner = await register(app, 'owner@example.com');
    const reason = { reason: 'Lost the password; verified by call-back' };

    const expiring = (await operator('post', `/api/platform/users/${owner.id}/reset-link`).send(reason).expect(200)).body;
    expect(Date.parse(expiring.expiresAt) - h.clock.current.getTime()).toBe(RESET_TTL_MS);
    h.clock.current = new Date(expiring.expiresAt);
    await browser(app).send('post', '/api/auth/reset', { token: tokenOf(expiring.url), password: 'too late for this' }).expect(410);

    const fresh = (await operator('post', `/api/platform/users/${owner.id}/reset-link`).send(reason).expect(200)).body;
    h.clock.current = new Date(Date.parse(fresh.expiresAt) - 1);
    await browser(app).send('post', '/api/auth/reset', { token: tokenOf(fresh.url), password: 'just in time now' }).expect(204);
    const replay = await browser(app).send('post', '/api/auth/reset', { token: tokenOf(fresh.url), password: 'second use of it' }).expect(410);
    const unknown = await browser(app).send('post', '/api/auth/reset', { token: 'x'.repeat(43), password: 'second use of it' }).expect(410);
    expect(replay.body).toEqual(unknown.body);
    await signIn(app, 'owner@example.com', 'just in time now');
  });

  it('two simultaneous uses of one link: exactly one sets the password', async () => {
    const { app, operator } = setup();
    const owner = await register(app, 'owner@example.com');
    const { url } = (await operator('post', `/api/platform/users/${owner.id}/reset-link`).send({ reason: 'Lost the password; verified by call-back' }).expect(200)).body;
    const candidates = ['first racer password', 'second racer password'];
    const statuses = (await Promise.all(candidates.map((password) => browser(app).send('post', '/api/auth/reset', { token: tokenOf(url), password })))).map((response) => response.status);
    expect(statuses.sort()).toEqual([204, 410]);
    const logins = await Promise.all(candidates.map((password) => browser(app).send('post', '/api/auth/login', { email: 'owner@example.com', password })));
    expect(logins.map((response) => response.status).sort()).toEqual([200, 401]);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'user.password_reset_used'").get()).toEqual({ n: 1 });
  });

  it('using one link ends every session and every other open link; a password change cancels open links too', async () => {
    const mailer = new FakeMailer();
    const { app } = setup({ mailer });
    const first = await register(app, 'owner@example.com');
    const second = await signIn(app, 'owner@example.com', PASSWORD);
    for (let i = 0; i < 2; i += 1) await browser(app).send('post', '/api/auth/forgot', { email: 'owner@example.com' }).expect(202);
    await h.service.accounts.idle();
    const [linkA, linkB] = mailer.sent.map(resetTokenIn);

    await browser(app).send('post', '/api/auth/reset', { token: linkA, password: 'brand new secret' }).expect(204);
    await first.send('get', '/api/auth/session').expect(401);
    await second.send('get', '/api/auth/session').expect(401);
    await browser(app).send('post', '/api/auth/reset', { token: linkB, password: 'another new one' }).expect(410);

    await browser(app).send('post', '/api/auth/forgot', { email: 'owner@example.com' }).expect(202);
    await h.service.accounts.idle();
    const pending = resetTokenIn(mailer.sent.at(-1)!);
    const signedIn = await signIn(app, 'owner@example.com', 'brand new secret');
    signedIn.capture(await signedIn.send('post', '/api/auth/password', { currentPassword: 'brand new secret', newPassword: 'changed by owner' }).expect(200));
    await browser(app).send('post', '/api/auth/reset', { token: pending, password: 'undo the change' }).expect(410);
    await signIn(app, 'owner@example.com', 'changed by owner');
  });
});

describe('disabled accounts', () => {
  it('can neither reset nor sign in, whichever link they hold, and the refusal looks like any other', async () => {
    const mailer = new FakeMailer();
    const { app, operator } = setup({ mailer });
    const person = await register(app, 'person@example.com');
    await browser(app).send('post', '/api/auth/forgot', { email: 'person@example.com' }).expect(202);
    await h.service.accounts.idle();
    const selfLink = resetTokenIn(mailer.sent[0]);
    const adminLink = tokenOf((await operator('post', `/api/platform/users/${person.id}/reset-link`).send({ delivery: 'link', reason: 'Prepared before the account was disabled' }).expect(200)).body.url);

    await operator('post', `/api/platform/users/${person.id}/disable`).expect(200);
    await person.send('get', '/api/auth/session').expect(401);
    for (const token of [selfLink, adminLink]) await browser(app).send('post', '/api/auth/reset', { token, password: 'take it back now' }).expect(410);

    // A link made while the account is disabled cannot be used either, and self-service sends nothing.
    const later = tokenOf((await operator('post', `/api/platform/users/${person.id}/reset-link`).send({ delivery: 'link', reason: 'Made while the account is disabled' }).expect(200)).body.url);
    await browser(app).send('post', '/api/auth/reset', { token: later, password: 'take it back now' }).expect(410);
    await browser(app).send('post', '/api/auth/forgot', { email: 'person@example.com' }).expect(202);
    await h.service.accounts.idle();
    expect(mailer.sent).toHaveLength(1);

    const disabled = await browser(app).send('post', '/api/auth/login', { email: 'person@example.com', password: PASSWORD }).expect(401);
    const wrong = await browser(app).send('post', '/api/auth/login', { email: 'nobody@example.com', password: PASSWORD }).expect(401);
    expect(disabled.body).toEqual(wrong.body);
  });
});

describe('administrator emergency reset', () => {
  it('needs a reason, cancels earlier links, ends every session, notifies the owner’s mailbox and leaves a notice', async () => {
    const mailer = new FakeMailer();
    const { app, operator } = setup({ mailer });
    const owner = await register(app, 'owner@example.com');
    const otherDevice = await signIn(app, 'owner@example.com', PASSWORD);
    await browser(app).send('post', '/api/auth/forgot', { email: 'owner@example.com' }).expect(202);
    await h.service.accounts.idle();
    const ownLink = resetTokenIn(mailer.sent[0]);

    await operator('post', `/api/platform/users/${owner.id}/reset-link`).send({ delivery: 'link', reason: 'short' }).expect(400);
    const { url } = (await operator('post', `/api/platform/users/${owner.id}/reset-link`).send({ delivery: 'link', reason: 'Owner lost the mailbox; checked ID in person' }).expect(200)).body;
    expect(mailer.sent).toHaveLength(1); // the operator holds the link; nothing new was emailed
    await browser(app).send('post', '/api/auth/reset', { token: ownLink, password: 'owner tries too' }).expect(410); // superseded

    await browser(app).send('post', '/api/auth/reset', { token: tokenOf(url), password: 'set by the operator' }).expect(204);
    await h.service.accounts.idle();
    await owner.send('get', '/api/auth/session').expect(401);
    await otherDevice.send('get', '/api/auth/session').expect(401);
    expect(mailer.sent.map((message) => message.subject)).toEqual(['Reset your GatePass password', 'Your GatePass password was changed']);
    expect(mailer.sent[1].to).toBe('owner@example.com');
    expect(`${mailer.sent[1].text}${mailer.sent[1].html}`).not.toContain(tokenOf(url));

    const after = browser(app);
    expect(after.capture(await after.send('post', '/api/auth/login', { email: 'owner@example.com', password: 'set by the operator' }).expect(200)).body.securityNotice).toMatchObject({ by: 'operator' });
    const audit = h.db.prepare("SELECT actor, action, details_json FROM audit_log WHERE action LIKE 'user.password_reset_%' ORDER BY id").all() as Array<{ actor: string; action: string; details_json: string }>;
    expect(audit.map((row) => [row.actor, row.action])).toEqual([
      [`user:${owner.id}`, 'user.password_reset_created'],
      ['operator', 'user.password_reset_created'],
      [`user:${owner.id}`, 'user.password_reset_used']
    ]);
    expect(JSON.parse(audit[1].details_json)).toMatchObject({ reason: 'Owner lost the mailbox; checked ID in person', delivery: 'link' });
    expect(JSON.parse(audit[2].details_json)).toEqual({ requestedBy: 'operator' });
    // The audit never stores a token or a link.
    expect(audit.map((row) => row.details_json).join('')).not.toMatch(/[A-Za-z0-9_-]{43}|#\/reset\//);
  });

  it('one platform administrator cannot take over another, nor take a link when email is configured', async () => {
    const mailer = new FakeMailer();
    const { app, operator } = setup({ mailer });
    const accept = async (email: string) => {
      await operator('post', '/api/platform/invitations').send({ email, role: 'platform_admin' }).expect(201);
      const token = /#\/invite\/([A-Za-z0-9_-]{43})/.exec(mailer.sent.at(-1)!.text)![1];
      const person = browser(app);
      const id = person.capture(await person.send('post', '/api/invitations/accept', { token, name: 'Admin', password: PASSWORD }).expect(200)).body.user.id as string;
      return { ...person, id };
    };
    const root = await accept('root@example.com');
    const peer = await accept('peer@example.com');
    const organizer = await register(app, 'organizer@example.com');

    await root.send('post', `/api/platform/users/${peer.id}/reset-link`, { reason: 'I would like to sign in as them' }).expect(403);
    await root.send('post', `/api/platform/users/${organizer.id}/reset-link`, { delivery: 'link', reason: 'I would like to see the link' }).expect(403);
    const emailed = (await root.send('post', `/api/platform/users/${organizer.id}/reset-link`, {}).expect(200)).body;
    expect(emailed).toMatchObject({ delivery: 'email', email: { status: 'sent' } });
    expect(JSON.stringify(emailed)).not.toMatch(/#\/reset\//);
    expect(mailer.sent.at(-1)!.to).toBe('organizer@example.com');
    // An organizer is not a platform administrator.
    await organizer.send('post', `/api/platform/users/${peer.id}/reset-link`, { reason: 'Not my business at all' }).expect(403);
  });
});

describe('after recovery', () => {
  it('a recovered account reaches only the events it belongs to, with only its role’s permissions', async () => {
    const mailer = new FakeMailer();
    const { app } = setup({ mailer });
    const owner = await register(app, 'owner@example.com');
    const secret = (await owner.send('post', '/api/events', EVENT_INPUT).expect(201)).body;
    const scanner = (await owner.send('post', `/api/events/${secret.id}/scanners`, { label: 'Door' }).expect(201)).body;
    const shared = (await owner.send('post', '/api/events', { ...EVENT_INPUT, name: 'Shared' }).expect(201)).body;
    const member = await register(app, 'member@example.com');
    const invite = (await owner.send('post', `/api/events/${shared.id}/invitations`, { email: 'member@example.com' }).expect(201)).body;
    expect(invite).not.toHaveProperty('url');
    const inviteToken = /#\/invite\/([A-Za-z0-9_-]{43})/.exec(mailer.sent.at(-1)!.text)![1];
    await member.send('post', '/api/invitations/accept', { token: inviteToken }).expect(200);

    await browser(app).send('post', '/api/auth/forgot', { email: 'member@example.com' }).expect(202);
    await h.service.accounts.idle();
    await browser(app).send('post', '/api/auth/reset', { token: resetTokenIn(mailer.sent.at(-1)!), password: 'recovered secret' }).expect(204);
    const recovered = await signIn(app, 'member@example.com', 'recovered secret');

    expect((await recovered.send('get', '/api/events').expect(200)).body.map((event: { id: string }) => event.id)).toEqual([shared.id]);
    // Not a member: 404, the same as an event that does not exist.
    await recovered.send('get', `/api/events/${secret.id}`).expect(404);
    await recovered.send('get', `/api/events/${secret.id}/passes`).expect(404);
    await recovered.send('post', `/api/scanners/${scanner.scanner.id}/rotate`).expect(404);
    await recovered.send('post', `/api/events/${secret.id}/invitations`, { email: 'friend@example.com' }).expect(404);
    // Member without the permission: 403.
    await recovered.send('get', `/api/events/${shared.id}/exports/attendance.csv`).expect(403);
    await recovered.send('delete', `/api/events/${shared.id}/members/${owner.id}`).expect(403);
    await recovered.send('get', `/api/events/${shared.id}/passes`).expect(200);
  });

  it('closed sign-up: an account from a manager invitation still cannot create events after an administrator reset', async () => {
    const { app, operator } = setup({ allowSignup: false });
    const ownerInvite = (await operator('post', '/api/platform/invitations').send({ email: 'owner@example.com', role: 'organizer' }).expect(201)).body;
    const owner = browser(app);
    owner.capture(await owner.send('post', '/api/invitations/accept', { token: tokenOf(ownerInvite.url), name: 'Owner', password: PASSWORD }).expect(200));
    const event = (await owner.send('post', '/api/events', EVENT_INPUT).expect(201)).body;
    const managerInvite = (await owner.send('post', `/api/events/${event.id}/invitations`, { email: 'manager@example.com' }).expect(201)).body;
    const manager = browser(app);
    const accepted = manager.capture(await manager.send('post', '/api/invitations/accept', { token: tokenOf(managerInvite.url), name: 'Manager', password: PASSWORD }).expect(200)).body;
    expect(accepted.user.canCreateEvents).toBe(false);

    const { url } = (await operator('post', `/api/platform/users/${accepted.user.id}/reset-link`).send({ reason: 'Forgot the password at the door' }).expect(200)).body;
    await browser(app).send('post', '/api/auth/reset', { token: tokenOf(url), password: 'recovered secret' }).expect(204);
    await operator('post', `/api/platform/users/${accepted.user.id}/disable`).expect(200);
    await operator('post', `/api/platform/users/${accepted.user.id}/enable`).expect(200);
    const recovered = await signIn(app, 'manager@example.com', 'recovered secret');
    expect((await recovered.send('get', '/api/auth/session').expect(200)).body.user.canCreateEvents).toBe(false);
    await recovered.send('post', '/api/events', EVENT_INPUT).expect(403);
    await recovered.send('post', `/api/events/${event.id}/clone`, { name: 'Copy', startsAt: EVENT_INPUT.startsAt, endsAt: EVENT_INPUT.endsAt }).expect(403);
    await recovered.send('post', '/api/auth/register', { email: 'manager2@example.com', name: 'Again', password: PASSWORD }).expect(403);
  });
});
