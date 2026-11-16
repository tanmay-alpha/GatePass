import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyDatabase } from '../src/server/integrity';
import { createHarness, enroll, EVENT_INPUT, scan, seedEvent, setupCode, type Harness } from './helpers';

let h: Harness;
beforeEach(() => {
  h = createHarness();
});
afterEach(() => h.close());

const admin = (method: 'get' | 'post' | 'patch' | 'delete', path: string) => h.admin(request(h.app)[method](path));

describe('event lifecycle, time zone and capacity', () => {
  it('admits only while active and allows only the documented status moves', async () => {
    const event = (await admin('post', '/api/events').send({ ...EVENT_INPUT, status: 'draft' }).expect(201)).body;
    const scanner = { key: await enroll(h.app, (await admin('post', `/api/events/${event.id}/scanners`).send({ label: 'Door' }).expect(201)).body) };
    const [first, second] = (await admin('post', `/api/events/${event.id}/passes`).send({ count: 2 }).expect(201)).body;
    expect((await scan(h, scanner.key, first.token).expect(200)).body.outcome).toBe('event_closed');

    await admin('patch', `/api/events/${event.id}`).send({ status: 'ended' }).expect(409); // draft → ended is not a move
    await admin('patch', `/api/events/${event.id}`).send({ status: 'active' }).expect(200);
    expect((await scan(h, scanner.key, first.token).expect(200)).body.outcome).toBe('admitted');
    await admin('patch', `/api/events/${event.id}`).send({ status: 'ended' }).expect(200);
    expect((await scan(h, scanner.key, second.token).expect(200)).body.outcome).toBe('event_closed');
    await admin('post', `/api/events/${event.id}/passes`).send({ count: 1 }).expect(409);
    await admin('patch', `/api/events/${event.id}`).send({ status: 'archived' }).expect(200);
    await admin('patch', `/api/events/${event.id}`).send({ name: 'Renamed' }).expect(409); // archived is read-only
    await admin('patch', `/api/events/${event.id}`).send({ status: 'ended' }).expect(200);
    const actions = (await admin('get', `/api/events/${event.id}/audit?action=event.status_changed`).expect(200)).body;
    expect(actions.map((entry: { details: { status: { to: string } } }) => entry.details.status.to)).toEqual(['ended', 'archived', 'ended', 'active']);
  });

  it('validates IANA time zones and keeps instants in UTC', async () => {
    await admin('post', '/api/events').send({ ...EVENT_INPUT, timeZone: 'Mars/Olympus' }).expect(400);
    const event = (await admin('post', '/api/events').send({ ...EVENT_INPUT, timeZone: 'Asia/Kolkata', startsAt: '2030-06-01T23:30:00+05:30' }).expect(201)).body;
    expect(event).toMatchObject({ timeZone: 'Asia/Kolkata', startsAt: '2030-06-01T18:00:00.000Z' });
  });

  it('enforces an event-wide capacity across policies and refuses lowering it below admissions', async () => {
    const event = (await admin('post', '/api/events').send({ ...EVENT_INPUT, capacity: 2 }).expect(201)).body;
    const vip = (await admin('post', `/api/events/${event.id}/policies`).send({ name: 'VIP', capacity: 10 }).expect(201)).body;
    const scanner = { key: await enroll(h.app, (await admin('post', `/api/events/${event.id}/scanners`).send({ label: 'Door' }).expect(201)).body) };
    const general = (await admin('post', `/api/events/${event.id}/passes`).send({ count: 2 }).expect(201)).body;
    const [vipPass] = (await admin('post', `/api/events/${event.id}/passes`).send({ count: 1, policyId: vip.id }).expect(201)).body;
    for (const pass of general) expect((await scan(h, scanner.key, pass.token)).body.outcome).toBe('admitted');
    const full = (await scan(h, scanner.key, vipPass.token).expect(200)).body;
    expect(full).toMatchObject({ outcome: 'capacity_full', detail: { capacity: 2, eventCapacity: true } });
    // The VIP policy counter was not consumed by the refused admission.
    expect(h.service.access.getPolicy(vip.id).admittedCount).toBe(0);
    await admin('patch', `/api/events/${event.id}`).send({ capacity: 1 }).expect(409);
    await admin('patch', `/api/events/${event.id}`).send({ capacity: 3 }).expect(200);
    expect((await scan(h, scanner.key, vipPass.token)).body.outcome).toBe('admitted');
    expect(verifyDatabase(h.db)).toMatchObject({ ok: true, violations: [] });
  });

  it('clones configuration into a draft with policy windows shifted, without passes, scanners or team', async () => {
    const source = (await admin('post', '/api/events').send({ ...EVENT_INPUT, capacity: 50, timeZone: 'Europe/London' }).expect(201)).body;
    const gate = (await admin('post', `/api/events/${source.id}/gates`).send({ name: 'North' }).expect(201)).body;
    await admin('post', `/api/events/${source.id}/policies`).send({ name: 'Early', opensAt: '2030-06-01T17:00:00.000Z', closesAt: '2030-06-01T19:00:00.000Z', capacity: 5, gateIds: [gate.id] }).expect(201);
    await admin('post', `/api/events/${source.id}/passes`).send({ count: 3 }).expect(201);
    await admin('post', `/api/events/${source.id}/scanners`).send({ label: 'Door' }).expect(201);

    const copy = (await admin('post', `/api/events/${source.id}/clone`).send({ name: 'Next week', startsAt: '2030-06-08T18:00:00.000Z', endsAt: '2030-06-08T23:00:00.000Z' }).expect(201)).body;
    expect(copy).toMatchObject({ status: 'draft', capacity: 50, timeZone: 'Europe/London', passCount: 0, scannerCount: 0, gateCount: 1, policyCount: 1 });
    const [policy] = (await admin('get', `/api/events/${copy.id}/policies`).expect(200)).body;
    const [copiedGate] = (await admin('get', `/api/events/${copy.id}/gates`).expect(200)).body;
    expect(policy).toMatchObject({ name: 'Early', opensAt: '2030-06-08T17:00:00.000Z', closesAt: '2030-06-08T19:00:00.000Z', capacity: 5, admittedCount: 0, gateIds: [copiedGate.id] });
    expect(copiedGate.id).not.toBe(gate.id);
  });
});

