/**
 * Phase 5 query profile (docs/performance.md, "2026-11-17: Phase 5").
 * In-process, no HTTP: seeds scripts/perf-dataset.ts events of each size into a
 * fresh temp database (production `openDatabase`: WAL, synchronous FULL),
 * then times the admin read paths through the service of the tree given with
 * --tree (default: this checkout), so the same script measures the base commit
 * and this branch. Every SQL statement a call prepares is traced: median time
 * per statement and its `EXPLAIN QUERY PLAN`.
 *
 * Usage: npx tsx --disable-warning=ExperimentalWarning scripts/perf-queries.ts
 *   [--tree <checkout>] [--sizes 5000,10000,25000] [--repeat 7]
 *   [--index "CREATE INDEX …"]… (applied after seeding: ad hoc index trials)
 *   [--pragma "cache_size = -32768"]… (run on the connection after opening: setting trials)
 *   [--out .local/perf/phase5] [--label name]
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { seedEvent } from './perf-dataset';

const { values: args } = parseArgs({
  options: {
    tree: { type: 'string', default: fileURLToPath(new URL('..', import.meta.url)) },
    sizes: { type: 'string', default: '5000,10000,25000' },
    repeat: { type: 'string', default: '7' },
    index: { type: 'string', multiple: true, default: [] },
    pragma: { type: 'string', multiple: true, default: [] },
    out: { type: 'string', default: path.join('.local', 'perf', 'phase5') },
    label: { type: 'string', default: 'run' }
  }
});
const REPEAT = Number(args.repeat);
const tree = path.resolve(args.tree);
const load = async (file: string) => import(pathToFileURL(path.join(tree, 'src', 'server', file)).href);
const { openDatabase } = await load('db.ts');
const { GatePass } = await load('gatepass.ts');
const { operationsSummary } = await load('operations.ts');
const { verifyDatabase } = await load('integrity.ts');

interface Trace {
  sql: string;
  args: unknown[];
  ms: number[];
  rows: number;
}

/** Wraps `db.prepare` so every statement execution is timed and attributed to its SQL text. */
function traced(db: DatabaseSync) {
  let current: Map<string, Trace> | null = null;
  const prepare = db.prepare.bind(db);
  (db as { prepare: unknown }).prepare = (sql: string) => {
    const statement = prepare(sql);
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        if (property !== 'all' && property !== 'get' && property !== 'run') return value.bind(target);
        return (...callArgs: unknown[]) => {
          const started = performance.now();
          const result = value.apply(target, callArgs);
          const ms = performance.now() - started;
          if (current) {
            const key = sql.replace(/\s+/g, ' ').trim();
            const entry = current.get(key) ?? { sql: key, args: callArgs, ms: [], rows: 0 };
            entry.ms.push(ms);
            entry.rows = Array.isArray(result) ? result.length : result ? 1 : 0;
            current.set(key, entry);
          }
          return result;
        };
      }
    });
  };
  return {
    /** Wall time includes the summary's yields to the event loop, which cost microseconds when nothing else is queued. */
    async run<T>(fn: () => T | Promise<T>): Promise<{ result: T; ms: number; traces: Map<string, Trace> }> {
      current = new Map();
      const started = performance.now();
      const result = await fn();
      const ms = performance.now() - started;
      const traces = current;
      current = null;
      return { result, ms, traces };
    }
  };
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? Number(sorted[Math.floor((sorted.length - 1) / 2)].toFixed(3)) : 0;
};
const max = (values: number[]) => Number(Math.max(0, ...values).toFixed(3));

