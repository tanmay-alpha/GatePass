import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, schemaVersion } from '../src/server/db';
import { verifyDatabase } from '../src/server/integrity';
import type { EventSummary, IssuedPass, ScanResult } from '../src/shared/types';

// Crash, restart, backup and restore against the real server process
// (`node --import tsx src/server/index.ts`), not an in-process app: the kill
// is a real SIGKILL (TerminateProcess on Windows), so nothing in the server
// gets a chance to flush or close the database. Every scenario checks the
// persisted file with verifyDatabase, not only the HTTP answers.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ADMIN_TOKEN = 'recovery-admin-token-0123456789abcdef';
const START_TIMEOUT = 60_000;
const TEST_TIMEOUT = 180_000;

interface ServerProcess {
  child: ChildProcess;
  url: string;
  output: string[];
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

interface Reply<T> {
  status: number;
  body: T;
}

const children = new Set<ChildProcess>();
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    [...children].map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGKILL');
        await exited;
      }
    })
  );
  children.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gatepass-recovery-'));
  dirs.push(dir);
  return dir;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Single node process (no tsx CLI wrapper), so a kill reaches the process that holds the database. */
function spawnNode(args: string[], env: Record<string, string>): { child: ChildProcess; output: string[]; exit: ServerProcess['exit'] } {
  const child = spawn(process.execPath, ['--import', 'tsx', '--disable-warning=ExperimentalWarning', 'src/server/index.ts', ...args], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_FILE: '', DEMO_MODE: 'false', ORIGIN_SECRET: '', CLIENT_IP_HEADER: '', TRUST_PROXY: '', NODE_ENV: 'test', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  children.add(child);
  const output: string[] = [];
  child.stdout!.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr!.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, output, exit };
}

