/**
 * Phase 5 admission-under-load run (docs/performance.md, "2026-11-17: Phase 5").
 * Developer-laptop numbers only.
 *
 * Question: do door redemptions stay dependable while organizers watch the
 * dashboard and download exports of a large event?
 *
 * 1. Seeds one 25,000-pass event (scripts/perf-dataset.ts: ~32,600 scans of
 *    history, 12 scanners, 6 gates, 3 policies, audit rows, pass emails) plus
 *    a 5,000-pass second event into a database file, once; every server run
 *    starts from its own copy, so all runs see identical data.
 * 2. For each --tree (a built checkout: `npm run build`, plus
 *    `vite build --ssr scripts/perf-server.ts --outDir dist/perf-server` for
 *    the saturation server) and each --mode, starts `node <bundle>` on
 *    127.0.0.1:--port with a clean environment and runs three phases:
 *      a. redemptions alone;
 *      b. redemptions while 3 dashboards poll `…/operations` and the scan
 *         feed every 2 s;
 *      c. redemptions while the attendance and scans exports (25,000 and
 *         ~32,600 rows) download back to back on two connections.
 *    Redemptions: every scanner device sends its own queue one request at a
 *    time; each pass once at an allowed gate, plus 10% re-scans of a pass of
 *    the same phase by another device (already_redeemed).
 *      production: dist/server/index.js, rate limits on, 3 scans/s per device
 *        (12 devices = 36/s; the per-device limit is 4/s).
 *      saturation: dist/perf-server/perf-server.js, rate limits off, closed loop.
 *    A preload (`--import`) samples the server's own memory and event-loop
 *    delay (`monitorEventLoopDelay`) over IPC; nothing else in the server changes.
 * 3. After each run: verifyDatabase on the file, admitted answers = new
 *    redemption rows, 2xx answers = new scan rows, no pass admitted twice.
 *
 * Usage: npx tsx --disable-warning=ExperimentalWarning scripts/perf-phase5.ts
 *   --tree <dir>[,<dir>…] [--label a,b] [--modes production,saturation] [--passes 25000]
 *   [--per-phase-production 1200] [--per-phase-saturation 2400] [--port 3521]
 *   [--index "CREATE INDEX …"]… (added to the seed copy: index trials) [--out .local/perf/phase5]
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/server/db';
import { verifyDatabase } from '../src/server/integrity';
import { hostInfo } from './bench-server';
import { mulberry32, SCANNER_GATES, type SeededEvent, seedEvent } from './perf-dataset';

const { values: args } = parseArgs({
  options: {
    tree: { type: 'string', default: fileURLToPath(new URL('..', import.meta.url)) },
    label: { type: 'string' },
    modes: { type: 'string', default: 'production,saturation' },
    passes: { type: 'string', default: '25000' },
    'per-phase-production': { type: 'string', default: '1200' },
    'per-phase-saturation': { type: 'string', default: '2400' },
    port: { type: 'string', default: '3521' },
    index: { type: 'string', multiple: true, default: [] },
    out: { type: 'string', default: path.join('.local', 'perf', 'phase5') }
  }
});
type Mode = 'production' | 'saturation';
const trees = args.tree.split(',').map((tree) => path.resolve(tree));
const labels = args.label?.split(',') ?? trees.map((tree) => path.basename(tree));
const modes = args.modes.split(',') as Mode[];
const PORT = Number(args.port);
const ADMIN = `perf-operator-${randomUUID()}`;
const PACE_HZ = 3;
const DASHBOARDS = 3;
const POLL_MS = 2000;

// ------------------------------------------------------------------ helpers

interface Latency {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}
/** Nearest-rank percentiles, ms. */
function summarize(values: number[]): Latency {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return { n: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const at = (p: number) => Number(sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)].toFixed(2));
  return { n: sorted.length, p50: at(50), p95: at(95), p99: at(99), max: Number(sorted.at(-1)!.toFixed(2)) };
}
const mib = (bytes: number) => Math.round((bytes / 2 ** 20) * 10) / 10;

// ------------------------------------------------------------------ seed

