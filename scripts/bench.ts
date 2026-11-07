/**
 * Admission benchmark (docs/testing.md). Starts scripts/bench-server.ts in a
 * child process (file-backed SQLite in a temp dir, rate limiting disabled),
 * seeds data through the admin API, then measures POST /api/scanner/redeem.
 */
import { fork } from 'node:child_process';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

const ADMIN = 'bench-admin-token-0123456789abcdef';
const SEQUENTIAL = Number(process.env.BENCH_SEQUENTIAL ?? 1000);
const CONCURRENT_TOTAL = Number(process.env.BENCH_TOTAL ?? 5000);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 50);

const child = fork(new URL('./bench-server.ts', import.meta.url), {
  execArgv: ['--import', 'tsx', '--disable-warning=ExperimentalWarning'],
  env: { ...process.env, BENCH_ADMIN_TOKEN: ADMIN }
});
const { port, sqlite } = await new Promise<{ port: number; sqlite: string }>((resolve) => child.once('message', (message) => resolve(message as { port: number; sqlite: string })));
const base = `http://127.0.0.1:${port}`;

async function admin<T>(method: string, route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${method} ${route} -> ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

const now = Date.now();
const event = await admin<{ id: string }>('POST', '/api/events', {
  name: 'Bench',
  startsAt: new Date(now - 3_600_000).toISOString(),
  endsAt: new Date(now + 6 * 3_600_000).toISOString()
});
const { key } = await admin<{ key: string }>('POST', `/api/events/${event.id}/scanners`, { label: 'Bench door' });

async function issue(count: number, policyId?: string): Promise<string[]> {
  const tokens: string[] = [];
  for (let left = count; left > 0; left -= 500) {
    const passes = await admin<Array<{ token: string }>>('POST', `/api/events/${event.id}/passes`, { count: Math.min(500, left), ...(policyId ? { policyId } : {}) });
    tokens.push(...passes.map((pass) => pass.token));
  }
  return tokens;
}

async function redeem(code: string): Promise<{ ms: number; outcome: string }> {
  const start = performance.now();
  const response = await fetch(`${base}/api/scanner/redeem`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code })
  });
  const body = (await response.json()) as { outcome: string };
  return { ms: performance.now() - start, outcome: body.outcome };
}

async function run(name: string, codes: string[], concurrency: number) {
  const results: Array<{ ms: number; outcome: string }> = [];
  let next = 0;
  const start = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < codes.length) results.push(await redeem(codes[next++]));
    })
  );
  const wallMs = performance.now() - start;
  const sorted = results.map((result) => result.ms).sort((a, b) => a - b);
  const pct = (p: number) => Number(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))].toFixed(2));
  const outcomes: Record<string, number> = {};
  for (const result of results) outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
  return { name, requests: results.length, concurrency, p50Ms: pct(50), p95Ms: pct(95), p99Ms: pct(99), maxMs: Number(sorted.at(-1)!.toFixed(2)), perSecond: Math.round((results.length / wallMs) * 1000), outcomes };
}

await run('warmup', await issue(300), 10);

const results = [];
results.push(await run(`sequential, ${SEQUENTIAL} unique passes`, await issue(SEQUENTIAL), 1));
results.push(await run(`${CONCURRENT_TOTAL} unique passes`, await issue(CONCURRENT_TOTAL), CONCURRENCY));
const [contended] = await issue(1);
results.push(await run('one pass, 100 simultaneous scans', Array.from({ length: 100 }, () => contended), 100));
const wave = await admin<{ id: string }>('POST', `/api/events/${event.id}/policies`, { name: 'Bench wave', capacity: 250 });
results.push(await run('1000 passes racing for capacity 250', await issue(1000, wave.id), 100));

const cpus = os.cpus();
console.log(
  JSON.stringify(
    {
      environment: {
        node: process.version,
        sqlite,
        platform: `${os.type()} ${os.release()} ${os.arch()}`,
        cpu: `${cpus[0]?.model ?? 'unknown'} (${cpus.length} logical)`,
        memoryGiB: Math.round(os.totalmem() / 2 ** 30),
        date: new Date().toISOString()
      },
      method:
        'Server in a separate Node process (scripts/bench-server.ts), file-backed SQLite (WAL, synchronous=NORMAL) in a temp dir, rate limits off. Client: keep-alive fetch over loopback; latency = request start to parsed JSON. 300-request warm-up discarded.',
      results
    },
    null,
    2
  )
);
child.send('stop');
