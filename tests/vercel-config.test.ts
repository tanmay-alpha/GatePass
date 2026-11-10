import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// vercel.mjs reads process.env at import time, so every case evaluates it in a
// fresh child process with exactly the given variables (plus what Node needs
// to start), never the developer's or CI's environment.
const configUrl = pathToFileURL(path.resolve('vercel.mjs')).href;

type Route = {
  src?: string;
  dest?: string;
  status?: number;
  handle?: string;
  continue?: boolean;
  headers?: Record<string, string>;
  transforms?: Array<{ type: string; op: string; target: { key: string }; args: string; env: string[] }>;
};
type Loaded = { ok: true; config: { routes: Route[]; outputDirectory: string } } | { ok: false; error: string };

function loadConfig(env: Record<string, string | undefined>): Loaded {
  const base: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP']) {
    const value = process.env[key];
    if (value !== undefined) base[key] = value;
  }
  const script = `
    try {
      const { config } = await import(${JSON.stringify(configUrl)});
      process.stdout.write(JSON.stringify({ ok: true, config }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, error: String(error && error.message) }));
    }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...base, ...env },
    encoding: 'utf8'
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Loaded;
}

function loaded(env: Record<string, string | undefined>) {
  const result = loadConfig(env);
  if (!result.ok) throw new Error(`vercel.mjs threw: ${result.error}`);
  return result.config;
}

const PROD_ORIGIN = 'https://api.gate.example.com';
const PREVIEW_ORIGIN = 'https://preview-api.gate.example.com';

describe('vercel.mjs environment policy', () => {
  it('fails a production build without GATEPASS_BACKEND_ORIGIN', () => {
    const result = loadConfig({ VERCEL_ENV: 'production' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/GATEPASS_BACKEND_ORIGIN/);
  });

  it('fails a production build with a non-HTTPS origin', () => {
    const result = loadConfig({ VERCEL_ENV: 'production', GATEPASS_BACKEND_ORIGIN: 'http://api.gate.example.com' });
    expect(result.ok).toBe(false);
  });

  it('proxies /api and /p in production with the ORIGIN_SECRET transform', () => {
    const config = loaded({ VERCEL_ENV: 'production', GATEPASS_BACKEND_ORIGIN: `${PROD_ORIGIN}/` });
    const api = config.routes.find((route) => route.src === '/api/(.*)');
    const pass = config.routes.find((route) => route.src === '/p/(.*)');
    expect(api?.dest).toBe(`${PROD_ORIGIN}/api/$1`);
    expect(pass?.dest).toBe(`${PROD_ORIGIN}/p/$1`);
    for (const route of [api, pass]) {
      expect(route?.transforms).toEqual([
        { type: 'request.headers', op: 'set', target: { key: 'x-origin-secret' }, args: '$ORIGIN_SECRET', env: ['ORIGIN_SECRET'] }
      ]);
    }
    expect(config.routes.some((route) => route.status === 503)).toBe(false);
  });

  it('builds a static-only preview with a 503 backend route and no production secret', () => {
    // Production values visible to the preview build must be ignored.
    const config = loaded({ VERCEL_ENV: 'preview', GATEPASS_BACKEND_ORIGIN: PROD_ORIGIN, ORIGIN_SECRET: 'x'.repeat(32) });
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain('ORIGIN_SECRET');
    expect(serialized).not.toContain(PROD_ORIGIN);
    expect(config.routes.some((route) => route.dest?.startsWith('https://'))).toBe(false);

    const filesystem = config.routes.findIndex((route) => route.handle === 'filesystem');
    const noBackend = config.routes.findIndex((route) => route.status === 503);
    const fallback = config.routes.findIndex((route) => route.dest === '/index.html');
    expect(filesystem).toBeGreaterThanOrEqual(0);
    expect(noBackend).toBeGreaterThan(filesystem);
    expect(fallback).toBeGreaterThan(noBackend);

    const route = config.routes[noBackend];
    expect(route.src).toBe('/(api|p)/(.*)');
    expect(route.dest).toBe('/preview-no-backend.json');
    expect(route.headers?.['Cache-Control']).toBe('no-store');
    for (const sample of ['/api/health', '/p/abc']) expect(new RegExp(`^${route.src}$`).test(sample)).toBe(true);

    const body = JSON.parse(readFileSync('public/preview-no-backend.json', 'utf8'));
    expect(body).toEqual({
      error: 'This preview deployment has no backend. Previews never connect to production data.',
      preview: true
    });
  });

  it('treats an unset VERCEL_ENV (local/development) like a preview', () => {
    const config = loaded({ GATEPASS_BACKEND_ORIGIN: PROD_ORIGIN });
    expect(JSON.stringify(config)).not.toContain(PROD_ORIGIN);
    expect(config.routes.some((route) => route.status === 503)).toBe(true);
  });

  it('proxies a preview to the preview origin with PREVIEW_ORIGIN_SECRET only', () => {
    const config = loaded({
      VERCEL_ENV: 'preview',
      GATEPASS_PREVIEW_BACKEND_ORIGIN: PREVIEW_ORIGIN,
      GATEPASS_BACKEND_ORIGIN: PROD_ORIGIN
    });
    const proxied = config.routes.filter((route) => route.dest?.startsWith('https://'));
    expect(proxied.map((route) => route.dest)).toEqual([`${PREVIEW_ORIGIN}/api/$1`, `${PREVIEW_ORIGIN}/p/$1`]);
    for (const route of proxied) {
      expect(route.transforms).toEqual([
        {
          type: 'request.headers',
          op: 'set',
          target: { key: 'x-origin-secret' },
          args: '$PREVIEW_ORIGIN_SECRET',
          env: ['PREVIEW_ORIGIN_SECRET']
        }
      ]);
    }
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain(PROD_ORIGIN);
    expect(serialized).not.toMatch(/(?<!PREVIEW_)ORIGIN_SECRET/);
    expect(config.routes.some((route) => route.status === 503)).toBe(false);
  });

  it('refuses a preview origin equal to the production origin', () => {
    const result = loadConfig({
      VERCEL_ENV: 'preview',
      GATEPASS_PREVIEW_BACKEND_ORIGIN: PROD_ORIGIN,
      GATEPASS_BACKEND_ORIGIN: `${PROD_ORIGIN}/`
    });
    expect(result.ok).toBe(false);
  });

  it('sends the security headers including HSTS on every route', () => {
    for (const env of [{ VERCEL_ENV: 'production', GATEPASS_BACKEND_ORIGIN: PROD_ORIGIN }, { VERCEL_ENV: 'preview' }]) {
      const headers = loaded(env).routes.find((route) => route.continue && route.headers)?.headers;
      expect(headers?.['Strict-Transport-Security']).toBe('max-age=63072000; includeSubDomains');
      expect(headers?.['X-Frame-Options']).toBe('DENY');
      expect(headers?.['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    }
  });

  it('ships the 503 body as a static file Vite copies into dist/client', () => {
    expect(existsSync('public/preview-no-backend.json')).toBe(true);
  });
});