function seedFile(dir: string): { file: string; main: SeededEvent } {
  const file = path.join(dir, 'seed.db');
  const db = openDatabase(file);
  const now = new Date();
  const main = seedEvent(db, { passes: Number(args.passes), now, seed: 11 });
  seedEvent(db, { passes: Math.round(Number(args.passes) / 5), now, seed: 12, name: 'Other event' });
  for (const ddl of args.index ?? []) db.exec(ddl);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  return { file, main };
}

// ------------------------------------------------------------------ server

/** Loaded into the server with --import: answers 'sample' over IPC with memory and event-loop delay since the last sample. */
const PRELOAD = `
import { monitorEventLoopDelay } from 'node:perf_hooks';
const delay = monitorEventLoopDelay({ resolution: 1 });
delay.enable();
process.on('message', (message) => {
  if (message !== 'sample') return;
  const memory = process.memoryUsage();
  process.send({ sample: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, external: memory.external, arrayBuffers: memory.arrayBuffers,
    loopDelayP99Ms: delay.percentile(99) / 1e6, loopDelayMaxMs: delay.max / 1e6 } });
  delay.reset();
});
`;

interface Sample {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  loopDelayP99Ms: number;
  loopDelayMaxMs: number;
}

interface Server {
  child: ChildProcess;
  base: string;
  serverMs: Record<string, number[]>;
  sample(): Promise<Sample>;
  stop(): Promise<void>;
}

async function startServer(tree: string, mode: Mode, dbFile: string, preload: string): Promise<Server> {
  const base = `http://127.0.0.1:${PORT}`;
  const entry = mode === 'production' ? path.join(tree, 'dist', 'server', 'index.js') : path.join(tree, 'dist', 'perf-server', 'perf-server.js');
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
    PORT: String(PORT),
    APP_PUBLIC_URL: base,
    CLIENT_DIR: path.join(tree, 'dist', 'client')
  };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', `file:///${preload.replaceAll('\\', '/')}`, entry], {
    cwd: tree,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  const serverMs: Record<string, number[]> = {};
  const consume = (line: string) => {
    try {
      const entry = JSON.parse(line) as { msg?: string; route?: string; method?: string; ms?: number };
      if (entry.msg === 'request' && entry.route) (serverMs[`${entry.method} ${entry.route}`] ??= []).push(entry.ms ?? 0);
    } catch {
      // not a log line
    }
  };
  createInterface({ input: child.stdout! }).on('line', consume);
  createInterface({ input: child.stderr! }).on('line', (line) => {
    consume(line);
    if (/error/i.test(line)) console.error(`[server] ${line.slice(0, 300)}`);
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`${mode} server exited with ${child.exitCode}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`${mode} server not healthy after 30 s`);
    await sleep(100);
  }
  // The laptop is shared with other development work: both the server and this driver run above normal
  // priority on Windows so the comparison measures GatePass more than its neighbours (documented with the results).
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${child.pid},${process.pid}) | ForEach-Object { $_.PriorityClass = 'AboveNormal' }`]);
  }
  return {
    child,
    base,
    serverMs,
    async sample() {
      const reply = once(child, 'message') as Promise<[{ sample: Sample }]>;
      child.send('sample');
      return (await reply)[0].sample;
    },
    async stop() {
      const exited = once(child, 'close');
      child.kill(); // Windows: TerminateProcess; WAL keeps the database consistent.
      await exited;
    }
  };
}

// ------------------------------------------------------------------ traffic

interface Tally {
  latencies: number[];
  outcomes: Record<string, number>;
  status: Record<string, number>;
  networkErrors: number;
  wallMs: number;
  admittedByCode: Map<string, number>;
}

async function redeem(base: string, key: string, code: string, tally: Tally): Promise<void> {
  const started = performance.now();
  try {
    const response = await fetch(`${base}/api/scanner/redeem`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, requestId: randomUUID(), method: 'camera' })
    });
    const body = (await response.json()) as { outcome?: string };
    tally.latencies.push(performance.now() - started);
    tally.status[response.status] = (tally.status[response.status] ?? 0) + 1;
    if (response.ok && body.outcome) {
      tally.outcomes[body.outcome] = (tally.outcomes[body.outcome] ?? 0) + 1;
      if (body.outcome === 'admitted') tally.admittedByCode.set(code, (tally.admittedByCode.get(code) ?? 0) + 1);
    }
  } catch {
    tally.latencies.push(performance.now() - started);
    tally.networkErrors++;
  }
}