async function startServer(databaseFile: string): Promise<ServerProcess> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const { child, output, exit } = spawnNode([], {
    ADMIN_TOKEN,
    PORT: String(port),
    HOST: '127.0.0.1',
    APP_PUBLIC_URL: url,
    DATABASE_FILE: databaseFile,
    ALLOW_SIGNUP: 'true'
  });
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become healthy within ${START_TIMEOUT} ms:\n${output.join('')}`);
}

async function stop(server: ServerProcess, signal: NodeJS.Signals = 'SIGKILL') {
  if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill(signal);
  return server.exit;
}

async function cli(databaseFile: string, ...args: string[]): Promise<{ code: number | null; output: string }> {
  const { output, exit } = spawnNode(args, { DATABASE_FILE: databaseFile });
  const { code } = await exit;
  return { code, output: output.join('') };
}

/** `T` is the documented response shape (src/shared/types.ts); error replies carry `{ error }`. */
async function call<T>(server: ServerProcess, method: string, route: string, body?: unknown, bearer = ADMIN_TOKEN): Promise<Reply<T>> {
  const response = await fetch(`${server.url}${route}`, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function ok<T>(server: ServerProcess, method: string, route: string, body?: unknown): Promise<T> {
  const reply = await call<T>(server, method, route, body);
  expect(reply.status, `${method} ${route}: ${JSON.stringify(reply.body)}`).toBeLessThan(300);
  return reply.body;
}

function redeem(server: ServerProcess, key: string, code: string, requestId?: string): Promise<Reply<ScanResult>> {
  return call<ScanResult>(server, 'POST', '/api/scanner/redeem', requestId ? { code, requestId } : { code }, key);
}

interface Seeded {
  eventId: string;
  policyId: string;
  scannerKey: string;
  passes: Array<{ id: string; token: string }>;
}

/** Live event (window contains the real clock) with a gate, a capacity-limited policy bound to it, a gate scanner and `count` passes. */
async function seed(server: ServerProcess, count: number): Promise<Seeded> {
  const now = Date.now();
  const event = await ok<EventSummary>(server, 'POST', '/api/events', {
    name: 'Recovery Night',
    startsAt: new Date(now - 3_600_000).toISOString(),
    endsAt: new Date(now + 6 * 3_600_000).toISOString(),
    capacity: 1000
  });
  const gate = await ok<{ id: string }>(server, 'POST', `/api/events/${event.id}/gates`, { name: 'Main' });
  const policy = await ok<{ id: string }>(server, 'POST', `/api/events/${event.id}/policies`, { name: 'General', capacity: 500, gateIds: [gate.id] });
  const { key } = await ok<{ key: string }>(server, 'POST', `/api/events/${event.id}/scanners`, { label: 'Door 1', gateId: gate.id });
  const passes = await ok<IssuedPass[]>(server, 'POST', `/api/events/${event.id}/passes`, { count, policyId: policy.id });
  return { eventId: event.id, policyId: policy.id, scannerKey: key, passes: passes.map(({ id, token }) => ({ id, token })) };
}

/** Opens the file (as the server would, without a pre-migration copy), runs `fn`, closes it. */
function inspect<T>(file: string, fn: (db: DatabaseSync) => T): T {
  const db = openDatabase(file, { backupBeforeMigrate: false });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function redeemedIds(db: DatabaseSync): string[] {
  return (db.prepare('SELECT pass_id FROM redemptions ORDER BY pass_id').all() as Array<{ pass_id: string }>).map((row) => row.pass_id);
}

function fileHash(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

describe('crash recovery of the server process', () => {
  it('keeps an acknowledged admission across SIGKILL and restart; retries and re-scans are answered correctly', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'gatepass.db');
    const first = await startServer(file);
    const { eventId, scannerKey, passes } = await seed(first, 3);

    const admitted = await redeem(first, scannerKey, passes[0].token, 'req-crash-0001');
    expect(admitted.status).toBe(200);
    expect(admitted.body.outcome).toBe('admitted');
    await stop(first, 'SIGKILL');

    const second = await startServer(file);
    const redeemedNow = await ok<IssuedPass[]>(second, 'GET', `/api/events/${eventId}/passes?status=redeemed`);
    expect(redeemedNow.map((p) => p.id)).toEqual([passes[0].id]);

    const rescan = await redeem(second, scannerKey, passes[0].token);
    expect(rescan.body).toMatchObject({ outcome: 'already_redeemed', detail: { sameDevice: true } });
    const retry = await redeem(second, scannerKey, passes[0].token, 'req-crash-0001');
    expect(retry.body).toMatchObject({ outcome: 'admitted', replayed: true, scanId: admitted.body.scanId });
    expect((await redeem(second, scannerKey, passes[1].token)).body.outcome).toBe('admitted');
    expect((await redeem(second, scannerKey, passes[1].token)).body.outcome).toBe('already_redeemed');
    expect((await ok<EventSummary>(second, 'GET', `/api/events/${eventId}`)).admittedCount).toBe(2);
    await stop(second, 'SIGKILL');

    const report = inspect(file, verifyDatabase);
    expect(report.violations).toEqual([]);
    expect(report.counts).toMatchObject({ redemptions: 2, scans: 4 });
  }, TEST_TIMEOUT);

  it('persists every admission acknowledged before a SIGKILL that lands mid-burst (50 passes)', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'gatepass.db');
    const first = await startServer(file);
    const { eventId, policyId, scannerKey, passes } = await seed(first, 50);

    const acknowledged: string[] = [];
    const answered: Array<{ passId: string; outcome: string }> = [];
    const { promise: firstAckSeen, resolve: firstAck } = Promise.withResolvers<void>();
    const burst = passes.map(async (pass, i) => {
      const reply = await redeem(first, scannerKey, pass.token, `burst-${String(i).padStart(4, '0')}`);
      answered.push({ passId: pass.id, outcome: reply.status === 200 ? reply.body.outcome : `http_${reply.status}` });
      if (reply.status === 200 && reply.body.outcome === 'admitted') {
        acknowledged.push(pass.id);
        firstAck();
      }
    });
    const settled = Promise.allSettled(burst);
    // Kill a few random milliseconds after the first acknowledgement, while the rest are in flight.
    // A real delay on purpose: the point is a kill at an arbitrary instant of real server work.
    await Promise.race([firstAckSeen, settled]);
    const delay = Math.floor(Math.random() * 8);
    await new Promise((resolve) => setTimeout(resolve, delay));
    const ackedAtKill = acknowledged.length;
    first.child.kill('SIGKILL');
    const results = await settled;
    await first.exit;
    const failed = results.filter((result) => result.status === 'rejected').length;
    expect(acknowledged.length).toBeGreaterThan(0);
    // Any HTTP answer the door saw is a real outcome: the passes were all valid and unused.
    expect(answered.filter((entry) => entry.outcome !== 'admitted')).toEqual([]);

    const persisted = inspect(file, (db) => {
      const report = verifyDatabase(db);
      const perPass = db.prepare('SELECT pass_id, COUNT(*) AS n FROM redemptions GROUP BY pass_id HAVING COUNT(*) > 1').all();
      const admittedScans = Number((db.prepare("SELECT COUNT(*) AS n FROM scans WHERE outcome = 'admitted'").get() as { n: number }).n);
      const counters = db.prepare('SELECT (SELECT admitted_count FROM events WHERE id = ?) AS event, (SELECT admitted_count FROM admission_policies WHERE id = ?) AS policy').get(eventId, policyId) as {
        event: number;
        policy: number;
      };
      return { report, perPass, admittedScans, counters, redeemed: redeemedIds(db) };
    });
    console.info(`burst: killed ${delay} ms after first ack; ${ackedAtKill} acknowledged at kill, ${acknowledged.length} total, ${failed} requests got no answer, ${persisted.redeemed.length} redemptions persisted`);
    expect(persisted.report.violations).toEqual([]);
    expect(persisted.perPass).toEqual([]);
    // Acknowledged ⇒ durable.
    expect(acknowledged.filter((id) => !persisted.redeemed.includes(id))).toEqual([]);
    expect(persisted.admittedScans).toBe(persisted.redeemed.length);
    expect(persisted.counters).toEqual({ event: persisted.redeemed.length, policy: persisted.redeemed.length });

    // After restart: committed passes are used, the others were never half-applied and admit exactly once now.
    const second = await startServer(file);
    for (const [i, pass] of passes.entries()) {
      const wasCommitted = persisted.redeemed.includes(pass.id);
      const retry = await redeem(second, scannerKey, pass.token, `burst-${String(i).padStart(4, '0')}`);
      expect(retry.status).toBe(200);
      // Same requestId: a committed attempt is replayed as admitted; an uncommitted one is judged now and admits.
      expect(retry.body.outcome).toBe('admitted');
      expect(Boolean(retry.body.replayed)).toBe(wasCommitted);
      expect((await redeem(second, scannerKey, pass.token)).body.outcome).toBe('already_redeemed');
    }
    expect((await ok<EventSummary>(second, 'GET', `/api/events/${eventId}`)).admittedCount).toBe(50);
    await stop(second, 'SIGKILL');

    const final = inspect(file, verifyDatabase);
    expect(final.violations).toEqual([]);
    expect(final.counts.redemptions).toBe(50);
  }, TEST_TIMEOUT);

  // On Windows, Node delivers SIGTERM/SIGINT to a child as TerminateProcess
  // (no handler runs), so a graceful stop can only be exercised on POSIX.
  it.skipIf(process.platform === 'win32')('stops gracefully on SIGTERM: exit code 0 and the WAL checkpointed into the main file', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'gatepass.db');
    const server = await startServer(file);
    const { scannerKey, passes } = await seed(server, 2);
    expect((await redeem(server, scannerKey, passes[0].token)).body.outcome).toBe('admitted');

    const { code, signal } = await stop(server, 'SIGTERM');
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(server.output.join('')).toContain('SIGTERM received');
    // Closing the last connection checkpoints and removes the WAL.
    expect(!existsSync(`${file}-wal`) || statSync(`${file}-wal`).size === 0).toBe(true);

    // The main file alone (read-only, no WAL) already contains the admission.
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      expect(redeemedIds(db)).toEqual([passes[0].id]);
    } finally {
      db.close();
    }
    expect(inspect(file, verifyDatabase).violations).toEqual([]);
  }, TEST_TIMEOUT);
});

describe('backup and restore through the CLI', () => {
  it('backs up while serving, restores to exactly the backup point and keeps the replaced files', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'gatepass.db');
    const backup = path.join(dir, 'backups', 'point.db');
    const server = await startServer(file);
    const { eventId, scannerKey, passes } = await seed(server, 6);
    for (const pass of passes.slice(0, 2)) expect((await redeem(server, scannerKey, pass.token)).body.outcome).toBe('admitted');

    const backedUp = await cli(file, 'backup', backup);
    expect(backedUp.code, backedUp.output).toBe(0);
    expect(backedUp.output).toContain('Backup written and verified');
    // The live server keeps serving while and after the backup is taken.
    for (const pass of passes.slice(2, 4)) expect((await redeem(server, scannerKey, pass.token)).body.outcome).toBe('admitted');
    await ok(server, 'POST', `/api/passes/${passes[4].id}/revoke`);
    await stop(server, 'SIGKILL'); // leaves -wal/-shm behind: restore must move them aside too

    const snapshot = (db: DatabaseSync) => ({
      redeemed: redeemedIds(db),
      scans: db.prepare('SELECT id, pass_id, outcome FROM scans ORDER BY id').all().map((row) => ({ ...row })),
      audit: db.prepare('SELECT id, action, entity_id FROM audit_log ORDER BY id').all().map((row) => ({ ...row })),
      revoked: (db.prepare('SELECT id FROM passes WHERE revoked_at IS NOT NULL').all() as Array<{ id: string }>).map((row) => row.id)
    });
    const atBackup = inspect(backup, snapshot);
    expect(atBackup.redeemed).toEqual(passes.slice(0, 2).map((p) => p.id).sort());
    const beforeRestore = inspect(file, snapshot);
    expect(beforeRestore.redeemed).toHaveLength(4);
    expect(beforeRestore.revoked).toEqual([passes[4].id]);
    const hadWal = existsSync(`${file}-wal`);

    const restored = await cli(file, 'restore', backup);
    expect(restored.code, restored.output).toBe(0);
    expect(restored.output).toContain('Restored');

    // Restored file == backup point: later admissions and the later revocation are gone, as documented.
    const after = inspect(file, (db) => ({ ...snapshot(db), report: verifyDatabase(db), version: schemaVersion(db) }));
    expect(after.report.violations).toEqual([]);
    expect({ redeemed: after.redeemed, scans: after.scans, audit: after.audit, revoked: after.revoked }).toEqual(atBackup);
    expect(after.revoked).toEqual([]);

    // Previous files kept with a .replaced-<time> suffix and still hold the post-backup state.
    const replaced = readdirSync(dir).filter((name) => name.startsWith('gatepass.db.replaced-'));
    const mainReplaced = replaced.find((name) => !name.endsWith('-wal') && !name.endsWith('-shm'));
    expect(mainReplaced, replaced.join(', ')).toBeDefined();
    if (hadWal) expect(replaced).toContain(`${mainReplaced}-wal`);
    const kept = path.join(dir, `${mainReplaced}-copy.db`);
    copyFileSync(path.join(dir, mainReplaced!), kept);
    if (hadWal) copyFileSync(path.join(dir, `${mainReplaced}-wal`), `${kept}-wal`);
    expect(inspect(kept, snapshot)).toEqual(beforeRestore);

    // Serving from the restored file: the pass admitted after the backup is valid again.
    const again = await startServer(file);
    expect((await redeem(again, scannerKey, passes[0].token)).body.outcome).toBe('already_redeemed');
    expect((await redeem(again, scannerKey, passes[2].token)).body.outcome).toBe('admitted');
    expect((await redeem(again, scannerKey, passes[4].token)).body.outcome).toBe('admitted');
    expect((await ok<EventSummary>(again, 'GET', `/api/events/${eventId}`)).admittedCount).toBe(4);
    await stop(again, 'SIGKILL');
    expect(inspect(file, verifyDatabase).violations).toEqual([]);
  }, TEST_TIMEOUT);

  it('refuses a corrupt or non-database backup and leaves the current database untouched', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'gatepass.db');
    const server = await startServer(file);
    const { scannerKey, passes } = await seed(server, 3);
    expect((await redeem(server, scannerKey, passes[0].token)).body.outcome).toBe('admitted');
    const good = path.join(dir, 'good.db');
    const backedUp = await cli(file, 'backup', good);
    expect(backedUp.code, backedUp.output).toBe(0);
    await stop(server, 'SIGTERM'); // TerminateProcess on Windows; graceful on POSIX
    // Fold the WAL into the main file so the byte comparison below covers all data.
    inspect(file, (db) => db.exec('PRAGMA wal_checkpoint(TRUNCATE)'));

    // Same header and schema page, every other page overwritten.
    const corrupt = path.join(dir, 'corrupt.db');
    const bytes = readFileSync(good);
    const pageSize = bytes.readUInt16BE(16) === 1 ? 65536 : bytes.readUInt16BE(16);
    expect(bytes.length).toBeGreaterThan(pageSize * 2);
    bytes.fill(0xa5, pageSize);
    writeFileSync(corrupt, bytes);
    const garbage = path.join(dir, 'garbage.db');
    writeFileSync(garbage, 'not a database at all '.repeat(500));

    const before = Object.fromEntries(readdirSync(dir).filter((name) => name.startsWith('gatepass.db')).map((name) => [name, fileHash(path.join(dir, name))]));
    for (const bad of [corrupt, garbage, path.join(dir, 'missing.db')]) {
      const result = await cli(file, 'restore', bad);
      expect(result.code, result.output).toBe(1);
      expect(result.output).toMatch(/integrity|malformed|not a database|corrupt|not found/i);
      const now = Object.fromEntries(readdirSync(dir).filter((name) => name.startsWith('gatepass.db')).map((name) => [name, fileHash(path.join(dir, name))]));
      expect(now).toEqual(before);
    }

    const report = inspect(file, verifyDatabase);
    expect(report.violations).toEqual([]);
    expect(report.counts.redemptions).toBe(1);
  }, TEST_TIMEOUT);
});

describe('two server processes on one database file (unsupported topology)', () => {
  it('admits a pass exactly once across processes; contention answers 503, never a second admission', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'gatepass.db');
    const a = await startServer(file);
    const { eventId, scannerKey, passes } = await seed(a, 1);
    const b = await startServer(file);
    expect((await call(b, 'GET', `/api/events/${eventId}`)).status).toBe(200);

    const attempts = [a, b].flatMap((server, s) =>
      Array.from({ length: 20 }, (_, i) => redeem(server, scannerKey, passes[0].token, `dup-${s}-${String(i).padStart(4, '0')}`))
    );
    const replies = await Promise.all(attempts);
    const outcomes = replies.map((reply) => (reply.status === 200 ? reply.body.outcome : `http_${reply.status}`));
    const tally = Object.fromEntries([...new Set(outcomes)].map((outcome) => [outcome, outcomes.filter((o) => o === outcome).length]));
    console.info(`two processes, 40 attempts: ${JSON.stringify(tally)}`);
    expect(tally.admitted).toBe(1);
    for (const outcome of Object.keys(tally)) expect(['admitted', 'already_redeemed', 'http_503']).toContain(outcome);
    for (const reply of replies.filter((r) => r.status !== 200)) expect(reply.body).toEqual({ error: 'The server is busy. Try again.' });

    await stop(a, 'SIGKILL');
    await stop(b, 'SIGKILL');
    const persisted = inspect(file, (db) => ({
      report: verifyDatabase(db),
      redeemed: redeemedIds(db),
      admittedScans: Number((db.prepare("SELECT COUNT(*) AS n FROM scans WHERE outcome = 'admitted'").get() as { n: number }).n),
      scans: Number((db.prepare('SELECT COUNT(*) AS n FROM scans').get() as { n: number }).n)
    }));
    expect(persisted.report.violations).toEqual([]);
    expect(persisted.redeemed).toEqual([passes[0].id]);
    expect(persisted.admittedScans).toBe(1);
    // Every 200 answer was recorded as a scan; a 503 attempt left nothing behind.
    expect(persisted.scans).toBe(replies.filter((reply) => reply.status === 200).length);
  }, TEST_TIMEOUT);
});
