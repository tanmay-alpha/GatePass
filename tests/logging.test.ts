import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app';
import type { MailMessage, Mailer } from '../src/server/mailer';
import type { EmailReport } from '../src/shared/types';
import { ADMIN_TOKEN, createHarness, EVENT_INPUT, PUBLIC_URL, setupCode, type Harness } from './helpers';

// Phase 2 audit of structured logging and error answers: the request log
// names route patterns only, so no credential, one-time code, address,
// password or pass path ever reaches stdout/stderr, and server errors answer
// with a generic body.

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

/** Captures every console and stdout/stderr line from here until the test's mocks are restored. */
function captureConsole() {
  const lines: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
  }
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => (lines.push(String(chunk)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => (lines.push(String(chunk)), true));
  return lines;
}

/** Lets response `finish` handlers (which write the request log) run before the output is checked. */
async function settle(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  await promise;
}

describe('request log', () => {
  it('never contains tokens, codes, keys, cookies, addresses, passwords or /p/<token> paths', async () => {
    const mailer = new FakeMailer();
    h = createHarness({ mailer });
    const app = createApp({ service: h.service, adminToken: ADMIN_TOKEN, publicUrl: PUBLIC_URL, allowSignup: true, requestLog: true });
    const lines = captureConsole();
    const operator = (method: 'get' | 'post', path: string) => request(app)[method](path).set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    const register = await request(app).post('/api/auth/register').set('X-GatePass-CSRF', '1').send({ email: 'owner@example.com', name: 'Owner', password: PASSWORD }).expect(201);
    const cookie = (register.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    const sessionId = cookie.split('=')[1];
    const event = (await request(app).post('/api/events').set('Cookie', cookie).set('X-GatePass-CSRF', '1').send(EVENT_INPUT).expect(201)).body;
    const created = (await operator('post', `/api/events/${event.id}/scanners`).send({ label: 'Door' }).expect(201)).body;
    const code = setupCode(created);
    const key = (await request(app).post('/api/scanner/enroll').send({ code }).expect(201)).body.key as string;
    await request(app).post('/api/scanner/enroll').send({ code }).expect(410);
    const pass = (await operator('post', `/api/events/${event.id}/passes`).send({ attendees: [{ name: 'Guest', email: 'guest@example.com' }] }).expect(201)).body[0];

    await request(app).get(`/p/${pass.token}`).expect(200);
    await request(app).get(`/P/${pass.token}`).expect(200);
    await request(app).get(`/p/${pass.token}/extra?token=${pass.token}`);
    await request(app).get(`/api/nothing/${pass.token}?key=${key}`).expect(404);
    await request(app).get('/api/scanner/session').set('Authorization', `Bearer ${key}`).expect(200);
    await request(app).post('/api/scanner/redeem').set('Authorization', `Bearer ${key}`).send({ code: `${PUBLIC_URL}/p/${pass.token}`, requestId: 'req-log-0001' }).expect(200);
    await request(app).get('/api/scanner/session').set('Authorization', `Bearer ${key}x`).expect(401);
    await request(app).post('/api/auth/login').set('X-GatePass-CSRF', '1').send({ email: 'owner@example.com', password: 'wrong password!!' }).expect(401);
    await request(app).post('/api/auth/forgot').set('X-GatePass-CSRF', '1').send({ email: 'owner@example.com' }).expect(202);
    await h.service.accounts.idle();
    const resetToken = /#\/reset\/([A-Za-z0-9_-]{43})/.exec(mailer.sent.at(-1)!.text)![1];
    await request(app).post('/api/auth/reset').set('X-GatePass-CSRF', '1').send({ token: resetToken, password: 'a fresh password' }).expect(204);
    const invite = await request(app).post('/api/platform/invitations').set('Authorization', `Bearer ${ADMIN_TOKEN}`).send({ email: 'invitee@example.com', role: 'organizer' }).expect(201);
    expect(invite.body).not.toHaveProperty('url');
    const inviteToken = /#\/invite\/([A-Za-z0-9_-]{43})/.exec(mailer.sent.at(-1)!.text)![1];
    await request(app).post('/api/invitations/preview').set('X-GatePass-CSRF', '1').send({ token: inviteToken }).expect(200);
    await request(app).post('/api/auth/login').set('X-GatePass-CSRF', '1').set('Content-Type', 'application/json').send(`{"email":"owner@example.com","password":"${PASSWORD}"`).expect(400);
    await settle();

    const output = lines.join('\n');
    const secrets = { passToken: pass.token, passPath: `/p/${pass.token}`, code, key, resetToken, inviteToken, sessionId, adminToken: ADMIN_TOKEN, password: PASSWORD };
    for (const [name, secret] of Object.entries(secrets)) expect(output.includes(secret), `${name} appears in the log`).toBe(false);
    for (const address of ['owner@example.com', 'guest@example.com', 'invitee@example.com']) expect(output).not.toContain(address);

    const requests = lines.filter((line) => line.includes('"msg":"request"')).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(requests).toHaveLength(19); // one line per request above
    for (const entry of requests) expect(Object.keys(entry).sort()).toEqual(['level', 'method', 'ms', 'msg', 'requestId', 'route', 'status']);
    const routes = new Set(requests.map((entry) => entry.route));
    expect(routes).toEqual(new Set(['/api/auth/register', '/api/events', '/api/events/:eventId/scanners', '/api/scanner/enroll', '/api/events/:eventId/passes', '/p/:token', 'static', 'unmatched', '/api/scanner/session', '/api/scanner/redeem', '/api/auth/login', '/api/auth/forgot', '/api/auth/reset', '/api/platform/invitations', '/api/invitations/preview']));
  });
});

describe('error answers', () => {
  it('a server error answers a generic 500 without the message or stack; the log line carries the request id', async () => {
    h = createHarness();
    const app = createApp({ service: h.service, adminToken: ADMIN_TOKEN, publicUrl: PUBLIC_URL, requestLog: true });
    const event = (await request(app).post('/api/events').set('Authorization', `Bearer ${ADMIN_TOKEN}`).send(EVENT_INPUT).expect(201)).body;
    const lines = captureConsole();
    vi.spyOn(h.service, 'listScanners').mockImplementation(() => {
      throw new Error('SQLITE_IOERR: disk I/O error in /srv/gatepass/data/gatepass.db');
    });
    const response = await request(app).get(`/api/events/${event.id}/scanners`).set('Authorization', `Bearer ${ADMIN_TOKEN}`).expect(500);
    await settle();
    expect(response.body).toEqual({ error: 'Internal server error' });
    expect(response.text).not.toMatch(/SQLITE|\/srv\/|at .*\.ts|stack/i);
    const requestId = response.headers['x-request-id'];
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged).toEqual([
      expect.objectContaining({ level: 'error', msg: 'unhandled error', requestId, error: expect.stringContaining('disk I/O error') }),
      expect.objectContaining({ level: 'error', msg: 'request', requestId, route: '/api/events/:eventId/scanners', status: 500 })
    ]);
  });

  it('lock contention answers a retryable 503, malformed JSON a 400, and neither echoes server internals', async () => {
    h = createHarness();
    const app = createApp({ service: h.service, adminToken: ADMIN_TOKEN, publicUrl: PUBLIC_URL });
    const event = (await request(app).post('/api/events').set('Authorization', `Bearer ${ADMIN_TOKEN}`).send(EVENT_INPUT).expect(201)).body;
    captureConsole();
    vi.spyOn(h.service, 'listScanners').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    const busy = await request(app).get(`/api/events/${event.id}/scanners`).set('Authorization', `Bearer ${ADMIN_TOKEN}`).expect(503);
    expect(busy.body).toEqual({ error: 'The server is busy. Try again.' });
    expect(busy.headers['retry-after']).toBe('1');
    const malformed = await request(app).post('/api/scanner/enroll').set('Content-Type', 'application/json').send('{"code":').expect(400);
    expect(malformed.text).not.toMatch(/at .*\.(ts|js)|node_modules/);
    const unknown = await request(app).get('/api/does-not-exist').expect(404);
    expect(unknown.body).toEqual({ error: 'Not found' });
  });
});
