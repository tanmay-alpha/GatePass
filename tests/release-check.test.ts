import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// scripts/release-check.ts against two local stubs (frontend and backend), run
// as a child process exactly like release-verify.yml does (`node <file>`, Node
// type stripping). Covers the deferral that keeps a release-verify run on main
// from deadlocking or cancelling Render's checksPass auto-deploy.

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

type Stub = { server: Server; url: string; version: string; health: string; healthStatus: number };

function stub(): Promise<Stub> {
  const state = { version: NEW, health: NEW, healthStatus: 200 } as Stub;
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (url === '/version.json') return json(200, { commit: state.version });
    if (url === '/api/health') {
      return state.healthStatus === 200
        ? json(200, { ok: true, service: 'gatepass', build: { commit: state.health, schema: 5 } })
        : json(state.healthStatus, { ok: false });
    }
    if (url.startsWith('/api/')) return json(401, { error: 'Unauthorized' });
    if (url.startsWith('/p/')) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'" });
      return res.end('<!doctype html><title>Not found</title>');
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
      'X-Content-Type-Options': 'nosniff'
    });
    res.end('<!doctype html><title>GatePass</title>');
  });
  state.server = server;
  const { promise, resolve } = Promise.withResolvers<Stub>();
  server.listen(0, '127.0.0.1', () => {
    state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    resolve(state);
  });
  return promise;
}

let frontend: Stub;
let backend: Stub;
let dir: string;

beforeAll(async () => {
  [frontend, backend] = await Promise.all([stub(), stub()]);
  dir = mkdtempSync(path.join(tmpdir(), 'release-check-'));
});
afterAll(() => {
  frontend.server.close();
  backend.server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Frontend already on NEW (Vercel deploys at once); the backend serves `backendCommit`. */
function serve(backendCommit: string, backendStatus = 200) {
  frontend.version = NEW;
  frontend.health = backendCommit; // /api/health is proxied to the backend
  frontend.healthStatus = backendStatus;
  backend.health = backendCommit;
  backend.healthStatus = backendStatus;
}

let runs = 0;
function run(env: Record<string, string>): Promise<{ code: number; stdout: string; summary: string }> {
  const summaryFile = path.join(dir, `summary-${++runs}.md`);
  const base: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP']) {
    const value = process.env[key];
    if (value !== undefined) base[key] = value;
  }
  const { promise, resolve } = Promise.withResolvers<{ code: number; stdout: string; summary: string }>();
  execFile(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', path.resolve('scripts/release-check.ts')],
    {
      env: {
        ...base,
        FRONTEND_URL: frontend.url,
        BACKEND_URL: backend.url,
        RELEASE_CHECK_TIMEOUT: '0',
        RELEASE_CHECK_INTERVAL: '0',
        GITHUB_STEP_SUMMARY: summaryFile,
        ...env
      },
      timeout: 30_000
    },
    (error, stdout) => {
      let summary = '';
      try {
        summary = readFileSync(summaryFile, 'utf8');
      } catch {
        // no summary written
      }
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, summary });
    }
  );
  return promise;
}

const now = () => String(Math.floor(Date.now() / 1000));
const twoHoursAgo = String(Math.floor(Date.now() / 1000) - 2 * 3600);

describe('scripts/release-check.ts', () => {
  it('passes when frontend and backend serve the gated commit', async () => {
    serve(NEW);
    const result = await run({ GATED_COMMIT: NEW, GATED_COMMIT_TIME: now() });
    expect(result.stdout).toContain('Release check passed');
    expect(result.stdout).not.toContain('DEFERRED');
    expect(result.code).toBe(0);
  });

  it('defers without waiting or failing while the gated commit is fresh and the backend still serves another commit', async () => {
    serve(OLD);
    const started = Date.now();
    const result = await run({ GATED_COMMIT: NEW, GATED_COMMIT_TIME: now(), RELEASE_CHECK_TIMEOUT: '300', RELEASE_CHECK_INTERVAL: '15' });
    expect(result.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(15_000); // did not poll for the 300 s timeout
    expect(result.stdout).toContain('DEFERRED');
    expect(result.stdout).toContain('not a release pass');
    expect(result.stdout).not.toContain('[poll');
    expect(result.summary).toContain('Release check deferred (not a pass)');
    expect(result.summary).not.toContain('Release check passed');
  });

  it('fails a frontend/backend skew once the gated commit is older than the grace period', async () => {
    serve(OLD);
    const result = await run({ GATED_COMMIT: NEW, GATED_COMMIT_TIME: twoHoursAgo });
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('DEFERRED');
    expect(result.stdout).toMatch(/FAIL {2}frontend and backend commits agree/);
  });

  it('fails a skew without GATED_COMMIT (runs off main, laptop runs)', async () => {
    serve(OLD);
    const result = await run({});
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/FAIL {2}frontend and backend commits agree/);
  });

  it('does not defer when the backend is unhealthy: no evidence of a pending deploy', async () => {
    serve(OLD, 503);
    const result = await run({ GATED_COMMIT: NEW, GATED_COMMIT_TIME: now() });
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('DEFERRED');
    expect(result.stdout).toContain('RELEASE CHECK FAILED');
  });

  it('rejects GATED_COMMIT without a commit time', async () => {
    serve(NEW);
    const result = await run({ GATED_COMMIT: NEW });
    expect(result.code).toBe(2);
  });
});
