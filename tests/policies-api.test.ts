import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, scan, seedEvent, type Harness } from './helpers';

let h: Harness;
beforeEach(() => {
  h = createHarness();
});
afterEach(() => h.close());

const api = () => request(h.app);

async function gate(eventId: string, name: string) {
  return (await h.admin(api().post(`/api/events/${eventId}/gates`)).send({ name }).expect(201)).body;
}
async function scannerAt(eventId: string, label: string, gateId: string | null) {
  return (await h.admin(api().post(`/api/events/${eventId}/scanners`)).send({ label, gateId }).expect(201)).body;
}
async function policy(eventId: string, body: object) {
  return (await h.admin(api().post(`/api/events/${eventId}/policies`)).send(body).expect(201)).body;
}
async function issue(eventId: string, body: object) {
  return (await h.admin(api().post(`/api/events/${eventId}/passes`)).send(body).expect(201)).body;
}

describe('gates and policies', () => {
  it('creates gates and policies, rejects duplicates and inconsistent windows', async () => {
    const { event } = await seedEvent(h, 1);
    const north = await gate(event.id, 'North');
    await h.admin(api().post(`/api/events/${event.id}/gates`)).send({ name: 'North' }).expect(409);
    const vip = await policy(event.id, { name: 'VIP', capacity: 10, gateIds: [north.id] });
    expect(vip).toMatchObject({ name: 'VIP', capacity: 10, admittedCount: 0, gateIds: [north.id], opensAt: null, closesAt: null });
    await h.admin(api().post(`/api/events/${event.id}/policies`)).send({ name: 'VIP' }).expect(409);
    const bad = await h.admin(api().post(`/api/events/${event.id}/policies`)).send({ name: 'Bad', opensAt: '2030-06-01T20:00:00Z', closesAt: '2030-06-01T19:00:00Z' });
    expect(bad.status).toBe(400);
    await h.admin(api().post(`/api/events/${event.id}/policies`)).send({ name: 'Zero', capacity: 0 }).expect(400);
  });

  it('refuses cross-event gates, policies and scanner bindings (IDOR)', async () => {
    const a = await seedEvent(h, 1);
    const b = await seedEvent(h, 1);
    const foreignGate = await gate(b.event.id, 'B door');
    const foreignPolicy = await policy(b.event.id, { name: 'B only' });
    await h.admin(api().post(`/api/events/${a.event.id}/policies`)).send({ name: 'X', gateIds: [foreignGate.id] }).expect(400);
    await h.admin(api().post(`/api/events/${a.event.id}/scanners`)).send({ label: 'X', gateId: foreignGate.id }).expect(400);
    await h.admin(api().post(`/api/events/${a.event.id}/passes`)).send({ count: 1, policyId: foreignPolicy.id }).expect(400);
    await h.admin(api().patch(`/api/passes/${a.passes[0].id}`)).send({ policyId: foreignPolicy.id }).expect(400);
  });

  it('lets an organiser move unused passes between policies but not redeemed ones', async () => {
    const { event, passes, scannerKey } = await seedEvent(h, 2);
    const vip = await policy(event.id, { name: 'VIP' });
    const moved = await h.admin(api().patch(`/api/passes/${passes[0].id}`)).send({ policyId: vip.id }).expect(200);
    expect(moved.body.policyId).toBe(vip.id);
    await scan(h, scannerKey, passes[1].token).expect(200);
    await h.admin(api().patch(`/api/passes/${passes[1].id}`)).send({ policyId: vip.id }).expect(409);
    await h.admin(api().patch(`/api/passes/${passes[0].id}`)).send({ policyId: null }).expect(200);
  });

  it('refuses to lower capacity below admissions already made', async () => {
    const { event, scannerKey } = await seedEvent(h, 1);
    const wave = await policy(event.id, { name: 'Wave', capacity: 3 });
    const passes = await issue(event.id, { count: 2, policyId: wave.id });
    for (const pass of passes) expect((await scan(h, scannerKey, pass.token)).body.outcome).toBe('admitted');
    const lower = await h.admin(api().patch(`/api/policies/${wave.id}`)).send({ capacity: 1 });
    expect(lower.status).toBe(409);
    expect(lower.body.error).toMatch(/2 people already admitted/);
    await h.admin(api().patch(`/api/policies/${wave.id}`)).send({ capacity: 2 }).expect(200);
  });
});

