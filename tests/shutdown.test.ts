import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app';
import { recordAudit } from '../src/server/audit';
import { openDatabase, transaction } from '../src/server/db';
import { DeliveryWorker } from '../src/server/deliveries';
import { GatePass } from '../src/server/gatepass';
import { verifyDatabase } from '../src/server/integrity';
import { resendMailer, type Mailer } from '../src/server/mailer';
import { gracefulShutdown } from '../src/server/shutdown';
import type { EventSummary, IssuedPass } from '../src/shared/types';

// Graceful shutdown with pass emails in flight (audit PR-R3), against a fake
// Resend endpoint on a local port (RESEND_API_URL). Real HTTP and real timers
// on purpose: the subject is how the process behaves while a provider request
// is open, so the provider answers after real delays or never.
//
// - In-process (every platform): `gracefulShutdown` with a real HTTP server,
//   the Resend adapter and the worker.
// - Child process: `node src/server/index.ts` as deployed. A SIGKILL during a
//   send runs everywhere. SIGTERM runs on POSIX only: on Windows Node delivers
//   it to a child as TerminateProcess (no handler runs), and index.ts has no
//   other shutdown trigger.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ADMIN_TOKEN = 'shutdown-admin-token-0123456789abcdef';
const TEST_TIMEOUT = 120_000;
const posixOnly = it.skipIf(process.platform === 'win32');

interface ProviderRequest {
  idempotencyKey: string | undefined;
  to: string[];
  text: string;
}

type Mode = 'accept' | 'fail' | 'hang' | 'accept-then-hang';

