/**
 * Release check: a release is complete only when this exits 0.
 *
 * 1. Waits (bounded, cold-start tolerant) until the frontend's /version.json
 *    and /api/health (and BACKEND_URL's /api/health, when given) all report
 *    the expected commit, health is ok and the schema version is present.
 *    Without EXPECTED_COMMIT it waits for health and requires the frontend and
 *    backend commits to agree whenever both are known.
 * 2. Runs nondestructive smoke checks: security headers on the SPA, health
 *    `no-store`, unauthenticated /api/events and /api/scanner/redeem refused,
 *    an unknown pass link answers 404, the origin refuses requests that did
 *    not come through the proxy, and (with PREVIEW_URL) a preview deployment
 *    does not reach a backend. Nothing is created, changed or deleted, and no
 *    credentials are used.
 *
 * Usage:
 *   FRONTEND_URL=https://gatepass-sandy.vercel.app \
 *   BACKEND_URL=https://gatepass-api-mvle.onrender.com \
 *   EXPECTED_COMMIT=$(git rev-parse origin/main) \
 *   npx tsx scripts/release-check.ts
 *
 * Environment:
 *   FRONTEND_URL            required; origin that serves the SPA (and proxies /api)
 *   BACKEND_URL             optional; the GatePass server's own origin
 *   EXPECTED_COMMIT         optional; full or abbreviated (>= 7 chars) commit SHA
 *   PREVIEW_URL             optional; a preview deployment to check for isolation
 *   RELEASE_CHECK_TIMEOUT   seconds to wait for step 1 (default 900)
 *   RELEASE_CHECK_INTERVAL  seconds between polls (default 15)
 *   GATED_COMMIT            optional; the commit this run reports a GitHub check on
 *                           (GITHUB_SHA in release-verify.yml). See "Deferral" below.
 *   GATED_COMMIT_TIME       GATED_COMMIT's committer time, Unix seconds
 *   DEPLOY_PENDING_GRACE    seconds after GATED_COMMIT_TIME during which a backend
 *                           still on another commit counts as "deploy pending" (default 3600)
 *
 * Deferral: the Render service deploys a commit only after ALL of that commit's
 * GitHub checks complete successfully (autoDeployTrigger: checksPass), and a
 * release-verify run on main is one of them. If such a run waited for the
 * backend to serve the commit, Render would wait for the run (a circular wait)
 * and, when the run then failed, skip the deploy for good. So when GATED_COMMIT
 * is younger than the grace period and the backend health reports a different
 * commit, the check is deferred: it reports why, writes a "deferred" summary
 * and exits 0 WITHOUT checking anything. A deferred run is not a release pass;
 * run it again once the backend reports the commit.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

type Level = 'pass' | 'fail' | 'warn';
type Result = { name: string; level: Level; detail: string };
type Fetched = { status: number; headers: Headers; text: string; json: unknown };

const REQUEST_TIMEOUT_MS = 75_000; // a sleeping Render free instance takes ~50 s to answer

function origin(name: string, required: boolean): string | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    if (required) fatal(`${name} is required, e.g. ${name}=https://gatepass-sandy.vercel.app`);
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fatal(`${name} is not a URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fatal(`${name} must be http(s): ${raw}`);
  return url.origin;
}

function seconds(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) fatal(`${name} must be a number of seconds`);
  return value;
}

function fatal(message: string): never {
  console.error(`release-check: ${message}`);
  process.exit(2);
}

const frontend = origin('FRONTEND_URL', true)!;
const backendRaw = origin('BACKEND_URL', false);
const backend = backendRaw && backendRaw !== frontend ? backendRaw : undefined;
const preview = origin('PREVIEW_URL', false);
const expectedRaw = process.env.EXPECTED_COMMIT?.trim().toLowerCase() || undefined;
if (expectedRaw && !/^[0-9a-f]{7,64}$/.test(expectedRaw)) fatal('EXPECTED_COMMIT must be a commit SHA (at least 7 hex characters)');
const expected = expectedRaw;
const timeoutMs = seconds('RELEASE_CHECK_TIMEOUT', 900) * 1000;
const intervalMs = seconds('RELEASE_CHECK_INTERVAL', 15) * 1000;
const gatedRaw = process.env.GATED_COMMIT?.trim().toLowerCase() || undefined;
if (gatedRaw && !/^[0-9a-f]{7,64}$/.test(gatedRaw)) fatal('GATED_COMMIT must be a commit SHA (at least 7 hex characters)');
const gated = gatedRaw;
const gatedTimeRaw = process.env.GATED_COMMIT_TIME?.trim();
if (gated && !(gatedTimeRaw && /^\d+$/.test(gatedTimeRaw))) fatal('GATED_COMMIT_TIME must be the commit time in Unix seconds when GATED_COMMIT is set');
const gatedTimeMs = Number(gatedTimeRaw) * 1000;
const pendingGraceMs = seconds('DEPLOY_PENDING_GRACE', 3600) * 1000;

async function get(url: string, init: RequestInit = {}): Promise<Fetched> {
  const response = await fetch(url, { redirect: 'manual', ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
  return String(error);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function sameCommit(actual: string, wanted: string): boolean {
  const a = actual.toLowerCase();
  return a.length >= 7 && (a.startsWith(wanted) || wanted.startsWith(a));
}

const short = (commit: string | null | undefined) => (commit ? commit.slice(0, 12) : String(commit));
/** A commit id read from a server: hex only, so nothing else from the response reaches logs or the step summary. */
const asCommit = (value: unknown) => (typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value) ? value.toLowerCase() : null);