/** Per-device queues: each pass at an allowed device, then 10% re-scans by another allowed device a few positions later. */
function queuesFor(passes: SeededEvent['live'], keys: string[], seed: number): string[][] {
  const random = mulberry32(seed);
  const allowed = (policy: string) =>
    SCANNER_GATES.map((gate, index) => ({ gate, index }))
      .filter(({ gate }) => gate === null || policy === 'staff' || (policy === 'vip' ? gate >= 4 : gate < 4))
      .map(({ index }) => index);
  const queues: string[][] = keys.map(() => []);
  for (const pass of passes) {
    const devices = allowed(pass.policy);
    const first = devices[Math.floor(random() * devices.length)];
    queues[first].push(pass.token);
    if (random() < 0.1) {
      const second = devices.filter((device) => device !== first)[Math.floor(random() * (devices.length - 1))];
      queues[second].splice(Math.min(queues[second].length, Math.floor(random() * 10) + queues[second].length - 5), 0, pass.token);
    }
  }
  return queues;
}

async function drive(base: string, keys: string[], queues: string[][], paceHz: number | null): Promise<Tally> {
  const tally: Tally = { latencies: [], outcomes: {}, status: {}, networkErrors: 0, wallMs: 0, admittedByCode: new Map() };
  const interval = paceHz ? 1000 / paceHz : 0;
  const started = performance.now();
  await Promise.all(
    queues.map(async (queue, device) => {
      let next = performance.now() + (interval * device) / keys.length;
      for (const code of queue) {
        if (interval) {
          const wait = next - performance.now();
          if (wait > 0) await sleep(wait);
          next = Math.max(next + interval, performance.now());
        }
        await redeem(base, keys[device], code, tally);
      }
    })
  );
  tally.wallMs = performance.now() - started;
  return tally;
}

interface Hits {
  [endpoint: string]: { ms: number[]; bytes: number[]; status: Record<string, number> };
}

async function hit(base: string, route: string, name: string, hits: Hits): Promise<unknown> {
  const started = performance.now();
  const response = await fetch(`${base}${route}`, { headers: { Authorization: `Bearer ${ADMIN}` } });
  const body = Buffer.from(await response.arrayBuffer());
  const entry = (hits[name] ??= { ms: [], bytes: [], status: {} });
  entry.ms.push(performance.now() - started);
  entry.bytes.push(body.length);
  entry.status[response.status] = (entry.status[response.status] ?? 0) + 1;
  return (response.headers.get('content-type') ?? '').includes('json') ? JSON.parse(body.toString('utf8')) : null;
}

/** Background admin load until stopped: 'dashboards' (operations + scan feed every 2 s each) or 'exports' (two downloads back to back). */
function background(base: string, eventId: string, kind: 'none' | 'dashboards' | 'exports') {
  const hits: Hits = {};
  let running = kind !== 'none';
  const loops: Array<Promise<void>> = [];
  if (kind === 'dashboards') {
    for (let index = 0; index < DASHBOARDS; index += 1) {
      loops.push(
        (async () => {
          await sleep((POLL_MS / DASHBOARDS) * index);
          let lastScan = 0;
          while (running) {
            const started = performance.now();
            await hit(base, `/api/events/${eventId}/operations`, 'operations', hits);
            const feed = (await hit(base, `/api/events/${eventId}/scans?after=${lastScan}&limit=100`, 'scan feed', hits)) as Array<{ id: number }>;
            if (Array.isArray(feed) && feed.length) lastScan = feed[0].id;
            const left = POLL_MS - (performance.now() - started);
            for (let waited = 0; running && waited < left; waited += 100) await sleep(Math.min(100, left - waited));
          }
        })()
      );
    }
  }
  if (kind === 'exports') {
    for (const file of ['attendance', 'scans']) {
      loops.push(
        (async () => {
          while (running) await hit(base, `/api/events/${eventId}/exports/${file}.csv`, `${file}.csv`, hits);
        })()
      );
    }
  }
  return {
    hits,
    async stop() {
      running = false;
      await Promise.all(loops);
    }
  };
}

