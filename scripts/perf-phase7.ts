/**
 * Phase 7 performance run on a locally BUILT server (docs/performance.md,
 * section "2026-11-17"). Developer-laptop numbers only.
 *
 * 1. Builds into .local/perf/build (never touches dist/): the client
 *    (`vite build`), the production server bundle (`vite build --ssr
 *    src/server/index.ts`, as `npm run build:server`) and the saturation
 *    server (`scripts/perf-server.ts`, same bundler, `rateLimits: false`).
 *    Reports browser bundle sizes (raw, gzip -9, brotli q11).
 * 2. For each server kind it starts `node <bundle>` on a fresh temp data dir
 *    and a free loopback port and runs one synthetic event:
 *      6 gates; policies General (gates 1-4), VIP (gates 5-6, capacity 450),
 *      Staff (all gates); 10 gate-bound scanners (gates 1..6,1..4);
 *      passes: General 2,000 issued + 2,000 imported from a generated CSV,
 *      VIP 500, Staff 500 (+ race passes).
 *    Traffic per scanner device: one request at a time; every pass once at an
 *    allowed gate, 10% re-scanned on another allowed scanner at about the
 *    same moment (cross-device race), 2% of General passes first presented at
 *    a VIP gate (wrong_gate). Segment 1 (first half of every queue) runs with
 *    no dashboards, segment 2 with D admin dashboards polling operations,
 *    scan feed, a pass-list page and the CSV exports.
 *    Then a race: R Staff passes, each sent by all 10 scanners at once.
 *    Then idle API timings over the full data set, memory, and checks:
 *    verifyDatabase, admitted responses == redemption rows, 2xx redeems ==
 *    scan rows, no pass admitted twice, VIP admissions == capacity.
 *    production: `node .local/perf/build/server/index.js`, NODE_ENV=production,
 *      rate limits ON; scanners paced at --pace scans/s each (default 3.5,
 *      just under the 240/min per-device limit); dashboards poll every 5 s
 *      (LIVE_POLL_MS), exports every 20 s.
 *    saturation: perf-server bundle, rate limits OFF; scanners closed-loop
 *      (next request as soon as the answer arrives); dashboards poll every
 *      1 s, exports every 5 s (a 5x stress of the UI rate).
 *
 * Usage: npx tsx --disable-warning=ExperimentalWarning scripts/perf-phase7.ts [options]
 *   --servers production,saturation   --skip-build   --pace 3.5   --dashboards 3
 *   --race-production 20   --race-saturation 200   --out .local/perf   --keep (keep temp data dirs)
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';
import { attendeesFromCsv, parseCsv } from '../src/client/csv';
import { verifyDatabase } from '../src/server/integrity';
import { hostInfo } from './bench-server';

const { values: args } = parseArgs({
  options: {
    servers: { type: 'string', default: 'production,saturation' },
    'skip-build': { type: 'boolean', default: false },
    pace: { type: 'string', default: '3.5' },
    dashboards: { type: 'string', default: '3' },
    'race-production': { type: 'string', default: '20' },
    'race-saturation': { type: 'string', default: '200' },
    out: { type: 'string', default: path.join('.local', 'perf') },
    keep: { type: 'boolean', default: false },
    ref: { type: 'string' }
  }
});
type Kind = 'production' | 'saturation';
const servers = args.servers.split(',').map((s) => s.trim()) as Kind[];
for (const kind of servers) if (kind !== 'production' && kind !== 'saturation') throw new Error(`Unknown server kind ${kind}`);
const PACE = Number(args.pace);
const DASHBOARDS = Number(args.dashboards);

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUILD = path.join(ROOT, '.local', 'perf', 'build');
/**
 * Tree the server and client are built from: the working tree, or with
 * `--ref <git-ref>` a clean `git archive` of that commit under .local/perf
 * (node_modules still resolve from the repo root), so concurrent uncommitted
 * edits cannot leak into the measurement.
 */