// ------------------------------------------------------------ step 1: commits

type Observation = { ready: boolean; commit: string | null | undefined; detail: string };

async function observeVersion(): Promise<Observation> {
  try {
    const res = await get(`${frontend}/version.json`, { headers: { 'Cache-Control': 'no-cache' } });
    const body = record(res.json);
    if (res.status !== 200 || !body || !('commit' in body)) return { ready: false, commit: undefined, detail: `HTTP ${res.status}, no commit field` };
    const commit = asCommit(body.commit);
    if (expected && !(commit && sameCommit(commit, expected))) return { ready: false, commit, detail: `commit ${short(commit)}, want ${short(expected)}` };
    return { ready: true, commit, detail: `commit ${short(commit)}` };
  } catch (error) {
    return { ready: false, commit: undefined, detail: describeError(error) };
  }
}

async function observeHealth(base: string): Promise<Observation> {
  try {
    const res = await get(`${base}/api/health`);
    const body = record(res.json);
    if (res.status !== 200 || body?.ok !== true || body.service !== 'gatepass') {
      return { ready: false, commit: undefined, detail: `HTTP ${res.status} ${res.text.slice(0, 120).replace(/\s+/g, ' ')}` };
    }
    const build = record(body.build);
    if (!build || typeof build.schema !== 'number' || build.schema < 1) return { ready: false, commit: undefined, detail: 'ok, but no build.schema (server older than the release-check contract)' };
    const commit = asCommit(build.commit);
    if (expected && !(commit && sameCommit(commit, expected))) return { ready: false, commit, detail: `schema ${build.schema}, commit ${short(commit)}, want ${short(expected)}` };
    return { ready: true, commit, detail: `schema ${build.schema}, commit ${short(commit)}${body.demo === true ? ', demo' : ''}` };
  } catch (error) {
    return { ready: false, commit: undefined, detail: describeError(error) };
  }
}

