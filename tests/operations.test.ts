import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transaction } from '../src/server/db';
import { ALERT_RULES, OPERATIONS_MEMO_MS, operationsSummary } from '../src/server/operations';
import { hashToken } from '../src/server/tokens';
import type { OperationsSummary } from '../src/shared/types';
import { createHarness, enroll, EVENT_INPUT, scan, type Harness } from './helpers';

let h: Harness;
beforeEach(() => {
  h = createHarness();
});
afterEach(() => h.close());

const api = () => request(h.app);
const MINUTE = 60_000;

async function post(path: string, body: object) {
  return (await h.admin(api().post(path)).send(body).expect(201)).body;
}
async function ops(eventId: string): Promise<OperationsSummary> {
  return (await h.admin(api().get(`/api/events/${eventId}/operations`)).expect(200)).body;
}
async function scannerAt(eventId: string, label: string, gateId: string | null) {
  const created = await post(`/api/events/${eventId}/scanners`, { label, gateId });
  return { id: created.scanner.id as string, key: await enroll(h.app, created) };
}

describe('operations dashboard aggregates', () => {
  /**
   * Clock starts at 18:30 inside an 18:00–23:00 event with capacity 10.
   * 18:30  North admits VIP 0; South refuses VIP 1 (wrong gate); North admits VIP 1.
   * 18:37  South admits General 0 and 1; the roaming scanner admits General 2;
   *        South re-scans General 0 (already used) and a revoked pass.
   * 18:50  Roaming scanner: 5 invalid codes (burst); South: 4 invalid codes (below threshold).
   */
  async function scenario() {
    const event = await post('/api/events', { ...EVENT_INPUT, capacity: 10 });
    const north = await post(`/api/events/${event.id}/gates`, { name: 'North' });
    const south = await post(`/api/events/${event.id}/gates`, { name: 'South' });
    const vip = await post(`/api/events/${event.id}/policies`, { name: 'VIP', capacity: 2, gateIds: [north.id] });
    const vipPasses = await post(`/api/events/${event.id}/passes`, { count: 2, policyId: vip.id });
    const general = await post(`/api/events/${event.id}/passes`, { count: 6 });
    await h.admin(api().post(`/api/passes/${general[5].id}/revoke`)).expect(200);
    const n = await scannerAt(event.id, 'North 1', north.id);
    const s = await scannerAt(event.id, 'South 1', south.id);
    const roam = await scannerAt(event.id, 'Roaming', null);

    await scan(h, n.key, vipPasses[0].token).expect(200);
    expect((await scan(h, s.key, vipPasses[1].token)).body.outcome).toBe('wrong_gate');
    await scan(h, n.key, vipPasses[1].token).expect(200);
    h.clock.advance(7 * MINUTE);
    await scan(h, s.key, general[0].token).expect(200);
    await scan(h, s.key, general[1].token).expect(200);
    await scan(h, roam.key, general[2].token).expect(200);
    expect((await scan(h, s.key, general[0].token)).body.outcome).toBe('already_redeemed');
    expect((await scan(h, s.key, general[5].token)).body.outcome).toBe('revoked');
    h.clock.advance(13 * MINUTE);
    for (let i = 0; i < 5; i += 1) await scan(h, roam.key, `not-a-pass-${i}`);
    for (let i = 0; i < 4; i += 1) await scan(h, s.key, `not-a-pass-${i}`);
    return { event, north, south, vip, n, s, roam };
  }

  it('reports attendance against expected passes, capacity, gates, denial reasons, recent activity and bursts', async () => {
    const { event, n, roam, vip } = await scenario();
    const summary = await ops(event.id);

    expect(summary.phase).toBe('live');
    expect(summary.totals).toEqual({ scans: 17, admitted: 5, denied: 12 });
    expect(summary.outcomes).toEqual({ admitted: 5, wrong_gate: 1, already_redeemed: 1, revoked: 1, invalid: 9 });
    expect(summary.passes).toEqual({ issued: 8, active: 2, redeemed: 5, revoked: 1, expired: 0 });
    expect(summary.attendance).toEqual({ expected: 7, admitted: 5, rate: 5 / 7 });
    expect(summary.capacity).toEqual({ limit: 10, admitted: 5, remaining: 5 });
    expect(summary.gates).toEqual([
      { id: expect.any(String), name: 'North', admitted: 2, denied: 0, lastScanAt: '2030-06-01T18:30:00.000Z' },
      { id: expect.any(String), name: 'South', admitted: 2, denied: 7, lastScanAt: '2030-06-01T18:50:00.000Z' },
      { id: null, name: 'Any gate', admitted: 1, denied: 5, lastScanAt: '2030-06-01T18:50:00.000Z' }
    ]);
    expect(summary.policies).toEqual([expect.objectContaining({ id: vip.id, admitted: 2, capacity: 2, state: 'full' })]);

    // Last hour in 5-minute buckets ending with the current one (18:50), zero-filled.
    expect(summary.recent.bucketMinutes).toBe(5);
    expect(summary.recent.buckets).toHaveLength(12);
    expect(summary.recent.buckets[0].bucketStart).toBe('2030-06-01T17:55:00.000Z');
    expect(summary.recent.buckets.at(-1)!.bucketStart).toBe('2030-06-01T18:50:00.000Z');
    expect(summary.recent.buckets.filter((b) => b.admitted + b.denied > 0)).toEqual([
      { bucketStart: '2030-06-01T18:30:00.000Z', admitted: 2, denied: 1 },
      { bucketStart: '2030-06-01T18:35:00.000Z', admitted: 3, denied: 2 },
      { bucketStart: '2030-06-01T18:50:00.000Z', admitted: 0, denied: 9 }
    ]);

    const bursts = summary.alerts.filter((alert) => alert.kind === 'invalid_burst');
    expect(bursts).toEqual([expect.objectContaining({ scannerId: roam.id, count: 5, severity: 'warning' })]);
    // VIP 1 was seen at both gates; North 1 has been silent since 18:30 while the doors are open.
    expect(summary.alerts.map((alert) => alert.kind).sort()).toEqual(['capacity_near', 'device_idle', 'invalid_burst', 'multi_gate']);
    expect(summary.alerts.filter((alert) => alert.kind === 'device_idle')).toEqual([expect.objectContaining({ scannerId: n.id, count: 20, lastAt: '2030-06-01T18:30:00.000Z' })]);
    expect(summary.completion).toBeNull();

    // Outside the burst window the burst alert clears; recent activity rolls forward.
    h.clock.advance(61 * MINUTE);
    const later = await ops(event.id);
    expect(later.alerts.some((alert) => alert.kind === 'invalid_burst')).toBe(false);
    // VIP 1's two gates (18:30) are older than the 60-minute pattern window now.
    expect(later.alerts.some((alert) => alert.kind === 'multi_gate')).toBe(false);
    expect(later.recent.buckets.every((b) => b.admitted + b.denied === 0)).toBe(true);
  });

  it('warns about devices that went silent while the doors are open, and stops once the event ended', async () => {
    const { event, n, s, roam } = await scenario();
    h.clock.advance(11 * MINUTE); // 19:01: North last seen 18:30, South and Roaming 18:50
    await request(h.app).get('/api/scanner/session').set('Authorization', `Bearer ${s.key}`).expect(200); // heartbeat keeps South fresh
    const idle = (await ops(event.id)).alerts.filter((alert) => alert.kind === 'device_idle');
    expect(idle.map((alert) => [alert.scannerId, alert.count, alert.severity])).toEqual(
      expect.arrayContaining([
        [n.id, 31, 'warning'],
        [roam.id, 11, 'warning']
      ])
    );
    expect(idle).toHaveLength(2);

    await h.admin(api().patch(`/api/events/${event.id}`)).send({ status: 'ended' }).expect(200);
    const ended = await ops(event.id);
    expect(ended.phase).toBe('finished');
    expect(ended.alerts.some((alert) => alert.kind === 'device_idle')).toBe(false);
  });

  it('summarises a finished event', async () => {
    const { event } = await scenario();
    h.clock.advance(5 * 60 * MINUTE); // past the 23:00 end, still status active
    const summary = await ops(event.id);
    expect(summary.phase).toBe('finished');
    expect(summary.completion).toEqual({
      expected: 7,
      admitted: 5,
      noShows: 2,
      rate: 5 / 7,
      firstAdmissionAt: '2030-06-01T18:30:00.000Z',
      lastAdmissionAt: '2030-06-01T18:37:00.000Z',
      peak: { bucketStart: '2030-06-01T18:35:00.000Z', admitted: 3 },
      denied: 12,
      topDenial: { outcome: 'invalid', count: 9 },
      devicesUsed: 3,
      gatesUsed: 2
    });
  });

  it('derives the phase from status and the entry window, including early-entry policies', async () => {
    const upcoming = await post('/api/events', { ...EVENT_INPUT, startsAt: '2030-06-02T18:00:00.000Z', endsAt: '2030-06-02T20:00:00.000Z' });
    expect((await ops(upcoming.id)).phase).toBe('upcoming');
    const draft = await post('/api/events', { ...EVENT_INPUT, status: 'draft' });
    expect((await ops(draft.id)).phase).toBe('paused');
    // Starts at 19:00 but VIPs may enter from 18:00: at 18:30 the doors are open.
    const early = await post('/api/events', { ...EVENT_INPUT, startsAt: '2030-06-01T19:00:00.000Z' });
    expect((await ops(early.id)).phase).toBe('upcoming');
    await post(`/api/events/${early.id}/policies`, { name: 'VIP', opensAt: '2030-06-01T18:00:00.000Z' });
    expect((await ops(early.id)).phase).toBe('live');
    const empty = await ops(early.id);
    expect(empty.attendance).toEqual({ expected: 0, admitted: 0, rate: null });
    expect(empty.recent.buckets).toHaveLength(12);
    expect(empty.completion).toBeNull();
  });

  it('reports repeated duplicates and multi-gate passes for scans inside the pattern window only', async () => {
    const { event, n, s } = await scenario();
    // VIP 0: admitted at North at 18:30 and never scanned again.
    const { pass_id: vip0 } = h.db
      .prepare("SELECT pass_id FROM scans WHERE scanner_id = ? AND outcome = 'admitted' AND pass_id NOT IN (SELECT pass_id FROM scans WHERE outcome <> 'admitted' AND pass_id IS NOT NULL)")
      .get(n.id) as { pass_id: string };
    // Presented twice more at South at 18:49 and 18:50.
    const duplicate = h.db.prepare(
      "INSERT INTO scans (event_id, scanner_id, gate_id, pass_id, outcome, created_at) VALUES (?, ?, (SELECT gate_id FROM scanners WHERE id = ?), ?, 'already_redeemed', ?)"
    );
    for (const at of ['2030-06-01T18:49:00.000Z', '2030-06-01T18:50:00.000Z']) duplicate.run(event.id, s.id, s.id, vip0, at);
    const alertsFor = (iso: string) =>
      operationsSummary(h.db, h.service.access, h.service.getEvent(event.id), new Date(iso))
        .alerts.filter((alert) => alert.passId === vip0)
        .map((alert) => [alert.kind, alert.count]);

    expect(alertsFor('2030-06-01T18:50:00.000Z').sort()).toEqual([
      ['multi_gate', 2],
      ['repeated_duplicate', 2]
    ]);
    // 19:30 still includes 18:30 (the window is inclusive); at 19:31 the North admission has left it, both South duplicates have not.
    expect(alertsFor('2030-06-01T19:30:00.000Z').sort()).toEqual([
      ['multi_gate', 2],
      ['repeated_duplicate', 2]
    ]);
    expect(alertsFor('2030-06-01T19:31:00.000Z')).toEqual([['repeated_duplicate', 2]]);
    // 19:49:30: only the 18:50 duplicate is inside, and one is not a pattern.
    expect(alertsFor('2030-06-01T19:49:30.000Z')).toEqual([]);
    expect(ALERT_RULES.patternWindowMinutes).toBe(60);
  });

  it('memoizes the summary per event for up to 2 s, but recomputes at once after an admin change', async () => {
    const { event, n } = await scenario();
    const first = await ops(event.id);
    // Issuing passes writes an audit row for the event: recomputed immediately.
    const extra = await post(`/api/events/${event.id}/passes`, { count: 1 });
    const afterIssue = await ops(event.id);
    expect(afterIssue.passes.issued).toBe(first.passes.issued + 1);
    // A scan does not invalidate: the same summary (same generatedAt) is served until the memo expires.
    await scan(h, n.key, extra[0].token).expect(200);
    expect(await ops(event.id)).toEqual(afterIssue);
    h.clock.advance(OPERATIONS_MEMO_MS - 1);
    expect((await ops(event.id)).generatedAt).toBe(afterIssue.generatedAt);
    h.clock.advance(1);
    const fresh = await ops(event.id);
    expect(fresh.generatedAt).not.toBe(afterIssue.generatedAt);
    expect(fresh.totals.admitted).toBe(afterIssue.totals.admitted + 1);
    // A lifecycle change shows at once, without waiting for the memo.
    await h.admin(api().patch(`/api/events/${event.id}`)).send({ status: 'ended' }).expect(200);
    expect((await ops(event.id)).phase).toBe('finished');
  });
});