describe('attendee import and pass management', () => {
  it('previews validation and duplicates without writing, then issues exactly the accepted rows', async () => {
    const { event } = await seedEvent(h, 1);
    await admin('post', `/api/events/${event.id}/passes`).send({ attendees: [{ name: 'Existing', email: 'existing@example.com' }] }).expect(201);
    const rows = [
      { name: 'Ada', email: 'ada@example.com' },
      { name: 'Ada again', email: 'ADA@example.com' },
      { name: 'Bad', email: 'not-an-email' },
      { name: '', email: '' },
      { name: 'Existing', email: 'existing@example.com' },
      { name: '=HYPERLINK("http://evil")', email: null },
      { name: 'x'.repeat(201), email: null }
    ];
    const before = h.service.listPasses(event.id).total;
    const preview = (await admin('post', `/api/events/${event.id}/passes/import`).send({ rows, dryRun: true }).expect(200)).body;
    expect(preview).toEqual({
      dryRun: true,
      accepted: 2,
      rejected: [
        { row: 2, reason: 'duplicate_in_file', detail: 'ADA@example.com' },
        { row: 3, reason: 'invalid_email', detail: 'not-an-email' },
        { row: 4, reason: 'empty', detail: 'No name or email' },
        { row: 5, reason: 'already_has_pass', detail: 'existing@example.com' },
        { row: 7, reason: 'too_long', detail: 'Name over 200 or email over 254 characters' }
      ]
    });
    expect(h.service.listPasses(event.id).total).toBe(before);

    const result = (await admin('post', `/api/events/${event.id}/passes/import`).send({ rows, dryRun: false }).expect(201)).body;
    expect(result.issued.map((pass: { attendeeName: string }) => pass.attendeeName)).toEqual(['Ada', '=HYPERLINK("http://evil")']);
    expect(h.service.listPasses(event.id).total).toBe(before + 2);
    // Importing the same file again issues nothing new.
    expect((await admin('post', `/api/events/${event.id}/passes/import`).send({ rows, dryRun: false }).expect(201)).body.accepted).toBe(1);
  });

  it('pages and filters passes in SQL with a total count', async () => {
    const { event, scannerKey, passes } = await seedEvent(h, 5);
    await scan(h, scannerKey, passes[0].token).expect(200);
    const page = await admin('get', `/api/events/${event.id}/passes?limit=2&offset=2`).expect(200);
    expect(page.headers['x-total-count']).toBe('5');
    expect(page.body).toHaveLength(2);
    const redeemed = await admin('get', `/api/events/${event.id}/passes?status=redeemed`).expect(200);
    expect(redeemed.headers['x-total-count']).toBe('1');
    expect(redeemed.body[0].id).toBe(passes[0].id);
  });

  it('bulk-revokes only unused passes of the same event', async () => {
    const { event, scannerKey, passes } = await seedEvent(h, 3);
    const other = await seedEvent(h, 1);
    await scan(h, scannerKey, passes[0].token).expect(200);
    const result = (await admin('post', `/api/events/${event.id}/passes/revoke`).send({ passIds: [passes[0].id, passes[1].id, passes[2].id, other.passes[0].id] }).expect(200)).body;
    expect(result).toEqual({ revoked: 2, skipped: 2 });
    expect(h.service.getPass(other.passes[0].id).status).toBe('active');
    expect((await scan(h, scannerKey, passes[1].token)).body.outcome).toBe('revoked');
    expect(verifyDatabase(h.db).ok).toBe(true);
  });

  it('exports attendance with formula injection neutralised and records the download', async () => {
    const { event, scannerKey } = await seedEvent(h, 1);
    const [pass] = (await admin('post', `/api/events/${event.id}/passes`).send({ attendees: [{ name: '=cmd|"/c calc"!A1', email: 'x@example.com' }] }).expect(201)).body;
    await scan(h, scannerKey, pass.token).expect(200);
    const csv = await admin('get', `/api/events/${event.id}/exports/attendance.csv`).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toMatch(/^attachment; filename="gatepass-[0-9a-f]{8}-attendance\.csv"$/);
    expect(csv.text).toContain(`"'=cmd|""/c calc""!A1"`);
    expect(csv.text).toMatch(/,redeemed,/);
    expect(csv.text).not.toContain(pass.token);
    const [entry] = (await admin('get', `/api/events/${event.id}/audit?action=export.downloaded`).expect(200)).body;
    expect(entry).toMatchObject({ actor: 'operator', actorLabel: 'operator', details: { kind: 'attendance', rows: 2 } });
  });

  it('searches the audit log by action prefix and text, newest first, with paging', async () => {
    const { event, passes } = await seedEvent(h, 3);
    for (const pass of passes) await admin('post', `/api/passes/${pass.id}/revoke`).expect(200);
    const revoked = (await admin('get', `/api/events/${event.id}/audit?action=pass.&limit=2`).expect(200)).body;
    expect(revoked.map((e: { entityId: string }) => e.entityId)).toEqual([passes[2].id, passes[1].id]);
    const older = (await admin('get', `/api/events/${event.id}/audit?action=pass.&before=${revoked[1].id}`).expect(200)).body;
    expect(older.map((e: { entityId: string }) => e.entityId)).toEqual([passes[0].id]);
    const byText = (await admin('get', `/api/events/${event.id}/audit?q=${passes[1].id.slice(0, 13)}`).expect(200)).body;
    expect(byText.map((e: { action: string }) => e.action)).toContain('pass.revoked');
    // LIKE wildcards in the query are literal.
    expect((await admin('get', `/api/events/${event.id}/audit?q=%25`).expect(200)).body).toEqual([]);
  });

  it('renames gates and refuses to delete gates or policies that are in use', async () => {
    const { event } = await seedEvent(h, 1);
    const gate = (await admin('post', `/api/events/${event.id}/gates`).send({ name: 'Nroth' }).expect(201)).body;
    const unused = (await admin('post', `/api/events/${event.id}/gates`).send({ name: 'Spare' }).expect(201)).body;
    expect((await admin('patch', `/api/gates/${gate.id}`).send({ name: 'North' }).expect(200)).body.name).toBe('North');
    await admin('patch', `/api/gates/${gate.id}`).send({ name: 'Spare' }).expect(409);
    const policy = (await admin('post', `/api/events/${event.id}/policies`).send({ name: 'GA', gateIds: [gate.id] }).expect(201)).body;
    await admin('delete', `/api/gates/${gate.id}`).expect(409);
    await admin('delete', `/api/gates/${unused.id}`).expect(204);
    await admin('post', `/api/events/${event.id}/passes`).send({ count: 1, policyId: policy.id }).expect(201);
    await admin('delete', `/api/policies/${policy.id}`).expect(409);
    const empty = (await admin('post', `/api/events/${event.id}/policies`).send({ name: 'Unused' }).expect(201)).body;
    await admin('delete', `/api/policies/${empty.id}`).expect(204);
  });
});

