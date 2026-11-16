import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCsv } from '../src/client/csv';
import type { AuditEntry, EventSummary, IssuedPass, OperationsSummary, Pass, ScanResult } from '../src/shared/types';

// The mandatory end-to-end scenario against a real server process on a
// temporary database file, over HTTP only: two organizers and a manager,
// gates, a capacity-limited policy, scanner enrollment, every door verdict,
// a lost response retried with the same requestId, a SIGKILL and restart,
// dashboard and CSV exports checked against the database, access control,
// the audit trail, and `verify` on the final file.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ADMIN_TOKEN = 'journey-admin-token-0123456789abcdef';
const PASSWORD = 'correct horse battery staple';
const START_TIMEOUT = 60_000;

interface ServerProcess {
  child: ChildProcess;
  url: string;
  output: string[];
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

interface Reply<T> {
  status: number;
  headers: Headers;
  text: string;
  body: T;
}

interface Credentials {
  /** `gatepass_session=<token>` (the app runs on plain http here, so no `__Host-` prefix). */
  cookie?: string;
  bearer?: string;
}

const children = new Set<ChildProcess>();
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    [...children].map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    })
  );
  children.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    probe.close(() => resolve(port));
  });
  return promise;
}

/** Single node process (no tsx CLI wrapper), so a kill reaches the process that holds the database. */
function spawnNode(args: string[], env: Record<string, string>): Pick<ServerProcess, 'child' | 'output' | 'exit'> {
  const child = spawn(process.execPath, ['--import', 'tsx', '--disable-warning=ExperimentalWarning', 'src/server/index.ts', ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_FILE: '',
      DEMO_MODE: 'false',
      ORIGIN_SECRET: '',
      CLIENT_IP_HEADER: '',
      TRUST_PROXY: '',
      RESEND_API_KEY: '',
      MAIL_FROM: '',
      NODE_ENV: 'test',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  children.add(child);
  const output: string[] = [];
  child.stdout!.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr!.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  child.once('exit', (code, signal) => exited.resolve({ code, signal }));
  const exit = exited.promise;
  return { child, output, exit };
}

async function startServer(databaseFile: string): Promise<ServerProcess> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const { child, output, exit } = spawnNode([], { ADMIN_TOKEN, PORT: String(port), HOST: '127.0.0.1', APP_PUBLIC_URL: url, DATABASE_FILE: databaseFile, ALLOW_SIGNUP: 'true' });
  let exited = false;
  void exit.then(() => (exited = true));
  const deadline = Date.now() + START_TIMEOUT;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Server exited during start-up:\n${output.join('')}`);
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok && (await response.json()).ok === true) return { child, url, output, exit };
    } catch {
      // not listening yet
    }
    // A separate process exposes no readiness event; poll its health endpoint.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become healthy within ${START_TIMEOUT} ms:\n${output.join('')}`);
}

async function kill(server: ServerProcess) {
  if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill('SIGKILL');
  return server.exit;
}

