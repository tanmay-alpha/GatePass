import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, scan, seedEvent, type Harness } from './helpers';

let h: Harness;
beforeEach(() => {
  h = createHarness();
});
afterEach(() => h.close());

describe('scanner redemption', () => {
  it('admits a valid pass once, then reports the original redemption', async () => {
    const { event, passes, scannerKey } = await seedEvent(h, 1);
    const first = await scan(h, scannerKey, passes[0].passUrl).expect(200);
    expect(first.body).toMatchObject({ outcome: 'admitted', pass: { id: passes[0].id, redeemedAt: h.clock.current.toISOString() } });

    h.clock.advance(60_000);
    const second = await scan(h, scannerKey, passes[0].token).expect(200);
    expect(second.body.outcome).toBe('already_redeemed');
    expect(second.body.pass.redeemedAt).toBe(first.body.pass.redeemedAt);

    const summary = await h.admin(request(h.app).get(`/api/events/${event.id}`)).expect(200);
    expect(summary.body.redeemedCount).toBe(1);
  });

  it('admits exactly one of 25 concurrent HTTP scans of the same pass', async () => {
    const { event, passes, scannerKey } = await seedEvent(h, 1);
    const responses = await Promise.all(Array.from({ length: 25 }, () => scan(h, scannerKey, passes[0].passUrl)));
    const outcomes = responses.map((response) => response.body.outcome);
    expect(outcomes.filter((outcome) => outcome === 'admitted')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'already_redeemed')).toHaveLength(24);
    const scans = await h.admin(request(h.app).get(`/api/events/${event.id}/scans`).query({ limit: 200 })).expect(200);
    expect(scans.body).toHaveLength(25);
  });

  it('rejects passes after their expiry instant', async () => {
    const { passes, scannerKey } = await seedEvent(h, 2);
    h.clock.current = new Date('2030-06-01T22:59:59.999Z');
    expect((await scan(h, scannerKey, passes[0].token)).body.outcome).toBe('admitted');
    h.clock.current = new Date('2030-06-01T23:00:00.000Z'); // == expiresAt
    expect((await scan(h, scannerKey, passes[1].token)).body.outcome).toBe('expired');
  });

  it('rejects revoked passes', async () => {
    const { passes, scannerKey } = await seedEvent(h, 1);
    await h.admin(request(h.app).post(`/api/passes/${passes[0].id}/revoke`)).expect(200);
    const response = await scan(h, scannerKey, passes[0].token).expect(200);
    expect(response.body.outcome).toBe('revoked');
  });

  it.each(['', 'garbage', 'A'.repeat(43), 'https://gate.example/p/' + 'B'.repeat(43), "'; DROP TABLE passes; --"])('reports unknown code %j as invalid without details', async (code) => {
    const { scannerKey } = await seedEvent(h, 1);
    const response = await scan(h, scannerKey, code);
    if (code === '') {
      expect(response.status).toBe(400);
      return;
    }
    expect(response.body.outcome).toBe('invalid');
    expect(response.body).not.toHaveProperty('pass');
  });

  it('does not admit or reveal a pass from another event', async () => {
    const a = await seedEvent(h, 1);
    const b = await seedEvent(h, 1);
    const response = await scan(h, a.scannerKey, b.passes[0].token).expect(200);
    expect(response.body).toEqual({ outcome: 'invalid', scanId: expect.any(Number), checkedAt: expect.any(String) });
    // The pass is still redeemable at its own event.
    expect((await scan(h, b.scannerKey, b.passes[0].token)).body.outcome).toBe('admitted');
    const scans = await h.admin(request(h.app).get(`/api/events/${a.event.id}/scans`)).expect(200);
    expect(scans.body[0]).toMatchObject({ outcome: 'wrong_event', passId: null });
  });

  it('closes scanning when the event is archived', async () => {
    const { event, passes, scannerKey } = await seedEvent(h, 1);
    await h.admin(request(h.app).patch(`/api/events/${event.id}`)).send({ status: 'archived' }).expect(200);
    expect((await scan(h, scannerKey, passes[0].token)).body.outcome).toBe('event_closed');
  });

  it('exposes the scanner session and live scan feed with a cursor', async () => {
    const { event, passes, scannerKey } = await seedEvent(h, 2);
    const session = await request(h.app).get('/api/scanner/session').set('Authorization', `Bearer ${scannerKey}`).expect(200);
    expect(session.body).toMatchObject({ scanner: { label: 'Door 1' }, event: { id: event.id, name: event.name } });

    const first = (await scan(h, scannerKey, passes[0].token)).body;
    await scan(h, scannerKey, passes[1].token);
    const feed = await h.admin(request(h.app).get(`/api/events/${event.id}/scans`).query({ after: first.scanId })).expect(200);
    expect(feed.body).toHaveLength(1);
    expect(feed.body[0]).toMatchObject({ outcome: 'admitted', scannerLabel: 'Door 1', passId: passes[1].id });
  });
});

