import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCsv } from '../src/client/csv';
import type { EventReport } from '../src/shared/types';
import { createHarness, enroll, EVENT_INPUT, scan, type Harness } from './helpers';

let h: Harness;
beforeEach(() => {
  h = createHarness();
});
afterEach(() => h.close());

const api = () => request(h.app);
const MINUTE = 60_000;

async function post(path: string, body: object = {}) {
  return (await h.admin(api().post(path)).send(body).expect((res) => expect(res.status).toBeLessThan(300))).body;
}
async function scannerAt(eventId: string, label: string, gateId: string | null) {
  const created = await post(`/api/events/${eventId}/scanners`, { label, gateId });
  return { id: created.scanner.id as string, key: await enroll(h.app, created) };
}

/**
 * Clock starts at 18:30 UTC in an 18:00–23:00 UTC event held in Kathmandu (UTC+05:45).
 * 18:30  North admits pass 0; South admits pass 1.
 * 18:47  North admits passes 2 and 3; the roaming scanner admits pass 4 from a lookup;
 *        South re-scans pass 0, reads a bad code and the revoked pass 5.
 *        Another event admits three passes in the same quarter hour (must not count).
 */
async function scenario() {
  const event = await post('/api/events', { ...EVENT_INPUT, timeZone: 'Asia/Kathmandu' });
  const north = await post(`/api/events/${event.id}/gates`, { name: 'North' });
  const south = await post(`/api/events/${event.id}/gates`, { name: 'South' });
  const passes = await post(`/api/events/${event.id}/passes`, { count: 6 });
  const n = await scannerAt(event.id, 'North 1', north.id);
  const s = await scannerAt(event.id, 'South 1', south.id);
  const roam = await scannerAt(event.id, 'Roaming', null);
  await scannerAt(event.id, 'Spare', null);
  await h.admin(api().post(`/api/passes/${passes[5].id}/revoke`)).expect(200);

  const other = await post('/api/events', { ...EVENT_INPUT, name: 'Other night' });
  const otherPasses = await post(`/api/events/${other.id}/passes`, { count: 3 });
  const otherDoor = await scannerAt(other.id, 'Other door', null);

  await scan(h, n.key, passes[0].token).expect(200);
  await scan(h, s.key, passes[1].token).expect(200);
  h.clock.advance(17 * MINUTE);
  await scan(h, n.key, passes[2].token).expect(200);
  await scan(h, n.key, passes[3].token).expect(200);
  const lookup = await api().post('/api/scanner/redeem').set('Authorization', `Bearer ${roam.key}`).send({ code: passes[4].id.slice(0, 8), method: 'lookup' }).expect(200);
  expect(lookup.body.outcome).toBe('admitted');
  expect((await scan(h, s.key, passes[0].token)).body.outcome).toBe('already_redeemed');
  expect((await scan(h, s.key, 'not-a-pass')).body.outcome).toBe('invalid');
  expect((await scan(h, s.key, passes[5].token)).body.outcome).toBe('revoked');
  for (const pass of otherPasses) expect((await scan(h, otherDoor.key, pass.token)).body.outcome).toBe('admitted');
  // A pass of this event shown at the other event's door is the other event's scan.
  expect((await scan(h, otherDoor.key, passes[0].token)).body.outcome).toBe('invalid');
  await h.admin(api().post(`/api/scanners/${roam.id}/revoke`)).expect(200);
  return { event, north, south, n, s, roam, other };
}