describe('operations dashboard at scale', () => {
  /** 10 000 passes, 6 000 admissions and 4 000 denied scans over three hours, written straight to the database. */
  function syntheticEvent() {
    const event = h.service.createEvent({ ...EVENT_INPUT, capacity: null }, 'test');
    const gates = ['A', 'B', 'C', 'D'].map((name) => h.service.access.createGate(event.id, name, 'test'));
    const general = h.service.access.createPolicy(event.id, { name: 'General' }, 'test');
    const scanners = Array.from({ length: 8 }, (_, i) => h.service.createScanner(event.id, `Door ${i}`, gates[i % 4].id, 'test').scanner);
    const start = Date.parse(EVENT_INPUT.startsAt);
    const at = (i: number) => new Date(start + Math.floor((i * 3 * 60 * MINUTE) / 10_000)).toISOString();
    const denied = ['invalid', 'already_redeemed', 'wrong_gate', 'too_early', 'expired', 'revoked'] as const;
    transaction(h.db, () => {
      const pass = h.db.prepare('INSERT INTO passes (id, event_id, policy_id, token_hash, attendee_name, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const redemption = h.db.prepare('INSERT INTO redemptions (pass_id, scanner_id, redeemed_at, gate_id, policy_id) VALUES (?, ?, ?, ?, ?)');
      const scanRow = h.db.prepare('INSERT INTO scans (event_id, scanner_id, gate_id, pass_id, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (let i = 0; i < 10_000; i += 1) {
        const id = randomUUID();
        const scanner = scanners[i % 8];
        pass.run(id, event.id, general.id, hashToken(`synthetic-${i}`), `Guest ${i}`, EVENT_INPUT.endsAt, EVENT_INPUT.startsAt);
        if (i < 6_000) {
          redemption.run(id, scanner.id, at(i), scanner.gateId, general.id);
          scanRow.run(event.id, scanner.id, scanner.gateId, id, 'admitted', at(i));
        } else {
          const outcome = denied[i % denied.length];
          scanRow.run(event.id, scanner.id, scanner.gateId, outcome === 'invalid' ? null : id, outcome, at(i));
        }
      }
      h.db.prepare('UPDATE events SET admitted_count = 6000 WHERE id = ?').run(event.id);
      h.db.prepare('UPDATE admission_policies SET admitted_count = 6000 WHERE id = ?').run(general.id);
    });
    return event;
  }

  it('answers from indexes on a 10k-pass event (EXPLAIN QUERY PLAN) within budget', () => {
    const created = syntheticEvent();
    const event = h.service.getEvent(created.id);

    // Capture every statement the dashboard runs, with its parameters, while live (20:30) and once finished (23:30).
    const statements: Array<{ sql: string; params: unknown[]; ms: number; at: 'live' | 'finished' }> = [];
    let phase: 'live' | 'finished' = 'live';
    const prepare = h.db.prepare.bind(h.db);
    h.db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      const record =
        (method: 'all' | 'get') =>
        (...params: never[]) => {
          const started = performance.now();
          const result = method === 'all' ? statement.all(...params) : statement.get(...params);
          statements.push({ sql, params, ms: performance.now() - started, at: phase });
          return result;
        };
      return { all: record('all'), get: record('get') };
    }) as typeof h.db.prepare;
    const live = operationsSummary(h.db, h.service.access, event, new Date('2030-06-01T20:30:00.000Z'));
    phase = 'finished';
    const finished = operationsSummary(h.db, h.service.access, event, new Date('2030-06-01T23:30:00.000Z'));
    h.db.prepare = prepare;

    expect(live.phase).toBe('live');
    expect(live.attendance).toEqual({ expected: 10_000, admitted: 6_000, rate: 0.6 });
    expect(live.totals).toEqual({ scans: 10_000, admitted: 6_000, denied: 4_000 });
    expect(live.gates.map((gate) => gate.admitted)).toEqual([1_500, 1_500, 1_500, 1_500]);
    expect(finished.completion).toMatchObject({ admitted: 6_000, noShows: 4_000, devicesUsed: 8, gatesUsed: 4, firstAdmissionAt: EVENT_INPUT.startsAt });

    const plans = statements.map(({ sql, params }) => ({
      sql: sql.replace(/\s+/g, ' ').slice(0, 90),
      plan: (h.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{ detail: string }>).map((row) => row.detail)
    }));
    for (const { sql, plan } of plans) {
      // Large tables are only ever searched through an index, never scanned in full.
      const fullScans = plan.filter((detail) => /^SCAN (scans|passes|redemptions|audit_log|s|p|r)\b/.test(detail) && !/USING (COVERING )?INDEX/.test(detail));
      expect(fullScans, `${sql}\n${plan.join('\n')}`).toEqual([]);
    }
    const recent = plans.find((entry) => entry.sql.includes("strftime('%s'"))!;
    expect(recent.plan.join('\n')).toMatch(/SEARCH scans USING (COVERING )?INDEX scans_alerts_idx \(event_id=\? AND outcome=\? AND created_at>\?\)/);
    const slowest = statements
      .filter((entry) => entry.at === 'live')
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 6)
      .map((entry) => ({ ms: Math.round(entry.ms * 10) / 10, sql: entry.sql.replace(/\s+/g, ' ').slice(0, 70) }));
    console.info(JSON.stringify({ msg: 'operations statements (live, first run)', slowest }));

    /** Median of 5 calls through the service; `fresh` moves the clock past the memo each time, so every call recomputes. */
    const median = (at: string, fresh: boolean) => {
      h.clock.current = new Date(at);
      h.service.operations(created.id);
      const runs: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        if (fresh) h.clock.advance(OPERATIONS_MEMO_MS);
        const started = performance.now();
        h.service.operations(created.id);
        runs.push(performance.now() - started);
      }
      return Math.round(runs.sort((a, b) => a - b)[2] * 100) / 100;
    };
    const timings = {
      liveMedianMs: median('2030-06-01T20:30:00.000Z', true),
      finishedMedianMs: median('2030-06-01T23:30:00.000Z', true),
      memoHitMedianMs: median('2030-06-01T20:30:00.000Z', false)
    };
    console.info(JSON.stringify({ msg: 'operations timing', passes: 10_000, scans: 10_000, ...timings }));
    // Generous ceilings for slow CI machines; the dashboard polls every 5 s.
    expect(Math.max(timings.liveMedianMs, timings.finishedMedianMs)).toBeLessThan(1_000);
    expect(timings.memoHitMedianMs).toBeLessThan(timings.liveMedianMs);
  });
});
