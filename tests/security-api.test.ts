import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { ADMIN_TOKEN, createHarness, scan, seedEvent, type Harness } from './helpers';

let h: Harness;
beforeEach(() => {
  h = createHarness();
});
afterEach(() => {
  vi.restoreAllMocks();
  h.close();
});

const adminRoutes: Array<[method: 'get' | 'post' | 'patch' | 'delete', path: string]> = [
  ['get', '/api/auth/session'],
  ['get', '/api/events'],
  ['post', '/api/events'],
  ['get', '/api/events/x'],
  ['patch', '/api/events/x'],
  ['post', '/api/events/x/clone'],
  ['get', '/api/events/x/members'],
  ['delete', '/api/events/x/members/y'],
  ['post', '/api/events/x/owner'],
  ['get', '/api/events/x/invitations'],
  ['post', '/api/events/x/invitations'],
  ['get', '/api/events/x/passes'],
  ['post', '/api/events/x/passes'],
  ['post', '/api/events/x/passes/import'],
  ['post', '/api/events/x/passes/revoke'],
  ['post', '/api/passes/x/revoke'],
  ['post', '/api/passes/x/reissue'],
  ['get', '/api/events/x/scanners'],
  ['post', '/api/events/x/scanners'],
  ['post', '/api/scanners/x/revoke'],
  ['post', '/api/scanners/x/rotate'],
  ['get', '/api/events/x/scans'],
  ['get', '/api/events/x/audit'],
  ['get', '/api/events/x/operations'],
  ['get', '/api/events/x/exports/attendance.csv'],
  ['get', '/api/events/x/exports/scans.csv'],
  ['get', '/api/events/x/exports/audit.csv'],
  ['get', '/api/events/x/gates'],
  ['post', '/api/events/x/gates'],
  ['patch', '/api/gates/x'],
  ['delete', '/api/gates/x'],
  ['get', '/api/events/x/policies'],
  ['post', '/api/events/x/policies'],
  ['patch', '/api/policies/x'],
  ['delete', '/api/policies/x'],
  ['patch', '/api/passes/x'],
  ['post', '/api/qr/custom'],
  ['get', '/api/platform/users'],
  ['post', '/api/platform/invitations'],
  ['post', '/api/platform/users/x/reset-link']
];

describe('authentication', () => {
  it.each(adminRoutes)('%s %s requires the admin token', async (method, path) => {
    const { scannerKey } = await seedEvent(h, 1);
    for (const header of [undefined, 'Bearer wrong-token', `Bearer ${scannerKey}`, ADMIN_TOKEN, `Basic ${ADMIN_TOKEN}`]) {
      const req = request(h.app)[method](path);
      if (header) req.set('Authorization', header);
      const response = await req.send({});
      expect(response.status).toBe(401);
    }
  });

  it('requires a scanner key for scanning; the admin token is not a scanner key', async () => {
    const { passes } = await seedEvent(h, 1);
    await request(h.app).post('/api/scanner/redeem').send({ code: passes[0].token }).expect(401);
    await scan(h, ADMIN_TOKEN, passes[0].token).expect(401);
    await scan(h, 'gps_' + 'A'.repeat(43), passes[0].token).expect(401);
    await request(h.app).get('/api/scanner/session').expect(401);
    const pass = await h.admin(request(h.app).get(`/api/events/${passes[0].eventId}/passes`)).expect(200);
    expect(pass.body[0].status).toBe('active');
  });

  it('rejects a scanner key immediately after revocation', async () => {
    const { passes, scannerKey, scannerId } = await seedEvent(h, 1);
    await h.admin(request(h.app).post(`/api/scanners/${scannerId}/revoke`)).expect(200);
    await scan(h, scannerKey, passes[0].token).expect(401);
  });

  it('never returns scanner keys after creation', async () => {
    const { event, scannerKey } = await seedEvent(h, 1);
    const list = await h.admin(request(h.app).get(`/api/events/${event.id}/scanners`)).expect(200);
    expect(JSON.stringify(list.body)).not.toContain(scannerKey);
    expect(list.body[0]).not.toHaveProperty('keyHash');
  });
});