async function waitForRelease(results: Result[]): Promise<void> {
  const targets: Array<[string, () => Promise<Observation>]> = [
    ['frontend /version.json', observeVersion],
    ['frontend /api/health', () => observeHealth(frontend)]
  ];
  if (backend) targets.push(['backend /api/health', () => observeHealth(backend)]);

  const deadline = Date.now() + timeoutMs;
  let last: Observation[] = [];
  for (let attempt = 1; ; attempt++) {
    last = await Promise.all(targets.map(([, observe]) => observe()));
    console.log(`[poll ${attempt}] ${targets.map(([name], i) => `${name}: ${last[i].ready ? 'ready' : 'waiting'} (${last[i].detail})`).join(' | ')}`);
    if (last.every((observation) => observation.ready) || Date.now() + intervalMs > deadline) break;
    await sleep(intervalMs);
  }
  targets.forEach(([name], i) => {
    results.push({ name: `${name}${expected ? ` reports ${short(expected)}` : ' ready'}`, level: last[i].ready ? 'pass' : 'fail', detail: last[i].detail });
  });

  // Frontend and backend must come from the same commit even when no commit was given.
  const commits = last.map((observation) => observation.commit).filter((commit): commit is string => typeof commit === 'string');
  const known = new Set(commits.map((commit) => commit.slice(0, 7)));
  if (commits.length === last.length) {
    results.push({ name: 'frontend and backend commits agree', level: known.size === 1 ? 'pass' : 'fail', detail: commits.map(short).join(' / ') });
  } else {
    results.push({
      name: 'frontend and backend commits agree',
      level: known.size > 1 ? 'fail' : 'warn',
      detail: `not every side reports a commit (${last.map((observation) => short(observation.commit)).join(' / ')}); build with GATEPASS_COMMIT or VERCEL_GIT_COMMIT_SHA`
    });
  }
}

// ------------------------------------------------------------ step 2: smoke

async function check(results: Result[], name: string, run: () => Promise<Omit<Result, 'name'>>): Promise<void> {
  try {
    results.push({ name, ...(await run()) });
  } catch (error) {
    results.push({ name, level: 'fail', detail: describeError(error) });
  }
}

const verdict = (ok: boolean, detail: string, otherwise: Level = 'fail'): Omit<Result, 'name'> => ({ level: ok ? 'pass' : otherwise, detail });

