import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, EVENT_INPUT, PUBLIC_URL, scan, seedEvent, type Harness } from './helpers';

let h: Harness;
beforeEach(() => {
  h = createHarness();
});
afterEach(() => h.close());

describe('events', () => {
  it('creates, lists, updates and archives events', async () => {
    const created = await h.admin(request(h.app).post('/api/events')).send({ ...EVENT_INPUT, design: { bodyColor: '#123456' } }).expect(201);
    expect(created.body).toMatchObject({ name: 'Launch Night', venue: 'Hall A', status: 'active', passCount: 0 });
    expect(created.body.design.bodyColor).toBe('#123456');

    const updated = await h.admin(request(h.app).patch(`/api/events/${created.body.id}`)).send({ name: 'Launch Night 2', venue: null }).expect(200);
    expect(updated.body).toMatchObject({ name: 'Launch Night 2', venue: null, startsAt: EVENT_INPUT.startsAt });

    await h.admin(request(h.app).patch(`/api/events/${created.body.id}`)).send({ status: 'archived' }).expect(200);
    const list = await h.admin(request(h.app).get('/api/events')).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].status).toBe('archived');
  });

  it('normalises timestamps to UTC', async () => {
    const created = await h.admin(request(h.app).post('/api/events')).send({ ...EVENT_INPUT, startsAt: '2030-06-01T20:00:00+02:00' }).expect(201);
    expect(created.body.startsAt).toBe('2030-06-01T18:00:00.000Z');
  });

  it.each([
    [{ ...EVENT_INPUT, name: '' }, /name/],
    [{ ...EVENT_INPUT, startsAt: 'tomorrow' }, /startsAt/],
    [{ ...EVENT_INPUT, endsAt: EVENT_INPUT.startsAt }, /must end after it starts/],
    [{ ...EVENT_INPUT, design: { bodyColor: 'red' } }, /six-digit hex/],
    [{ ...EVENT_INPUT, extra: true }, /extra|Unrecognized/i]
  ])('rejects invalid event input %#', async (body, message) => {
    const response = await h.admin(request(h.app).post('/api/events')).send(body).expect(400);
    expect(response.body.error).toMatch(message);
  });

  it('rejects an update that would invert the event window', async () => {
    const { event } = await seedEvent(h);
    const response = await h.admin(request(h.app).patch(`/api/events/${event.id}`)).send({ endsAt: '2030-06-01T17:00:00.000Z' }).expect(400);
    expect(response.body.error).toMatch(/must end after it starts/);
  });

  it('returns 404 for unknown events', async () => {
    await h.admin(request(h.app).get('/api/events/nope')).expect(404);
    await h.admin(request(h.app).post('/api/events/nope/passes')).send({ count: 1 }).expect(404);
  });
});

