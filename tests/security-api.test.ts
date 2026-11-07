import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_TOKEN, createHarness, scan, seedEvent, type Harness } from './helpers';

let h: Harness;
beforeEach(() => {
  h = createHarness();
});
afterEach(() => {
  vi.restoreAllMocks();
  h.close();
});

const adminRoutes: Array<[method: 'get' | 'post' | 'patch', path: string]> = [
  ['get', '/api/admin/session'],
  ['get', '/api/events'],
  ['post', '/api/events'],
  ['get', '/api/events/x'],
  ['patch', '/api/events/x'],
  ['get', '/api/events/x/passes'],
  ['post', '/api/events/x/passes'],
  ['post', '/api/passes/x/revoke'],
  ['post', '/api/passes/x/reissue'],
  ['get', '/api/events/x/scanners'],
  ['post', '/api/events/x/scanners'],
  ['post', '/api/scanners/x/revoke'],
  ['get', '/api/events/x/scans'],
  ['get', '/api/events/x/audit']
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
    await request(h.app).get('/api/health').expect(200, { ok: true, service: 'gatepass' });
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
    const huge = await h.admin(request(h.app).post('/api/events')).send({ name: 'x'.repeat(200_000) });
    expect(huge.status).toBe(413);
  });

  it('rate-limits scan attempts per client', async () => {
    const { scannerKey } = await seedEvent(h, 1);
    const statuses: number[] = [];
    for (let i = 0; i < 245; i += 1) statuses.push((await scan(h, scannerKey, 'garbage')).status);
    expect(statuses.slice(0, 240).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(240)).toEqual([429, 429, 429, 429, 429]);
  });
});

describe('retained QR render endpoint', () => {
  it('renders SVG and PNG', async () => {
    const svg = await request(h.app).post('/api/qr/custom').send({ data: 'https://example.com', file: 'svg', size: 300 }).expect(200);
    expect(svg.headers['content-type']).toContain('image/svg+xml');
    expect(svg.body.toString()).toContain('<svg');
    const png = await request(h.app).get('/api/qr/custom').query({ data: 'https://example.com', file: 'png' }).expect(200);
    expect(png.headers['content-type']).toContain('image/png');
  });

  it('answers invalid input with 400 instead of 500', async () => {
    expect((await request(h.app).post('/api/qr/custom').send({ data: 'x', config: { bodyColor: 'red' } })).status).toBe(400);
    expect((await request(h.app).get('/api/qr/custom').query({ data: 'x', config: '{bad' })).status).toBe(400);
    expect((await request(h.app).post('/api/qr/custom').send({ data: 'x'.repeat(1025) })).status).toBe(400);
    for (const file of ['pdf', 'eps']) {
      const response = await request(h.app).post('/api/qr/custom').send({ data: 'x', file });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/not supported/i);
    }
  });
});
