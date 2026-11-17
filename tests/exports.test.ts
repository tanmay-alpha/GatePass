import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedEvent } from '../scripts/perf-dataset';
import { parseCsv } from '../src/client/csv';
import { csvCell, streamCsv } from '../src/server/csv';
import { EXPORT_CHUNK_ROWS } from '../src/server/gatepass';
import { ADMIN_TOKEN, createHarness, scan, type Harness } from './helpers';

let h: Harness;
beforeEach(() => {
  h = createHarness();
});
afterEach(() => h.close());

type Row = Record<string, unknown>;

/** The exports as they were built before streaming (whole document in memory), kept here as the golden reference. */
function previousExports(eventId: string) {
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    let text = typeof value === 'string' ? value : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const toCsv = (header: string[], rows: unknown[][]) => `\uFEFF${[header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
  const now = h.clock.now().toISOString();
  const timeZone = (h.db.prepare('SELECT time_zone FROM events WHERE id = ?').get(eventId) as Row).time_zone;
  const attendance = h.db
    .prepare(
      `SELECT p.id, p.attendee_name, p.attendee_email, ap.name AS policy, p.created_at, p.expires_at, p.revoked_at, r.redeemed_at,
              g.name AS gate, sc.label AS scanner,
              CASE WHEN r.redeemed_at IS NOT NULL THEN 'redeemed' WHEN p.revoked_at IS NOT NULL THEN 'revoked' WHEN p.expires_at <= :now THEN 'expired' ELSE 'active' END AS status
       FROM passes p LEFT JOIN redemptions r ON r.pass_id = p.id LEFT JOIN admission_policies ap ON ap.id = p.policy_id
       LEFT JOIN gates g ON g.id = r.gate_id LEFT JOIN scanners sc ON sc.id = r.scanner_id
       WHERE p.event_id = :eventId ORDER BY p.created_at, p.rowid`
    )
    .all({ eventId, now }) as Row[];
  const scans = h.db
    .prepare(
      `SELECT s.id, s.created_at, s.outcome, g.name AS gate, sc.label AS scanner, s.pass_id, p.attendee_name, s.method
       FROM scans s JOIN scanners sc ON sc.id = s.scanner_id LEFT JOIN gates g ON g.id = s.gate_id LEFT JOIN passes p ON p.id = s.pass_id
       WHERE s.event_id = ? ORDER BY s.id`
    )
    .all(eventId) as Row[];
  const audit = h.service.listAudit(eventId, { limit: 100_000 }).reverse();
  return {
    attendance: toCsv(
      ['pass_id', 'reference', 'attendee_name', 'attendee_email', 'policy', 'status', 'issued_at', 'expires_at', 'revoked_at', 'admitted_at', 'gate', 'scanner', 'time_zone'],
      attendance.map((row) => [
        row.id,
        (row.id as string).slice(0, 8).toUpperCase(),
        row.attendee_name,
        row.attendee_email,
        row.policy,
        row.status,
        row.created_at,
        row.expires_at,
        row.revoked_at,
        row.redeemed_at,
        row.gate,
        row.scanner,
        timeZone
      ])
    ),
    scans: toCsv(
      ['scan_id', 'time_utc', 'outcome', 'gate', 'scanner', 'pass_reference', 'attendee_name', 'method'],
      scans.map((row) => [row.id, row.created_at, row.outcome, row.gate, row.scanner, row.pass_id ? (row.pass_id as string).slice(0, 8).toUpperCase() : null, row.attendee_name, row.method])
    ),
    audit: toCsv(
      ['id', 'time_utc', 'actor', 'action', 'entity_id', 'details'],
      audit.map((entry) => [entry.id, entry.createdAt, entry.actorLabel, entry.action, entry.entityId, JSON.stringify(entry.details)])
    )
  };
}

const exportPath = (eventId: string, kind: string) => `/api/events/${eventId}/exports/${kind}.csv`;
const download = async (eventId: string, kind: string) => (await h.admin(request(h.app).get(exportPath(eventId, kind))).buffer(true).expect(200)).text;
const exportEntries = (eventId: string) => h.service.listAudit(eventId, { action: 'export.downloaded' });

describe('streamed CSV exports', () => {
  it('are byte-identical to the previous in-memory exports across several chunks', async () => {
    // 1,300 passes and ~1,700 scans: three or more chunks per export, names with quotes, commas and formulas.
    const { eventId } = seedEvent(h.db, { passes: 1300, now: h.clock.now(), seed: 3 });
    seedEvent(h.db, { passes: 200, now: h.clock.now(), seed: 4, name: 'Other event' });
    for (const kind of ['attendance', 'scans', 'audit'] as const) {
      const expected = previousExports(eventId)[kind];
      const body = await download(eventId, kind);
      expect(body.length).toBeGreaterThan(10_000);
      expect(body === expected, `${kind}.csv differs from the previous export`).toBe(true);
    }
    // Newest first; the seeded history holds earlier downloads too.
    expect(exportEntries(eventId).slice(0, 3).map((entry) => entry.details)).toEqual([
      { kind: 'audit', rows: expect.any(Number) },
      { kind: 'scans', rows: Number((h.db.prepare('SELECT COUNT(*) AS n FROM scans WHERE event_id = ?').get(eventId) as Row).n) },
      { kind: 'attendance', rows: 1300 }
    ]);
  });

  it('records the exact row count of a scans export taken while scans keep arriving', async () => {
    const { eventId, scanners, live } = seedEvent(h.db, { passes: 1000, now: h.clock.now(), seed: 5 });
    const exported = await h.service.openExport(eventId, 'scans', 'operator');
    const first = exported.next();
    expect(first).toHaveLength(EXPORT_CHUNK_ROWS);
    // Admissions during the download are not part of it: the export covers the scans that existed when it opened.
    for (const pass of live.slice(0, 3)) await scan(h, scanners[10].key, pass.token).expect(200);
    const rows = [...first];
    for (let chunk = exported.next(); chunk.length; chunk = exported.next()) rows.push(...chunk);
    expect(rows).toHaveLength(exported.rows);
    expect(exportEntries(eventId)[0].details).toEqual({ kind: 'scans', rows: exported.rows });
    const newest = Number((h.db.prepare('SELECT MAX(id) AS id FROM scans WHERE event_id = ?').get(eventId) as Row).id);
    expect(rows.map((row) => Number(row[0])).every((id) => id < newest - 2)).toBe(true);
  });

  it('stops reading the database when the client disconnects mid-download, keeps the audit entry and keeps serving', async () => {
    const { eventId, scanners, live } = seedEvent(h.db, { passes: 12_000, now: h.clock.now(), seed: 6 });
    let chunks = 0;
    const open = h.service.openExport.bind(h.service);
    vi.spyOn(h.service, 'openExport').mockImplementation(async (...args) => {
      const exported = await open(...args);
      return { ...exported, next: () => (chunks++, exported.next()) };
    });
    const server = http.createServer(h.app).listen(0, '127.0.0.1');
    // The server side of the download: closes when the server sees the client go away.
    const serverClosed = new Promise<void>((resolve) => server.once('request', (_req, res: http.ServerResponse) => res.once('close', () => resolve())));
    const turns = async (count: number) => {
      for (let i = 0; i < count; i += 1) await new Promise((resolve) => setImmediate(resolve));
    };
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      await new Promise<void>((resolve, reject) => {
        const req = http.get({ port, host: '127.0.0.1', path: exportPath(eventId, 'attendance'), headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
        req.on('response', (res) => {
          expect(res.statusCode).toBe(200);
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        });
        req.on('error', (error) => (req.destroyed ? resolve() : reject(error)));
      });
      await serverClosed;
      await turns(3);
      const afterAbort = chunks;
      expect(afterAbort).toBeLessThan(Math.ceil(12_000 / EXPORT_CHUNK_ROWS));
      await turns(20);
      expect(chunks).toBe(afterAbort);
      expect(exportEntries(eventId)[0].details).toEqual({ kind: 'attendance', rows: 12_000 });
      const response = await fetch(`http://127.0.0.1:${port}/api/scanner/redeem`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${scanners[10].key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: live[0].token })
      });
      expect((await response.json()).outcome).toBe('admitted');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('keeps permission checks and 404s for foreign events', async () => {
    const { eventId } = seedEvent(h.db, { passes: 10, now: h.clock.now(), seed: 9 });
    for (const kind of ['attendance', 'scans', 'audit', 'summary']) {
      await h.admin(request(h.app).get(exportPath('00000000-0000-4000-a000-000000000000', kind))).expect(404);
      await request(h.app).get(exportPath(eventId, kind)).expect(401);
    }
    expect(exportEntries(eventId)).toEqual([]);
  });

  it('answers door redemptions and the dashboard between the chunks of a large export streaming to a slow client', async () => {
    const { eventId, scanners, live } = seedEvent(h.db, { passes: 25_000, now: h.clock.now(), seed: 11 });
    // When the server reads each chunk of the export.
    const chunkTimes: number[] = [];
    const open = h.service.openExport.bind(h.service);
    vi.spyOn(h.service, 'openExport').mockImplementation(async (...args) => {
      const exported = await open(...args);
      return { ...exported, next: () => (chunkTimes.push(performance.now()), exported.next()) };
    });
    const server = http.createServer(h.app).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    try {
      // The client reads the export slowly (a phone on venue Wi-Fi), so the server streams it over many turns. A real
      // delay on purpose: the subject is how the server interleaves socket back-pressure with other requests.
      const { promise: downloading, resolve: firstBytes } = Promise.withResolvers<void>();
      const { promise: exported, resolve, reject } = Promise.withResolvers<string>();
      const req = http.get({ port, host: '127.0.0.1', path: exportPath(eventId, 'attendance'), headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
      req.on('error', reject);
      req.on('response', (res) => {
        const parts: Buffer[] = [];
        res.once('data', () => firstBytes());
        res.on('data', (chunk: Buffer) => {
          parts.push(chunk);
          res.pause();
          setTimeout(() => res.resume(), 2);
        });
        res.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
      });
      await downloading;

      const latencies: number[] = [];
      const answeredAt: number[] = [];
      const doors = (async () => {
        for (const pass of live.slice(0, 40)) {
          const started = performance.now();
          const response = await fetch(`${base}/api/scanner/redeem`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${scanners[10].key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: pass.token })
          });
          expect((await response.json()).outcome).toBe('admitted');
          latencies.push(performance.now() - started);
          answeredAt.push(performance.now());
        }
      })();
      const dashboards = Promise.all(
        Array.from({ length: 3 }, async () => {
          const response = await fetch(`${base}/api/events/${eventId}/operations`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
          expect(response.status).toBe(200);
        })
      );
      const [body] = await Promise.all([exported, doors, dashboards]);

      // The server kept producing the export while it answered the doors: most redemptions came between two chunks
      // (a synchronous export would have produced every row before the first redemption was read).
      const between = answeredAt.filter((at) => at > chunkTimes[0] && at < chunkTimes.at(-1)!);
      expect(between.length).toBeGreaterThan(30);
      // Generous bound for a loaded CI machine: the door never waits for a whole export or dashboard pass.
      expect(Math.max(...latencies)).toBeLessThan(1_000);
      const [header, ...rows] = parseCsv(body);
      expect(header[0]).toBe('pass_id');
      expect(rows).toHaveLength(25_000);
      expect(exportEntries(eventId)[0].details).toEqual({ kind: 'attendance', rows: 25_000 });
      expect(Number((h.db.prepare('SELECT COUNT(*) AS n FROM redemptions r JOIN passes p ON p.id = r.pass_id WHERE p.event_id = ?').get(eventId) as Row).n)).toBe(
        Number((h.db.prepare("SELECT COUNT(*) AS n FROM scans WHERE event_id = ? AND outcome = 'admitted'").get(eventId) as Row).n)
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, 60_000);

  it('neutralises formula payloads in attendee names end to end, and the file parses back to the stored names', async () => {
    const event = (await h.admin(request(h.app).post('/api/events')).send({ name: '=cmd|\' /C calc\'!A0', startsAt: '2030-06-01T18:00:00.000Z', endsAt: '2030-06-01T23:00:00.000Z' }).expect(201))
      .body;
    const payloads = ["=cmd|' /C calc'!A0", '@SUM(1)', '\t=1+1', '\r=1+1', '＝1+1', '-2+3', '+1', ' =1+1', 'Bob;=1+1', 'Ada "Countess" Lovelace, Esq.'];
    await h
      .admin(request(h.app).post(`/api/events/${event.id}/passes`))
      .send({ attendees: payloads.map((name) => ({ name })) })
      .expect(201);
    const stored = (h.db.prepare('SELECT attendee_name FROM passes WHERE event_id = ? ORDER BY rowid').all(event.id) as Array<{ attendee_name: string }>).map((row) => row.attendee_name);
    for (const kind of ['attendance', 'summary'] as const) {
      const [, ...rows] = parseCsv(await download(event.id, kind));
      for (const row of rows) {
        for (const cell of row) expect(cell, `${kind}: ${JSON.stringify(cell)}`).not.toMatch(/^(?:[\t\r]|\s*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20])/);
      }
      if (kind === 'attendance') {
        // A cell is the stored value, with a leading apostrophe only where a spreadsheet would run it.
        expect(rows.map((row) => row[2].replace(/^'/, ''))).toEqual(stored);
      }
    }
  });
});

describe('streamCsv', () => {
  it('waits for the reader: rows produced ahead of a slow consumer stay bounded', async () => {
    let produced = 0;
    let consumed = 0;
    let maxAhead = 0;
    const sink = new Writable({
      highWaterMark: 16 * 1024,
      write(chunk: Buffer, _encoding, callback) {
        consumed += chunk.length;
        setImmediate(callback);
      }
    });
    const row = ['x'.repeat(90)];
    const result = await streamCsv(sink, ['h'], () => {
      maxAhead = Math.max(maxAhead, produced - consumed);
      if (produced > 5_000_000) return [];
      const rows = Array.from({ length: 100 }, () => row);
      produced += 100 * 92;
      return rows;
    });
    expect(result).toEqual({ rows: 54_400, complete: true });
    // 5 MB went through; never more than the writable buffer plus one chunk was waiting.
    expect(maxAhead).toBeLessThan(16 * 1024 + 2 * 100 * 92);
  });

  it('yields to the event loop between chunks', async () => {
    const order: string[] = [];
    const sink = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    let calls = 0;
    await streamCsv(sink, ['h'], () => {
      order.push('chunk');
      // Another request becomes ready while this chunk is being read.
      if (calls === 0) setImmediate(() => order.push('other request'));
      return calls++ < 50 ? [['a']] : [];
    });
    // Work queued by another request runs after the first chunk, not after the whole export (as it did when the export was one synchronous step).
    expect(order.slice(0, 3)).toEqual(['chunk', 'other request', 'chunk']);
  });

  it('stops when the writable is destroyed and reports an incomplete document', async () => {
    let calls = 0;
    const sink = new Writable({ highWaterMark: 1, write: (_chunk, _encoding, callback) => setImmediate(callback) });
    const done = streamCsv(sink, ['h'], () => {
      calls++;
      if (calls === 3) sink.destroy();
      return [['row']];
    });
    expect(await done).toEqual({ rows: 3, complete: false });
    expect(calls).toBe(3);
  });
});

describe('csvCell formula-injection protection (OWASP CSV Injection)', () => {
  it('keeps the existing protections', () => {
    expect(['=1+1', '+1', '-2', '@SUM(A1)', '\tx', '\rx'].map(csvCell)).toEqual(["'=1+1", "'+1", "'-2", "'@SUM(A1)", "'\tx", `"'\rx"`]);
    expect(csvCell(`=cmd|' /C calc'!A0`)).toBe(`'=cmd|' /C calc'!A0`);
    expect(csvCell('=HYPERLINK("https://evil.example","x")')).toBe(`"'=HYPERLINK(""https://evil.example"",""x"")"`);
    expect([null, undefined, 42, 'Ada Lovelace', 'a|b', '|cmd'].map(csvCell)).toEqual(['', '', '42', 'Ada Lovelace', 'a|b', '|cmd']);
  });

  it('neutralises a formula behind leading whitespace or in full-width form', () => {
    expect([' =1+1', '\u00A0=1+1', '\n=1+1', '\u3000@SUM(A1)'].map(csvCell)).toEqual(["' =1+1", "'\u00A0=1+1", `"'\n=1+1"`, "'\u3000@SUM(A1)"]);
    expect(['\uFF1D1+1', '\uFF0B1', '\uFF0D1', '\uFF20SUM(A1)'].map(csvCell)).toEqual(["'\uFF1D1+1", "'\uFF0B1", "'\uFF0D1", "'\uFF20SUM(A1)"]);
  });

  it('quotes cells with a semicolon so semicolon-separated spreadsheets keep them in one cell', () => {
    expect(csvCell('Bob;=1+1')).toBe('"Bob;=1+1"');
    expect(parseCsv(`a;${csvCell('Bob;=1+1')}\r\n`, ';')).toEqual([['a', 'Bob;=1+1']]);
  });
});