describe('attendee pass page', () => {
  it('shows the pass without redeeming it', async () => {
    const { passes, scannerKey } = await seedEvent(h, 1);
    for (let i = 0; i < 3; i += 1) {
      const page = await request(h.app).get(`/p/${passes[0].token}`).expect(200);
      expect(page.text).toContain('Launch Night');
      expect(page.text).toContain('<svg');
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.headers['x-robots-tag']).toContain('noindex');
    }
    await request(h.app).head(`/p/${passes[0].token}`).expect(200);
    expect((await scan(h, scannerKey, passes[0].token)).body.outcome).toBe('admitted');

    const after = await request(h.app).get(`/p/${passes[0].token}`).expect(200);
    expect(after.text).toContain('Already used');
    expect(after.text).not.toContain('<svg');
  });

  it('answers unknown and malformed tokens identically', async () => {
    const unknown = await request(h.app).get(`/p/${'C'.repeat(43)}`).expect(404);
    const malformed = await request(h.app).get('/p/short').expect(404);
    expect(unknown.text).toBe(malformed.text);
  });

  it('escapes attendee and event names', async () => {
    const { event } = await seedEvent(h, 1);
    await h.admin(request(h.app).patch(`/api/events/${event.id}`)).send({ name: '<script>alert(1)</script>' }).expect(200);
    const [pass] = (await h.admin(request(h.app).post(`/api/events/${event.id}/passes`)).send({ attendees: [{ name: '<img src=x onerror=alert(1)>' }] })).body;
    const page = await request(h.app).get(`/p/${pass.token}`).expect(200);
    expect(page.text).not.toContain('<script>alert');
    expect(page.text).not.toContain('<img src=x');
    expect(page.text).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('renders ticket details with admission policy, gates, and short pass reference', async () => {
    const { event } = await seedEvent(h, 1);
    const gate = (await h.admin(request(h.app).post(`/api/events/${event.id}/gates`)).send({ name: 'North' }).expect(201)).body;
    const policy = (await h.admin(request(h.app).post(`/api/events/${event.id}/policies`)).send({ name: 'VIP', gateIds: [gate.id] }).expect(201)).body;
    const [pass] = (await h.admin(request(h.app).post(`/api/events/${event.id}/passes`)).send({ policyId: policy.id, attendees: [{ name: 'Barbara Liskov' }] }).expect(201)).body;

    const page = await request(h.app).get(`/p/${pass.token}`).expect(200);
    expect(page.text).toContain('GATEPASS');
    expect(page.text).toContain('Barbara Liskov');
    expect(page.text).toContain('VIP · North');
    expect(page.text).toContain(pass.id.slice(0, 8).toUpperCase());
    expect(page.text).toContain('Valid — show this code at the entrance.');
    expect(page.text).toContain('Opening this page does not check you in.');
  });
});
