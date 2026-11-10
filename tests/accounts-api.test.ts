import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { ROLE_PERMISSIONS } from '../src/server/permissions';
import { ADMIN_TOKEN, createHarness, EVENT_INPUT, scan, type Harness } from './helpers';

let h: Harness;
beforeEach(() => {
  h = createHarness();
});
afterEach(() => h.close());

const PASSWORD = 'correct horse battery';

/** Cookie session driven by hand: the harness public URL is https, so the cookie is `Secure` and supertest's jar would not send it over plain HTTP. */
class Browser {
  cookie = '';
  constructor(private readonly harness: Harness) {}

  send(method: 'get' | 'post' | 'patch' | 'delete', path: string, body?: object, csrf = true) {
    const req = request(this.harness.app)[method](path);
    if (this.cookie) req.set('Cookie', this.cookie);
    if (csrf && method !== 'get') req.set('X-GatePass-CSRF', '1');
    return body === undefined ? req : req.send(body);
  }

  async capture(response: request.Response) {
    const header = response.headers['set-cookie'] as unknown as string[] | undefined;
    const value = header?.[0]?.split(';')[0];
    if (value) this.cookie = value.endsWith('=') ? '' : value;
    return response;
  }

  async signUp(email: string, name = email.split('@')[0]) {
    return this.capture(await this.send('post', '/api/auth/register', { email, name, password: PASSWORD }).expect(201));
  }

  async signIn(email: string, password = PASSWORD) {
    return this.capture(await this.send('post', '/api/auth/login', { email, password }));
  }

  async createEvent(name = 'Owned') {
    return (await this.send('post', '/api/events', { ...EVENT_INPUT, name }).expect(201)).body;
  }
}

async function organizer(email: string) {
  const browser = new Browser(h);
  await browser.signUp(email);
  return browser;
}

/** Owner creates an event and invites `managerEmail`; the manager accepts and returns signed in. */
async function ownerAndManager() {
  const owner = await organizer('owner@example.com');
  const event = await owner.createEvent();
  const invite = (await owner.send('post', `/api/events/${event.id}/invitations`, { email: 'manager@example.com' }).expect(201)).body;
  const token = invite.url.split('/').at(-1);
  const manager = new Browser(h);
  await manager.capture(await manager.send('post', '/api/invitations/accept', { token, name: 'Manager', password: PASSWORD }).expect(200));
  return { owner, manager, event };
}

