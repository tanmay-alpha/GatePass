import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASSIST_DAILY_LIMIT, maskEmail } from '../src/server/assist';
import { diagnosticPayload } from '../src/shared/diagnostic';
import { createHarness, enroll, scan, seedEvent, type Harness } from './helpers';

let h: Harness;
beforeEach(() => {
  h = createHarness();
});
afterEach(() => h.close());

const find = (key: string, q: string) => request(h.app).get('/api/scanner/attendees').query({ q }).set('Authorization', `Bearer ${key}`);

/** An event with a scanner and three named passes (two share a surname). */
async function door() {
  const seeded = await seedEvent(h, 1);
  const named = (
    await h
      .admin(request(h.app).post(`/api/events/${seeded.event.id}/passes`))
      .send({ attendees: [{ name: 'Ada Lovelace', email: 'ada.lovelace@example.org' }, { name: 'Byron Lovelace', email: 'byron@example.org' }, { name: 'Grace Hopper' }] })
      .expect(201)
  ).body as Array<{ id: string; token: string; passUrl: string; attendeeName: string }>;
  return { ...seeded, named };
}

const reference = (pass: { id: string }) => pass.id.slice(0, 8).toUpperCase();

describe('door attendee search', () => {
  it('finds passes of its own event by name fragment, reference prefix or exact email, with masked emails', async () => {
    const { scannerKey, named } = await door();
    const byName = (await find(scannerKey, 'lovel').expect(200)).body;
    expect(byName.more).toBe(false);
    expect(byName.matches.map((m: { attendeeName: string }) => m.attendeeName)).toEqual(['Ada Lovelace', 'Byron Lovelace']);
    expect(byName.matches[0]).toEqual({
      reference: reference(named[0]),
      attendeeName: 'Ada Lovelace',
      emailHint: 'a***@e***.org',
      status: 'active',
      redeemedAt: null,
      redeemedAtGate: null,
      policyName: null,
      check: { admit: true },
      ambiguous: false
    });

    const byReference = (await find(scannerKey, reference(named[2]).slice(0, 6).toLowerCase()).expect(200)).body;
    expect(byReference.matches[0].attendeeName).toBe('Grace Hopper');
    expect(byReference.matches[0].emailHint).toBeNull();

    const byEmail = (await find(scannerKey, 'BYRON@example.org').expect(200)).body;
    expect(byEmail.matches.map((m: { attendeeName: string }) => m.attendeeName)).toEqual(['Byron Lovelace']);
    // An email fragment is not an email search: no enumeration of addresses.
    expect((await find(scannerKey, 'example.org').expect(200)).body.matches).toEqual([]);
  });

  it('never returns tokens, token hashes, pass ids or full email addresses', async () => {
    const { scannerKey, named } = await door();
    const response = await find(scannerKey, 'Lovelace').expect(200);
    const text = JSON.stringify(response.body);
    for (const pass of named) {
      expect(text).not.toContain(pass.token);
      expect(text).not.toContain(pass.id);
    }
    expect(text).not.toContain('ada.lovelace@example.org');
    expect(text).not.toContain('byron@example.org');
    expect(text).not.toMatch(/[0-9a-f]{64}/); // no SHA-256 hash
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('requires at least 3 characters, and a search matching more than 10 passes shows none of them', async () => {
    const { event, scannerKey } = await door();
    expect((await find(scannerKey, 'ab').expect(400)).body.error).toContain('at least 3 characters');
    expect((await find(scannerKey, '  ab  ').expect(400)).body.error).toContain('at least 3 characters');
    await request(h.app).get('/api/scanner/attendees').set('Authorization', `Bearer ${scannerKey}`).expect(400);
    await h
      .admin(request(h.app).post(`/api/events/${event.id}/passes`))
      .send({ attendees: Array.from({ length: 12 }, (_, i) => ({ name: `Guest ${String(i).padStart(2, '0')}` })) })
      .expect(201);
    // Too broad to be one person: no names at all, only "refine the search". A door phone's key cannot page through the guest list.
    expect((await find(scannerKey, 'Guest').expect(200)).body).toEqual({ matches: [], more: true });
    const narrowed = (await find(scannerKey, 'guest 05').expect(200)).body;
    expect(narrowed.more).toBe(false);
    expect(narrowed.matches.map((m: { attendeeName: string }) => m.attendeeName)).toEqual(['Guest 05']);
    const audit = (await h.admin(request(h.app).get(`/api/events/${event.id}/audit`)).query({ action: 'scanner.attendee_lookup' }).expect(200)).body;
    expect(audit.map((entry: { details: unknown }) => entry.details)).toContainEqual({ results: 0, more: true, references: [] });
  });

  it('matches names from the start of a word only, every word of the query', async () => {
    const { event, scannerKey } = await door();
    await h.admin(request(h.app).post(`/api/events/${event.id}/passes`)).send({ attendees: [{ name: 'Jean-Luc Picard' }] }).expect(201);
    const names = async (q: string) => (await find(scannerKey, q).expect(200)).body.matches.map((m: { attendeeName: string }) => m.attendeeName);
    expect(await names('lov')).toEqual(['Ada Lovelace', 'Byron Lovelace']);
    expect(await names('LOVELACE ada')).toEqual(['Ada Lovelace']);
    expect(await names('ada lov')).toEqual(['Ada Lovelace']);
    expect(await names('luc')).toEqual(['Jean-Luc Picard']);
    // Fragments from the middle of a name do not match: no fishing with common letter runs.
    expect(await names('ove')).toEqual([]);
    expect(await names('ace')).toEqual([]);
    expect(await names('da ove')).toEqual([]);
  });

  it('matches a hyphenated name typed as written, and names starting with non-ASCII capitals, in any case', async () => {
    const { event, scannerKey } = await door();
    await h
      .admin(request(h.app).post(`/api/events/${event.id}/passes`))
      .send({ attendees: [{ name: 'Jean-Luc Picard' }, { name: 'Émile Zola' }, { name: 'Анна Каренина' }, { name: 'ŁUKASZ NOWAK' }] })
      .expect(201);
    const names = async (q: string) => (await find(scannerKey, q).expect(200)).body.matches.map((m: { attendeeName: string }) => m.attendeeName);
    expect(await names('Jean-Luc')).toEqual(['Jean-Luc Picard']);
    expect(await names('jean-luc pic')).toEqual(['Jean-Luc Picard']);
    expect(await names('Émile')).toEqual(['Émile Zola']);
    expect(await names('émile zo')).toEqual(['Émile Zola']);
    expect(await names('Анна')).toEqual(['Анна Каренина']);
    expect(await names('карен')).toEqual(['Анна Каренина']);
    expect(await names('łukasz')).toEqual(['ŁUKASZ NOWAK']);
    // Still word starts only.
    expect(await names('mile')).toEqual([]);
    expect(await names('арен')).toEqual([]);
  });

  it('refuses a whitespace-only query like a short one', async () => {
    const { scannerKey } = await door();
    expect((await find(scannerKey, '      ').expect(400)).body.error).toContain('at least 3 characters');
    expect((await find(scannerKey, '\t\t\t\t').expect(400)).body.error).toContain('at least 3 characters');
  });

  it('answers adversarial queries without errors, wildcards or matches from other events', async () => {
    const { scannerKey } = await door();
    for (const q of ['%%%', '___', '\\\\\\', "'; DROP TABLE passes; --", 'x'.repeat(100), '🙂🙂🙂', 'Ādá Łovelace', 'a b c d e f g h i j k', '%a%', 'a_a', '---', '-- --']) {
      const body = (await find(scannerKey, q).expect(200)).body;
      expect(body, q).toEqual({ matches: [], more: false });
    }
    await find(scannerKey, 'x'.repeat(101)).expect(400);
  });

  it('marks passes sharing a printed reference as ambiguous, and the reference admits neither', async () => {
    const { event, scannerKey, named } = await door();
    // A second pass whose id starts with the same 8 characters (1 in 4 billion by chance; forced here).
    const twin = `${named[2].id.slice(0, 8)}-0000-4000-8000-000000000000`;
    h.db
      .prepare('INSERT INTO passes (id, event_id, token_hash, attendee_name, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(twin, event.id, 'f'.repeat(64), 'Grace Twin', '2030-06-02T00:00:00.000Z', h.clock.current.toISOString());
    const found = (await find(scannerKey, reference(named[2])).expect(200)).body.matches;
    expect(found.map((m: { attendeeName: string; ambiguous: boolean }) => [m.attendeeName, m.ambiguous])).toEqual([
      ['Grace Hopper', true],
      ['Grace Twin', true]
    ]);
    expect((await scan(h, scannerKey, reference(named[2])).expect(200)).body.outcome).toBe('invalid');
    expect((await h.admin(request(h.app).get(`/api/events/${event.id}`)).expect(200)).body.redeemedCount).toBe(0);
  });

  it('allows each device 300 searches in any 24 hours, counted from the audit log; then 429 with a door message', async () => {
    const { event, scannerKey, scannerId, named } = await door();
    const scanner = h.service.authenticateScanner(scannerKey)!;
    for (let i = 0; i < ASSIST_DAILY_LIMIT - 1; i++) h.service.assist.search(scanner, 'Grace');
    h.clock.advance(3_600_000);
    await find(scannerKey, 'Grace').expect(200);
    const refused = await find(scannerKey, 'Grace').expect(429);
    expect(refused.body.error).toContain('used its 300 attendee searches for the last 24 hours');
    // The first 299 searches stop counting 23 hours from now.
    expect(Number(refused.headers['retry-after'])).toBe(23 * 3600);
    // Refusals are not searches: nothing more is logged or counted.
    const logged = () => Number((h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'scanner.attendee_lookup' AND entity_id = ?").get(scannerId) as { n: number }).n);
    expect(logged()).toBe(ASSIST_DAILY_LIMIT);
    // Another device keeps its own budget, and this one still admits by reference.
    const second = (await h.admin(request(h.app).post(`/api/events/${event.id}/scanners`)).send({ label: 'Door 2' }).expect(201)).body;
    await find(await enroll(h.app, second), 'Grace').expect(200);
    expect((await scan(h, scannerKey, reference(named[2])).expect(200)).body.outcome).toBe('admitted');
    // A day after the first searches, they stop counting.
    h.clock.advance(23 * 3_600_000);
    await find(scannerKey, 'Grace').expect(200);
    expect(logged()).toBe(ASSIST_DAILY_LIMIT + 1);
  });

  it('reads passes without holding the write lock; only the audit row is written', async () => {
    const { scannerKey } = await door();
    const prepare = h.db.prepare.bind(h.db);
    const states: Array<[string, boolean]> = [];
    vi.spyOn(h.db, 'prepare').mockImplementation((sql: string) => {
      states.push([sql.includes('INSERT INTO audit_log') ? 'audit' : sql.includes('FROM passes p') ? 'search' : 'other', h.db.isTransaction]);
      return prepare(sql);
    });
    await find(scannerKey, 'Grace').expect(200);
    expect(states.filter(([what]) => what !== 'other')).toEqual([
      ['search', false],
      ['audit', true]
    ]);
  });

  it('treats LIKE wildcards literally', async () => {
    const { scannerKey } = await door();
    expect((await find(scannerKey, '%%%').expect(200)).body.matches).toEqual([]);
    expect((await find(scannerKey, '___').expect(200)).body.matches).toEqual([]);
  });

  it('isolates events: a scanner never sees another event’s passes, by name, email or reference', async () => {
    const a = await door();
    const other = (await h.admin(request(h.app).post('/api/events')).send({ name: 'Other', startsAt: '2030-06-01T18:00:00.000Z', endsAt: '2030-06-01T23:00:00.000Z' }).expect(201)).body;
    const foreign = (
      await h
        .admin(request(h.app).post(`/api/events/${other.id}/passes`))
        .send({ attendees: [{ name: 'Zelda Foreign', email: 'zelda@example.org' }] })
        .expect(201)
    ).body[0];
    expect((await find(a.scannerKey, 'Zelda').expect(200)).body.matches).toEqual([]);
    expect((await find(a.scannerKey, 'zelda@example.org').expect(200)).body.matches).toEqual([]);
    expect((await find(a.scannerKey, reference(foreign)).expect(200)).body.matches).toEqual([]);
    // Nor can it admit the foreign pass by reference.
    expect((await scan(h, a.scannerKey, reference(foreign)).expect(200)).body.outcome).toBe('invalid');
  });

  it('refuses unauthenticated and revoked scanners with 401', async () => {
    const { scannerKey, scannerId } = await door();
    await request(h.app).get('/api/scanner/attendees').query({ q: 'Ada' }).expect(401);
    await find('gps_not-a-real-key', 'Ada').expect(401);
    await h.admin(request(h.app).post(`/api/scanners/${scannerId}/revoke`)).expect(200);
    await find(scannerKey, 'Ada').expect(401);
  });

  it('is rate limited per device', async () => {
    const { scannerKey, event } = await door();
    for (let i = 0; i < 30; i++) await find(scannerKey, 'Ada').expect(200);
    await find(scannerKey, 'Ada').expect(429);
    // Another device at the same venue keeps its own budget.
    const second = (await h.admin(request(h.app).post(`/api/events/${event.id}/scanners`)).send({ label: 'Door 2' }).expect(201)).body;
    await find(await enroll(h.app, second), 'Ada').expect(200);
  });

  it('shows used, revoked and wrong-gate states with the same rules as a scan', async () => {
    const { event, scannerKey, named } = await door();
    await scan(h, scannerKey, named[0].passUrl).expect(200);
    await h.admin(request(h.app).post(`/api/passes/${named[1].id}/revoke`)).expect(200);
    const found = (await find(scannerKey, 'Lovelace').expect(200)).body.matches;
    expect(found[0]).toMatchObject({ status: 'redeemed', redeemedAt: h.clock.current.toISOString(), check: { admit: false, outcome: 'already_redeemed', detail: { sameDevice: true } } });
    expect(found[1]).toMatchObject({ status: 'revoked', check: { admit: false, outcome: 'revoked' } });

    const north = (await h.admin(request(h.app).post(`/api/events/${event.id}/gates`)).send({ name: 'North' }).expect(201)).body;
    const south = (await h.admin(request(h.app).post(`/api/events/${event.id}/gates`)).send({ name: 'South' }).expect(201)).body;
    const vip = (await h.admin(request(h.app).post(`/api/events/${event.id}/policies`)).send({ name: 'VIP', gateIds: [north.id] }).expect(201)).body;
    await h.admin(request(h.app).patch(`/api/passes/${named[2].id}`)).send({ policyId: vip.id }).expect(200);
    const southDoor = (await h.admin(request(h.app).post(`/api/events/${event.id}/scanners`)).send({ label: 'South door', gateId: south.id }).expect(201)).body;
    const southKey = await enroll(h.app, southDoor);
    const grace = (await find(southKey, 'Grace').expect(200)).body.matches[0];
    expect(grace).toMatchObject({ policyName: 'VIP', check: { admit: false, outcome: 'wrong_gate', detail: { allowedGates: ['North'] } } });
    expect((await scan(h, southKey, grace.reference).expect(200)).body.outcome).toBe('wrong_gate');
  });

  it('assisted admit goes through redeem: admitted once, recorded in the scan feed, and a second admit is refused as already used', async () => {
    const { event, scannerKey, named } = await door();
    const match = (await find(scannerKey, 'Grace').expect(200)).body.matches[0];
    const admit = (requestId: string) =>
      request(h.app).post('/api/scanner/redeem').set('Authorization', `Bearer ${scannerKey}`).send({ code: match.reference, requestId });

    const first = (await admit('assist-0001').expect(200)).body;
    expect(first).toMatchObject({ outcome: 'admitted', pass: { id: named[2].id, attendeeName: 'Grace Hopper' } });
    // A retry of the same request is the stored answer, not a second admission.
    expect((await admit('assist-0001').expect(200)).body).toMatchObject({ outcome: 'admitted', replayed: true, scanId: first.scanId });
    expect((await admit('assist-0002').expect(200)).body.outcome).toBe('already_redeemed');

    const scans = (await h.admin(request(h.app).get(`/api/events/${event.id}/scans`)).expect(200)).body;
    expect(scans.map((s: { passId: string; outcome: string }) => [s.passId, s.outcome])).toEqual([
      [named[2].id, 'already_redeemed'],
      [named[2].id, 'admitted']
    ]);
    const summary = (await h.admin(request(h.app).get(`/api/events/${event.id}`)).expect(200)).body;
    expect(summary.redeemedCount).toBe(1);
    expect((await find(scannerKey, 'Grace').expect(200)).body.matches[0]).toMatchObject({ status: 'redeemed', check: { outcome: 'already_redeemed' } });
  });

  it('records each search in the audit log with result references only, never the query text', async () => {
    const { event, scannerKey, named } = await door();
    await find(scannerKey, 'Hopper').expect(200);
    const audit = (await h.admin(request(h.app).get(`/api/events/${event.id}/audit`)).query({ action: 'scanner.attendee_lookup' }).expect(200)).body;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorLabel: 'Door 1', details: { results: 1, more: false, references: [reference(named[2])] } });
    expect(JSON.stringify(audit[0])).not.toContain('Hopper');
  });

  it('masks email addresses', () => {
    expect(maskEmail('ada@example.org')).toBe('a***@e***.org');
    expect(maskEmail('x@localhost')).toBe('x***@l***');
    expect(maskEmail(null)).toBeNull();
  });
});

describe('diagnostic test codes', () => {
  it('can never admit: the server answers invalid and creates no admission, whatever follows the prefix', async () => {
    const { event, passes, scannerKey } = await seedEvent(h, 1);
    const codes = [
      diagnosticPayload('nonce-1234567890'),
      'GATEPASS:DIAGNOSTIC:v1:abcdefgh',
      // A crafted test code that embeds a real pass link is still only a test code.
      `gatepass:diagnostic:v1:${passes[0].passUrl}`,
      `gatepass:diagnostic:${passes[0].token}`
    ];
    for (const code of codes) {
      const result = (await scan(h, scannerKey, code).expect(200)).body;
      expect(result.outcome).toBe('invalid');
      expect(result.pass).toBeUndefined();
    }
    const summary = (await h.admin(request(h.app).get(`/api/events/${event.id}`)).expect(200)).body;
    expect(summary.redeemedCount).toBe(0);
    expect((await scan(h, scannerKey, passes[0].passUrl).expect(200)).body.outcome).toBe('admitted');
  });

  it('the session reports the server time for the readiness check', async () => {
    const { scannerKey } = await seedEvent(h, 1);
    const session = (await request(h.app).get('/api/scanner/session').set('Authorization', `Bearer ${scannerKey}`).expect(200)).body;
    expect(session.serverTime).toBe(h.clock.current.toISOString());
    expect(session.event).toMatchObject({ status: 'active', startsAt: '2030-06-01T18:00:00.000Z' });
  });
});

describe('scan method (camera, manual, lookup)', () => {
  const redeem = (key: string, body: Record<string, unknown>) => request(h.app).post('/api/scanner/redeem').set('Authorization', `Bearer ${key}`).send(body);
  const feed = async (eventId: string) =>
    ((await h.admin(request(h.app).get(`/api/events/${eventId}/scans`)).expect(200)).body as Array<{ passId: string; outcome: string; method: string | null }>).map((s) => [
      s.passId,
      s.outcome,
      s.method
    ]);

  it('is stored on the scan row, listed in the feed and exported; absent means null', async () => {
    const { event, scannerKey, passes } = await seedEvent(h, 4);
    await redeem(scannerKey, { code: passes[0].passUrl, method: 'camera' }).expect(200);
    await redeem(scannerKey, { code: passes[1].token, method: 'manual' }).expect(200);
    await redeem(scannerKey, { code: reference(passes[2]), method: 'lookup' }).expect(200);
    await redeem(scannerKey, { code: passes[3].passUrl }).expect(200);
    expect(await feed(event.id)).toEqual([
      [passes[3].id, 'admitted', null],
      [passes[2].id, 'admitted', 'lookup'],
      [passes[1].id, 'admitted', 'manual'],
      [passes[0].id, 'admitted', 'camera']
    ]);
    const csv = (await h.admin(request(h.app).get(`/api/events/${event.id}/exports/scans.csv`)).expect(200)).text.trim().split(/\r?\n/);
    expect(csv[0].split(',').at(-1)).toBe('method');
    expect(csv.slice(1).map((line) => line.split(',').at(-1))).toEqual(['camera', 'manual', 'lookup', '']);
  });

  it('rejects an unknown method with 400 and records nothing', async () => {
    const { event, scannerKey, passes } = await seedEvent(h, 1);
    for (const method of ['override', 'LOOKUP', '', 1, null]) {
      expect((await redeem(scannerKey, { code: passes[0].passUrl, method }).expect(400)).body.error).toMatch(/^method: /);
    }
    expect(await feed(event.id)).toEqual([]);
    // The database refuses it too, for callers that skip the route's validation.
    const scanner = h.service.authenticateScanner(scannerKey)!;
    expect(() => h.service.redeem(scanner, passes[0].passUrl, undefined, 'override' as never)).toThrow(/CHECK constraint/);
    expect((await h.admin(request(h.app).get(`/api/events/${event.id}`)).expect(200)).body.redeemedCount).toBe(0);
  });

  it('a replayed request keeps the method of the first attempt', async () => {
    const { event, scannerKey, passes } = await seedEvent(h, 1);
    const first = (await redeem(scannerKey, { code: passes[0].passUrl, requestId: 'retry-0001', method: 'camera' }).expect(200)).body;
    const again = (await redeem(scannerKey, { code: passes[0].passUrl, requestId: 'retry-0001', method: 'manual' }).expect(200)).body;
    expect(again).toMatchObject({ outcome: 'admitted', replayed: true, scanId: first.scanId });
    expect(await feed(event.id)).toEqual([[passes[0].id, 'admitted', 'camera']]);
  });

  it('changes nothing about admission: lookup admits are refused on duplicates and full capacity, and counted only when admitted', async () => {
    const { event, scannerKey, passes } = await seedEvent(h, 2);
    await h.admin(request(h.app).patch(`/api/events/${event.id}`)).send({ capacity: 1 }).expect(200);
    expect((await redeem(scannerKey, { code: reference(passes[0]), method: 'lookup' }).expect(200)).body.outcome).toBe('admitted');
    expect((await redeem(scannerKey, { code: reference(passes[0]), method: 'lookup' }).expect(200)).body.outcome).toBe('already_redeemed');
    expect((await redeem(scannerKey, { code: reference(passes[1]), method: 'lookup' }).expect(200)).body.outcome).toBe('capacity_full');
    expect((await redeem(scannerKey, { code: passes[1].passUrl, method: 'camera' }).expect(200)).body.outcome).toBe('capacity_full');
    const summary = (await h.admin(request(h.app).get(`/api/events/${event.id}`)).expect(200)).body;
    expect(summary).toMatchObject({ redeemedCount: 1 });
    const operations = (await h.admin(request(h.app).get(`/api/events/${event.id}/operations`)).expect(200)).body;
    expect(operations.assistedAdmissions).toBe(1);
    expect(operations.totals).toMatchObject({ scans: 4, admitted: 1 });
  });

  it('changes nothing about the other rules either: a lookup admit is refused for revoked passes, outside the entry window and when check-in is closed', async () => {
    const { event, scannerKey, passes } = await seedEvent(h, 3);
    const lookup = async (pass: { id: string }) => (await redeem(scannerKey, { code: reference(pass), method: 'lookup' }).expect(200)).body.outcome;
    await h.admin(request(h.app).post(`/api/passes/${passes[0].id}/revoke`)).expect(200);
    expect(await lookup(passes[0])).toBe('revoked');
    const later = (await h.admin(request(h.app).post(`/api/events/${event.id}/policies`)).send({ name: 'Late entry', opensAt: '2030-06-01T21:00:00.000Z' }).expect(201)).body;
    await h.admin(request(h.app).patch(`/api/passes/${passes[1].id}`)).send({ policyId: later.id }).expect(200);
    expect(await lookup(passes[1])).toBe('too_early');
    await h.admin(request(h.app).patch(`/api/events/${event.id}`)).send({ status: 'ended' }).expect(200);
    expect(await lookup(passes[2])).toBe('event_closed');
    expect((await h.admin(request(h.app).get(`/api/events/${event.id}`)).expect(200)).body.redeemedCount).toBe(0);
    // The door's search shows the same refusals, before anyone presses Admit.
    const found = (await request(h.app).get('/api/scanner/attendees').query({ q: reference(passes[1]) }).set('Authorization', `Bearer ${scannerKey}`).expect(200)).body.matches;
    expect(found[0].check).toEqual({ admit: false, outcome: 'event_closed' });
  });
});