describe('scanner behaviour', () => {
  it('returns the stored result for a retried request instead of judging it again', async () => {
    const { passes, scannerKey } = await seedEvent(h, 1);
    const requestId = 'retry-0123456789';
    const first = (await request(h.app).post('/api/scanner/redeem').set('Authorization', `Bearer ${scannerKey}`).send({ code: passes[0].token, requestId }).expect(200)).body;
    const retry = (await request(h.app).post('/api/scanner/redeem').set('Authorization', `Bearer ${scannerKey}`).send({ code: passes[0].token, requestId }).expect(200)).body;
    expect(first.outcome).toBe('admitted');
    expect(retry).toMatchObject({ outcome: 'admitted', replayed: true, scanId: first.scanId, checkedAt: first.checkedAt });
    // A new attempt (new id) is judged: already used, by this device.
    const again = (await request(h.app).post('/api/scanner/redeem').set('Authorization', `Bearer ${scannerKey}`).send({ code: passes[0].token, requestId: 'another-attempt' }).expect(200)).body;
    expect(again).toMatchObject({ outcome: 'already_redeemed', detail: { sameDevice: true, redeemedAtGate: null } });
    // The retry created no second scan row.
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM scans').get()).toEqual({ n: 2 });
    await request(h.app).post('/api/scanner/redeem').set('Authorization', `Bearer ${scannerKey}`).send({ code: passes[0].token, requestId: 'bad id!' }).expect(400);
  });

  it('keeps request ids per device: another scanner reusing an id gets its own judgement', async () => {
    const { event, passes, scannerKey } = await seedEvent(h, 1);
    const other = await enroll(h.app, (await admin('post', `/api/events/${event.id}/scanners`).send({ label: 'Door 2' }).expect(201)).body);
    const send = (key: string) => request(h.app).post('/api/scanner/redeem').set('Authorization', `Bearer ${key}`).send({ code: passes[0].token, requestId: 'shared-id-123' });
    expect((await send(scannerKey)).body.outcome).toBe('admitted');
    expect((await send(other)).body).toMatchObject({ outcome: 'already_redeemed', detail: { sameDevice: false } });
  });

  it('accepts the 8-character reference only within the scanner’s own event', async () => {
    const { passes, scannerKey } = await seedEvent(h, 1);
    const other = await seedEvent(h, 1);
    const reference = passes[0].id.slice(0, 8).toUpperCase();
    expect((await scan(h, other.scannerKey, reference)).body.outcome).toBe('invalid');
    expect((await scan(h, scannerKey, reference)).body.outcome).toBe('admitted');
    expect((await scan(h, scannerKey, reference)).body.outcome).toBe('already_redeemed');
    expect((await scan(h, scannerKey, 'zzzzzzzz')).body.outcome).toBe('invalid');
  });

  it('rotates a scanner key: the old key stops at once, history and gate are kept', async () => {
    const { event, passes, scannerKey, scannerId } = await seedEvent(h, 2);
    await scan(h, scannerKey, passes[0].token).expect(200);
    const rotated = (await admin('post', `/api/scanners/${scannerId}/rotate`).expect(200)).body;
    expect(rotated.scanner).toMatchObject({ id: scannerId, setup: 'pending', enrolledAt: null });
    expect(rotated).not.toHaveProperty('key');
    await scan(h, scannerKey, passes[1].token).expect(401);
    expect((await scan(h, await enroll(h.app, rotated), passes[1].token)).body.outcome).toBe('admitted');
    expect(h.service.listScans(event.id).every((s) => s.scannerId === scannerId)).toBe(true);
  });

  it('records a heartbeat for device health and reports pass states from the passes table', async () => {
    const { event, passes, scannerKey } = await seedEvent(h, 3);
    await request(h.app).get('/api/scanner/session').set('Authorization', `Bearer ${scannerKey}`).expect(200);
    await scan(h, scannerKey, passes[0].token).expect(200);
    await admin('post', `/api/passes/${passes[1].id}/revoke`).expect(200);
    const ops = (await admin('get', `/api/events/${event.id}/operations`).expect(200)).body;
    expect(ops.passes).toEqual({ issued: 3, active: 1, redeemed: 1, revoked: 1, expired: 0 });
    expect(ops.capacity).toEqual({ limit: null, admitted: 1, remaining: null });
    expect(ops.scanners).toEqual([expect.objectContaining({ label: 'Door 1', state: 'recent', scansLast15m: 1, revoked: false })]);
    h.clock.advance(11 * 60_000);
    expect((await admin('get', `/api/events/${event.id}/operations`).expect(200)).body.scanners[0].state).toBe('idle');
  });
});