describe('sessions', () => {
  it('signs up with an HttpOnly, Secure, SameSite=Strict host-only cookie and never returns a credential in the body', async () => {
    const browser = new Browser(h);
    const response = await browser.signUp('ada@example.com', 'Ada');
    const cookie = (response.headers['set-cookie'] as unknown as string[])[0];
    expect(cookie).toMatch(/^__Host-gatepass_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
    expect(response.body.user).toMatchObject({ email: 'ada@example.com', name: 'Ada', platformRole: 'organizer' });
    expect(JSON.stringify(response.body)).not.toContain(browser.cookie.split('=')[1]);
    expect(response.body.user).not.toHaveProperty('passwordHash');
    await browser.send('get', '/api/auth/session').expect(200);
  });

  it('stores only hashes of passwords and session ids', async () => {
    const browser = await organizer('hash@example.com');
    const row = h.db.prepare('SELECT password_hash FROM users').get() as { password_hash: string };
    expect(row.password_hash).toMatch(/^scrypt\$32768\$8\$3\$/);
    expect(row.password_hash).not.toContain(PASSWORD);
    const sessions = h.db.prepare('SELECT id_hash FROM sessions').all() as Array<{ id_hash: string }>;
    expect(sessions.map((s) => s.id_hash)).not.toContain(browser.cookie.split('=')[1]);
  });

  it('gives the same answer for an unknown email and a wrong password, and audits failures', async () => {
    await organizer('known@example.com');
    const unknown = await new Browser(h).signIn('nobody@example.com');
    const wrong = await new Browser(h).signIn('known@example.com', 'not the password');
    expect([unknown.status, wrong.status]).toEqual([401, 401]);
    expect(unknown.body).toEqual(wrong.body);
    const failures = h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'user.login_failed'").get() as { n: number };
    expect(failures.n).toBe(2);
  });

  it('throttles repeated failures for one account even across addresses, without locking out other accounts', async () => {
    await organizer('target@example.com');
    await organizer('other@example.com');
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await new Browser(h).signIn('target@example.com', `guess-${i}-xxxxxx`)).status);
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect((await new Browser(h).signIn('other@example.com')).status).toBe(200);
  }, 30_000);

  it('ends sessions on sign-out, after 24 h idle and after 7 days regardless of activity', async () => {
    const browser = await organizer('idle@example.com');
    const copy = browser.cookie;
    await browser.capture(await browser.send('post', '/api/auth/logout').expect(204));
    expect(browser.cookie).toBe('');
    await request(h.app).get('/api/auth/session').set('Cookie', copy).expect(401);

    await browser.signIn('idle@example.com');
    h.clock.advance(24 * 3_600_000);
    await browser.send('get', '/api/auth/session').expect(401);

    await browser.signIn('idle@example.com');
    for (let day = 0; day < 7; day += 1) {
      h.clock.advance(23 * 3_600_000);
      await browser.send('get', '/api/auth/session').expect(200);
    }
    h.clock.advance(23 * 3_600_000);
    await browser.send('get', '/api/auth/session').expect(401);
  }, 30_000);

  it('ends every other session when the password changes', async () => {
    const first = await organizer('change@example.com');
    const second = new Browser(h);
    await second.signIn('change@example.com');
    await first.capture(await first.send('post', '/api/auth/password', { currentPassword: PASSWORD, newPassword: 'a whole new passphrase' }).expect(200));
    await second.send('get', '/api/auth/session').expect(401);
    await first.send('get', '/api/auth/session').expect(200);
    expect((await new Browser(h).signIn('change@example.com')).status).toBe(401);
    expect((await new Browser(h).signIn('change@example.com', 'a whole new passphrase')).status).toBe(200);
  }, 30_000);

  it('rejects weak passwords and refuses sign-up when registration is closed', async () => {
    const weak = await new Browser(h).send('post', '/api/auth/register', { email: 'w@example.com', name: 'W', password: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.error).toMatch(/at least 10/);
    const common = await new Browser(h).send('post', '/api/auth/register', { email: 'c@example.com', name: 'C', password: 'password123' });
    expect(common.status).toBe(400);

    const closed = createApp({ service: h.service, adminToken: ADMIN_TOKEN, publicUrl: 'https://gate.example', allowSignup: false });
    await request(closed).get('/api/health').expect(200, { ok: true, service: 'gatepass', signup: false });
    await request(closed).post('/api/auth/register').set('X-GatePass-CSRF', '1').send({ email: 'x@example.com', name: 'X', password: PASSWORD }).expect(403);
  });
});

describe('CSRF', () => {
  it('refuses cookie-authenticated writes without the custom header or from a cross-site context', async () => {
    const browser = await organizer('csrf@example.com');
    await browser.send('post', '/api/events', EVENT_INPUT, false).expect(403);
    await browser.send('post', '/api/events', EVENT_INPUT).set('Sec-Fetch-Site', 'cross-site').expect(403);
    await new Browser(h).send('post', '/api/auth/login', { email: 'csrf@example.com', password: PASSWORD }, false).expect(403);
    await browser.send('post', '/api/events', EVENT_INPUT).expect(201);
    expect(h.service.listEvents()).toHaveLength(1);
  });

  it('does not require the header for bearer credentials, which browsers never attach on their own', async () => {
    await h.admin(request(h.app).post('/api/events')).send(EVENT_INPUT).expect(201);
  });
});