/** Resend double: dedupes by Idempotency-Key like the real API, answers after `delayMs`, fails with 503, never answers, or takes the message and never answers. */
class FakeResend {
  mode: Mode = 'accept';
  delayMs = 0;
  readonly requests: ProviderRequest[] = [];
  /** Requests answered, in order (`accepted:<id>` or `failed`). */
  readonly answers: string[] = [];
  url = '';
  private readonly accepted = new Map<string, string>();
  private waiter: { count: number; resolve: () => void } | null = null;
  private readonly server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const parsed = JSON.parse(body) as { to: string[]; text: string };
      const key = req.headers['idempotency-key'];
      const idempotencyKey = typeof key === 'string' ? key : undefined;
      this.requests.push({ idempotencyKey, to: parsed.to, text: parsed.text });
      if (this.waiter && this.requests.length >= this.waiter.count) this.waiter.resolve();
      const mode = this.mode;
      if (mode === 'hang') return;
      if (mode === 'accept-then-hang') {
        if (idempotencyKey && !this.accepted.has(idempotencyKey)) this.accepted.set(idempotencyKey, `re_${this.accepted.size + 1}`);
        return;
      }
      setTimeout(() => {
        if (mode === 'fail') {
          this.answers.push('failed');
          res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ name: 'internal_server_error' }));
          return;
        }
        const id = (idempotencyKey && this.accepted.get(idempotencyKey)) || `re_${this.accepted.size + 1}`;
        if (idempotencyKey) this.accepted.set(idempotencyKey, id);
        this.answers.push(`accepted:${id}`);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id }));
      }, this.delayMs);
    });
  });

  async start(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.server.listen(0, '127.0.0.1', () => resolve());
    await promise;
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/emails`;
  }

  /** Resolves once `count` requests have arrived (answered or not). */
  requestsReached(count: number): Promise<void> {
    if (this.requests.length >= count) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.waiter = { count, resolve };
    return promise;
  }

  /** Distinct messages the provider would have sent. */
  get sent(): number {
    return this.accepted.size;
  }

  close(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.server.closeAllConnections();
    this.server.close(() => resolve());
    return promise;
  }
}

const providers: FakeResend[] = [];
const children = new Set<ChildProcess>();
const dirs: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
  vi.restoreAllMocks();
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
  for (const cleanup of cleanups.splice(0)) cleanup();
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function fakeResend(): Promise<FakeResend> {
  const provider = new FakeResend();
  await provider.start();
  providers.push(provider);
  return provider;
}

function tempFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gatepass-shutdown-'));
  dirs.push(dir);
  return path.join(dir, 'gatepass.db');
}

/** Built at run time: a key-shaped literal next to the variable name trips the secret scanner. */
function providerKey(): string {
  return `re_${randomBytes(12).toString('hex')}`;
}

function walCheckpointed(file: string): boolean {
  return !existsSync(`${file}-wal`) || statSync(`${file}-wal`).size === 0;
}

/** Opens the file as the server would, runs `fn`, closes it. */
function inspect<T>(file: string, fn: (db: DatabaseSync) => T): T {
  const db = openDatabase(file, { backupBeforeMigrate: false });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function deliveries(db: DatabaseSync): Array<Record<string, unknown>> {
  return db.prepare('SELECT id, status, attempts, provider_id, last_error, sealed_link FROM pass_deliveries ORDER BY created_at').all() as Array<Record<string, unknown>>;
}

function actions(db: DatabaseSync): string[] {
  return (db.prepare('SELECT action FROM audit_log ORDER BY id').all() as Array<{ action: string }>).map((row) => row.action);
}

// ------------------------------------------------------------ in-process

describe('graceful shutdown drain (in-process, every platform)', () => {
  async function serve(provider: FakeResend, mailer: Mailer = resendMailer({ apiKey: providerKey(), from: 'GatePass <passes@example.com>', url: provider.url })) {
    const file = tempFile();
    const db = openDatabase(file);
    const service = new GatePass(db, { publicUrl: 'https://gate.example', mailer, passDeliveryKey: randomBytes(32) });
    const server = http.createServer(createApp({ service, adminToken: ADMIN_TOKEN, rateLimits: false }));
    const { promise: listening, resolve } = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', () => resolve());
    await listening;
    const logs: Array<Record<string, unknown>> = [];
    const worker = new DeliveryWorker(service.deliveries, mailer, { perSecond: 50, maxAttempts: 5, log: (entry) => logs.push(entry) });
    worker.start();
    cleanups.push(() => {
      server.closeAllConnections();
      server.close();
      if (db.isOpen) db.close();
    });
    const now = Date.now();
    const event = service.createEvent({ name: 'Drain', startsAt: new Date(now - 3_600_000).toISOString(), endsAt: new Date(now + 6 * 3_600_000).toISOString() }, 'operator');
    service.issuePasses(event.id, { attendees: [{ name: 'Ada', email: 'ada@example.com' }], emailPasses: true }, 'operator');
    let code: number | null = null;
    const stop = (timings: { closeConnectionsMs: number; abortSendsMs: number; deadlineMs: number }) =>
      gracefulShutdown(
        { server, stopWorkers: () => worker.stop(), abortWorkers: () => worker.abort(), idle: () => service.accounts.idle(), db, exit: (value) => (code = value), log: (entry) => logs.push(entry) },
        timings
      ).then(() => code);
    return { file, db, service, stop, logs };
  }

  it('waits for a slow provider and for background email work, records both, then closes the database (exit 0)', async () => {
    const provider = await fakeResend();
    provider.delayMs = 400;
    const { file, db, service, stop } = await serve(provider);
    await provider.requestsReached(1);
    // Work a request started after its response (like the reset email): it must finish before the close.
    service.accounts.runInBackground(
      new Promise((resolve) => setTimeout(resolve, 300)).then(() =>
        transaction(db, () => recordAudit(db, { eventId: null, actor: 'system', action: 'test.background_done', entityId: null, details: {}, at: new Date().toISOString() }))
      ),
      'test background work'
    );

    expect(await stop({ closeConnectionsMs: 2_000, abortSendsMs: 4_000, deadlineMs: 6_000 })).toBe(0);
    expect(db.isOpen).toBe(false);
    expect(provider.answers).toEqual(['accepted:re_1']);
    expect(walCheckpointed(file)).toBe(true);
    inspect(file, (reopened) => {
      expect(deliveries(reopened)).toMatchObject([{ status: 'accepted', provider_id: 're_1', sealed_link: null }]);
      expect(actions(reopened)).toEqual(expect.arrayContaining(['pass.email_accepted', 'test.background_done']));
      expect(verifyDatabase(reopened).violations).toEqual([]);
    });
  });

  it('cancels a provider request that does not answer, records it as interrupted and still exits 0 before the deadline', async () => {
    const provider = await fakeResend();
    provider.mode = 'hang';
    const adapterErrors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { file, stop, logs } = await serve(provider);
    await provider.requestsReached(1);
    const started = performance.now();
    expect(await stop({ closeConnectionsMs: 100, abortSendsMs: 300, deadlineMs: 5_000 })).toBe(0);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(logs).toContainEqual({ level: 'info', msg: 'stopped', code: 0 });
    expect(adapterErrors.mock.calls.flat()).toEqual([JSON.stringify({ level: 'error', msg: 'email provider unreachable', provider: 'resend', reason: 'interrupted' })]);
    inspect(file, (reopened) => {
      const [row] = deliveries(reopened);
      expect(row).toMatchObject({ status: 'queued', attempts: 1, last_error: 'Sending was interrupted by a server shutdown; the provider may have accepted it.' });
      expect(row.sealed_link).toBeInstanceOf(Uint8Array);
    });
  });

  it('stops at the deadline when a send ignores cancellation (exit 1), leaving the email recoverable on the next start', async () => {
    const provider = await fakeResend();
    const { promise: claimed, resolve: onAttempt } = Promise.withResolvers<void>();
    const stuck: Mailer = {
      enabled: true,
      send: () => new Promise(() => {}),
      attempt: () => {
        onAttempt();
        return new Promise(() => {});
      }
    };
    const { file, db, stop, logs } = await serve(provider, stuck);
    await claimed; // the worker moved the row to `sending` and waits on the stuck provider
    expect(deliveries(db)[0].status).toBe('sending');
    expect(await stop({ closeConnectionsMs: 50, abortSendsMs: 100, deadlineMs: 500 })).toBe(1);
    expect(db.isOpen).toBe(false);
    expect(logs).toContainEqual(expect.objectContaining({ msg: 'shutdown deadline reached; stopping with work still running' }));
    expect(walCheckpointed(file)).toBe(true);
    inspect(file, (reopened) => {
      expect(deliveries(reopened)[0]).toMatchObject({ status: 'sending', attempts: 1 });
      expect(verifyDatabase(reopened).violations).toEqual([]);
    });
    // Next start: back in the queue with the same id (idempotency key).
    const reopened = openDatabase(file, { backupBeforeMigrate: false });
    cleanups.push(() => reopened.isOpen && reopened.close());
    const service = new GatePass(reopened, { publicUrl: 'https://gate.example', mailer: stuck, passDeliveryKey: randomBytes(32) });
    expect(service.deliveries.recoverInterrupted()).toBe(1);
    expect(deliveries(reopened)[0]).toMatchObject({ status: 'queued', attempts: 1 });
  });
});

// ------------------------------------------------------------ child process

interface ServerProcess {
  child: ChildProcess;
  url: string;
  output: string[];
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

async function freePort(): Promise<number> {
  const probe = createNetServer();
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as AddressInfo;
    probe.close(() => resolve(port));
  });
  return promise;
}

/** One node process (no tsx CLI wrapper), so a signal reaches the process that holds the database. */
async function startServer(file: string, provider: FakeResend, deliveryKey: string): Promise<ServerProcess> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--disable-warning=ExperimentalWarning', 'src/server/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DEMO_MODE: 'false',
      ORIGIN_SECRET: '',
      CLIENT_IP_HEADER: '',
      TRUST_PROXY: '',
      NODE_ENV: 'test',
      ADMIN_TOKEN,
      PORT: String(port),
      HOST: '127.0.0.1',
      APP_PUBLIC_URL: url,
      DATABASE_FILE: file,
      ALLOW_SIGNUP: 'true',
      RESEND_API_KEY: providerKey(),
      MAIL_FROM: 'GatePass <passes@example.com>',
      RESEND_API_URL: provider.url,
      PASS_DELIVERY_KEY: deliveryKey,
      PASS_EMAIL_PER_SECOND: '50',
      PASS_EMAIL_MAX_ATTEMPTS: '5'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  children.add(child);
  const output: string[] = [];
  child.stdout!.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr!.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  let exited = false;
  void exit.then(() => (exited = true));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Server exited during start-up:\n${output.join('')}`);
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        expect(await response.json()).toMatchObject({ email: true, passEmail: true });
        return { child, url, output, exit };
      }
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become healthy:\n${output.join('')}`);
}

async function call<T>(server: ServerProcess, method: string, route: string, body?: unknown, headers: Record<string, string> = { Authorization: `Bearer ${ADMIN_TOKEN}` }): Promise<T> {
  const response = await fetch(`${server.url}${route}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  expect(response.status, `${method} ${route}: ${text}`).toBeLessThan(300);
  return (text ? JSON.parse(text) : null) as T;
}

