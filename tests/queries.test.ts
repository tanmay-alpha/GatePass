import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedEvent } from '../scripts/perf-dataset';
import { operationsEvent, operationsSummary } from '../src/server/operations';
import type { PassStatus } from '../src/shared/types';
import { createHarness, type Harness } from './helpers';

/**
 * The phase 5 query rewrites (docs/performance.md) must return exactly what the
 * previous SQL returned. Each test runs the previous statement next to the
 * service on a seeded event with a second event in the same file.
 */
let h: Harness;
beforeEach(() => {
  h = createHarness();
});
afterEach(() => h.close());

type Row = Record<string, unknown>;

function seed(passes = 700) {
  const main = seedEvent(h.db, { passes, now: h.clock.now(), seed: 7 });
  seedEvent(h.db, { passes: 150, now: h.clock.now(), seed: 8, name: 'Other event' });
  return main;
}

describe('operations summary rewrites', () => {
  it('buckets the timeline exactly as the strftime expression did', async () => {
    const { eventId } = seed();
    const previous = (
      h.db
        .prepare(
          `SELECT strftime('%Y-%m-%dT%H:', created_at) || printf('%02d', (CAST(strftime('%M', created_at) AS INTEGER) / 15) * 15) || ':00.000Z' AS bucket,
                  SUM(outcome = 'admitted') AS admitted, SUM(outcome <> 'admitted') AS denied
           FROM scans WHERE event_id = ? GROUP BY bucket ORDER BY bucket DESC LIMIT 96`
        )
        .all(eventId) as Row[]
    )
      .reverse()
      .map((row) => ({ bucketStart: row.bucket, admitted: Number(row.admitted), denied: Number(row.denied) }));
    const summary = await operationsSummary(h.db, h.service.access, operationsEvent(h.db, eventId), h.clock.now());
    expect(previous.length).toBeGreaterThan(5);
    expect(summary.timeline).toEqual(previous);
  });

  it('counts pass states as the redemption join did, before and after the passes expire', async () => {
    const { eventId } = seed();
    for (const at of [h.clock.now(), new Date(h.clock.now().getTime() + 7 * 3600_000)]) {
      const row = h.db
        .prepare(
          `SELECT COUNT(*) AS issued,
                  COALESCE(SUM(r.pass_id IS NOT NULL), 0) AS redeemed,
                  COALESCE(SUM(r.pass_id IS NULL AND p.revoked_at IS NOT NULL), 0) AS revoked,
                  COALESCE(SUM(r.pass_id IS NULL AND p.revoked_at IS NULL AND p.expires_at <= ?), 0) AS expired
           FROM passes p LEFT JOIN redemptions r ON r.pass_id = p.id WHERE p.event_id = ?`
        )
        .get(at.toISOString(), eventId) as Row;
      const [issued, redeemed, revoked, expired] = [row.issued, row.redeemed, row.revoked, row.expired].map(Number);
      const summary = await operationsSummary(h.db, h.service.access, operationsEvent(h.db, eventId), at);
      expect(summary.passes).toEqual({ issued, active: issued - redeemed - revoked - expired, redeemed, revoked, expired });
    }
  });

  it('lets other work run between its queries, and dashboards that miss the memo together share one computation', async () => {
    const { eventId } = seed();
    const order: string[] = [];
    const first = h.service.operations(eventId).then((summary) => (order.push('summary'), summary));
    const second = h.service.operations(eventId);
    setImmediate(() => order.push('queued request'));
    const [a, b] = await Promise.all([first, second]);
    expect(order).toEqual(['queued request', 'summary']);
    expect(b).toBe(a);
  });
});

describe('pass list rewrite', () => {
  it('returns the same page and total as the previous single statement for every filter combination', () => {
    const { eventId, policyIds, live } = seed();
    const now = h.clock.now().toISOString();
    const previous = (filter: { q?: string; status?: PassStatus; policyId?: string; limit?: number; offset?: number }) => {
      const q = filter.q ? `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
      const where = `WHERE p.event_id = :eventId
        AND (:q IS NULL OR p.attendee_name LIKE :q ESCAPE '\\' OR p.attendee_email LIKE :q ESCAPE '\\' OR p.id LIKE :q ESCAPE '\\')
        AND (:policyId IS NULL OR p.policy_id = :policyId)
        AND (:status IS NULL OR CASE WHEN r.redeemed_at IS NOT NULL THEN 'redeemed' WHEN p.revoked_at IS NOT NULL THEN 'revoked' WHEN p.expires_at <= :now THEN 'expired' ELSE 'active' END = :status)`;
      const params = { eventId, q, now, policyId: filter.policyId ?? null, status: filter.status ?? null };
      const from = 'FROM passes p LEFT JOIN redemptions r ON r.pass_id = p.id';
      const total = Number((h.db.prepare(`SELECT COUNT(*) AS n ${from} ${where}`).get(params) as Row).n);
      const ids = (
        h.db
          .prepare(`SELECT p.id ${from} ${where} ORDER BY p.created_at DESC, p.rowid DESC LIMIT :limit OFFSET :offset`)
          .all({ ...params, limit: filter.limit ?? 1000, offset: filter.offset ?? 0 }) as Row[]
      ).map((row) => row.id);
      return { total, ids };
    };
    const filters = [
      {},
      { limit: 50 },
      { limit: 50, offset: 650 },
      { q: 'Attendee 0001' },
      { q: 'attendee12@' },
      { q: live[3].passId.slice(0, 8) },
      { q: '100%_\\' },
      { q: 'Doe, "J"', limit: 20, offset: 5 },
      { status: 'active' as const, limit: 25, offset: 100 },
      { status: 'redeemed' as const },
      { status: 'revoked' as const },
      { status: 'expired' as const },
      { policyId: policyIds.vip },
      { policyId: policyIds.staff, status: 'redeemed' as const, q: 'example', limit: 10, offset: 3 }
    ];
    for (const filter of filters) {
      const { passes, total } = h.service.listPasses(eventId, filter);
      expect({ filter, total, ids: passes.map((pass) => pass.id) }).toEqual({ filter, ...previous(filter) });
    }
    // Pages carry the redemption details, not just the ids.
    const redeemed = h.service.listPasses(eventId, { status: 'redeemed', limit: 1 }).passes[0];
    expect(redeemed).toMatchObject({ status: 'redeemed', redeemedAt: expect.any(String), redeemedBy: expect.any(String) });
  });

  it('answers 404 for a missing event before any query', () => {
    expect(() => h.service.listPasses('missing')).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => h.service.listScans('missing')).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => h.service.listAudit('missing')).toThrow(expect.objectContaining({ status: 404 }));
  });
});