describe('tenant isolation', () => {
  it('shows each organizer only their own events and answers 404 for anyone else’s', async () => {
    const alice = await organizer('alice@example.com');
    const bob = await organizer('bob@example.com');
    const event = await alice.createEvent('Alice only');
    const [pass] = (await alice.send('post', `/api/events/${event.id}/passes`, { count: 1 }).expect(201)).body;
    const scanner = (await alice.send('post', `/api/events/${event.id}/scanners`, { label: 'Door' }).expect(201)).body;
    const gate = (await alice.send('post', `/api/events/${event.id}/gates`, { name: 'North' }).expect(201)).body;
    const policy = (await alice.send('post', `/api/events/${event.id}/policies`, { name: 'GA' }).expect(201)).body;

    expect((await bob.send('get', '/api/events').expect(200)).body).toEqual([]);
    const probes: Array<['get' | 'post' | 'patch' | 'delete', string, object?]> = [
      ['get', `/api/events/${event.id}`],
      ['patch', `/api/events/${event.id}`, { name: 'Taken' }],
      ['get', `/api/events/${event.id}/passes`],
      ['post', `/api/events/${event.id}/passes`, { count: 1 }],
      ['post', `/api/events/${event.id}/passes/import`, { rows: [{ name: 'X' }], dryRun: true }],
      ['post', `/api/events/${event.id}/passes/revoke`, { passIds: [pass.id] }],
      ['post', `/api/passes/${pass.id}/revoke`],
      ['post', `/api/passes/${pass.id}/reissue`],
      ['patch', `/api/passes/${pass.id}`, { policyId: null }],
      ['post', `/api/scanners/${scanner.scanner.id}/rotate`],
      ['post', `/api/scanners/${scanner.scanner.id}/revoke`],
      ['patch', `/api/gates/${gate.id}`, { name: 'Mine' }],
      ['delete', `/api/gates/${gate.id}`],
      ['patch', `/api/policies/${policy.id}`, { capacity: 1 }],
      ['delete', `/api/policies/${policy.id}`],
      ['get', `/api/events/${event.id}/audit`],
      ['get', `/api/events/${event.id}/members`],
      ['post', `/api/events/${event.id}/invitations`, { email: 'bob@example.com' }],
      ['get', `/api/events/${event.id}/exports/attendance.csv`],
      ['post', `/api/events/${event.id}/clone`, { name: 'Copy', startsAt: EVENT_INPUT.startsAt, endsAt: EVENT_INPUT.endsAt }]
    ];
    for (const [method, path, body] of probes) {
      const response = await bob.send(method, path, body);
      expect([method, path, response.status]).toEqual([method, path, 404]);
    }
    // Nothing changed.
    expect(h.service.getPass(pass.id).status).toBe('active');
    expect(h.service.getEvent(event.id).name).toBe('Alice only');
    await scan(h, scanner.key, pass.token).expect(200);
  }, 30_000);

  it('does not let a platform admin read organizers’ events through their role alone', async () => {
    const alice = await organizer('alice@example.com');
    const event = await alice.createEvent();
    const invite = (await h.admin(request(h.app).post('/api/platform/invitations')).send({ email: 'root@example.com', role: 'platform_admin' }).expect(201)).body;
    const admin = new Browser(h);
    await admin.capture(await admin.send('post', '/api/invitations/accept', { token: invite.url.split('/').at(-1), name: 'Root', password: PASSWORD }).expect(200));
    await admin.send('get', '/api/platform/users').expect(200);
    await admin.send('get', `/api/events/${event.id}`).expect(404);
    await admin.send('get', `/api/events/${event.id}/exports/attendance.csv`).expect(404);
  }, 30_000);
});

