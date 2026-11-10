import { afterEach, describe, expect, it } from 'vitest';
import { verifyDatabase } from '../src/server/integrity';
import { createHarness, EVENT_INPUT, type Harness } from './helpers';
import { count, redeemHistory, singlePassViolations, type RedeemJob } from './threads';

// Concurrency scenarios run against real worker threads, each with its own
// SQLite connection, released together by a barrier. Every test checks the
// persisted database (verifyDatabase invariants + row counts), not only the
// returned outcomes. These are repeatable correctness checks on one machine;
// they say nothing about throughput on the deployed host.

let h: Harness;
afterEach(() => h?.close());

/** Event whose window contains the real current time (workers use the real clock). */
function liveEvent(overrides: Partial<typeof EVENT_INPUT> & { capacity?: number } = {}) {
  h = createHarness({ now: () => new Date() });
  return h.service.createEvent(
    { ...EVENT_INPUT, startsAt: new Date(Date.now() - 3_600_000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString(), ...overrides },
    'test'
  );
}

function scannerFor(eventId: string, label: string, gateId: string | null = null) {
  const { scanner } = h.service.createScanner(eventId, label, gateId, 'test');
  return { id: scanner.id, eventId, gateId, label };
}

function rowCount(sql: string, ...params: Array<string | number>): number {
  return Number((h.db.prepare(sql).get(...params) as { n: number }).n);
}

describe.each([2, 25, 100])('%i simultaneous redemptions of one pass', (n) => {
  it('admits exactly once, persists one redemption, and yields a linearizable history', async () => {
    const event = liveEvent();
    const devices = Array.from({ length: Math.min(n, 5) }, (_, i) => scannerFor(event.id, `Door ${i + 1}`));
    const [pass] = h.service.issuePasses(event.id, { count: 1 }, 'test');
    const history = await redeemHistory(
      h.dbFile,
      Array.from({ length: n }, (_, i) => ({ code: i % 2 ? pass.passUrl : pass.token, scanner: devices[i % devices.length] }))
    );
    // With n separate connections (not the deployed model: production has one
    // process and one connection), waits beyond busy_timeout fail closed as
    // `busy` (HTTP 503, "not verified"). They must never admit.
    const busy = count(history.map((entry) => entry.outcome), 'busy');
    expect(singlePassViolations(history)).toEqual([]);
    expect(rowCount('SELECT COUNT(*) AS n FROM redemptions WHERE pass_id = ?', pass.id)).toBe(1);
    expect(rowCount("SELECT COUNT(*) AS n FROM scans WHERE pass_id = ? AND outcome = 'admitted'", pass.id)).toBe(1);
    expect(rowCount('SELECT COUNT(*) AS n FROM scans')).toBe(n - busy);
    if (busy) console.info(`${n} threads: ${busy} attempts failed closed with SQLITE_BUSY`);
    expect(verifyDatabase(h.db).violations).toEqual([]);
  }, 120_000);
});

describe('contention scenarios', () => {
  it('never exceeds a policy capacity or the event capacity when 40 passes race for 7 places', async () => {
    const event = liveEvent({ capacity: 10 });
    const policy = h.service.access.createPolicy(event.id, { name: 'Wave', capacity: 7 }, 'test');
    const devices = [scannerFor(event.id, 'A'), scannerFor(event.id, 'B'), scannerFor(event.id, 'C')];
    const limited = h.service.issuePasses(event.id, { count: 40, policyId: policy.id }, 'test');
    const outcomes = (await redeemHistory(h.dbFile, limited.map((pass, i) => ({ code: pass.token, scanner: devices[i % 3] })))).map((e) => e.outcome);
    expect(count(outcomes, 'admitted')).toBe(7);
    expect(count(outcomes, 'capacity_full')).toBe(33);
    expect(h.service.access.getPolicy(policy.id).admittedCount).toBe(7);
    expect(h.service.getEvent(event.id).admittedCount).toBe(7);
    expect(verifyDatabase(h.db).violations).toEqual([]);
  }, 120_000);

  it('event capacity binds across policies and unrestricted passes: 30 racers, 12 places', async () => {
    const event = liveEvent({ capacity: 12 });
    const vip = h.service.access.createPolicy(event.id, { name: 'VIP', capacity: 100 }, 'test');
    const door = scannerFor(event.id, 'Door');
    const passes = [...h.service.issuePasses(event.id, { count: 15 }, 'test'), ...h.service.issuePasses(event.id, { count: 15, policyId: vip.id }, 'test')];
    const outcomes = (await redeemHistory(h.dbFile, passes.map((pass) => ({ code: pass.token, scanner: door })))).map((e) => e.outcome);
    expect(count(outcomes, 'admitted')).toBe(12);
    expect(rowCount('SELECT COUNT(*) AS n FROM redemptions')).toBe(12);
    // Policy counter equals its own redemptions even though some VIP claims were undone by the event limit.
    expect(h.service.access.getPolicy(vip.id).admittedCount).toBe(rowCount('SELECT COUNT(*) AS n FROM redemptions WHERE policy_id = ?', vip.id));
    expect(verifyDatabase(h.db).violations).toEqual([]);
  }, 120_000);

  it('keeps overlapping events isolated: each event admits only its own passes', async () => {
    const first = liveEvent();
    const second = h.service.createEvent({ ...EVENT_INPUT, name: 'Second', startsAt: first.startsAt, endsAt: first.endsAt }, 'test');
    const doorA = scannerFor(first.id, 'A');
    const doorB = scannerFor(second.id, 'B');
    const passesA = h.service.issuePasses(first.id, { count: 10 }, 'test');
    const passesB = h.service.issuePasses(second.id, { count: 10 }, 'test');
    // Every pass is presented at both events' doors at once.
    const jobs: RedeemJob[] = [...passesA, ...passesB].flatMap((pass) => [
      { code: pass.token, scanner: doorA },
      { code: pass.token, scanner: doorB }
    ]);
    const history = await redeemHistory(h.dbFile, jobs);
    expect(count(history.map((e) => e.outcome), 'admitted')).toBe(20);
    expect(count(history.map((e) => e.outcome), 'invalid')).toBe(20); // wrong event is reported as invalid
    expect(rowCount('SELECT COUNT(*) AS n FROM redemptions r JOIN passes p ON p.id = r.pass_id JOIN scanners s ON s.id = r.scanner_id WHERE s.event_id <> p.event_id')).toBe(0);
    expect(verifyDatabase(h.db).violations).toEqual([]);
  }, 120_000);

  it('a transaction holding the write lock for 400 ms delays redemptions but never splits a pass', async () => {
    const event = liveEvent();
    const door = scannerFor(event.id, 'Door');
    const [pass] = h.service.issuePasses(event.id, { count: 1 }, 'test');
    const jobs: RedeemJob[] = [{ code: '', scanner: door, holdLockMs: 400 }, ...Array.from({ length: 10 }, () => ({ code: pass.token, scanner: door }))];
    const history = await redeemHistory(h.dbFile, jobs);
    const redemptions = history.filter((entry) => entry.outcome !== 'held_lock');
    expect(singlePassViolations(redemptions)).toEqual([]);
    expect(rowCount('SELECT COUNT(*) AS n FROM redemptions')).toBe(1);
  }, 120_000);

  it('the same request id sent from 10 threads at once yields one judgement and one scan row', async () => {
    const event = liveEvent();
    const door = scannerFor(event.id, 'Door');
    const [pass] = h.service.issuePasses(event.id, { count: 1 }, 'test');
    const history = await redeemHistory(h.dbFile, Array.from({ length: 10 }, () => ({ code: pass.token, scanner: door, requestId: 'same-attempt-0001' })));
    // Every duplicate of the request sees the stored answer of the first: admitted.
    expect(history.map((entry) => entry.outcome)).toEqual(Array(10).fill('admitted'));
    expect(rowCount('SELECT COUNT(*) AS n FROM scans')).toBe(1);
    expect(rowCount('SELECT COUNT(*) AS n FROM redemptions')).toBe(1);
  }, 120_000);

  it('revocation racing redemption: either the pass is admitted and stays unrevoked, or it is revoked and never admitted', async () => {
    const seen = new Set<string>();
    for (let round = 0; round < 6; round += 1) {
      const event = liveEvent();
      const door = scannerFor(event.id, 'Door');
      const [pass] = h.service.issuePasses(event.id, { count: 1 }, 'test');
      // The revoke is placed at a different position among the racers each round.
      const jobs: RedeemJob[] = Array.from({ length: 6 }, () => ({ code: pass.token, scanner: door }));
      jobs.splice(round, 0, { code: '', scanner: door, revokePassId: pass.id });
      const outcomes = (await redeemHistory(h.dbFile, jobs)).map((entry) => entry.outcome);
      const final = h.service.getPass(pass.id);
      if (final.status === 'redeemed') {
        expect(count(outcomes, 'admitted')).toBe(1);
        expect(outcomes).toContain('revoke_refused');
        expect(final.revokedAt).toBeNull();
      } else {
        expect(final.status).toBe('revoked');
        expect(outcomes).toContain('revoke_applied');
        expect(count(outcomes, 'admitted')).toBe(0);
      }
      seen.add(final.status);
      expect(verifyDatabase(h.db).violations).toEqual([]);
      h.close();
    }
    // Which side wins is up to the scheduler; both are valid serial orders.
    expect([...seen].every((status) => status === 'redeemed' || status === 'revoked')).toBe(true);
  }, 120_000);
});