describe('pass issuance', () => {
  it('issues anonymous passes with one-time tokens and pass URLs', async () => {
    const { event, passes } = await seedEvent(h, 3);
    expect(passes).toHaveLength(3);
    for (const pass of passes) {
      expect(pass.passUrl).toBe(`${PUBLIC_URL}/p/${pass.token}`);
      expect(pass).toMatchObject({ status: 'active', expiresAt: event.endsAt, attendeeName: null });
    }
    expect(new Set(passes.map((pass: { token: string }) => pass.token)).size).toBe(3);
  });

  it('issues named passes with a custom expiry and counts attendees', async () => {
    const { event } = await seedEvent(h, 1);
    const response = await h
      .admin(request(h.app).post(`/api/events/${event.id}/passes`))
      .send({ attendees: [{ name: 'Ada Lovelace', email: 'ada@example.com' }, { name: 'Grace Hopper', email: '' }], expiresAt: '2030-06-01T20:00:00Z' })
      .expect(201);
    expect(response.body.map((pass: { attendeeName: string }) => pass.attendeeName)).toEqual(['Ada Lovelace', 'Grace Hopper']);
    expect(response.body[1].attendeeEmail).toBeNull();
    expect(response.body[0].expiresAt).toBe('2030-06-01T20:00:00.000Z');

    const summary = await h.admin(request(h.app).get(`/api/events/${event.id}`)).expect(200);
    expect(summary.body).toMatchObject({ passCount: 3, attendeeCount: 2, redeemedCount: 0, revokedCount: 0 });
  });

  it.each([
    [{ count: 0 }],
    [{ count: 501 }],
    [{ attendees: [] }],
    [{ attendees: [{ email: 'not-an-email' }] }],
    [{ count: 1, attendees: [{ name: 'x' }] }],
    [{ count: 1, expiresAt: '2030-06-01T09:00:00Z' }]
  ])('rejects invalid issuance %#', async (body) => {
    const { event } = await seedEvent(h, 1);
    await h.admin(request(h.app).post(`/api/events/${event.id}/passes`)).send(body).expect(400);
  });

  it('refuses to issue passes for archived events', async () => {
    const { event } = await seedEvent(h, 1);
    await h.admin(request(h.app).patch(`/api/events/${event.id}`)).send({ status: 'archived' }).expect(200);
    await h.admin(request(h.app).post(`/api/events/${event.id}/passes`)).send({ count: 1 }).expect(409);
  });

  it('filters and searches passes', async () => {
    const { event } = await seedEvent(h, 1);
    await h.admin(request(h.app).post(`/api/events/${event.id}/passes`)).send({ attendees: [{ name: 'Ada 100%' }, { name: 'Bob' }] }).expect(201);
    const search = await h.admin(request(h.app).get(`/api/events/${event.id}/passes`).query({ q: '100%' })).expect(200);
    expect(search.body.map((pass: { attendeeName: string }) => pass.attendeeName)).toEqual(['Ada 100%']);
    const underscore = await h.admin(request(h.app).get(`/api/events/${event.id}/passes`).query({ q: '_' })).expect(200);
    expect(underscore.body).toEqual([]);
  });
});

describe('revocation and reissue', () => {
  it('revokes passes idempotently and records the action in the audit log', async () => {
    const { event, passes } = await seedEvent(h, 1);
    const revoked = await h.admin(request(h.app).post(`/api/passes/${passes[0].id}/revoke`)).expect(200);
    expect(revoked.body.status).toBe('revoked');
    await h.admin(request(h.app).post(`/api/passes/${passes[0].id}/revoke`)).expect(200);

    const filtered = await h.admin(request(h.app).get(`/api/events/${event.id}/passes`).query({ status: 'revoked' })).expect(200);
    expect(filtered.body).toHaveLength(1);
    const audit = await h.admin(request(h.app).get(`/api/events/${event.id}/audit`)).expect(200);
    expect(audit.body.map((entry: { action: string }) => entry.action)).toEqual(['pass.revoked', 'scanner.enrolled', 'passes.issued', 'scanner.created', 'event.created']);
  });

  it('reissue invalidates the old token and keeps the same pass', async () => {
    const { passes, scannerKey } = await seedEvent(h, 1);
    const reissued = await h.admin(request(h.app).post(`/api/passes/${passes[0].id}/reissue`)).expect(200);
    expect(reissued.body.id).toBe(passes[0].id);
    expect(reissued.body.token).not.toBe(passes[0].token);

    const old = await request(h.app).post('/api/scanner/redeem').set('Authorization', `Bearer ${scannerKey}`).send({ code: passes[0].passUrl }).expect(200);
    expect(old.body.outcome).toBe('invalid');
    const fresh = await request(h.app).post('/api/scanner/redeem').set('Authorization', `Bearer ${scannerKey}`).send({ code: reissued.body.passUrl }).expect(200);
    expect(fresh.body.outcome).toBe('admitted');

    await h.admin(request(h.app).post(`/api/passes/${passes[0].id}/reissue`)).expect(409);
    await h.admin(request(h.app).post(`/api/passes/${passes[0].id}/revoke`)).expect(409);
  });
});

