/**
 * HTTP load test of POST /api/scanner/redeem plus a synchronous=FULL vs
 * NORMAL micro-benchmark (docs/performance.md).
 *
 * HTTP part: forks scripts/bench-server.ts (real `createApp` with
 * `rateLimits: false`, production `openDatabase` pragmas, temp database),
 * then for every pattern and client count provisions a fresh event with N
 * scanners and M passes through the operator API and drives redeem traffic.
 * Patterns:
 *   distinct  every pass scanned once
 *   dup10     every pass once plus a re-scan of every 10th pass shortly after
 *   onepass   K clients all scanning ONE pass, R rounds each
 * Each request carries a fresh requestId, as the scanner client does. After
 * every run the persisted database is opened read-only and checked with
 * `verifyDatabase`; admitted responses must equal the event's redemption
 * rows and 2xx responses must equal its scan rows.
 *
 * Sync part: opens databases in-process with the production `openDatabase`
 * (synchronous=FULL), optionally sets `PRAGMA synchronous = NORMAL` on that
 * connection, and times `GatePass.redeem` transactions back to back. Server
 * code is unchanged.
 *
 * Usage: npx tsx --disable-warning=ExperimentalWarning scripts/load-test.ts [options]
 *   --part all|http|sync          (all)
 *   --patterns distinct,dup10,onepass
 *   --clients 1,10,50,100         client counts for distinct and dup10
 *   --passes 2000                 M, passes per run
 *   --scanners 10                 N, scanner devices per event
 *   --one-pass-clients 100 --one-pass-rounds 5
 *   --repeat 1                    repetitions of every HTTP run
 *   --sync-redeems 2000 --sync-trials 5
 *   --out .local/perf             JSON and Markdown reports are written here
 */
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/server/db';
import { GatePass } from '../src/server/gatepass';
import { verifyDatabase, type IntegrityReport } from '../src/server/integrity';
import { databaseSettings, hostInfo, type BenchServerReady, type DatabaseSettings } from './bench-server';

const { values: args } = parseArgs({
  options: {
    part: { type: 'string', default: 'all' },
    patterns: { type: 'string', default: 'distinct,dup10,onepass' },
    clients: { type: 'string', default: '1,10,50,100' },
    passes: { type: 'string', default: '2000' },
    scanners: { type: 'string', default: '10' },
    'one-pass-clients': { type: 'string', default: '100' },
    'one-pass-rounds': { type: 'string', default: '5' },
    repeat: { type: 'string', default: '1' },
    'sync-redeems': { type: 'string', default: '2000' },
    'sync-trials': { type: 'string', default: '5' },
    out: { type: 'string', default: path.join('.local', 'perf') }
  }
});
const list = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);
const config = {
  part: args.part as 'all' | 'http' | 'sync',
  patterns: list(args.patterns) as Array<'distinct' | 'dup10' | 'onepass'>,
  clients: list(args.clients).map(Number),
  passes: Number(args.passes),
  scanners: Number(args.scanners),
  onePassClients: Number(args['one-pass-clients']),
  onePassRounds: Number(args['one-pass-rounds']),
  repeat: Number(args.repeat),
  syncRedeems: Number(args['sync-redeems']),
  syncTrials: Number(args['sync-trials'])
};
if (!['all', 'http', 'sync'].includes(config.part)) throw new Error(`--part must be all, http or sync`);
for (const pattern of config.patterns) if (!['distinct', 'dup10', 'onepass'].includes(pattern)) throw new Error(`Unknown pattern ${pattern}`);

const ADMIN = 'load-test-operator-token-0123456789abcdef';

interface LatencySummary {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

/** Nearest-rank percentiles of an ascending array. */
function summarize(sorted: number[]): LatencySummary {
  const at = (p: number) => Number(sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)].toFixed(2));
  return { p50Ms: at(50), p95Ms: at(95), p99Ms: at(99), maxMs: Number(sorted.at(-1)!.toFixed(2)) };
}

/** Small deterministic PRNG so duplicate placement is the same on every run. */
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

// ------------------------------------------------------------------ HTTP part

interface HttpRun extends LatencySummary {
  pattern: string;
  clients: number;
  repetition: number;
  scanners: number;
  passes: number;
  requests: number;
  outcomes: Record<string, number>;
  httpErrors: Record<string, number>;
  networkErrors: number;
  wallMs: number;
  perSecond: number;
  expectedAdmitted: number;
  checks: {
    verifyDatabaseOk: boolean;
    violations: string[];
    admittedResponses: number;
    redemptionRows: number;
    okResponses: number;
    scanRows: number;
    passed: boolean;
  };
}