const SOURCE = args.ref ? path.join(ROOT, '.local', 'perf', 'source') : ROOT;
const ADMIN = `perf-operator-${randomUUID()}`;
const SCANNERS = 10;
const GATES = 6;
/** Scanner i is bound to gate SCANNER_GATE[i] (0-based). */
const SCANNER_GATE = [0, 1, 2, 3, 4, 5, 0, 1, 2, 3];
const GENERAL_SCANNERS = [0, 1, 2, 3, 6, 7, 8, 9];
const VIP_SCANNERS = [4, 5];
const COUNTS = { generalIssued: 2000, imported: 2000, vip: 500, staff: 500 };
const VIP_CAPACITY = 450;

// ------------------------------------------------------------------ helpers

interface Latency {
  n: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}
/** Nearest-rank percentiles. */
function summarize(values: number[]): Latency {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return { n: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  const at = (p: number) => Number(sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)].toFixed(2));
  return { n: sorted.length, p50Ms: at(50), p95Ms: at(95), p99Ms: at(99), maxMs: Number(sorted.at(-1)!.toFixed(2)) };
}
const median = (values: number[]) => summarize(values).p50Ms;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}
const mib = (bytes: number) => Math.round((bytes / 2 ** 20) * 10) / 10;

function vite(viteArgs: string[]): { ms: number; output: string } {
  const started = performance.now();
  const output = execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), ...viteArgs], {
    cwd: SOURCE,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return { ms: Math.round(performance.now() - started), output };
}

interface BundleFile {
  file: string;
  bytes: number;
  gzip: number;
  brotli: number;
}
function bundleSizes(dir: string): { files: BundleFile[]; totals: Record<string, { bytes: number; gzip: number; brotli: number }> } {
  const files: BundleFile[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const data = readFileSync(full);
        files.push({
          file: path.relative(dir, full).replaceAll('\\', '/'),
          bytes: data.length,
          gzip: gzipSync(data, { level: 9 }).length,
          brotli: brotliCompressSync(data, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11 } }).length
        });
      }
    }
  };
  walk(dir);
  files.sort((a, b) => b.bytes - a.bytes);
  const totals: Record<string, { bytes: number; gzip: number; brotli: number }> = {};
  for (const file of files) {
    const ext = path.extname(file.file).slice(1) || 'other';
    for (const key of [ext, 'all']) {
      totals[key] ??= { bytes: 0, gzip: 0, brotli: 0 };
      totals[key].bytes += file.bytes;
      totals[key].gzip += file.gzip;
      totals[key].brotli += file.brotli;
    }
  }
  return { files, totals };
}

interface Memory {
  label: string;
  rssMiB: number;
  peakRssMiB: number;
  privateMiB: number | null;
}
/** Resident set (Windows: working set) of another process, best effort. */
function memoryOf(pid: number, label: string): Memory {
  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-Process -Id ${pid}; "$($p.WorkingSet64) $($p.PeakWorkingSet64) $($p.PrivateMemorySize64)"`],
      { encoding: 'utf8', timeout: 20_000 }
    ).trim();
    const [ws, peak, priv] = out.split(/\s+/).map(Number);
    return { label, rssMiB: mib(ws), peakRssMiB: mib(peak), privateMiB: mib(priv) };
  }
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const kb = (field: string) => Number(new RegExp(`${field}:\\s+(\\d+)`).exec(status)?.[1] ?? 0) * 1024;
  return { label, rssMiB: mib(kb('VmRSS')), peakRssMiB: mib(kb('VmHWM')), privateMiB: null };
}

async function freePort(): Promise<number> {
  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  probe.close();
  await once(probe, 'close');
  return port;
}

// ------------------------------------------------------------------ server

interface LogTally {
  /** Request log lines by route and status, from the server's own structured log. */
  byRoute: Record<string, Record<string, number>>;
  serverMs: Record<string, number[]>;
  databaseBusy: number;
  unhandled: number;
  errorLines: number;
}

interface Server {
  child: ChildProcess;
  base: string;
  dir: string;
  dbFile: string;
  log: LogTally;
  stop(): Promise<void>;
}

async function startServer(kind: Kind): Promise<Server> {
  const dir = mkdtempSync(path.join(os.tmpdir(), `gatepass-perf-${kind}-`));
  const dbFile = path.join(dir, 'gatepass.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const entry = kind === 'production' ? path.join(BUILD, 'server', 'index.js') : path.join(BUILD, 'perf-server', 'perf-server.js');
  // Clean environment: nothing from the developer's shell (no mail keys, no .env).
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
    NODE_ENV: 'production',
    ADMIN_TOKEN: ADMIN,
    DATABASE_FILE: dbFile,
    HOST: '127.0.0.1',
    PORT: String(port),
    APP_PUBLIC_URL: base,
    CLIENT_DIR: path.join(BUILD, 'client')
  };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entry], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const log: LogTally = { byRoute: {}, serverMs: {}, databaseBusy: 0, unhandled: 0, errorLines: 0 };
  const consume = (line: string) => {
    let entry: { msg?: string; level?: string; route?: string; status?: number; ms?: number; method?: string };
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (entry.level === 'error') log.errorLines++;
    if (entry.msg === 'database busy') log.databaseBusy++;
    if (entry.msg === 'unhandled error') log.unhandled++;
    if (entry.msg === 'request' && entry.route) {
      const route = `${entry.method} ${entry.route}`;
      (log.byRoute[route] ??= {})[String(entry.status)] = (log.byRoute[route][String(entry.status)] ?? 0) + 1;
      (log.serverMs[route] ??= []).push(entry.ms ?? 0);
    }
  };
  createInterface({ input: child.stdout! }).on('line', consume);
  createInterface({ input: child.stderr! }).on('line', consume);
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`${kind} server exited with ${child.exitCode}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`${kind} server not healthy after 30 s`);
    await sleep(100);
  }
  return {
    child,
    base,
    dir,
    dbFile,
    log,
    async stop() {
      // 'close' fires after stdout/stderr are drained, so every log line has been read.
      const exited = once(child, 'close');
      if (kind === 'saturation') child.send('stop');
      else child.kill(); // Windows: TerminateProcess; WAL keeps the database consistent.
      await exited;
      if (!args.keep) rmSync(dir, { recursive: true, force: true });
    }
  };
}

