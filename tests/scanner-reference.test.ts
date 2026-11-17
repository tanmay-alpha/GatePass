import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, seedEvent, type Harness } from './helpers';

let h: Harness;
beforeEach(() => {
  h = createHarness();
});
afterEach(() => h.close());

/**
 * The plan SQLite chooses for every statement run while `act` runs, for statements touching `passes`.
 * Without ANALYZE statistics the planner prefers `passes_event_idx (event_id=?)` over the id range,
 * which reads every pass of the event: at 25,000 passes about 14 ms per reference scan inside the
 * write lock, against 0.02 ms on the id range (Phase 5 benchmark).
 */
async function passPlans(act: () => Promise<unknown>): Promise<string[]> {
  const prepare = h.db.prepare.bind(h.db);
  const statements: string[] = [];
  const spy = vi.spyOn(h.db, 'prepare').mockImplementation((sql: string) => {
    if (/\bpasses\s+[op]\b/.test(sql) && /\.id\s*>=/.test(sql)) statements.push(sql);
    return prepare(sql);
  });
  await act();
  spy.mockRestore();
  return statements.flatMap((sql) => {
    const parameters = (sql.match(/\?/g) ?? []).map(() => 'x');
    const named = Object.fromEntries([...sql.matchAll(/:(\w+)/g)].map(([, name]) => [name, 'x']));
    const plan = (Object.keys(named).length ? h.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(named) : h.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters)) as Array<{ detail: string }>;
    return plan.map((row) => row.detail);
  });
}

describe('pass references (the 8 characters printed under the QR code)', () => {
  it('a reference scan reads the id range, not every pass of the event', async () => {
    const { scannerKey, passes } = await seedEvent(h, 3);
    const plans = await passPlans(() =>
      request(h.app).post('/api/scanner/redeem').set('Authorization', `Bearer ${scannerKey}`).send({ code: passes[0].id.slice(0, 8).toUpperCase() }).expect(200)
    );
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.filter((detail) => detail.includes('passes_event_idx'))).toEqual([]);
    expect(plans.some((detail) => /\(id>\? AND id<\?\)/.test(detail))).toBe(true);
  });

  it('the door search counts passes sharing a reference on the id range too', async () => {
    const { scannerKey } = await seedEvent(h, 3);
    await h.service.issuePasses(h.service.authenticateScanner(scannerKey)!.eventId, { attendees: [{ name: 'Ada Lovelace' }] }, 'test');
    const plans = await passPlans(() => request(h.app).get('/api/scanner/attendees').query({ q: 'Ada' }).set('Authorization', `Bearer ${scannerKey}`).expect(200));
    // The outer search scans the event (names cannot use an index); the correlated reference count must not.
    const correlated = plans.slice(plans.findIndex((detail) => detail.startsWith('CORRELATED')));
    expect(correlated.filter((detail) => detail.includes('passes_event_idx'))).toEqual([]);
  });
});

describe('door search budget', () => {
  it("counts the device's lookups of the last day on the lookup index, not every audit row of the event", async () => {
    const { scannerKey } = await seedEvent(h, 3);
    const prepare = h.db.prepare.bind(h.db);
    const budget: string[] = [];
    const spy = vi.spyOn(h.db, 'prepare').mockImplementation((sql: string) => {
      if (/FROM audit_log/.test(sql) && /attendee_lookup/.test(sql) && /COUNT\(\*\)/.test(sql)) budget.push(sql);
      return prepare(sql);
    });
    await request(h.app).get('/api/scanner/attendees').query({ q: 'Ada' }).set('Authorization', `Bearer ${scannerKey}`).expect(200);
    spy.mockRestore();
    expect(budget).toHaveLength(1);
    const plan = (h.db.prepare(`EXPLAIN QUERY PLAN ${budget[0]}`).all('x', 'x', 'x') as Array<{ detail: string }>).map((row) => row.detail);
    expect(plan.join('\n')).toContain('audit_lookup_idx');
  });
});