/** Cookie-authenticated writes carry the CSRF header, as the SPA does; bearer requests (devices) do not need it. */
async function call<T = any>(server: ServerProcess, method: string, route: string, as: Credentials = {}, body?: unknown): Promise<Reply<T>> {
  const response = await fetch(`${server.url}${route}`, {
    method,
    headers: {
      ...(as.cookie ? { Cookie: as.cookie } : {}),
      ...(as.bearer ? { Authorization: `Bearer ${as.bearer}` } : {}),
      ...(method === 'GET' ? {} : { 'X-GatePass-CSRF': '1' }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  const json = (response.headers.get('content-type') ?? '').includes('application/json') && text ? JSON.parse(text) : null;
  return { status: response.status, headers: response.headers, text, body: json as T };
}

async function ok<T = any>(server: ServerProcess, method: string, route: string, as: Credentials, body?: unknown): Promise<T> {
  const reply = await call<T>(server, method, route, as, body);
  expect(reply.status, `${method} ${route}: ${reply.text}`).toBeLessThan(300);
  return reply.body;
}

function sessionCookie(reply: Reply<unknown>): string {
  const cookie = reply.headers.getSetCookie().find((value) => value.startsWith('gatepass_session='));
  expect(cookie, 'session cookie').toBeDefined();
  return cookie!.split(';')[0];
}

async function register(server: ServerProcess, email: string, name: string): Promise<{ cookie: string; userId: string }> {
  const reply = await call<{ user: { id: string } }>(server, 'POST', '/api/auth/register', {}, { email, name, password: PASSWORD });
  expect(reply.status, reply.text).toBe(201);
  return { cookie: sessionCookie(reply), userId: reply.body.user.id };
}

async function redeem(server: ServerProcess, key: string, code: string, requestId?: string): Promise<Reply<ScanResult>> {
  return call<ScanResult>(server, 'POST', '/api/scanner/redeem', { bearer: key }, requestId ? { code, requestId } : { code });
}

/**
 * A response lost on the way back: the request is sent in full and the
 * server answers (it has committed by the time the status line leaves), but
 * the client drops the connection on the first response byte and never
 * reads the verdict.
 */
function redeemLosingResponse(server: ServerProcess, key: string, code: string, requestId: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const payload = JSON.stringify({ code, requestId });
  const req = http.request(`${server.url}/api/scanner/redeem`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
  });
  req.once('response', (res) => {
    res.destroy();
    req.destroy();
    resolve();
  });
  req.on('error', reject);
  req.end(payload);
  return promise;
}

/** Direct read-only view of the persisted file (the server may be running: WAL readers never block it). */
function persisted(file: string, eventId: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const all = (sql: string, ...params: string[]) => db.prepare(sql).all(...params).map((row) => ({ ...row }));
    return {
      passes: all('SELECT id, token_hash, policy_id, revoked_at FROM passes WHERE event_id = ? ORDER BY created_at, rowid', eventId),
      redemptions: all(
        'SELECT r.pass_id, r.scanner_id, r.gate_id, r.policy_id, r.redeemed_at FROM redemptions r JOIN passes p ON p.id = r.pass_id WHERE p.event_id = ? ORDER BY r.redeemed_at, r.pass_id',
        eventId
      ),
      scans: all('SELECT id, scanner_id, gate_id, pass_id, outcome, request_id, created_at FROM scans WHERE event_id = ? ORDER BY id', eventId),
      audit: all('SELECT id, actor, action, entity_id FROM audit_log WHERE event_id = ? ORDER BY id', eventId),
      scanners: all('SELECT id, label, gate_id, revoked_at FROM scanners WHERE event_id = ? ORDER BY created_at', eventId),
      members: all('SELECT user_id, role FROM event_members WHERE event_id = ? ORDER BY role, user_id', eventId),
      counters: all(
        'SELECT (SELECT admitted_count FROM events WHERE id = ?1) AS event, (SELECT group_concat(name || \'=\' || admitted_count) FROM admission_policies WHERE event_id = ?1) AS policies',
        eventId
      )[0]
    };
  } finally {
    db.close();
  }
}

describe('organizer-to-door journey against a real server process', () => {
  it('runs the full admission journey, survives SIGKILL, and leaves a verifiable, consistent file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gatepass-journey-'));
    dirs.push(dir);
    const file = path.join(dir, 'gatepass.db');
    let server = await startServer(file);

    // ---- Organizer A: account, event, gates, a capacity-limited policy bound to gate 1, passes.
    const a = await register(server, 'ada.organizer@journey.example', 'Ada Organizer');
    const A = { cookie: a.cookie };
    const now = Date.now();
    const event = await ok<EventSummary>(server, 'POST', '/api/events', A, {
      name: 'Journey Night',
      status: 'active',
      startsAt: new Date(now - 3_600_000).toISOString(),
      endsAt: new Date(now + 6 * 3_600_000).toISOString(),
      capacity: 50
    });
    expect(event).toMatchObject({ myRole: 'owner', status: 'active' });
    const north = await ok<{ id: string }>(server, 'POST', `/api/events/${event.id}/gates`, A, { name: 'North' });
    const south = await ok<{ id: string }>(server, 'POST', `/api/events/${event.id}/gates`, A, { name: 'South' });
    const vip = await ok<{ id: string }>(server, 'POST', `/api/events/${event.id}/policies`, A, { name: 'VIP', capacity: 3, gateIds: [north.id] });
    const vipPasses = await ok<IssuedPass[]>(server, 'POST', `/api/events/${event.id}/passes`, A, {
      attendees: ['Vera One', 'Vic Two', 'Val Three', 'Viv Four', 'Vin Five'].map((name) => ({ name })),
      policyId: vip.id
    });
    expect(vipPasses).toHaveLength(5);

    // ---- Manager B: invited without email (the link comes back), accepts by creating an account.
    const invitation = await ok<{ url?: string; email: { status: string } }>(server, 'POST', `/api/events/${event.id}/invitations`, A, { email: 'ben.manager@journey.example' });
    expect(invitation.email.status).toBe('disabled');
    expect(invitation.url).toContain('#/invite/');
    const accepted = await call<{ user: { id: string }; eventId: string }>(server, 'POST', '/api/invitations/accept', {}, {
      token: invitation.url!.split('#/invite/')[1],
      name: 'Ben Manager',
      password: PASSWORD
    });
    expect(accepted.status, accepted.text).toBe(200);
    expect(accepted.body.eventId).toBe(event.id);
    const B = { cookie: sessionCookie(accepted) };
    const b = { userId: accepted.body.user.id };
    expect(await ok<EventSummary>(server, 'GET', `/api/events/${event.id}`, B)).toMatchObject({ myRole: 'manager' });

    // B can issue passes…
    const walkIns = await ok<IssuedPass[]>(server, 'POST', `/api/events/${event.id}/passes`, B, { attendees: [{ name: 'Walk-in One' }, { name: 'Walk-in Two' }] });
    expect(walkIns).toHaveLength(2);
    // …but cannot export attendee data, change the lifecycle or manage the team.
    const forbidden: Array<[string, string, unknown?]> = [
      ['GET', `/api/events/${event.id}/exports/attendance.csv`],
      ['GET', `/api/events/${event.id}/exports/scans.csv`],
      ['GET', `/api/events/${event.id}/exports/audit.csv`],
      ['PATCH', `/api/events/${event.id}`, { status: 'ended' }],
      ['POST', `/api/events/${event.id}/invitations`, { email: 'someone.else@journey.example' }],
      ['DELETE', `/api/events/${event.id}/members/${a.userId}`],
      ['POST', `/api/events/${event.id}/owner`, { userId: b.userId }]
    ];
    for (const [method, route, body] of forbidden) expect((await call(server, method, route, B, body)).status, `${method} ${route}`).toBe(403);

    // ---- One scanner per gate, each enrolled through its one-time setup link.
    const devices: Record<'north' | 'south', { id: string; key: string }> = {} as never;
    for (const [name, gate, label] of [
      ['north', north, 'North door'],
      ['south', south, 'South door']
    ] as const) {
      const created = await ok<{ scanner: { id: string }; enrollment: { url: string } }>(server, 'POST', `/api/events/${event.id}/scanners`, A, { label, gateId: gate.id });
      const enrolled = await ok<{ key: string; session: { gate: { name: string } } }>(server, 'POST', '/api/scanner/enroll', {}, { code: created.enrollment.url.split('#enroll=')[1] });
      expect(enrolled.session.gate.name).toBe(gate === north ? 'North' : 'South');
      devices[name] = { id: created.scanner.id, key: enrolled.key };
    }
    const { north: northDoor, south: southDoor } = devices;

    // ---- At the doors.
    const verdict = async (key: string, code: string, requestId?: string) => {
      const reply = await redeem(server, key, code, requestId);
      expect(reply.status, reply.text).toBe(200);
      return reply.body;
    };
    expect(await verdict(northDoor.key, vipPasses[0].passUrl)).toMatchObject({ outcome: 'admitted', pass: { attendeeName: 'Vera One' } });
    expect(await verdict(northDoor.key, vipPasses[0].passUrl)).toMatchObject({ outcome: 'already_redeemed', detail: { redeemedAtGate: 'North', sameDevice: true } });
    expect(await verdict(southDoor.key, vipPasses[1].passUrl)).toMatchObject({ outcome: 'wrong_gate', detail: { policyName: 'VIP', allowedGates: ['North'] } });
    expect(await verdict(northDoor.key, vipPasses[1].passUrl)).toMatchObject({ outcome: 'admitted' });

    expect(await ok<Pass>(server, 'POST', `/api/passes/${vipPasses[4].id}/revoke`, A)).toMatchObject({ status: 'revoked' });
    expect(await verdict(northDoor.key, vipPasses[4].passUrl)).toMatchObject({ outcome: 'revoked' });

    const reissued = await ok<IssuedPass>(server, 'POST', `/api/passes/${vipPasses[2].id}/reissue`, A);
    expect(reissued.id).toBe(vipPasses[2].id);
    expect(reissued.token).not.toBe(vipPasses[2].token);
    expect((await verdict(northDoor.key, vipPasses[2].passUrl)).outcome).toBe('invalid');
    expect(await verdict(northDoor.key, reissued.passUrl)).toMatchObject({ outcome: 'admitted', pass: { id: vipPasses[2].id } });

    // The third VIP admission filled the policy.
    expect(await verdict(northDoor.key, vipPasses[3].passUrl)).toMatchObject({ outcome: 'capacity_full', detail: { policyName: 'VIP', capacity: 3 } });

    // A lost response, then the door retries with the same requestId: the stored verdict, not "already used".
    await redeemLosingResponse(server, southDoor.key, walkIns[0].passUrl, 'journey-lost-0001');
    expect(await verdict(southDoor.key, walkIns[0].passUrl, 'journey-lost-0001')).toMatchObject({ outcome: 'admitted', replayed: true, pass: { id: walkIns[0].id } });
    const lost = persisted(file, event.id);
    expect(lost.redemptions.filter((row) => row.pass_id === walkIns[0].id)).toHaveLength(1);
    expect(lost.scans.filter((row) => row.request_id === 'journey-lost-0001')).toEqual([expect.objectContaining({ pass_id: walkIns[0].id, outcome: 'admitted' })]);

    // ---- SIGKILL mid-operation state, restart on the same file: every record is still there.
    const beforeKill = persisted(file, event.id);
    expect(beforeKill.redemptions.map((row) => row.pass_id).sort()).toEqual([vipPasses[0].id, vipPasses[1].id, vipPasses[2].id, walkIns[0].id].sort());
    expect(beforeKill.scans.map((row) => row.outcome)).toEqual(['admitted', 'already_redeemed', 'wrong_gate', 'admitted', 'revoked', 'invalid', 'admitted', 'capacity_full', 'admitted']);
    expect(beforeKill.counters).toEqual({ event: 4, policies: 'VIP=3' });
    expect(await kill(server)).toMatchObject({ code: null });
    server = await startServer(file);
    expect(persisted(file, event.id)).toEqual(beforeKill);

    const afterRestart = await ok<EventSummary>(server, 'GET', `/api/events/${event.id}`, A);
    expect(afterRestart).toMatchObject({ admittedCount: 4, redeemedCount: 4, passCount: 7, revokedCount: 1, scanCount: 9 });
    const redeemedViaApi = await ok<Pass[]>(server, 'GET', `/api/events/${event.id}/passes?status=redeemed`, A);
    expect(redeemedViaApi.map((pass) => pass.id).sort()).toEqual(beforeKill.redemptions.map((row) => row.pass_id).sort());
    // The stored verdicts survive the restart too.
    expect(await verdict(southDoor.key, walkIns[0].passUrl, 'journey-lost-0001')).toMatchObject({ outcome: 'admitted', replayed: true });
    expect(await verdict(northDoor.key, vipPasses[0].passUrl)).toMatchObject({ outcome: 'already_redeemed' });

    // ---- Operations dashboard agrees with the database.
    const db = persisted(file, event.id);
    const ops = await ok<OperationsSummary>(server, 'GET', `/api/events/${event.id}/operations`, A);
    const outcomeCounts: Record<string, number> = {};
    for (const scan of db.scans) outcomeCounts[scan.outcome as string] = (outcomeCounts[scan.outcome as string] ?? 0) + 1;
    expect(ops.passes).toEqual({ issued: 7, active: 2, redeemed: 4, revoked: 1, expired: 0 });
    expect(ops.totals).toEqual({ scans: db.scans.length, admitted: db.redemptions.length, denied: db.scans.length - db.redemptions.length });
    expect(ops.outcomes).toEqual(outcomeCounts);
    expect(ops.capacity).toEqual({ limit: 50, admitted: 4, remaining: 46 });
    for (const gate of [north, south]) {
      const scansHere = db.scans.filter((scan) => scan.gate_id === gate.id);
      expect(ops.gates.find((row) => row.id === gate.id)).toMatchObject({
        admitted: scansHere.filter((scan) => scan.outcome === 'admitted').length,
        denied: scansHere.filter((scan) => scan.outcome !== 'admitted').length
      });
    }
    expect(ops.policies).toEqual([expect.objectContaining({ id: vip.id, admitted: 3, capacity: 3, state: 'full' })]);

    // ---- Exports agree with the database, row for row.
    const attendance = await call(server, 'GET', `/api/events/${event.id}/exports/attendance.csv`, A);
    expect(attendance.status).toBe(200);
    expect(attendance.headers.get('content-type')).toContain('text/csv');
    const [attendanceHeader, ...attendanceRows] = parseCsv(attendance.text);
    const col = (name: string) => attendanceHeader.indexOf(name);
    expect(attendanceRows.map((row) => row[col('pass_id')])).toEqual(db.passes.map((pass) => pass.id));
    const redemptionOf = new Map(db.redemptions.map((row) => [row.pass_id, row]));
    for (const row of attendanceRows) {
      const passId = row[col('pass_id')];
      const pass = db.passes.find((candidate) => candidate.id === passId)!;
      const redemption = redemptionOf.get(passId);
      expect({ passId, status: row[col('status')], admittedAt: row[col('admitted_at')], gate: row[col('gate')] }).toEqual({
        passId,
        status: redemption ? 'redeemed' : pass.revoked_at ? 'revoked' : 'active',
        admittedAt: (redemption?.redeemed_at as string | undefined) ?? '',
        gate: redemption ? (redemption.gate_id === north.id ? 'North' : 'South') : ''
      });
    }
    const scansCsv = await call(server, 'GET', `/api/events/${event.id}/exports/scans.csv`, A);
    expect(scansCsv.status).toBe(200);
    const [scanHeader, ...scanRows] = parseCsv(scansCsv.text);
    const scanCol = (name: string) => scanHeader.indexOf(name);
    expect(scanRows.map((row) => ({ id: Number(row[scanCol('scan_id')]), outcome: row[scanCol('outcome')], at: row[scanCol('time_utc')] }))).toEqual(
      db.scans.map((scan) => ({ id: scan.id, outcome: scan.outcome, at: scan.created_at }))
    );

    // ---- Access control.
    const c = await register(server, 'cleo.other@journey.example', 'Cleo Other');
    const C = { cookie: c.cookie };
    for (const route of [`/api/events/${event.id}`, `/api/events/${event.id}/operations`, `/api/events/${event.id}/passes`, `/api/events/${event.id}/exports/attendance.csv`]) {
      expect((await call(server, 'GET', route, C)).status, `other organizer GET ${route}`).toBe(404);
      expect((await call(server, 'GET', route)).status, `no session GET ${route}`).toBe(401);
      expect((await call(server, 'GET', route, { bearer: northDoor.key })).status, `scanner key GET ${route}`).toBe(401);
    }
    expect((await call(server, 'POST', `/api/passes/${walkIns[1].id}/revoke`, C)).status).toBe(404);
    expect((await call(server, 'POST', `/api/passes/${walkIns[1].id}/revoke`, { bearer: northDoor.key })).status).toBe(401);
    expect(await ok<EventSummary[]>(server, 'GET', '/api/events', C)).toEqual([]);
    await ok(server, 'POST', `/api/scanners/${southDoor.id}/revoke`, A);
    const revokedScan = await redeem(server, southDoor.key, walkIns[1].passUrl);
    expect(revokedScan.status).toBe(401);
    expect(revokedScan.body).not.toHaveProperty('outcome');
    expect((await call(server, 'GET', '/api/scanner/session', { bearer: southDoor.key })).status).toBe(401);
    expect((await ok<Pass[]>(server, 'GET', `/api/events/${event.id}/passes?status=active`, A)).map((pass) => pass.id).sort()).toEqual([vipPasses[3].id, walkIns[1].id].sort());

    // ---- The audit trail names who did what, in order, and nothing for the refused attempts.
    const audit = (await ok<AuditEntry[]>(server, 'GET', `/api/events/${event.id}/audit?limit=500`, A)).reverse();
    expect(audit.map((entry) => entry.action)).toEqual([
      'event.created',
      'member.owner_set',
      'gate.created',
      'gate.created',
      'policy.created',
      'passes.issued',
      'invitation.created',
      'invitation.accepted',
      'passes.issued',
      'scanner.created',
      'scanner.enrolled',
      'scanner.created',
      'scanner.enrolled',
      'pass.revoked',
      'pass.reissued',
      'export.downloaded',
      'export.downloaded',
      'scanner.revoked'
    ]);
    const actorOf = (action: string, index = 0) => audit.filter((entry) => entry.action === action)[index].actorLabel;
    expect(actorOf('event.created')).toBe('ada.organizer@journey.example');
    expect(actorOf('invitation.accepted')).toBe('ben.manager@journey.example');
    expect(actorOf('passes.issued', 1)).toBe('ben.manager@journey.example');
    expect(actorOf('scanner.enrolled', 0)).toBe('North door');
    expect(audit.filter((entry) => entry.action === 'export.downloaded').map((entry) => entry.details)).toEqual([
      { kind: 'attendance', rows: 7 },
      { kind: 'scans', rows: db.scans.length }
    ]);
    expect(audit.map((entry) => entry.id)).toEqual(persisted(file, event.id).audit.map((row) => row.id));

    // ---- Crash once more, then verify the final file offline.
    await kill(server);
    const verify = spawnNode(['verify', file], {});
    const { code } = await verify.exit;
    const output = verify.output.join('');
    expect(code, output).toBe(0);
    const report = JSON.parse(output.slice(output.indexOf('{'))) as { ok: boolean; violations: string[]; counts: Record<string, number> };
    expect(report).toMatchObject({ ok: true, violations: [], counts: { events: 1, passes: 7, redemptions: 4, users: 3 } });
  }, 120_000);
});