// ------------------------------------------------------------------ HTTP

interface Timed<T> {
  status: number;
  ms: number;
  bytes: number;
  body: T;
}
async function request<T>(base: string, method: string, route: string, token: string, body?: unknown): Promise<Timed<T>> {
  const started = performance.now();
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  const ms = performance.now() - started;
  let parsed: unknown = text;
  if ((response.headers.get('content-type') ?? '').includes('json')) parsed = JSON.parse(text);
  return { status: response.status, ms, bytes: Buffer.byteLength(text), body: parsed as T };
}
async function admin<T>(base: string, method: string, route: string, body?: unknown): Promise<Timed<T>> {
  const result = await request<T>(base, method, route, ADMIN, body);
  if (result.status >= 300) throw new Error(`${method} ${route} -> ${result.status} ${JSON.stringify(result.body).slice(0, 300)}`);
  return result;
}

// ------------------------------------------------------------------ scenario

interface QueueItem {
  code: string;
  slot: number;
  kind: 'first' | 'dup' | 'wrong_gate';
}

interface RedeemTally {
  latencies: number[];
  outcomes: Record<string, number>;
  httpStatus: Record<string, number>;
  networkErrors: number;
  wallMs: number;
  /** Admitted answers per pass token (must never exceed 1). */
  admittedByCode: Map<string, number>;
}
const newTally = (): RedeemTally => ({ latencies: [], outcomes: {}, httpStatus: {}, networkErrors: 0, wallMs: 0, admittedByCode: new Map() });

async function redeem(base: string, key: string, code: string, tally: RedeemTally): Promise<void> {
  const started = performance.now();
  try {
    const response = await fetch(`${base}/api/scanner/redeem`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, requestId: randomUUID() })
    });
    const body = (await response.json()) as { outcome?: string };
    tally.latencies.push(performance.now() - started);
    tally.httpStatus[response.status] = (tally.httpStatus[response.status] ?? 0) + 1;
    if (response.ok && body.outcome) {
      tally.outcomes[body.outcome] = (tally.outcomes[body.outcome] ?? 0) + 1;
      if (body.outcome === 'admitted') tally.admittedByCode.set(code, (tally.admittedByCode.get(code) ?? 0) + 1);
    }
  } catch {
    tally.latencies.push(performance.now() - started);
    tally.networkErrors++;
  }
}