describe('event roles', () => {
  it('lets a manager run operations but not change lifecycle, team, ownership or export attendee data', async () => {
    const { owner, manager, event } = await ownerAndManager();
    const own = (await owner.send('get', `/api/events/${event.id}`).expect(200)).body;
    const managed = (await manager.send('get', `/api/events/${event.id}`).expect(200)).body;
    expect(own).toMatchObject({ myRole: 'owner', permissions: ROLE_PERMISSIONS.owner });
    expect(managed).toMatchObject({ myRole: 'manager', permissions: ROLE_PERMISSIONS.manager });

    // Allowed for managers.
    await manager.send('patch', `/api/events/${event.id}`, { venue: 'Hall B' }).expect(200);
    const gate = (await manager.send('post', `/api/events/${event.id}/gates`, { name: 'North' }).expect(201)).body;
    await manager.send('post', `/api/events/${event.id}/policies`, { name: 'GA', gateIds: [gate.id] }).expect(201);
    const [pass] = (await manager.send('post', `/api/events/${event.id}/passes`, { count: 1 }).expect(201)).body;
    await manager.send('post', `/api/events/${event.id}/scanners`, { label: 'Door' }).expect(201);
    await manager.send('post', `/api/passes/${pass.id}/reissue`).expect(200);
    await manager.send('get', `/api/events/${event.id}/audit`).expect(200);

    // Owner-only: 403 (the manager knows the event exists).
    const ownerId = (await owner.send('get', '/api/auth/session')).body.user.id;
    const managerId = (await manager.send('get', '/api/auth/session')).body.user.id;
    const forbidden: Array<['get' | 'post' | 'patch' | 'delete', string, object?]> = [
      ['patch', `/api/events/${event.id}`, { status: 'archived' }],
      ['patch', `/api/events/${event.id}`, { status: 'ended', venue: 'x' }],
      ['post', `/api/events/${event.id}/invitations`, { email: 'friend@example.com' }],
      ['get', `/api/events/${event.id}/invitations`],
      ['delete', `/api/events/${event.id}/members/${ownerId}`],
      ['post', `/api/events/${event.id}/owner`, { userId: managerId }],
      ['get', `/api/events/${event.id}/exports/attendance.csv`],
      ['get', `/api/events/${event.id}/exports/scans.csv`],
      ['get', `/api/events/${event.id}/exports/audit.csv`],
      ['get', '/api/platform/users'],
      ['post', '/api/platform/invitations', { email: 'x@example.com', role: 'platform_admin' }]
    ];
    for (const [method, path, body] of forbidden) {
      const response = await manager.send(method, path, body);
      expect([method, path, response.status]).toEqual([method, path, 403]);
    }
    expect(h.service.getEvent(event.id).status).toBe('active');
    expect(h.service.accounts.listMembers(event.id).map((m) => m.role).sort()).toEqual(['manager', 'owner']);

    // The owner can do all of it.
    await owner.send('get', `/api/events/${event.id}/exports/attendance.csv`).expect(200);
    await owner.send('post', `/api/events/${event.id}/owner`, { userId: managerId }).expect(200);
    expect((await manager.send('get', `/api/events/${event.id}`)).body.myRole).toBe('owner');
    expect((await owner.send('get', `/api/events/${event.id}`)).body.myRole).toBe('manager');
  }, 30_000);

  it('removing a manager ends their access immediately', async () => {
    const { owner, manager, event } = await ownerAndManager();
    const managerId = (await manager.send('get', '/api/auth/session')).body.user.id;
    await owner.send('delete', `/api/events/${event.id}/members/${managerId}`).expect(204);
    await manager.send('get', `/api/events/${event.id}`).expect(404);
    await manager.send('post', `/api/events/${event.id}/passes`, { count: 1 }).expect(404);
  }, 30_000);

  it('never accepts scanner keys or account sessions in place of each other', async () => {
    const browser = await organizer('door@example.com');
    const event = await browser.createEvent();
    const { key } = (await browser.send('post', `/api/events/${event.id}/scanners`, { label: 'Door' }).expect(201)).body;
    await request(h.app).get(`/api/events/${event.id}`).set('Authorization', `Bearer ${key}`).expect(401);
    await request(h.app).post('/api/scanner/redeem').set('Cookie', browser.cookie).set('X-GatePass-CSRF', '1').send({ code: 'x' }).expect(401);
  });
});