const results: Array<Record<string, unknown>> = [];
for (const size of args.sizes.split(',').map(Number)) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gatepass-perfq-'));
  try {
    const db: DatabaseSync = openDatabase(path.join(dir, 'gatepass.db'));
    const now = new Date();
    const seedStarted = performance.now();
    const main = seedEvent(db, { passes: size, now, seed: 1 });
    // A second event in the same file: indexes must keep the other event's rows out of every scan.
    const other = seedEvent(db, { passes: Math.round(size / 5), now, seed: 2, name: 'Other event' });
    const seedMs = performance.now() - seedStarted;
    for (const ddl of args.index ?? []) db.exec(ddl);
    for (const pragma of args.pragma ?? []) db.exec(`PRAGMA ${pragma}`);
    const integrity = verifyDatabase(db);
    if (!integrity.ok) throw new Error(`seeded database fails verifyDatabase: ${integrity.violations.join('; ')}`);
    const tracer = traced(db);
    const service = new GatePass(db, { publicUrl: 'https://gate.example', now: () => now });
    const event = service.getEvent(main.eventId);
    const samplePass = main.live[Math.floor(main.live.length / 2)].passId;
    const scans = Number((db.prepare('SELECT COUNT(*) AS n FROM scans WHERE event_id = ?').get(main.eventId) as { n: number }).n);
    const midScan = Number((db.prepare('SELECT id FROM scans WHERE event_id = ? ORDER BY id LIMIT 1 OFFSET ?').get(main.eventId, Math.floor(scans / 2)) as { id: number }).id);
    type Exported = { header: string[]; next(): unknown[][] };
    const csv = await load('csv.ts');
    const exportCall = (kind: 'attendance' | 'scans' | 'audit') => async () => {
      if (typeof service.attendanceCsv === 'function') {
        const method = { attendance: 'attendanceCsv', scans: 'scansCsv', audit: 'auditCsv' }[kind];
        return { bytes: Buffer.byteLength(service[method](main.eventId, 'operator') as string), maxChunkMs: null as number | null };
      }
      // Streaming build: every chunk is a separate synchronous step; the longest one bounds how long a redeem can wait.
      const exported = (await service.openExport(main.eventId, kind, 'operator')) as Exported;
      let bytes = Buffer.byteLength(csv.toCsv(exported.header, []));
      let maxChunkMs = 0;
      for (;;) {
        const started = performance.now();
        const rows = exported.next();
        if (!rows.length) break;
        bytes += Buffer.byteLength(csv.csvRows(rows));
        maxChunkMs = Math.max(maxChunkMs, performance.now() - started);
      }
      return { bytes, maxChunkMs: Number(maxChunkMs.toFixed(3)) };
    };

    const calls: Array<[string, () => unknown]> = [
      ['getEvent', () => service.getEvent(main.eventId)],
      ['operationsSummary (live)', () => operationsSummary(db, service.access, event, now)],
      [
        'operationsSummary (finished: + completion)',
        () => operationsSummary(db, service.access, { ...event, status: 'ended' }, new Date(now.getTime() + 7 * 3600_000))
      ],
      ['listScans newest 100', () => service.listScans(main.eventId, { limit: 100 })],
      ['listScans after mid (feed)', () => service.listScans(main.eventId, { after: midScan, limit: 100 })],
      ['listPasses first page 50', () => service.listPasses(main.eventId, { limit: 50 })],
      ['listPasses last page 50 (offset N-50)', () => service.listPasses(main.eventId, { limit: 50, offset: size - 50 })],
      ['listPasses q=name', () => service.listPasses(main.eventId, { limit: 50, q: 'Attendee 0123' })],
      ['listPasses q=email', () => service.listPasses(main.eventId, { limit: 50, q: 'attendee123@' })],
      ['listPasses q=reference', () => service.listPasses(main.eventId, { limit: 50, q: samplePass.slice(0, 8) })],
      ['listPasses status=active', () => service.listPasses(main.eventId, { limit: 50, status: 'active' })],
      ['listPasses status=redeemed deep', () => service.listPasses(main.eventId, { limit: 50, offset: Math.floor(size / 2), status: 'redeemed' })],
      ['listPasses policy', () => service.listPasses(main.eventId, { limit: 50, policyId: main.policyIds.vip })],
      ['listAudit 100', () => service.listAudit(main.eventId, { limit: 100 })],
      ['export attendance', exportCall('attendance')],
      ['export scans', exportCall('scans')],
      ['export audit', exportCall('audit')]
    ];
    if (typeof service.report === 'function') calls.push(['report', () => service.report(main.eventId)]);

    const measured: Array<Record<string, unknown>> = [];
    for (const [name, fn] of calls) {
      await fn(); // warm the statement cache and the page cache
      const totals: number[] = [];
      const perSql = new Map<string, Trace>();
      let extra: unknown = null;
      for (let i = 0; i < REPEAT; i += 1) {
        const { ms, traces, result } = await tracer.run(fn);
        totals.push(ms);
        if (result && typeof result === 'object' && 'maxChunkMs' in result) extra = result;
        for (const [sql, trace] of traces) {
          const entry = perSql.get(sql) ?? { ...trace, ms: [] };
          entry.ms.push(trace.ms.reduce((a, b) => a + b, 0));
          perSql.set(sql, entry);
        }
      }
      const queries = [...perSql.values()]
        .map((trace) => ({
          sql: trace.sql,
          medianMs: median(trace.ms),
          rows: trace.rows,
          plan: (() => {
            try {
              return (db.prepare(`EXPLAIN QUERY PLAN ${trace.sql}`).all(...(trace.args as never[])) as Array<{ detail: string }>).map((row) => row.detail);
            } catch (error) {
              return [`(plan unavailable: ${(error as Error).message})`];
            }
          })()
        }))
        .sort((a, b) => b.medianMs - a.medianMs);
      measured.push({ name, medianMs: median(totals), maxMs: max(totals), ...(extra ? { export: extra } : {}), queries });
      console.error(`${size}\t${name}\t${median(totals)} ms${extra ? `\t${JSON.stringify(extra)}` : ''}`);
    }
    results.push({ size, seed: { ms: Math.round(seedMs), main: main.counts, other: other.counts }, indexes: args.index, pragmas: args.pragma, calls: measured });
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

mkdirSync(args.out, { recursive: true });
const file = path.join(args.out, `perf-queries-${args.label}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, `${JSON.stringify({ tree, node: process.version, repeat: REPEAT, results }, null, 2)}\n`);
console.log(file);