interface DashboardTally {
  byEndpoint: Record<string, { ms: number[]; bytes: number[]; status: Record<string, number> }>;
}

/** Admin dashboards: every `intervalMs` operations + scan feed + a pass-list page; exports every `exportEvery` cycles. */
function startDashboards(base: string, eventId: string, count: number, intervalMs: number, exportEvery: number) {
  const tally: DashboardTally = { byEndpoint: {} };
  let running = true;
  const hit = async (name: string, route: string) => {
    const result = await request(base, 'GET', route, ADMIN);
    const entry = (tally.byEndpoint[name] ??= { ms: [], bytes: [], status: {} });
    entry.ms.push(result.ms);
    entry.bytes.push(result.bytes);
    entry.status[result.status] = (entry.status[result.status] ?? 0) + 1;
    return result;
  };
  const loops = Array.from({ length: count }, async (_, index) => {
    await sleep((intervalMs / count) * index);
    let lastScan = 0;
    for (let cycle = 0; running; cycle++) {
      const started = performance.now();
      await hit('operations', `/api/events/${eventId}/operations`);
      const feed = await hit('scan feed (after, limit 100)', `/api/events/${eventId}/scans?after=${lastScan}&limit=100`);
      const scans = feed.body as Array<{ id: number }>;
      if (Array.isArray(scans) && scans.length) lastScan = scans[0].id;
      await hit('passes page (limit 50)', `/api/events/${eventId}/passes?limit=50&offset=0${cycle % 2 ? '&q=attendee%201' : ''}`);
      if (cycle % exportEvery === exportEvery - 1) {
        await hit('attendance.csv', `/api/events/${eventId}/exports/attendance.csv`);
        await hit('scans.csv', `/api/events/${eventId}/exports/scans.csv`);
      }
      const left = intervalMs - (performance.now() - started);
      // Wake early when stopped so the run ends promptly.
      for (let waited = 0; running && waited < left; waited += 100) await sleep(Math.min(100, left - waited));
    }
  });
  return {
    tally,
    async stop() {
      running = false;
      await Promise.all(loops);
    }
  };
}

/** Each scanner sends its queue one request at a time; `paceHz` caps it at that many requests per second. */
async function driveScanners(base: string, keys: string[], queues: QueueItem[][], paceHz: number | null): Promise<RedeemTally> {
  const tally = newTally();
  const interval = paceHz ? 1000 / paceHz : 0;
  const started = performance.now();
  await Promise.all(
    queues.map(async (queue, scanner) => {
      // Stagger paced devices so they do not fire in lock-step.
      let next = performance.now() + (interval * scanner) / keys.length;
      for (const item of queue) {
        if (interval) {
          const wait = next - performance.now();
          if (wait > 0) await sleep(wait);
          next = Math.max(next + interval, performance.now());
        }
        await redeem(base, keys[scanner], item.code, tally);
      }
    })
  );
  tally.wallMs = performance.now() - started;
  return tally;
}

function summarizeTally(tally: RedeemTally) {
  const requests = tally.latencies.length;
  return {
    requests,
    ...summarize(tally.latencies),
    perSecond: Math.round((requests / tally.wallMs) * 10_000) / 10,
    wallS: Math.round(tally.wallMs / 100) / 10,
    outcomes: tally.outcomes,
    httpStatus: tally.httpStatus,
    networkErrors: tally.networkErrors,
    admitted: tally.outcomes.admitted ?? 0,
    passesAdmittedTwice: [...tally.admittedByCode.values()].filter((n) => n > 1).length
  };
}

function summarizeDashboards(tally: DashboardTally) {
  return Object.fromEntries(
    Object.entries(tally.byEndpoint).map(([name, entry]) => [name, { ...summarize(entry.ms), medianBytes: median(entry.bytes), status: entry.status }])
  );
}