describe('one-time links', () => {
  it('accepts an invitation exactly once, even when two acceptances race', async () => {
    const owner = await organizer('owner@example.com');
    const event = await owner.createEvent();
    const invite = (await owner.send('post', `/api/events/${event.id}/invitations`, { email: 'twice@example.com' }).expect(201)).body;
    const token = invite.url.split('/').at(-1);
    const accept = () => new Browser(h).send('post', '/api/invitations/accept', { token, name: 'Twice', password: PASSWORD });
    const results = await Promise.all([accept(), accept()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'twice@example.com'").get()).toEqual({ n: 1 });
    await new Browser(h).send('post', '/api/invitations/preview', { token }).expect(410);
  }, 30_000);

  it('binds an invitation to its email: an existing account must be signed in as that email', async () => {
    const owner = await organizer('owner@example.com');
    const invited = await organizer('invited@example.com');
    const stranger = await organizer('stranger@example.com');
    const event = await owner.createEvent();
    const token = (await owner.send('post', `/api/events/${event.id}/invitations`, { email: 'invited@example.com' }).expect(201)).body.url.split('/').at(-1);
    expect((await new Browser(h).send('post', '/api/invitations/preview', { token }).expect(200)).body).toMatchObject({ role: 'manager', eventName: 'Owned', accountExists: true });
    await stranger.send('post', '/api/invitations/accept', { token }).expect(409);
    await new Browser(h).send('post', '/api/invitations/accept', { token, name: 'Hijack', password: PASSWORD }).expect(409);
    await invited.send('post', '/api/invitations/accept', { token }).expect(200);
    expect((await invited.send('get', `/api/events/${event.id}`).expect(200)).body.myRole).toBe('manager');
    await stranger.send('get', `/api/events/${event.id}`).expect(404);
  }, 30_000);

  it('refuses revoked and expired invitations', async () => {
    const owner = await organizer('owner@example.com');
    const event = await owner.createEvent();
    const revoked = (await owner.send('post', `/api/events/${event.id}/invitations`, { email: 'r@example.com' }).expect(201)).body;
    await owner.send('post', `/api/invitations/${revoked.invitation.id}/revoke`).expect(200);
    await new Browser(h).send('post', '/api/invitations/accept', { token: revoked.url.split('/').at(-1), name: 'R', password: PASSWORD }).expect(410);
    const expiring = (await owner.send('post', `/api/events/${event.id}/invitations`, { email: 'e@example.com' }).expect(201)).body;
    h.clock.advance(7 * 24 * 3_600_000);
    await new Browser(h).send('post', '/api/invitations/accept', { token: expiring.url.split('/').at(-1), name: 'E', password: PASSWORD }).expect(410);
  }, 30_000);

  it('uses a password reset link once, ends existing sessions, and only the newest link works', async () => {
    const user = await organizer('reset@example.com');
    const userId = (await user.send('get', '/api/auth/session')).body.user.id;
    const first = (await h.admin(request(h.app).post(`/api/platform/users/${userId}/reset-link`)).expect(200)).body.url.split('/').at(-1);
    const second = (await h.admin(request(h.app).post(`/api/platform/users/${userId}/reset-link`)).expect(200)).body.url.split('/').at(-1);
    await new Browser(h).send('post', '/api/auth/reset', { token: first, password: 'brand new passphrase' }).expect(410);
    await new Browser(h).send('post', '/api/auth/reset', { token: second, password: 'brand new passphrase' }).expect(204);
    await new Browser(h).send('post', '/api/auth/reset', { token: second, password: 'another passphrase!' }).expect(410);
    await user.send('get', '/api/auth/session').expect(401);
    expect((await new Browser(h).signIn('reset@example.com', 'brand new passphrase')).status).toBe(200);
    const actions = (h.db.prepare('SELECT action FROM audit_log WHERE event_id IS NULL ORDER BY id').all() as Array<{ action: string }>).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['user.password_reset_created', 'user.password_reset_used']));
  }, 30_000);

  it('a disabled account is signed out everywhere and cannot sign in', async () => {
    const user = await organizer('gone@example.com');
    const userId = (await user.send('get', '/api/auth/session')).body.user.id;
    await h.admin(request(h.app).post(`/api/platform/users/${userId}/disable`)).expect(200);
    await user.send('get', '/api/auth/session').expect(401);
    expect((await new Browser(h).signIn('gone@example.com')).status).toBe(401);
  }, 30_000);
});