describe('information exposure', () => {
  it('never returns tokens or token hashes from list endpoints', async () => {
    const { event, passes } = await seedEvent(h, 2);
    const list = await h.admin(request(h.app).get(`/api/events/${event.id}/passes`)).expect(200);
    const body = JSON.stringify(list.body);
    for (const pass of passes) expect(body).not.toContain(pass.token);
    expect(body).not.toMatch(/token/i);
    const audit = JSON.stringify((await h.admin(request(h.app).get(`/api/events/${event.id}/audit`))).body);
    for (const pass of passes) expect(audit).not.toContain(pass.token);
  });

  it('returns a generic 500 without SQL or stack details and keeps serving', async () => {
    const { event } = await seedEvent(h, 1);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(h.service, 'listPasses').mockImplementationOnce(() => {
      throw new Error('SQLITE_CORRUPT: database disk image is malformed at /srv/data/gatepass.db');
    });
    const failed = await h.admin(request(h.app).get(`/api/events/${event.id}/passes`)).expect(500);
    expect(failed.body).toEqual({ error: 'Internal server error' });
    await h.admin(request(h.app).get(`/api/events/${event.id}/passes`)).expect(200);
  });

  it('reports an unavailable database through the health check', async () => {
    await request(h.app).get('/api/health').expect(200, { ok: true, service: 'gatepass', signup: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.db.close();
    await request(h.app).get('/api/health').expect(503, { ok: false });
    const failed = await h.admin(request(h.app).get('/api/events')).expect(500);
    expect(failed.body.error).toBe('Internal server error');
  });

  it('sends security headers and disables caching on API responses', async () => {
    const response = await request(h.app).get('/api/health');
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('maps malformed JSON and oversized bodies to 4xx', async () => {
    const malformed = await h.admin(request(h.app).post('/api/events')).set('Content-Type', 'application/json').send('{"name":');
    expect(malformed.status).toBe(400);
    const huge = await h.admin(request(h.app).post('/api/events')).send({ name: 'x'.repeat(600_000) });
    expect(huge.status).toBe(413);
  });

  it('rate-limits scans per device, so gates sharing one NAT address do not throttle each other', async () => {
    const { event, scannerKey } = await seedEvent(h, 1);
    const addDevice = async (label: string) => (await h.admin(request(h.app).post(`/api/events/${event.id}/scanners`)).send({ label }).expect(201)).body.key as string;
    const [second, third] = [await addDevice('Door 2'), await addDevice('Door 3')];
    const statuses: number[] = [];
    for (let i = 0; i < 245; i += 1) statuses.push((await scan(h, scannerKey, 'garbage')).status);
    expect(statuses.slice(0, 240).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(240)).toEqual([429, 429, 429, 429, 429]);
    // Same client IP, other devices: 380 more scans (625 total from one address) all succeed.
    for (let i = 0; i < 240; i += 1) expect((await scan(h, second, 'garbage')).status).toBe(200);
    for (let i = 0; i < 140; i += 1) expect((await scan(h, third, 'garbage')).status).toBe(200);
  }, 60_000); // 625 sequential scans, each an fsync'd transaction (synchronous=FULL)

  it('throttles failed authentication per IP without locking out valid credentials from that IP', async () => {
    const { scannerKey } = await seedEvent(h, 1);
    const statuses: number[] = [];
    for (let i = 0; i < 62; i += 1) statuses.push((await request(h.app).get('/api/events').set('Authorization', 'Bearer wrong')).status);
    expect(statuses.slice(0, 60).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(60)).toEqual([429, 429]);
    expect((await scan(h, 'gps_' + 'x'.repeat(43), 'garbage')).status).toBe(429);
    // Same address, valid credentials: unaffected.
    await h.admin(request(h.app).get('/api/events')).expect(200);
    expect((await scan(h, scannerKey, 'garbage')).status).toBe(200);
  });

  it('ignores spoofed X-Forwarded-For when no proxy is trusted', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {}); // express-rate-limit warns about the unexpected header, as intended
    const statuses: number[] = [];
    for (let i = 0; i < 62; i += 1) {
      statuses.push((await request(h.app).get('/api/events').set('X-Forwarded-For', `203.0.113.${i}`).set('Authorization', 'Bearer wrong')).status);
    }
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('deployment boundaries', () => {
  it('rate-limits by the CDN-provided client IP, not by spoofable X-Forwarded-For', async () => {
    const secret = 's'.repeat(40);
    const app = createApp({ service: h.service, adminToken: ADMIN_TOKEN, originSecret: secret, clientIpHeader: 'x-vercel-forwarded-for' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const attempt = (cdnIp: string, spoof: string) =>
      request(app).get('/api/events').set('X-Origin-Secret', secret).set('x-vercel-forwarded-for', cdnIp).set('X-Forwarded-For', spoof).set('Authorization', 'Bearer wrong');
    const statuses: number[] = [];
    for (let i = 0; i < 61; i += 1) statuses.push((await attempt('203.0.113.7', `198.51.100.${i}`)).status);
    expect(statuses.at(-1)).toBe(429);
    // A different visitor (different CDN-reported IP) is unaffected.
    expect((await attempt('203.0.113.8', '198.51.100.1')).status).toBe(401);
    expect(() => loadConfig({ ADMIN_TOKEN, CLIENT_IP_HEADER: 'x-vercel-forwarded-for' })).toThrow(/requires ORIGIN_SECRET/);
  });

  it('refuses requests without the origin secret when a CDN fronts the API', async () => {
    const app = createApp({ service: h.service, adminToken: ADMIN_TOKEN, originSecret: 's'.repeat(40) });
    await request(app).get('/api/health').expect(200);
    await request(app).get('/api/events').set('Authorization', `Bearer ${ADMIN_TOKEN}`).expect(403);
    await request(app).get('/api/events').set('Authorization', `Bearer ${ADMIN_TOKEN}`).set('X-Origin-Secret', 'wrong').expect(403);
    await request(app).get('/api/events').set('Authorization', `Bearer ${ADMIN_TOKEN}`).set('X-Origin-Secret', 's'.repeat(40)).expect(200);
  });

  it('rejects configuration that would trust spoofed forwarding headers', () => {
    expect(() => loadConfig({ ADMIN_TOKEN, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY=true/);
    expect(() => loadConfig({ ADMIN_TOKEN, ORIGIN_SECRET: 'short' })).toThrow(/ORIGIN_SECRET/);
    expect(loadConfig({ ADMIN_TOKEN, TRUST_PROXY: '2' }).TRUST_PROXY).toBe('2');
  });
});

describe('retained QR render endpoint', () => {
  it('requires the admin token (CPU-heavy rendering is not public)', async () => {
    await request(h.app).post('/api/qr/custom').send({ data: 'https://example.com' }).expect(401);
    await request(h.app).get('/api/qr/custom').query({ data: 'https://example.com' }).expect(401);
  });

  it('renders SVG and PNG', async () => {
    const svg = await h.admin(request(h.app).post('/api/qr/custom')).send({ data: 'https://example.com', file: 'svg', size: 300 }).expect(200);
    expect(svg.headers['content-type']).toContain('image/svg+xml');
    expect(svg.body.toString()).toContain('<svg');
    const png = await h.admin(request(h.app).get('/api/qr/custom').query({ data: 'https://example.com', file: 'png' })).expect(200);
    expect(png.headers['content-type']).toContain('image/png');
  });

  it('answers invalid input with 400 instead of 500', async () => {
    const post = (body: object) => h.admin(request(h.app).post('/api/qr/custom')).send(body);
    expect((await post({ data: 'x', config: { bodyColor: 'red' } })).status).toBe(400);
    expect((await h.admin(request(h.app).get('/api/qr/custom').query({ data: 'x', config: '{bad' }))).status).toBe(400);
    expect((await post({ data: 'x'.repeat(1025) })).status).toBe(400);
    for (const file of ['pdf', 'eps']) {
      const response = await post({ data: 'x', file });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/not supported/i);
    }
  });
});