async function scenario(kind: Kind) {
  console.error(`\n== ${kind} server`);
  const server = await startServer(kind);
  const { base } = server;
  const memory: Memory[] = [memoryOf(server.child.pid!, 'idle after start')];
  const raceCount = Number(kind === 'production' ? args['race-production'] : args['race-saturation']);
  const provisionMs: Record<string, number> = {};
  let measured;
  try {
    // -------------------------------------------------- provisioning
    const t0 = performance.now();
    const now = Date.now();
    const event = (
      await admin<{ id: string }>(base, 'POST', '/api/events', {
        name: `Perf ${kind}`,
        startsAt: new Date(now - 3_600_000).toISOString(),
        endsAt: new Date(now + 6 * 3_600_000).toISOString(),
        status: 'active'
      })
    ).body;
    const gates: string[] = [];
    for (let i = 0; i < GATES; i++) gates.push((await admin<{ id: string }>(base, 'POST', `/api/events/${event.id}/gates`, { name: `Gate ${i + 1}` })).body.id);
    const general = (await admin<{ id: string }>(base, 'POST', `/api/events/${event.id}/policies`, { name: 'General', gateIds: gates.slice(0, 4) })).body.id;
    const vip = (await admin<{ id: string }>(base, 'POST', `/api/events/${event.id}/policies`, { name: 'VIP', gateIds: gates.slice(4, 6), capacity: VIP_CAPACITY })).body.id;
    const staff = (await admin<{ id: string }>(base, 'POST', `/api/events/${event.id}/policies`, { name: 'Staff' })).body.id;
    const keys: string[] = [];
    for (let i = 0; i < SCANNERS; i++) {
      const created = await admin<{ enrollment: { url: string } }>(base, 'POST', `/api/events/${event.id}/scanners`, { label: `Door ${i + 1}`, gateId: gates[SCANNER_GATE[i]] });
      const code = created.body.enrollment.url.split('#enroll=')[1];
      keys.push((await admin<{ key: string }>(base, 'POST', '/api/scanner/enroll', { code })).body.key);
    }
    provisionMs['event, 6 gates, 3 policies, 10 scanners enrolled'] = Math.round(performance.now() - t0);

    const issueTimes: number[] = [];
    const issue = async (policyId: string, total: number) => {
      const tokens: string[] = [];
      for (let left = total; left > 0; left -= 500) {
        const result = await admin<Array<{ token: string }>>(base, 'POST', `/api/events/${event.id}/passes`, { count: Math.min(500, left), policyId });
        issueTimes.push(result.ms);
        tokens.push(...result.body.map((pass) => pass.token));
      }
      return tokens;
    };
    const t1 = performance.now();
    const generalTokens = await issue(general, COUNTS.generalIssued);
    const vipTokens = await issue(vip, COUNTS.vip);
    const staffTokens = await issue(staff, COUNTS.staff);
    const raceTokens = raceCount ? await issue(staff, raceCount) : [];
    provisionMs[`issue ${COUNTS.generalIssued + COUNTS.vip + COUNTS.staff + raceCount} passes in batches of 500`] = Math.round(performance.now() - t1);

    // -------------------------------------------------- CSV import, 2,000 rows
    const lines = ['Name,Email'];
    for (let i = 1; i <= COUNTS.imported; i++) lines.push(i % 7 === 0 ? `"Attendee ${i}, ""Jr.""",attendee${i}@example.test` : `Attendee ${i},attendee${i}@example.test`);
    const csv = `${lines.join('\r\n')}\r\n`;
    const parseRuns: number[] = [];
    let parsed = attendeesFromCsv(parseCsv(csv));
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      parsed = attendeesFromCsv(parseCsv(csv));
      parseRuns.push(performance.now() - started);
    }
    const dryRun = await admin<{ accepted: number; rejected: unknown[] }>(base, 'POST', `/api/events/${event.id}/passes/import`, { rows: parsed.rows, dryRun: true, policyId: general });
    const commit = await admin<{ accepted: number; rejected: unknown[]; issued: Array<{ token: string }> }>(base, 'POST', `/api/events/${event.id}/passes/import`, {
      rows: parsed.rows,
      dryRun: false,
      policyId: general
    });
    if (commit.body.accepted !== COUNTS.imported || commit.body.issued.length !== COUNTS.imported) throw new Error(`Import accepted ${commit.body.accepted}`);
    const csvImport = {
      rows: parsed.rows.length,
      csvBytes: Buffer.byteLength(csv),
      requestBytes: Buffer.byteLength(JSON.stringify({ rows: parsed.rows, dryRun: false, policyId: general })),
      parseMedianMs: median(parseRuns),
      dryRunMs: Math.round(dryRun.ms * 10) / 10,
      dryRunAccepted: dryRun.body.accepted,
      commitMs: Math.round(commit.ms * 10) / 10,
      commitResponseBytes: commit.bytes,
      accepted: commit.body.accepted,
      rejected: commit.body.rejected.length
    };
    console.error(`import: parse ${csvImport.parseMedianMs} ms, dry run ${csvImport.dryRunMs} ms, commit ${csvImport.commitMs} ms`);
    const allGeneral = [...generalTokens, ...commit.body.issued.map((pass) => pass.token)];
    memory.push(memoryOf(server.child.pid!, `after provisioning ${allGeneral.length + vipTokens.length + staffTokens.length + raceTokens.length} passes`));

    // -------------------------------------------------- traffic plan
    const random = mulberry32(20261117);
    const shuffle = <T>(items: T[]) => {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
      return items;
    };
    const plan = shuffle([
      ...allGeneral.map((code) => ({ code, allowed: GENERAL_SCANNERS })),
      ...vipTokens.map((code) => ({ code, allowed: VIP_SCANNERS })),
      // Staff passes may use any gate; route them to the VIP doors so every queue is about the same length.
      ...staffTokens.map((code) => ({ code, allowed: VIP_SCANNERS, anyGate: true }))
    ]);
    const queues: QueueItem[][] = Array.from({ length: SCANNERS }, () => []);
    const rr = new Map<number[], number>();
    let duplicates = 0;
    let wrongGate = 0;
    for (const item of plan) {
      const turn = rr.get(item.allowed) ?? 0;
      rr.set(item.allowed, turn + 1);
      const scanner = item.allowed[turn % item.allowed.length];
      const slot = queues[scanner].filter((q) => q.kind === 'first').length;
      queues[scanner].push({ code: item.code, slot, kind: 'first' });
      if (random() < 0.1) {
        const others = ('anyGate' in item ? Array.from({ length: SCANNERS }, (_, i) => i) : item.allowed).filter((s) => s !== scanner);
        queues[others[Math.floor(random() * others.length)]].push({ code: item.code, slot: slot + random() * 3, kind: 'dup' });
        duplicates++;
      }
      if (item.allowed === GENERAL_SCANNERS && random() < 0.02) {
        queues[VIP_SCANNERS[Math.floor(random() * 2)]].push({ code: item.code, slot: slot - 0.5 - random() * 2, kind: 'wrong_gate' });
        wrongGate++;
      }
    }
    for (const queue of queues) queue.sort((a, b) => a.slot - b.slot);
    const half = Math.max(...queues.map((q) => q.filter((i) => i.kind === 'first').length)) / 2;
    const segment1 = queues.map((q) => q.filter((i) => i.slot < half));
    const segment2 = queues.map((q) => q.filter((i) => i.slot >= half));

    // -------------------------------------------------- segment 1: scanning only
    const pace = kind === 'production' ? PACE : null;
    console.error(`segment 1: ${segment1.flat().length} requests, ${pace ? `${pace}/s per scanner` : 'closed loop'}`);
    const seg1 = await driveScanners(base, keys, segment1, pace);
    memory.push(memoryOf(server.child.pid!, 'after segment 1 (scanning only)'));

    // -------------------------------------------------- segment 2: scanning + dashboards
    const dashInterval = kind === 'production' ? 5000 : 1000;
    const exportEvery = kind === 'production' ? 4 : 5;
    console.error(`segment 2: ${segment2.flat().length} requests + ${DASHBOARDS} dashboards every ${dashInterval} ms`);
    const dashboards = startDashboards(base, event.id, DASHBOARDS, dashInterval, exportEvery);
    const seg2 = await driveScanners(base, keys, segment2, pace);
    await dashboards.stop();
    memory.push(memoryOf(server.child.pid!, 'after segment 2 (scanning + dashboards)'));

    // -------------------------------------------------- race: all scanners, same pass, same moment
    const race = newTally();
    const raceStarted = performance.now();
    for (const code of raceTokens) await Promise.all(keys.map((key) => redeem(base, key, code, race)));
    race.wallMs = performance.now() - raceStarted;

    // -------------------------------------------------- idle API timings over the full data set
    const idle: Record<string, Latency & { medianBytes: number }> = {};
    const endpoints: Array<[string, string]> = [
      ['operations', `/api/events/${event.id}/operations`],
      ['passes page (limit 50)', `/api/events/${event.id}/passes?limit=50`],
      ['passes search q=attendee 1 (limit 50)', `/api/events/${event.id}/passes?limit=50&q=attendee%201`],
      ['passes status=active (limit 50)', `/api/events/${event.id}/passes?limit=50&status=active`],
      ['passes all (limit 5000)', `/api/events/${event.id}/passes?limit=5000`],
      ['scans (limit 200)', `/api/events/${event.id}/scans?limit=200`],
      ['audit (limit 500)', `/api/events/${event.id}/audit?limit=500`],
      ['attendance.csv', `/api/events/${event.id}/exports/attendance.csv`],
      ['scans.csv', `/api/events/${event.id}/exports/scans.csv`],
      ['audit.csv', `/api/events/${event.id}/exports/audit.csv`]
    ];
    for (const [name, route] of endpoints) {
      const ms: number[] = [];
      const bytes: number[] = [];
      for (let i = 0; i < 5; i++) {
        const result = await admin(base, 'GET', route);
        ms.push(result.ms);
        bytes.push(result.bytes);
      }
      idle[name] = { ...summarize(ms), medianBytes: median(bytes) };
    }
    memory.push(memoryOf(server.child.pid!, 'after idle API timings and exports'));

    // -------------------------------------------------- correctness checks (read-only connection)
    const db = new DatabaseSync(server.dbFile, { readOnly: true });
    let checks;
    try {
      const report = verifyDatabase(db);
      const count = (sql: string, ...params: string[]) => Number((db.prepare(sql).get(...params) as { n: number }).n);
      const redemptionRows = count('SELECT COUNT(*) AS n FROM redemptions r JOIN passes p ON p.id = r.pass_id WHERE p.event_id = ?', event.id);
      const vipRedemptions = count('SELECT COUNT(*) AS n FROM redemptions r JOIN passes p ON p.id = r.pass_id WHERE p.policy_id = ?', vip);
      const scanRows = count("SELECT COUNT(*) AS n FROM scans WHERE event_id = ? AND request_id IS NOT NULL", event.id);
      const tallies = [seg1, seg2, race];
      const admittedResponses = tallies.reduce((sum, t) => sum + (t.outcomes.admitted ?? 0), 0);
      const okResponses = tallies.reduce((sum, t) => sum + Object.values(t.outcomes).reduce((a, b) => a + b, 0), 0);
      const admittedCodes = new Map<string, number>();
      for (const t of tallies) for (const [code, n] of t.admittedByCode) admittedCodes.set(code, (admittedCodes.get(code) ?? 0) + n);
      const passesAdmittedTwice = [...admittedCodes.values()].filter((n) => n > 1).length;
      const expectedAdmitted = allGeneral.length + VIP_CAPACITY + staffTokens.length + raceTokens.length;
      const raceAdmittedPerPass = raceTokens.map((code) => race.admittedByCode.get(code) ?? 0);
      checks = {
        verifyDatabaseOk: report.ok,
        violations: report.violations,
        expectedAdmitted,
        admittedResponses,
        redemptionRows,
        vipRedemptions,
        vipCapacity: VIP_CAPACITY,
        okRedeemResponses: okResponses,
        scanRows,
        passesAdmittedTwice,
        racePassesWithExactlyOneAdmission: raceAdmittedPerPass.filter((n) => n === 1).length,
        racePasses: raceTokens.length,
        passed:
          report.ok &&
          admittedResponses === redemptionRows &&
          redemptionRows === expectedAdmitted &&
          vipRedemptions === VIP_CAPACITY &&
          okResponses === scanRows &&
          passesAdmittedTwice === 0 &&
          raceAdmittedPerPass.every((n) => n === 1)
      };
    } finally {
      db.close();
    }
    const dbBytes = statSync(server.dbFile).size;
    let walBytes = 0;
    try {
      walBytes = statSync(`${server.dbFile}-wal`).size;
    } catch {
      // no WAL file
    }

    measured = {
      kind,
      rateLimits: kind === 'production',
      pacePerScanner: pace,
      dashboardIntervalMs: dashInterval,
      exportEveryCycles: exportEvery,
      plan: { passes: plan.length + raceTokens.length, firstScans: plan.length, duplicates, wrongGate, raceTokens: raceTokens.length },
      provisionMs,
      issueBatchMs: summarize(issueTimes),
      csvImport,
      segment1: summarizeTally(seg1),
      segment2: summarizeTally(seg2),
      dashboards: summarizeDashboards(dashboards.tally),
      race: summarizeTally(race),
      idle,
      memory,
      database: { fileMiB: mib(dbBytes), walMiB: mib(walBytes) },
      checks
    };
  } finally {
    await server.stop();
  }
  // Summarized after the server has exited, so the log lines of the last requests are counted too.
  return {
    ...measured,
    serverLog: {
      databaseBusy: server.log.databaseBusy,
      unhandledErrors: server.log.unhandled,
      errorLines: server.log.errorLines,
      // Server-side handler time (request log `ms`) and status counts per route, whole run.
      routes: Object.fromEntries(Object.entries(server.log.byRoute).map(([route, status]) => [route, { status, ...summarize(server.log.serverMs[route]) }]))
    }
  };
}