describe('security review regressions', () => {
  it('keeps a locked account locked even for the correct password (guessing from many addresses gains nothing)', async () => {
    await organizer('target@example.com');
    for (let i = 0; i < 10; i += 1) expect((await new Browser(h).signIn('target@example.com', `wrong-guess-${i}-xx`)).status).toBe(401);
    expect((await new Browser(h).signIn('TARGET@example.com')).status).toBe(429);
  }, 30_000);

  it('lets only the operator reset a platform administrator, and a password change cancels open reset links', async () => {
    const invite = (await h.admin(request(h.app).post('/api/platform/invitations')).send({ email: 'root@example.com', role: 'platform_admin' }).expect(201)).body;
    const root = new Browser(h);
    await root.capture(await root.send('post', '/api/invitations/accept', { token: invite.url.split('/').at(-1), name: 'Root', password: PASSWORD }).expect(200));
    const second = (await h.admin(request(h.app).post('/api/platform/invitations')).send({ email: 'second@example.com', role: 'platform_admin' }).expect(201)).body;
    const other = new Browser(h);
    await other.capture(await other.send('post', '/api/invitations/accept', { token: second.url.split('/').at(-1), name: 'Second', password: PASSWORD }).expect(200));
    const secondId = (await other.send('get', '/api/auth/session')).body.user.id;
    await root.send('post', `/api/platform/users/${secondId}/reset-link`).expect(403);

    const user = await organizer('owner@example.com');
    const userId = (await user.send('get', '/api/auth/session')).body.user.id;
    const reset = (await root.send('post', `/api/platform/users/${userId}/reset-link`).expect(200)).body.url.split('/').at(-1);
    await user.capture(await user.send('post', '/api/auth/password', { currentPassword: PASSWORD, newPassword: 'owner chose a new one' }).expect(200));
    await new Browser(h).send('post', '/api/auth/reset', { token: reset, password: 'admin takeover attempt' }).expect(410);
  }, 30_000);

  it('revokes the scanner keys a removed manager issued, and a disabled admin’s pending invitations', async () => {
    const { owner, manager, event } = await ownerAndManager();
    const managerId = (await manager.send('get', '/api/auth/session')).body.user.id;
    const managerKey = (await manager.send('post', `/api/events/${event.id}/scanners`, { label: 'Manager phone' }).expect(201)).body.key;
    const ownerKey = (await owner.send('post', `/api/events/${event.id}/scanners`, { label: 'Owner phone' }).expect(201)).body.key;
    await owner.send('delete', `/api/events/${event.id}/members/${managerId}`).expect(204);
    await request(h.app).get('/api/scanner/session').set('Authorization', `Bearer ${managerKey}`).expect(401);
    await request(h.app).get('/api/scanner/session').set('Authorization', `Bearer ${ownerKey}`).expect(200);

    const invite = (await h.admin(request(h.app).post('/api/platform/invitations')).send({ email: 'rogue@example.com', role: 'platform_admin' }).expect(201)).body;
    const rogue = new Browser(h);
    await rogue.capture(await rogue.send('post', '/api/invitations/accept', { token: invite.url.split('/').at(-1), name: 'Rogue', password: PASSWORD }).expect(200));
    const planted = (await rogue.send('post', '/api/platform/invitations', { email: 'sleeper@example.com', role: 'platform_admin' }).expect(201)).body;
    const rogueId = (await rogue.send('get', '/api/auth/session')).body.user.id;
    await h.admin(request(h.app).post(`/api/platform/users/${rogueId}/disable`)).expect(200);
    await new Browser(h).send('post', '/api/invitations/accept', { token: planted.url.split('/').at(-1), name: 'Sleeper', password: PASSWORD }).expect(410);
  }, 30_000);
});