describe('one-time scanner enrollment', () => {
  const enrollWith = (code: string) => request(h.app).post('/api/scanner/enroll').send({ code });

  it('never puts the device key in the setup link; the link works exactly once', async () => {
    const event = (await admin('post', '/api/events').send(EVENT_INPUT).expect(201)).body;
    const created = (await admin('post', `/api/events/${event.id}/scanners`).send({ label: 'Door' }).expect(201)).body;
    expect(created).not.toHaveProperty('key');
    expect(created.enrollment.url).toMatch(/^https:\/\/gate\.example\/scan#enroll=[A-Za-z0-9_-]{43}$/);
    expect(created.scanner).toMatchObject({ setup: 'pending', enrolledAt: null });

    const first = (await enrollWith(setupCode(created)).expect(201)).body;
    expect(first.key).toMatch(/^gps_/);
    expect(first.session).toMatchObject({ scanner: { id: created.scanner.id }, event: { id: event.id } });
    await enrollWith(setupCode(created)).expect(410); // replay
    const [scanner] = (await admin('get', `/api/events/${event.id}/scanners`).expect(200)).body;
    expect(scanner).toMatchObject({ setup: 'enrolled', setupExpiresAt: null });
    // Only hashes are stored: neither the code nor the key appears in the database.
    const dump = JSON.stringify(h.db.prepare('SELECT * FROM scanner_enrollments').all()) + JSON.stringify(h.db.prepare('SELECT * FROM scanners').all());
    expect(dump).not.toContain(setupCode(created));
    expect(dump).not.toContain(first.key);
  });

  it('counts a device as ready for the door only once a phone holds its key', async () => {
    const event = (await admin('post', '/api/events').send(EVENT_INPUT).expect(201)).body;
    const counts = async () => {
      const { scannerCount, readyScannerCount } = (await admin('get', `/api/events/${event.id}`).expect(200)).body;
      return { scannerCount, readyScannerCount };
    };
    const created = (await admin('post', `/api/events/${event.id}/scanners`).send({ label: 'Door' }).expect(201)).body;
    expect(await counts()).toEqual({ scannerCount: 1, readyScannerCount: 0 }); // link not opened yet
    await enrollWith(setupCode(created)).expect(201);
    expect(await counts()).toEqual({ scannerCount: 1, readyScannerCount: 1 });
    await admin('post', `/api/scanners/${created.scanner.id}/rotate`).expect(200); // key stopped, new link waiting
    expect(await counts()).toEqual({ scannerCount: 1, readyScannerCount: 0 });
  });

  it('lets exactly one of two racing devices claim a link', async () => {
    const event = (await admin('post', '/api/events').send(EVENT_INPUT).expect(201)).body;
    const created = (await admin('post', `/api/events/${event.id}/scanners`).send({ label: 'Door' }).expect(201)).body;
    const results = await Promise.all([enrollWith(setupCode(created)), enrollWith(setupCode(created))]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 410]);
  });

  it('refuses expired, superseded and revoked links, and audits the enrollment', async () => {
    const event = (await admin('post', '/api/events').send(EVENT_INPUT).expect(201)).body;
    const expiring = (await admin('post', `/api/events/${event.id}/scanners`).send({ label: 'Late phone' }).expect(201)).body;
    h.clock.advance(60 * 60_000);
    await enrollWith(setupCode(expiring)).expect(410);
    expect((await admin('get', `/api/events/${event.id}/scanners`).expect(200)).body[0]).toMatchObject({ setup: 'expired' });

    const renewed = (await admin('post', `/api/scanners/${expiring.scanner.id}/rotate`).expect(200)).body;
    const newest = (await admin('post', `/api/scanners/${expiring.scanner.id}/rotate`).expect(200)).body;
    await enrollWith(setupCode(renewed)).expect(410); // superseded by the newest link
    await enrollWith(setupCode(newest)).expect(201);

    const lost = (await admin('post', `/api/events/${event.id}/scanners`).send({ label: 'Lost phone' }).expect(201)).body;
    await admin('post', `/api/scanners/${lost.scanner.id}/revoke`).expect(200);
    await enrollWith(setupCode(lost)).expect(410);
    await admin('post', `/api/scanners/${lost.scanner.id}/rotate`).expect(409);

    const audit = (await admin('get', `/api/events/${event.id}/audit?action=scanner.enrolled`).expect(200)).body;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: `scanner:${expiring.scanner.id}`, actorLabel: 'Late phone' });
  });

  it('throttles repeated bad codes from one address', async () => {
    for (let i = 0; i < 60; i += 1) await enrollWith(`bad-code-${i}`.padEnd(43, 'x')).expect(410);
    await enrollWith('x'.repeat(43)).expect(429);
  });
});