// ------------------------------------------------------------------ main

const started = new Date();
// Resolved once, before building: HEAD may move while the run is in progress.
let commitHash = 'unknown';
let dirty = false;
try {
  commitHash = execFileSync('git', ['rev-parse', args.ref ?? 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  dirty = args.ref ? false : execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim() !== '';
} catch (error) {
  if (args.ref) throw error;
  // Not a git checkout: the working tree is measured as is.
}
let build: Record<string, unknown> = { skipped: true, note: 'bundles from an earlier run; commit below is not verified against them' };
if (!args['skip-build']) {
  console.error('building into .local/perf/build ...');
  if (args.ref) {
    rmSync(SOURCE, { recursive: true, force: true });
    mkdirSync(SOURCE, { recursive: true });
    const tarFile = path.join(ROOT, '.local', 'perf', 'source.tar');
    execFileSync('git', ['archive', '--format=tar', '-o', tarFile, commitHash], { cwd: ROOT });
    execFileSync('tar', ['-xf', tarFile, '-C', SOURCE]);
    rmSync(tarFile);
    copyFileSync(path.join(ROOT, 'scripts', 'perf-server.ts'), path.join(SOURCE, 'scripts', 'perf-server.ts'));
  }
  let client, serverBundle, perfServer;
  try {
    client = vite(['build', '--outDir', path.join(BUILD, 'client'), '--emptyOutDir']);
    serverBundle = vite(['build', '--ssr', 'src/server/index.ts', '--outDir', path.join(BUILD, 'server'), '--emptyOutDir']);
    perfServer = vite(['build', '--ssr', 'scripts/perf-server.ts', '--outDir', path.join(BUILD, 'perf-server'), '--emptyOutDir']);
  } finally {
    // The snapshot contains a full copy of tests/ and configs; do not leave it where other tools might pick it up.
    if (args.ref && !args.keep) rmSync(SOURCE, { recursive: true, force: true });
  }
  mkdirSync(args.out, { recursive: true });
  writeFileSync(path.join(args.out, 'vite-client-build.txt'), client.output);
  build = { clientMs: client.ms, serverMs: serverBundle.ms, perfServerMs: perfServer.ms, viteClientOutput: path.join(args.out, 'vite-client-build.txt') };
}
const bundle = bundleSizes(path.join(BUILD, 'client'));
const results = [];
for (const kind of servers) results.push(await scenario(kind));

const report = {
  date: started.toISOString(),
  command: `tsx scripts/perf-phase7.ts ${process.argv.slice(2).join(' ')}`.trim(),
  commit: commitHash,
  workingTreeDirty: dirty,
  host: hostInfo(os.tmpdir()),
  build,
  bundle,
  results
};
mkdirSync(args.out, { recursive: true });
const file = path.join(args.out, `perf-phase7-${started.toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ file, checks: results.map((r) => ({ kind: r.kind, passed: r.checks.passed })) }));
if (results.some((r) => !r.checks.passed)) process.exitCode = 1;