// ------------------------------------------------------------------ run

function counts(file: string, eventId: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const one = (sql: string) => Number((db.prepare(sql).get(eventId) as { n: number }).n);
    return {
      redemptions: one('SELECT COUNT(*) AS n FROM redemptions r JOIN passes p ON p.id = r.pass_id WHERE p.event_id = ?'),
      scans: one('SELECT COUNT(*) AS n FROM scans WHERE event_id = ?'),
      verify: verifyDatabase(db)
    };
  } finally {
    db.close();
  }
}

async function run(tree: string, label: string, mode: Mode, seed: { file: string; main: SeededEvent }, preload: string) {
  console.error(`\n== ${label} / ${mode}`);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gatepass-perf5-'));
  const dbFile = path.join(dir, 'gatepass.db');
  copyFileSync(seed.file, dbFile);
  const before = counts(dbFile, seed.main.eventId);
  const server = await startServer(tree, mode, dbFile, preload);
  const { eventId } = seed.main;
  const keys = seed.main.scanners.map((scanner) => scanner.key);
  const perPhase = Number(mode === 'production' ? args['per-phase-production'] : args['per-phase-saturation']);
  const phases: Array<Record<string, unknown>> = [];
  const allAdmitted = new Map<string, number>();
  let admittedTotal = 0;
  let okTotal = 0;
  try {
    const idle = await server.sample();
    for (const [index, kind] of (['none', 'dashboards', 'exports'] as const).entries()) {
      const passes = seed.main.live.slice(index * perPhase, (index + 1) * perPhase);
      const queues = queuesFor(passes, keys, 100 + index);
      await server.sample(); // reset the loop-delay histogram
      const load = background(server.base, eventId, kind);
      const samples: Sample[] = [];
      let sampling = true;
      const sampler = (async () => {
        while (sampling) {
          samples.push(await server.sample());
          await sleep(250);
        }
      })();
      // Let the background load reach steady state before the first redeem.
      if (kind !== 'none') await sleep(1000);
      const tally = await drive(server.base, keys, queues, mode === 'production' ? PACE_HZ : null);
      await load.stop();
      sampling = false;
      await sampler;
      for (const [code, n] of tally.admittedByCode) allAdmitted.set(code, (allAdmitted.get(code) ?? 0) + n);
      admittedTotal += tally.outcomes.admitted ?? 0;
      okTotal += Object.entries(tally.status).reduce((sum, [status, n]) => sum + (Number(status) < 300 ? n : 0), 0);
      const requests = tally.latencies.length;
      const phase = {
        phase: { none: 'a: redeem alone', dashboards: `b: + ${DASHBOARDS} dashboards every ${POLL_MS / 1000} s`, exports: 'c: + attendance & scans exports downloading' }[kind],
        requests,
        expectedAdmitted: passes.length,
        perSecond: Math.round((requests / tally.wallMs) * 10_000) / 10,
        wallS: Math.round(tally.wallMs / 100) / 10,
        latency: summarize(tally.latencies),
        outcomes: tally.outcomes,
        status: tally.status,
        networkErrors: tally.networkErrors,
        admin: Object.fromEntries(
          Object.entries(load.hits).map(([name, entry]) => [name, { ...summarize(entry.ms), bytes: Math.max(...entry.bytes), status: entry.status }])
        ),
        server: {
          peakRssMiB: mib(Math.max(...samples.map((s) => s.rss))),
          peakHeapUsedMiB: mib(Math.max(...samples.map((s) => s.heapUsed))),
          peakArrayBuffersMiB: mib(Math.max(...samples.map((s) => s.arrayBuffers))),
          loopDelayP99Ms: Number(Math.max(...samples.map((s) => s.loopDelayP99Ms)).toFixed(1)),
          loopDelayMaxMs: Number(Math.max(...samples.map((s) => s.loopDelayMaxMs)).toFixed(1))
        }
      };
      phases.push(phase);
      console.error(
        `${phase.phase}: ${requests} req, ${phase.perSecond}/s, p50 ${phase.latency.p50} p95 ${phase.latency.p95} p99 ${phase.latency.p99} max ${phase.latency.max} ms; admitted ${tally.outcomes.admitted ?? 0}/${passes.length}; status ${JSON.stringify(tally.status)}; rss ${phase.server.peakRssMiB} MiB, heap ${phase.server.peakHeapUsedMiB} MiB, loop max ${phase.server.loopDelayMaxMs} ms ${JSON.stringify(phase.admin)}`
      );
    }
    // At rest: sizes and times of the admin reads on the final data set.
    const rest: Hits = {};
    for (let i = 0; i < 3; i += 1) {
      await hit(server.base, `/api/events/${eventId}/passes?limit=50&offset=0`, 'passes first page', rest);
      await hit(server.base, `/api/events/${eventId}/passes?limit=50&offset=24950`, 'passes last page', rest);
      await hit(server.base, `/api/events/${eventId}/passes?limit=50&q=attendee12`, 'passes search', rest);
      await hit(server.base, `/api/events/${eventId}/scans?limit=100`, 'scan feed', rest);
      await hit(server.base, `/api/events/${eventId}/report`, 'report', rest);
      await hit(server.base, `/api/events/${eventId}/exports/audit.csv`, 'audit.csv', rest);
      await hit(server.base, `/api/events/${eventId}/exports/summary.csv`, 'summary.csv', rest);
      await sleep(2100); // past the operations memo
      await hit(server.base, `/api/events/${eventId}/operations`, 'operations (memo miss)', rest);
    }
    const end = await server.sample();
    await server.stop();
    const after = counts(dbFile, eventId);
    const twice = [...allAdmitted.values()].filter((n) => n > 1).length;
    const checks = {
      verifyDatabase: after.verify.ok,
      violations: after.verify.violations,
      admittedAnswers: admittedTotal,
      newRedemptionRows: after.redemptions - before.redemptions,
      okAnswers: okTotal,
      newScanRows: after.scans - before.scans,
      passesAdmittedTwice: twice,
      passed: after.verify.ok && admittedTotal === after.redemptions - before.redemptions && okTotal === after.scans - before.scans && twice === 0
    };
    console.error(`checks: ${JSON.stringify(checks)}`);
    return {
      label,
      tree,
      mode,
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tree, encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: tree, encoding: 'utf8' }).trim() !== '',
      databaseMiB: mib(statSync(dbFile).size),
      memory: { idleRssMiB: mib(idle.rss), idleHeapUsedMiB: mib(idle.heapUsed), endRssMiB: mib(end.rss), endHeapUsedMiB: mib(end.heapUsed) },
      phases,
      atRest: Object.fromEntries(Object.entries(rest).map(([name, entry]) => [name, { ...summarize(entry.ms), bytes: Math.max(...entry.bytes), status: entry.status }])),
      serverMs: Object.fromEntries(Object.entries(server.serverMs).map(([route, values]) => [route, summarize(values)])),
      checks
    };
  } catch (error) {
    if (server.child.exitCode === null) await server.stop();
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const started = new Date();
const work = mkdtempSync(path.join(os.tmpdir(), 'gatepass-perf5-seed-'));
try {
  const preload = path.join(work, 'preload.mjs');
  writeFileSync(preload, PRELOAD);
  const seedStarted = performance.now();
  const seed = seedFile(work);
  console.error(`seeded ${JSON.stringify(seed.main.counts)} in ${Math.round(performance.now() - seedStarted)} ms; live passes ${seed.main.live.length}`);
  const results = [];
  for (const mode of modes) for (const [index, tree] of trees.entries()) results.push(await run(tree, labels[index], mode, seed, preload));
  mkdirSync(args.out, { recursive: true });
  const file = path.join(args.out, `perf-phase5-${started.toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(
    file,
    `${JSON.stringify({ date: started.toISOString(), host: hostInfo(work), node: process.version, passes: Number(args.passes), seed: seed.main.counts, indexes: args.index, results }, null, 2)}\n`
  );
  console.log(file);
  if (results.some((result) => !result.checks.passed)) process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