describe('pass expiry follows the event', () => {
  it('extends default-expiry passes when the event end moves, and keeps explicit expiries', async () => {
    const { event, scannerKey, passes } = await seedEvent(h, 1);
    const explicit = (await h.admin(request(h.app).post(`/api/events/${event.id}/passes`)).send({ count: 1, expiresAt: '2030-06-01T22:00:00Z' }).expect(201)).body[0];
    const later = '2030-06-02T01:00:00.000Z';
    await h.admin(request(h.app).patch(`/api/events/${event.id}`)).send({ endsAt: later }).expect(200);
    expect(h.service.getPass(passes[0].id).expiresAt).toBe(later);
    expect(h.service.getPass(explicit.id).expiresAt).toBe('2030-06-01T22:00:00.000Z');
    expect(h.service.listAudit(event.id).find((entry) => entry.action === 'event.updated')?.details.passesExtended).toBe(1);

    h.clock.advance(5 * 3_600_000); // 23:30, after the old end
    expect((await scan(h, scannerKey, passes[0].token).expect(200)).body.outcome).toBe('admitted');
  });

  it('defaults the expiry of a late-entry policy pass to the policy close', async () => {
    const { event } = await seedEvent(h, 1);
    const closesAt = '2030-06-02T02:00:00.000Z';
    const policy = (await h.admin(request(h.app).post(`/api/events/${event.id}/policies`)).send({ name: 'Late', closesAt }).expect(201)).body;
    const pass = (await h.admin(request(h.app).post(`/api/events/${event.id}/passes`)).send({ count: 1, policyId: policy.id }).expect(201)).body[0];
    expect(pass.expiresAt).toBe(closesAt);
  });
});

describe('archived events are read-only', () => {
  it('refuses changes to gates, passes and scanners but still allows revoking a scanner', async () => {
    const { event, scannerId, passes } = await seedEvent(h, 2);
    await h.admin(request(h.app).patch(`/api/events/${event.id}`)).send({ status: 'archived' }).expect(200);
    const refused = (req: request.Test) => req.expect(409).then((res) => expect(res.body.error).toMatch(/archived event is read-only/));
    await refused(h.admin(request(h.app).post(`/api/events/${event.id}/gates`)).send({ name: 'North' }));
    await refused(h.admin(request(h.app).post(`/api/passes/${passes[0].id}/revoke`)));
    await refused(h.admin(request(h.app).post(`/api/events/${event.id}/passes/revoke`)).send({ passIds: [passes[1].id] }));
    await refused(h.admin(request(h.app).post(`/api/events/${event.id}/scanners`)).send({ label: 'Door 2' }));
    await refused(h.admin(request(h.app).post(`/api/scanners/${scannerId}/rotate`)));
    await h.admin(request(h.app).post(`/api/scanners/${scannerId}/revoke`)).expect(200);
  });
});

describe('input validation', () => {
  it('counts duplicate ids once when bulk revoking', async () => {
    const { event, passes } = await seedEvent(h, 2);
    const result = (await h.admin(request(h.app).post(`/api/events/${event.id}/passes/revoke`)).send({ passIds: [passes[0].id, passes[0].id, 'unknown'] }).expect(200)).body;
    expect(result).toEqual({ revoked: 1, skipped: 1 });
  });

  it('requires an explicit offset on date-times', async () => {
    await h.admin(request(h.app).post('/api/events')).send({ ...EVENT_INPUT, startsAt: '2030-06-01T18:00:00' }).expect(400);
    await h.admin(request(h.app).post('/api/events')).send({ ...EVENT_INPUT, startsAt: '2030-06-01' }).expect(400);
    await h.admin(request(h.app).post('/api/events')).send({ ...EVENT_INPUT, startsAt: '2030-06-01T20:00:00+02:00' }).expect(201);
  });

  it('answers 400 for QR data too long for the code, and honours download=false', async () => {
    await h.admin(request(h.app).post('/api/qr/custom')).send({ data: 'é'.repeat(700) }).expect(400);
    const plain = await h.admin(request(h.app).get('/api/qr/custom').query({ data: 'hello', download: 'false' })).expect(200);
    expect(plain.headers['content-disposition']).toBeUndefined();
    const download = await h.admin(request(h.app).get('/api/qr/custom').query({ data: 'hello', download: 'true' })).expect(200);
    expect(download.headers['content-disposition']).toMatch(/attachment/);
  });
});