async function smoke(results: Result[]): Promise<void> {
  await check(results, 'SPA index sends CSP and security headers', async () => {
    const res = await get(`${frontend}/`);
    const csp = res.headers.get('content-security-policy') ?? '';
    const problems: string[] = [];
    if (res.status !== 200) problems.push(`HTTP ${res.status}`);
    if (!/text\/html/.test(res.headers.get('content-type') ?? '')) problems.push('not text/html');
    for (const directive of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'"]) {
      if (!csp.includes(directive)) problems.push(`CSP lacks ${directive}`);
    }
    if (res.headers.get('x-content-type-options') !== 'nosniff') problems.push('no X-Content-Type-Options: nosniff');
    if (frontend.startsWith('https:') && !res.headers.get('strict-transport-security')) problems.push('no Strict-Transport-Security');
    return verdict(problems.length === 0, problems.join('; ') || `HTTP 200, CSP ${csp.length} chars`);
  });

  await check(results, '/version.json is not cacheable', async () => {
    const res = await get(`${frontend}/version.json`);
    const cache = res.headers.get('cache-control') ?? '(none)';
    // A cached file can only cause a false mismatch, never a false pass: warn.
    return verdict(res.status === 200 && cache.includes('no-store'), `HTTP ${res.status}, Cache-Control ${cache}`, 'warn');
  });

  await check(results, '/api/health 200 with Cache-Control: no-store', async () => {
    const res = await get(`${frontend}/api/health`);
    const cache = res.headers.get('cache-control') ?? '(none)';
    return verdict(res.status === 200 && cache.includes('no-store'), `HTTP ${res.status}, Cache-Control ${cache}`);
  });

  await check(results, 'unauthenticated GET /api/events refused (401)', async () => {
    const res = await get(`${frontend}/api/events`);
    return verdict(res.status === 401, `HTTP ${res.status}`);
  });

  await check(results, 'POST /api/scanner/redeem without a key refused (401)', async () => {
    const res = await get(`${frontend}/api/scanner/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return verdict(res.status === 401, `HTTP ${res.status}`);
  });

  await check(results, 'unknown pass link answers a 404 page', async () => {
    const token = randomBytes(32).toString('base64url'); // 43 characters, the real token length
    const res = await get(`${frontend}/p/${token}`);
    const html = /text\/html/.test(res.headers.get('content-type') ?? '');
    const csp = res.headers.get('content-security-policy') ?? '';
    return verdict(res.status === 404 && html && csp.includes("default-src 'none'"), `HTTP ${res.status}, ${res.headers.get('content-type') ?? 'no content-type'}, CSP ${csp ? 'present' : 'missing'}`);
  });

  if (backend) {
    await check(results, 'backend origin refuses unproxied API requests (401/403)', async () => {
      const res = await get(`${backend}/api/events`);
      return verdict(res.status === 401 || res.status === 403, `HTTP ${res.status}${res.status === 403 ? ' (origin-secret gate)' : ''}`);
    });
  }

  if (preview) {
    await check(results, 'preview deployment does not reach a backend', async () => {
      const res = await get(`${preview}/api/health`);
      const body = record(res.json);
      if (res.status === 503 && body?.preview === true) return { level: 'pass', detail: 'HTTP 503 preview-no-backend' };
      if (res.status === 401 || res.status === 403) return { level: 'pass', detail: `HTTP ${res.status}: protected by Vercel Deployment Protection; the no-backend body is not observable` };
      if (res.status === 200) {
        return { level: 'warn', detail: 'preview answers /api/health: it has its own backend (GATEPASS_PREVIEW_BACKEND_ORIGIN); vercel.mjs refuses the production origin at build time, confirm the target is not production' };
      }
      return { level: 'fail', detail: `HTTP ${res.status}` };
    });
  }
}

// ------------------------------------------------------------ report

function report(results: Result[]): boolean {
  const failed = results.filter((result) => result.level === 'fail');
  const mark = { pass: 'PASS', fail: 'FAIL', warn: 'WARN' } as const;
  console.log(`\nRelease check: ${frontend}${backend ? ` + ${backend}` : ''}${expected ? ` @ ${short(expected)}` : ''}`);
  for (const result of results) console.log(`  ${mark[result.level]}  ${result.name}: ${result.detail}`);
  console.log(failed.length ? `\nRELEASE CHECK FAILED (${failed.length} of ${results.length} checks)` : `\nRelease check passed (${results.length} checks)`);

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    // Markdown table cell: backslashes first, so an escaped pipe cannot be un-escaped by the text.
    const escape = (text: string) => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    const lines = [
      `### Release check ${failed.length ? 'failed' : 'passed'}`,
      '',
      `Frontend \`${frontend}\`${backend ? `, backend \`${backend}\`` : ''}${expected ? `, expected commit \`${short(expected)}\`` : ''}`,
      '',
      '| Result | Check | Detail |',
      '| --- | --- | --- |',
      ...results.map((result) => `| ${mark[result.level]} | ${escape(result.name)} | ${escape(result.detail)} |`),
      ''
    ];
    appendFileSync(summary, `${lines.join('\n')}\n`);
  }
  return failed.length === 0;
}

// ------------------------------------------------------------ deferral

/** Why this run must not wait or fail (see "Deferral" above), or undefined to run the release check. */
async function pendingDeploy(): Promise<string | undefined> {
  if (!gated) return undefined;
  const ageMs = Date.now() - gatedTimeMs;
  if (ageMs >= pendingGraceMs) return undefined;
  const serving = await observeHealth(backend ?? frontend);
  // Only positive evidence defers: an unreachable backend is checked (and fails) as usual.
  if (typeof serving.commit !== 'string' || sameCommit(serving.commit, gated)) return undefined;
  return `the backend serves ${short(serving.commit)}, not ${short(gated)} (committed ${Math.max(0, Math.round(ageMs / 60_000))} min ago): its deploy waits for this commit's checks, including this run`;
}

const deferred = await pendingDeploy();
if (deferred) {
  console.log(`Release check DEFERRED, nothing was checked: ${deferred}. Run it again once the backend reports ${short(gated)}; a deferred run is not a release pass.`);
  console.log(`::notice title=Release check deferred::${deferred}`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `### Release check deferred (not a pass)\n\nNothing was checked: ${deferred}. Run it again once the backend reports \`${short(gated)}\`.\n`);
} else {
  const results: Result[] = [];
  await waitForRelease(results);
  await smoke(results);
  process.exitCode = report(results) ? 0 : 1;
}