/** Live event with one pass for `email`, queued for email. */
async function issueWithEmail(server: ServerProcess, email: string): Promise<IssuedPass> {
  const now = Date.now();
  const event = await call<EventSummary>(server, 'POST', '/api/events', {
    name: 'Shutdown Night',
    startsAt: new Date(now - 3_600_000).toISOString(),
    endsAt: new Date(now + 6 * 3_600_000).toISOString()
  });
  const [pass] = await call<IssuedPass[]>(server, 'POST', `/api/events/${event.id}/passes`, { attendees: [{ name: 'Ada', email }], emailPasses: true });
  return pass;
}

function logLines(server: ServerProcess): Array<Record<string, unknown>> {
  return server.output
    .join('')
    .split('\n')
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

async function terminate(server: ServerProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }> {
  const started = performance.now();
  server.child.kill('SIGTERM');
  const result = await server.exit;
  return { ...result, ms: performance.now() - started };
}

describe('server process with pass emails in flight', () => {
  it('SIGKILL during a send: the restart queues it again and the provider sends it once (same idempotency key)', async () => {
    const provider = await fakeResend();
    provider.mode = 'hang';
    const file = tempFile();
    const key = randomBytes(32).toString('base64');
    const first = await startServer(file, provider, key);
    const pass = await issueWithEmail(first, 'ada@example.com');
    await provider.requestsReached(1);
    first.child.kill('SIGKILL');
    await first.exit;
    inspect(file, (db) => expect(deliveries(db)[0]).toMatchObject({ status: 'sending', attempts: 1 }));

    provider.mode = 'accept';
    const second = await startServer(file, provider, key);
    await provider.requestsReached(2);
    expect(provider.requests[1].idempotencyKey).toBe(provider.requests[0].idempotencyKey);
    expect(provider.requests[1].text).toContain(pass.passUrl);
    // The answer is recorded shortly after the provider sends it.
    const recorded = Date.now() + 10_000;
    while ((await call<{ counts: { accepted: number } }>(second, 'GET', `/api/events/${pass.eventId}/deliveries`)).counts.accepted !== 1) {
      if (Date.now() > recorded) throw new Error('the resent email was never recorded as accepted');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    second.child.kill('SIGKILL');
    await second.exit;
    expect(logLines(second)).toContainEqual(expect.objectContaining({ msg: 'pass emails interrupted by a restart were queued again', count: 1 }));
    expect(provider.sent).toBe(1);
    expect(second.output.join('')).not.toContain(pass.token);
    expect(second.output.join('')).not.toContain('ada@example.com');
    inspect(file, (db) => expect(verifyDatabase(db).violations).toEqual([]));
  }, TEST_TIMEOUT);

  it('SIGKILL after the provider took the email; restarted a day later: unconfirmed, never sent again', async () => {
    const provider = await fakeResend();
    provider.mode = 'accept-then-hang';
    const file = tempFile();
    const key = randomBytes(32).toString('base64');
    const first = await startServer(file, provider, key);
    const pass = await issueWithEmail(first, 'ada@example.com');
    await provider.requestsReached(1);
    first.child.kill('SIGKILL');
    await first.exit;
    expect(provider.sent).toBe(1);
    // The server stays down for 24 hours: the attempt started a day before the restart.
    const dayAgo = new Date(Date.now() - 24 * 3_600_000).toISOString();
    inspect(file, (db) => {
      expect(deliveries(db)[0]).toMatchObject({ status: 'sending', attempts: 1 });
      db.prepare("UPDATE pass_deliveries SET last_attempt_at = ?, updated_at = ? WHERE status = 'sending'").run(dayAgo, dayAgo);
    });

    provider.mode = 'accept';
    const second = await startServer(file, provider, key);
    const settled = Date.now() + 10_000;
    let counts = { unconfirmed: 0 };
    while (counts.unconfirmed !== 1) {
      if (Date.now() > settled) throw new Error('the interrupted email was never closed');
      await new Promise((resolve) => setTimeout(resolve, 50));
      counts = (await call<{ counts: { unconfirmed: number } }>(second, 'GET', `/api/events/${pass.eventId}/deliveries`)).counts;
    }
    second.child.kill('SIGKILL');
    await second.exit;
    expect(provider.requests).toHaveLength(1);
    expect(provider.sent).toBe(1);
    inspect(file, (db) => {
      expect(deliveries(db)[0]).toMatchObject({ status: 'unconfirmed', sealed_link: null });
      expect(actions(db)).toContain('pass.email_unconfirmed');
      expect(verifyDatabase(db).violations).toEqual([]);
    });
    for (const output of [first.output.join(''), second.output.join('')]) {
      expect(output).not.toContain(pass.token);
      expect(output).not.toContain('ada@example.com');
    }
  }, TEST_TIMEOUT);

  posixOnly('SIGTERM with a slow provider: the pass email and a reset email finish and are audited before the database closes (exit 0)', async () => {
    const provider = await fakeResend();
    provider.delayMs = 1_500;
    const file = tempFile();
    const server = await startServer(file, provider, randomBytes(32).toString('base64'));
    await issueWithEmail(server, 'ada@example.com');
    await call(server, 'POST', '/api/auth/register', { email: 'owner@example.com', name: 'Owner', password: 'correct horse battery' }, { 'X-GatePass-CSRF': '1' });
    await call(server, 'POST', '/api/auth/forgot', { email: 'owner@example.com' }, { 'X-GatePass-CSRF': '1' });
    await provider.requestsReached(2); // pass email (worker) and reset email (runInBackground), both unanswered

    const { code, signal, ms } = await terminate(server);
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(ms).toBeLessThan(10_000);
    expect(provider.answers).toHaveLength(2);
    expect(logLines(server)).toContainEqual({ level: 'info', msg: 'shutting down', signal: 'SIGTERM' });
    expect(logLines(server)).toContainEqual({ level: 'info', msg: 'stopped', code: 0 });
    expect(walCheckpointed(file)).toBe(true);
    inspect(file, (db) => {
      expect(deliveries(db)).toMatchObject([{ status: 'accepted', sealed_link: null }]);
      expect(actions(db)).toEqual(expect.arrayContaining(['pass.email_accepted', 'email.sent']));
      expect(verifyDatabase(db).violations).toEqual([]);
    });
  }, TEST_TIMEOUT);

  posixOnly('SIGTERM with a failing provider: the email is re-queued for a later retry and the process exits 0', async () => {
    const provider = await fakeResend();
    provider.mode = 'fail';
    provider.delayMs = 800;
    const file = tempFile();
    const server = await startServer(file, provider, randomBytes(32).toString('base64'));
    await issueWithEmail(server, 'ada@example.com');
    await provider.requestsReached(1);

    const { code, signal } = await terminate(server);
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(provider.answers).toEqual(['failed']);
    expect(walCheckpointed(file)).toBe(true);
    inspect(file, (db) => {
      const [row] = deliveries(db);
      expect(row).toMatchObject({ status: 'queued', attempts: 1, last_error: 'The email provider refused the message (internal_server_error).' });
      expect(row.sealed_link).toBeInstanceOf(Uint8Array);
      expect(verifyDatabase(db).violations).toEqual([]);
    });
  }, TEST_TIMEOUT);

  posixOnly('SIGTERM with a provider that never answers: bounded exit, the email stays queued and is sent once after the restart', async () => {
    const provider = await fakeResend();
    provider.mode = 'hang';
    const file = tempFile();
    const key = randomBytes(32).toString('base64');
    const server = await startServer(file, provider, key);
    const pass = await issueWithEmail(server, 'ada@example.com');
    await provider.requestsReached(1);

    const { code, signal, ms } = await terminate(server);
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(ms).toBeLessThan(10_000); // provider requests are cancelled at 7 s, inside the 10 s deadline
    expect(walCheckpointed(file)).toBe(true);
    inspect(file, (db) => {
      expect(deliveries(db)[0]).toMatchObject({ status: 'queued', attempts: 1 });
      expect(verifyDatabase(db).violations).toEqual([]);
    });

    provider.mode = 'accept';
    const restarted = await startServer(file, provider, key);
    await provider.requestsReached(2);
    expect(provider.requests[1].idempotencyKey).toBe(provider.requests[0].idempotencyKey);
    expect(provider.requests[1].text).toContain(pass.passUrl);
    const after = await terminate(restarted);
    expect(after.code).toBe(0);
    expect(provider.sent).toBe(1);
    inspect(file, (db) => expect(deliveries(db)[0]).toMatchObject({ status: 'accepted', attempts: 2 }));
  }, TEST_TIMEOUT);
});