describe('policy enforcement at the door', () => {
  it('admits through allowed gates only and explains wrong gates safely', async () => {
    const { event } = await seedEvent(h, 1);
    const north = await gate(event.id, 'North');
    const south = await gate(event.id, 'South');
    const vip = await policy(event.id, { name: 'VIP', gateIds: [north.id] });
    const [pass] = await issue(event.id, { count: 1, policyId: vip.id });
    const southScanner = await scannerAt(event.id, 'South 1', south.id);
    const northScanner = await scannerAt(event.id, 'North 1', north.id);

    const denied = await scan(h, southScanner.key, pass.token).expect(200);
    expect(denied.body).toMatchObject({ outcome: 'wrong_gate', detail: { policyName: 'VIP', allowedGates: ['North'] } });
    const admitted = await scan(h, northScanner.key, pass.token).expect(200);
    expect(admitted.body.outcome).toBe('admitted');

    const session = await api().get('/api/scanner/session').set('Authorization', `Bearer ${northScanner.key}`).expect(200);
    expect(session.body.gate).toEqual({ id: north.id, name: 'North' });
  });

  it('enforces timed entry windows', async () => {
    const { event, scannerKey } = await seedEvent(h, 1);
    const wave = await policy(event.id, { name: '19:00 wave', opensAt: '2030-06-01T19:00:00Z', closesAt: '2030-06-01T19:30:00Z' });
    const [pass] = await issue(event.id, { count: 1, policyId: wave.id });
    expect((await scan(h, scannerKey, pass.token)).body).toMatchObject({ outcome: 'too_early', detail: { opensAt: '2030-06-01T19:00:00.000Z' } });
    h.clock.current = new Date('2030-06-01T19:30:00.000Z');
    expect((await scan(h, scannerKey, pass.token)).body).toMatchObject({ outcome: 'too_late', detail: { closesAt: '2030-06-01T19:30:00.000Z' } });
    h.clock.current = new Date('2030-06-01T19:10:00.000Z');
    expect((await scan(h, scannerKey, pass.token)).body.outcome).toBe('admitted');
  });

  it('rejects passes scanned before the event starts (previously accepted)', async () => {
    const { passes, scannerKey } = await seedEvent(h, 1);
    h.clock.current = new Date('2030-06-01T17:59:00.000Z');
    expect((await scan(h, scannerKey, passes[0].token)).body.outcome).toBe('too_early');
  });

  it('refuses issuance of passes that expire before the event starts', async () => {
    const { event } = await seedEvent(h, 1);
    h.clock.current = new Date('2030-06-01T10:00:00.000Z');
    const response = await h.admin(api().post(`/api/events/${event.id}/passes`)).send({ count: 1, expiresAt: '2030-06-01T17:00:00Z' }).expect(400);
    expect(response.body.error).toMatch(/after the event starts/);
  });

  it('stops at capacity under 30 concurrent HTTP scans of different passes', async () => {
    const { event, scannerKey } = await seedEvent(h, 1);
    const wave = await policy(event.id, { name: 'Wave', capacity: 10 });
    const passes = await issue(event.id, { count: 30, policyId: wave.id });
    const responses = await Promise.all(passes.map((pass: { token: string }) => scan(h, scannerKey, pass.token)));
    const outcomes = responses.map((response) => response.body.outcome);
    expect(outcomes.filter((outcome) => outcome === 'admitted')).toHaveLength(10);
    expect(outcomes.filter((outcome) => outcome === 'capacity_full')).toHaveLength(20);
    const full = responses.find((response) => response.body.outcome === 'capacity_full')!;
    expect(full.body.detail).toEqual({ policyName: 'Wave', capacity: 10 });
    const after = (await h.admin(api().get(`/api/events/${event.id}/policies`)).expect(200)).body[0];
    expect(after.admittedCount).toBe(10);
  });

  it('a pass denied for capacity does not consume it and can be retried after capacity grows', async () => {
    const { event, scannerKey } = await seedEvent(h, 1);
    const wave = await policy(event.id, { name: 'Wave', capacity: 1 });
    const [first, second] = await issue(event.id, { count: 2, policyId: wave.id });
    expect((await scan(h, scannerKey, first.token)).body.outcome).toBe('admitted');
    expect((await scan(h, scannerKey, second.token)).body.outcome).toBe('capacity_full');
    await h.admin(api().patch(`/api/policies/${wave.id}`)).send({ capacity: 2 }).expect(200);
    expect((await scan(h, scannerKey, second.token)).body.outcome).toBe('admitted');
  });

  it('never reveals policy details for another event’s pass', async () => {
    const a = await seedEvent(h, 1);
    const b = await seedEvent(h, 1);
    const secret = await policy(b.event.id, { name: 'Backstage', capacity: 1 });
    const [pass] = await issue(b.event.id, { count: 1, policyId: secret.id });
    const response = await scan(h, a.scannerKey, pass.token).expect(200);
    expect(response.body).toEqual({ outcome: 'invalid', scanId: expect.any(Number), checkedAt: expect.any(String) });
  });
});

describe('operations dashboard', () => {
  it('summarises admissions per gate, capacity usage and suspicious patterns', async () => {
    const { event } = await seedEvent(h, 1);
    const north = await gate(event.id, 'North');
    const south = await gate(event.id, 'South');
    const wave = await policy(event.id, { name: 'Wave', capacity: 2 });
    const passes = await issue(event.id, { count: 2, policyId: wave.id });
    const n = await scannerAt(event.id, 'North 1', north.id);
    const s = await scannerAt(event.id, 'South 1', south.id);

    await scan(h, n.key, passes[0].token);
    await scan(h, s.key, passes[0].token); // duplicate at another gate
    await scan(h, s.key, passes[0].token); // second duplicate
    await scan(h, s.key, passes[1].token);
    for (let i = 0; i < 5; i += 1) await scan(h, n.key, 'not-a-pass');

    const ops = (await h.admin(api().get(`/api/events/${event.id}/operations`)).expect(200)).body;
    expect(ops.totals).toEqual({ scans: 9, admitted: 2, denied: 7 });
    expect(ops.outcomes).toMatchObject({ admitted: 2, already_redeemed: 2, invalid: 5 });
    expect(ops.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'North', admitted: 1, denied: 5 }),
        expect.objectContaining({ name: 'South', admitted: 1, denied: 2 })
      ])
    );
    expect(ops.policies).toEqual([expect.objectContaining({ name: 'Wave', capacity: 2, admitted: 2, state: 'full' })]);
    const kinds = ops.alerts.map((alert: { kind: string }) => alert.kind).sort();
    expect(kinds).toEqual(['capacity_near', 'invalid_burst', 'multi_gate', 'repeated_duplicate']);
    expect(ops.timeline).toEqual([{ bucketStart: '2030-06-01T18:30:00.000Z', admitted: 2, denied: 7 }]);
  });
});