describe('post-event report', () => {
  it('reports passes, attendance, gates, peak, denials, devices and assisted admissions for this event only', async () => {
    const { event, north, south, n, s, roam } = await scenario();
    h.clock.advance(5 * 3600_000);
    const report: EventReport = (await h.admin(api().get(`/api/events/${event.id}/report`)).expect(200)).body;
    const at = (minutes: number) => new Date(Date.parse('2030-06-01T18:30:00.000Z') + minutes * MINUTE).toISOString();
    expect(report).toEqual({
      generatedAt: h.clock.now().toISOString(),
      event: { id: event.id, name: EVENT_INPUT.name, timeZone: 'Asia/Kathmandu', startsAt: EVENT_INPUT.startsAt, endsAt: EVENT_INPUT.endsAt, status: 'active' },
      passes: { issued: 6, active: 0, redeemed: 5, revoked: 1, expired: 0 },
      attendance: { expected: 5, admitted: 5, rate: 1 },
      gates: [
        { id: north.id, name: 'North', admitted: 3, denied: 0 },
        { id: south.id, name: 'South', admitted: 1, denied: 3 },
        { id: null, name: 'Any gate', admitted: 1, denied: 0 }
      ],
      peak: {
        start: '2030-06-01T18:45:00.000Z',
        end: '2030-06-01T19:00:00.000Z',
        localStart: '2030-06-02T00:30',
        localEnd: '2030-06-02T00:45',
        timeZone: 'Asia/Kathmandu',
        admitted: 3
      },
      denials: [
        { outcome: 'already_redeemed', count: 1 },
        { outcome: 'invalid', count: 1 },
        { outcome: 'revoked', count: 1 }
      ],
      scanners: [
        { id: n.id, label: 'North 1', gateName: 'North', revoked: false, firstScanAt: at(0), lastScanAt: at(17), lastContactAt: at(17), scans: 3, admitted: 3 },
        { id: roam.id, label: 'Roaming', gateName: null, revoked: true, firstScanAt: at(17), lastScanAt: at(17), lastContactAt: at(17), scans: 1, admitted: 1 },
        { id: s.id, label: 'South 1', gateName: 'South', revoked: false, firstScanAt: at(0), lastScanAt: at(17), lastContactAt: at(17), scans: 4, admitted: 1 },
        // Enrolled (its setup call is a heartbeat) but never scanned.
        { id: expect.any(String), label: 'Spare', gateName: null, revoked: false, firstScanAt: null, lastScanAt: null, lastContactAt: at(0), scans: 0, admitted: 0 }
      ],
      assistedAdmissions: 1
    });
  });

  it('has no peak and no rate before anything happened, and 404s for an unknown event', async () => {
    const event = await post('/api/events', EVENT_INPUT);
    const report: EventReport = (await h.admin(api().get(`/api/events/${event.id}/report`)).expect(200)).body;
    expect(report).toMatchObject({ passes: { issued: 0 }, attendance: { expected: 0, admitted: 0, rate: null }, peak: null, denials: [], scanners: [], gates: [], assistedAdmissions: 0 });
    await h.admin(api().get('/api/events/00000000-0000-4000-a000-000000000000/report')).expect(404);
    await h.admin(api().get('/api/events/00000000-0000-4000-a000-000000000000/exports/summary.csv')).expect(404);
  });

  it('reports an ended and then archived event with its figures intact, and later scans refused at the door count only as denials', async () => {
    const { event, n } = await scenario();
    const [late] = await post(`/api/events/${event.id}/passes`, { count: 1 });
    const before: EventReport = (await h.admin(api().get(`/api/events/${event.id}/report`)).expect(200)).body;
    await h.admin(api().patch(`/api/events/${event.id}`)).send({ status: 'ended' }).expect(200);
    // A door scan after the end is refused and recorded as a denial; no admission is added.
    expect((await scan(h, n.key, late.token)).body.outcome).toBe('event_closed');
    expect((await scan(h, n.key, 'not-a-pass')).body.outcome).toBe('invalid');
    await h.admin(api().patch(`/api/events/${event.id}`)).send({ status: 'archived' }).expect(200);
    const after: EventReport = (await h.admin(api().get(`/api/events/${event.id}/report`)).expect(200)).body;
    expect(after.event.status).toBe('archived');
    expect(after.passes).toEqual(before.passes);
    expect(after.attendance).toEqual(before.attendance);
    expect(after.peak).toEqual(before.peak);
    expect(after.denials).toEqual([
      { outcome: 'invalid', count: 2 },
      { outcome: 'already_redeemed', count: 1 },
      { outcome: 'event_closed', count: 1 },
      { outcome: 'revoked', count: 1 }
    ]);
    await h.admin(api().get(`/api/events/${event.id}/exports/summary.csv`)).expect(200);
  });

  it('exports the same figures as summary.csv and records the download', async () => {
    const { event } = await scenario();
    const report: EventReport = (await h.admin(api().get(`/api/events/${event.id}/report`)).expect(200)).body;
    const response = await h.admin(api().get(`/api/events/${event.id}/exports/summary.csv`)).buffer(true).expect(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toMatch(/^attachment; filename="gatepass-[0-9a-f]{8}-summary\.csv"$/);
    expect(response.text.startsWith('\uFEFFsection,item,metric,value\r\n')).toBe(true);
    const [header, ...rows] = parseCsv(response.text);
    expect(header).toEqual(['section', 'item', 'metric', 'value']);
    const value = (section: string, item: string, metric: string) => rows.find((row) => row[0] === section && row[1] === item && row[2] === metric)?.[3];
    expect(value('passes', '', 'issued')).toBe('6');
    expect(value('passes', '', 'revoked')).toBe('1');
    expect(value('attendance', '', 'admitted')).toBe('5');
    expect(value('attendance', '', 'rate')).toBe('1.0000');
    expect(value('attendance', '', 'assisted_admissions')).toBe('1');
    expect(value('peak', 'Asia/Kathmandu', 'local_start')).toBe(report.peak!.localStart);
    expect(value('peak', '', 'admitted')).toBe('3');
    expect(value('gate', 'South', 'denied')).toBe('3');
    expect(value('denial', 'revoked', 'count')).toBe('1');
    expect(value('scanner', 'Roaming', 'revoked')).toBe('yes');
    expect(value('scanner', 'North 1', 'scans')).toBe('3');
    const [entry] = (await h.admin(api().get(`/api/events/${event.id}/audit?action=export.downloaded`)).expect(200)).body;
    expect(entry.details).toEqual({ kind: 'summary', rows: rows.length });
  });
});