interface HttpPartResult {
  host: BenchServerReady['host'];
  database: DatabaseSettings;
  runs: HttpRun[];
}

async function httpPart(): Promise<HttpPartResult> {
  const child = fork(new URL('./bench-server.ts', import.meta.url), {
    execArgv: ['--import', 'tsx', '--disable-warning=ExperimentalWarning'],
    env: { ...process.env, BENCH_ADMIN_TOKEN: ADMIN }
  });
  const [ready] = (await once(child, 'message')) as [BenchServerReady];
  const base = `http://127.0.0.1:${ready.port}`;

  async function admin<T>(method: string, route: string, body?: unknown): Promise<T> {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`${method} ${route} -> ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  }

  async function provision(name: string, passes: number) {
    const now = Date.now();
    const event = await admin<{ id: string }>('POST', '/api/events', {
      name,
      startsAt: new Date(now - 3_600_000).toISOString(),
      endsAt: new Date(now + 6 * 3_600_000).toISOString()
    });
    const keys: string[] = [];
    for (let i = 0; i < config.scanners; i++) keys.push((await admin<{ key: string }>('POST', `/api/events/${event.id}/scanners`, { label: `Load ${i + 1}` })).key);
    const tokens: string[] = [];
    for (let left = passes; left > 0; left -= 500) {
      const issued = await admin<Array<{ token: string }>>('POST', `/api/events/${event.id}/passes`, { count: Math.min(500, left) });
      tokens.push(...issued.map((pass) => pass.token));
    }
    return { eventId: event.id, keys, tokens };
  }

  /** `clients` loops share one queue; loop i always uses scanner key i mod N. */
  async function drive(codes: string[], clients: number, keys: string[]) {
    const latencies: number[] = [];
    const outcomes: Record<string, number> = {};
    const httpErrors: Record<string, number> = {};
    let networkErrors = 0;
    let next = 0;
    const start = performance.now();
    await Promise.all(
      Array.from({ length: clients }, async (_, client) => {
        const key = keys[client % keys.length];
        while (next < codes.length) {
          const code = codes[next++];
          const sent = performance.now();
          try {
            const response = await fetch(`${base}/api/scanner/redeem`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ code, requestId: randomUUID() })
            });
            const body = (await response.json()) as { outcome?: string };
            latencies.push(performance.now() - sent);
            if (response.ok) outcomes[body.outcome!] = (outcomes[body.outcome!] ?? 0) + 1;
            else httpErrors[response.status] = (httpErrors[response.status] ?? 0) + 1;
          } catch {
            latencies.push(performance.now() - sent);
            networkErrors++;
          }
        }
      })
    );
    const wallMs = performance.now() - start;
    return { latencies: latencies.sort((a, b) => a - b), outcomes, httpErrors, networkErrors, wallMs };
  }

  function check(eventId: string, admittedResponses: number, okResponses: number): HttpRun['checks'] {
    const db = new DatabaseSync(ready.dbFile, { readOnly: true });
    let report: IntegrityReport;
    let redemptionRows: number;
    let scanRows: number;
    try {
      report = verifyDatabase(db);
      redemptionRows = Number((db.prepare('SELECT COUNT(*) AS n FROM redemptions r JOIN passes p ON p.id = r.pass_id WHERE p.event_id = ?').get(eventId) as { n: number }).n);
      scanRows = Number((db.prepare('SELECT COUNT(*) AS n FROM scans WHERE event_id = ?').get(eventId) as { n: number }).n);
    } finally {
      db.close();
    }
    return {
      verifyDatabaseOk: report.ok,
      violations: report.violations,
      admittedResponses,
      redemptionRows,
      okResponses,
      scanRows,
      passed: report.ok && admittedResponses === redemptionRows && okResponses === scanRows
    };
  }

  async function run(pattern: 'distinct' | 'dup10' | 'onepass', clients: number, repetition: number): Promise<HttpRun> {
    const passes = pattern === 'onepass' ? 1 : config.passes;
    const { eventId, keys, tokens } = await provision(`Load ${pattern} c${clients} r${repetition}`, passes);
    let codes: string[];
    if (pattern === 'distinct') codes = tokens;
    else if (pattern === 'onepass') codes = Array.from({ length: clients * config.onePassRounds }, () => tokens[0]);
    else {
      // Re-scan of every 10th pass, placed 1-50 positions after the original so some race it in flight.
      const random = mulberry32(clients * 1000 + repetition);
      const keyed = tokens.map((code, i) => ({ code, at: i }));
      tokens.forEach((code, i) => {
        if (i % 10 === 0) keyed.push({ code, at: i + 1 + Math.floor(random() * 50) + 0.5 });
      });
      codes = keyed.sort((a, b) => a.at - b.at).map((item) => item.code);
    }
    const result = await drive(codes, clients, keys);
    const admitted = result.outcomes.admitted ?? 0;
    const okResponses = Object.values(result.outcomes).reduce((sum, n) => sum + n, 0);
    return {
      pattern,
      clients,
      repetition,
      scanners: keys.length,
      passes,
      requests: codes.length,
      outcomes: result.outcomes,
      httpErrors: result.httpErrors,
      networkErrors: result.networkErrors,
      ...summarize(result.latencies),
      wallMs: Math.round(result.wallMs),
      perSecond: Math.round((codes.length / result.wallMs) * 1000),
      expectedAdmitted: passes,
      checks: check(eventId, admitted, okResponses)
    };
  }

  const runs: HttpRun[] = [];
  try {
    const warmup = await run('distinct', 10, 0);
    if (!warmup.checks.passed) throw new Error(`Warm-up failed its checks: ${JSON.stringify(warmup.checks)}`);
    for (let repetition = 1; repetition <= config.repeat; repetition++) {
      for (const pattern of config.patterns) {
        for (const clients of pattern === 'onepass' ? [config.onePassClients] : config.clients) {
          const result = await run(pattern, clients, repetition);
          console.error(`${pattern} c=${clients} rep=${repetition}: ${result.requests} req, ${result.perSecond}/s, p99 ${result.p99Ms} ms, checks ${result.checks.passed ? 'ok' : 'FAILED'}`);
          runs.push(result);
        }
      }
    }
  } finally {
    child.send('stop');
    await once(child, 'exit');
  }
  return { host: ready.host, database: ready.database, runs };
}

// ------------------------------------------------------------------ sync part

interface SyncTrial extends LatencySummary {
  synchronous: 'FULL' | 'NORMAL';
  trial: number;
  settings: DatabaseSettings;
  redeems: number;
  meanMs: number;
  perSecond: number;
  admitted: number;
}

function syncTrial(mode: 'FULL' | 'NORMAL', trial: number): SyncTrial {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gatepass-sync-'));
  const db = openDatabase(path.join(dir, 'sync.db'));
  try {
    if (mode === 'NORMAL') db.exec('PRAGMA synchronous = NORMAL');
    const settings = databaseSettings(db);
    if (settings.synchronous !== mode) throw new Error(`Expected synchronous=${mode}, connection reports ${settings.synchronous}`);
    const service = new GatePass(db, { publicUrl: 'https://gate.example' });
    const now = Date.now();
    const event = service.createEvent({ name: 'Sync', startsAt: new Date(now - 3_600_000).toISOString(), endsAt: new Date(now + 6 * 3_600_000).toISOString() }, 'operator');
    const { key } = service.createScanner(event.id, 'Sync door', null, 'operator');
    const scanner = service.authenticateScanner(key)!;
    const warmup = 100;
    const tokens: string[] = [];
    for (let left = config.syncRedeems + warmup; left > 0; left -= 500) tokens.push(...service.issuePasses(event.id, { count: Math.min(500, left) }, 'operator').map((pass) => pass.token));
    for (const token of tokens.slice(0, warmup)) service.redeem(scanner, token, randomUUID());
    const latencies: number[] = [];
    let admitted = 0;
    const start = performance.now();
    for (const token of tokens.slice(warmup)) {
      const sent = performance.now();
      if (service.redeem(scanner, token, randomUUID()).outcome === 'admitted') admitted++;
      latencies.push(performance.now() - sent);
    }
    const wallMs = performance.now() - start;
    if (!verifyDatabase(db).ok) throw new Error('verifyDatabase failed after sync trial');
    return {
      synchronous: mode,
      trial,
      settings,
      redeems: latencies.length,
      meanMs: Number((wallMs / latencies.length).toFixed(3)),
      ...summarize(latencies.sort((a, b) => a - b)),
      perSecond: Math.round((latencies.length / wallMs) * 1000),
      admitted
    };
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

interface SyncPartResult {
  trials: SyncTrial[];
  summary: Record<'FULL' | 'NORMAL', { medianMeanMs: number; medianP99Ms: number; medianPerSecond: number }>;
  fullOverNormalMeanRatio: number;
}

function syncPart(): SyncPartResult {
  const trials: SyncTrial[] = [];
  // Alternate the order so drift (thermal, background I/O) does not favour one mode.
  for (let trial = 1; trial <= config.syncTrials; trial++) {
    const order: Array<'FULL' | 'NORMAL'> = trial % 2 ? ['FULL', 'NORMAL'] : ['NORMAL', 'FULL'];
    for (const mode of order) {
      const result = syncTrial(mode, trial);
      console.error(`sync ${mode} trial ${trial}: mean ${result.meanMs} ms, ${result.perSecond}/s`);
      trials.push(result);
    }
  }
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const summary = Object.fromEntries(
    (['FULL', 'NORMAL'] as const).map((mode) => {
      const own = trials.filter((trial) => trial.synchronous === mode);
      return [mode, { medianMeanMs: Number(median(own.map((t) => t.meanMs)).toFixed(3)), medianP99Ms: Number(median(own.map((t) => t.p99Ms)).toFixed(2)), medianPerSecond: Math.round(median(own.map((t) => t.perSecond))) }];
    })
  ) as SyncPartResult['summary'];
  return { trials, summary, fullOverNormalMeanRatio: Number((summary.FULL.medianMeanMs / summary.NORMAL.medianMeanMs).toFixed(2)) };
}

// ------------------------------------------------------------------ report

function markdown(http: HttpPartResult | null, sync: SyncPartResult | null): string {
  const lines: string[] = [];
  if (http) {
    lines.push(
      '| Pattern | Clients | Rep | Requests | Admitted | Already redeemed | Other outcomes | HTTP errors | Network errors | p50 ms | p95 ms | p99 ms | max ms | req/s | Checks |',
      '| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |'
    );
    for (const run of http.runs) {
      const { admitted = 0, already_redeemed = 0, ...other } = run.outcomes;
      const fmt = (record: Record<string, number>) => Object.entries(record).map(([k, v]) => `${k} ${v}`).join(', ') || '0';
      const checks = `${run.checks.passed ? 'pass' : 'FAIL'} (redemptions ${run.checks.redemptionRows}, scans ${run.checks.scanRows})`;
      lines.push(
        `| ${run.pattern} | ${run.clients} | ${run.repetition} | ${run.requests} | ${admitted} | ${already_redeemed} | ${fmt(other)} | ${fmt(run.httpErrors)} | ${run.networkErrors} | ${run.p50Ms} | ${run.p95Ms} | ${run.p99Ms} | ${run.maxMs} | ${run.perSecond} | ${checks} |`
      );
    }
  }
  if (sync) {
    if (lines.length) lines.push('');
    lines.push('| synchronous | Trial | Redeems | mean ms | p50 ms | p95 ms | p99 ms | max ms | txn/s |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const t of sync.trials) lines.push(`| ${t.synchronous} | ${t.trial} | ${t.redeems} | ${t.meanMs} | ${t.p50Ms} | ${t.p95Ms} | ${t.p99Ms} | ${t.maxMs} | ${t.perSecond} |`);
    lines.push('', `Median of trial means: FULL ${sync.summary.FULL.medianMeanMs} ms, NORMAL ${sync.summary.NORMAL.medianMeanMs} ms (FULL/NORMAL = ${sync.fullOverNormalMeanRatio}).`);
  }
  return lines.join('\n');
}

const http = config.part === 'sync' ? null : await httpPart();
const sync = config.part === 'http' ? null : syncPart();
const report = {
  date: new Date().toISOString(),
  command: `tsx scripts/load-test.ts ${process.argv.slice(2).join(' ')}`.trim(),
  host: http?.host ?? hostInfo(os.tmpdir()),
  serverDatabase: http?.database ?? null,
  config,
  method: {
    http: 'Server: scripts/bench-server.ts forked as a separate Node process (tsx sources), createApp({ rateLimits: false }), production openDatabase pragmas, temp database. Client: keep-alive fetch over loopback, one fresh event per run, fresh requestId per request, latency = request start to parsed JSON body, nearest-rank percentiles, req/s = requests / wall time. A 10-client distinct warm-up run is discarded.',
    sync: 'In-process, one connection, GatePass.redeem called back to back (no HTTP). Fresh temp database per trial; NORMAL set with PRAGMA on the connection after openDatabase. 100 warm-up redeems discarded per trial; modes alternate order per trial.'
  },
  http: http?.runs ?? null,
  sync
};
const table = markdown(http, sync);
mkdirSync(args.out, { recursive: true });
const stamp = report.date.replace(/[:.]/g, '-');
const jsonFile = path.join(args.out, `load-test-${stamp}.json`);
const mdFile = path.join(args.out, `load-test-${stamp}.md`);
writeFileSync(jsonFile, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(mdFile, `${table}\n`);
console.log(table);
console.log(`\nWrote ${jsonFile} and ${mdFile}`);
const failed = http?.runs.filter((run) => !run.checks.passed) ?? [];
if (failed.length) {
  console.error(`${failed.length} run(s) failed persisted-state checks`);
  process.exitCode = 1;
}
