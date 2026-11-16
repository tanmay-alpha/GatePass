import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIAGNOSTIC_WHERE, clockOffsetMs, entryWindow, isReady, readinessItems, type ReadinessFacts } from '../src/client/scanner/readiness';
import { createApp } from '../src/server/app';
import { DIAGNOSTIC_PREFIX, diagnosticPayload, isDiagnosticPayload, isValidDiagnosticCode } from '../src/shared/diagnostic';
import type { ScannerSession } from '../src/shared/types';
import { ADMIN_TOKEN, PUBLIC_URL, createHarness } from './helpers';

const NOW = Date.parse('2030-06-01T18:30:00.000Z');

const SESSION: ScannerSession = {
  scanner: { id: 's1', label: 'Door 1' },
  gate: { id: 'g1', name: 'North' },
  event: { id: 'e1', name: 'Launch Night', venue: 'Hall A', timeZone: 'UTC', startsAt: '2030-06-01T18:00:00.000Z', endsAt: '2030-06-01T23:00:00.000Z', status: 'active' },
  serverTime: new Date(NOW).toISOString()
};

/** Everything in order: online, fast server with the same clock, camera on, test code read. */
function facts(overrides: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    session: SESSION,
    online: true,
    probe: { state: 'ok', latencyMs: 80, serverTime: new Date(NOW).toISOString(), receivedAt: NOW + 40 },
    camera: { supported: true, permission: 'granted', live: true, error: '' },
    diagnostic: 'passed',
    nowMs: NOW,
    ...overrides
  };
}

const item = (input: ReadinessFacts, id: string) => readinessItems(input).find((entry) => entry.id === id)!;

describe('scanner readiness checklist', () => {
  it('passes every item when the device is ready, in a fixed order', () => {
    const items = readinessItems(facts());
    expect(items.map((entry) => [entry.id, entry.state])).toEqual([
      ['enrolled', 'ok'],
      ['assignment', 'info'],
      ['server', 'ok'],
      ['camera', 'ok'],
      ['window', 'ok'],
      ['diagnostic', 'ok']
    ]);
    expect(isReady(items)).toBe(true);
    expect(item(facts(), 'server').detail).toBe('Reachable, 80 ms round trip.');
    expect(item(facts(), 'assignment').detail).toBe('Launch Night, Hall A — admits at the North gate.');
    expect(item(facts({ session: { ...SESSION, gate: null } }), 'assignment').detail).toContain('admits at every gate');
  });

  it('every item that is not passed carries concrete guidance', () => {
    const bad = facts({
      online: false,
      camera: { supported: true, permission: 'denied', live: false, error: '' },
      diagnostic: 'idle',
      session: { ...SESSION, event: { ...SESSION.event, status: 'draft' } }
    });
    const items = readinessItems(bad);
    expect(isReady(items)).toBe(false);
    for (const entry of items.filter((e) => e.state !== 'ok')) expect(entry.guidance, entry.id).toMatch(/\w{3,}/);
  });

  it('reports the server as unavailable offline, failed, or still checking, and never as passed', () => {
    expect(item(facts({ online: false }), 'server')).toMatchObject({ state: 'fail', detail: 'No network connection.' });
    expect(item(facts({ online: false }), 'server').guidance).toContain('nobody can be admitted');
    expect(item(facts({ probe: { state: 'failed', message: 'Cannot reach the server.' } }), 'server')).toMatchObject({ state: 'fail', detail: 'Cannot reach the server.' });
    expect(item(facts({ probe: { state: 'failed', message: 'x' } }), 'server').guidance).toContain('Test connection');
    expect(item(facts({ probe: { state: 'checking' } }), 'server').state).toBe('pending');
  });

  it('warns about a slow connection and about a device clock that is off', () => {
    const slow = item(facts({ probe: { state: 'ok', latencyMs: 2400, serverTime: new Date(NOW).toISOString(), receivedAt: NOW + 1200 } }), 'server');
    expect(slow.state).toBe('warn');
    expect(slow.guidance).toContain('slow');
    // The server's clock is 5 minutes ahead of this phone's.
    const skewed = facts({ probe: { state: 'ok', latencyMs: 0, serverTime: new Date(NOW + 5 * 60_000).toISOString(), receivedAt: NOW } });
    expect(clockOffsetMs(skewed.probe)).toBe(5 * 60_000);
    expect(item(skewed, 'server')).toMatchObject({ state: 'warn' });
    expect(item(skewed, 'server').guidance).toContain('5 minutes behind the server');
    // An older server that sends no time: no skew, no crash.
    expect(clockOffsetMs({ state: 'ok', latencyMs: 10, serverTime: undefined as unknown as string, receivedAt: NOW })).toBe(0);
  });

  it('judges the entry window by the server clock, in the event zone', () => {
    const early = { state: 'ok' as const, latencyMs: 0, serverTime: '2030-06-01T17:15:00.000Z', receivedAt: NOW };
    // The phone's own clock says 18:30 (inside the window), but the server says 17:15.
    const window = item(facts({ probe: early }), 'window');
    expect(window.state).toBe('warn');
    expect(window.detail).toBe('Entry opens at 18:00 event time (UTC).');
    expect(window.guidance).toContain('too early');

    const late = item(facts({ probe: { ...early, serverTime: '2030-06-01T23:00:00.000Z' } }), 'window');
    expect(late).toMatchObject({ state: 'fail', detail: 'Entry closed at 23:00.' });

    const zoned = item(facts({ probe: early, session: { ...SESSION, event: { ...SESSION.event, timeZone: 'Asia/Kolkata' } } }), 'window');
    expect(zoned.detail).toBe('Entry opens at 23:30 event time (Asia/Kolkata).');

    for (const status of ['draft', 'ended', 'archived'] as const) {
      const closed = item(facts({ session: { ...SESSION, event: { ...SESSION.event, status } } }), 'window');
      expect(closed.state).toBe('fail');
      expect(closed.detail).toContain('every pass is refused');
    }
    expect(entryWindow(SESSION.event, NOW)).toEqual({ state: 'open', closesAt: SESSION.event.endsAt });
  });

  it('explains camera problems: unsupported, blocked, failed to start, not yet allowed', () => {
    expect(item(facts({ camera: { supported: false, permission: 'unknown', live: false, error: '' } }), 'camera')).toMatchObject({ state: 'fail' });
    const denied = item(facts({ camera: { supported: true, permission: 'denied', live: false, error: '' } }), 'camera');
    expect(denied.state).toBe('fail');
    expect(denied.guidance).toContain('site settings');
    const failed = item(facts({ camera: { supported: true, permission: 'granted', live: false, error: 'The camera is in use by another app.' } }), 'camera');
    expect(failed).toMatchObject({ state: 'fail', detail: 'The camera is in use by another app.' });
    const prompt = item(facts({ camera: { supported: true, permission: 'prompt', live: false, error: '' } }), 'camera');
    expect(prompt.state).toBe('pending');
    expect(prompt.guidance).toContain('Test camera');
  });

  it('asks for the camera test until the test code has been read on the device', () => {
    expect(item(facts({ diagnostic: 'idle' }), 'diagnostic')).toMatchObject({ state: 'pending', guidance: `Tap Test camera. ${DIAGNOSTIC_WHERE}` });
    expect(item(facts({ diagnostic: 'running' }), 'diagnostic')).toMatchObject({ state: 'pending', guidance: DIAGNOSTIC_WHERE });
    expect(item(facts(), 'diagnostic').detail).toContain('Nothing was sent to the server');
  });
});

describe('camera test codes', () => {
  it('recognises any diagnostic payload, but accepts only well-formed version 1 codes as a passed test', () => {
    const code = diagnosticPayload('AbC-123_xyz');
    expect(code).toBe(`${DIAGNOSTIC_PREFIX}v1:AbC-123_xyz`);
    expect(isValidDiagnosticCode(code)).toBe(true);
    expect(isDiagnosticPayload(code)).toBe(true);
    expect(isDiagnosticPayload('  GatePass:Diagnostic:v9:whatever ')).toBe(true);
    expect(isValidDiagnosticCode('gatepass:diagnostic:v1:short')).toBe(false);
    expect(isValidDiagnosticCode('gatepass:diagnostic:v1:https://gate.example/p/xyz')).toBe(false);
    expect(isDiagnosticPayload(`${PUBLIC_URL}/p/${'A'.repeat(43)}`)).toBe(false);
    expect(isDiagnosticPayload('ABCD1234')).toBe(false);
  });
});

describe('scanner PWA', () => {
  const root = path.resolve('public');
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));

  it('the manifest is scoped to the scanner and its icons exist', () => {
    expect(manifest).toMatchObject({ id: '/scan', start_url: '/scan', scope: '/scan', display: 'standalone' });
    const purposes = manifest.icons.map((icon: { purpose: string }) => icon.purpose);
    expect(purposes).toContain('maskable');
    for (const icon of manifest.icons as Array<{ src: string; sizes: string }>) {
      const png = readFileSync(path.join(root, icon.src));
      expect(png.subarray(1, 4).toString()).toBe('PNG');
      const [width, height] = icon.sizes.split('x').map(Number);
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([width, height]);
    }
    expect(readFileSync(path.resolve('index.html'), 'utf8')).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
  });

  type Handler = (event: unknown) => void;

  /** Runs public/sw.js in a minimal service worker global and returns its fetch handler. */
  function loadWorker(network: (url: string) => Promise<Response>, cached: Response | undefined) {
    const handlers: Record<string, Handler> = {};
    const cache = { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined), keys: vi.fn(async () => []), delete: vi.fn(async () => true) };
    const context = {
      self: {
        location: { origin: PUBLIC_URL },
        addEventListener: (type: string, handler: Handler) => (handlers[type] = handler),
        skipWaiting: async () => undefined,
        clients: { claim: async () => undefined }
      },
      caches: { open: async () => cache, match: vi.fn(async () => cached), keys: async () => [], delete: async () => true },
      fetch: vi.fn((input: string | { url: string }) => network(typeof input === 'string' ? input : input.url)),
      URL,
      Response,
      Promise,
      setTimeout,
      Set
    };
    vm.runInNewContext(readFileSync(path.join(root, 'sw.js'), 'utf8'), context);
    const fetchEvent = (url: string, init: { method?: string; mode?: string } = {}) => {
      const respondWith = vi.fn();
      handlers.fetch({ request: { url, method: init.method ?? 'GET', mode: init.mode ?? 'cors' }, respondWith, waitUntil: () => undefined });
      return respondWith;
    };
    return { fetchEvent, context };
  }

  it('the service worker never answers /api/* or /p/* (network only), nor writes or other origins', () => {
    const { fetchEvent } = loadWorker(async () => new Response('ok'), undefined);
    for (const url of [
      `${PUBLIC_URL}/api/scanner/redeem`,
      `${PUBLIC_URL}/api/scanner/session`,
      `${PUBLIC_URL}/api/scanner/attendees?q=ada`,
      `${PUBLIC_URL}/api`,
      `${PUBLIC_URL}/p/${'A'.repeat(43)}`,
      'https://elsewhere.example/assets/x.js'
    ]) {
      expect(fetchEvent(url), url).not.toHaveBeenCalled();
      expect(fetchEvent(url, { mode: 'navigate' }), url).not.toHaveBeenCalled();
    }
    expect(fetchEvent(`${PUBLIC_URL}/assets/index-abc.js`, { method: 'POST' })).not.toHaveBeenCalled();
    // Non-hashed files (version.json, the manifest, sw.js itself) are not cached either.
    expect(fetchEvent(`${PUBLIC_URL}/version.json`)).not.toHaveBeenCalled();
    expect(fetchEvent(`${PUBLIC_URL}/assets/index-abc.js`)).toHaveBeenCalledOnce();
    expect(fetchEvent(`${PUBLIC_URL}/scan`, { mode: 'navigate' })).toHaveBeenCalledOnce();
  });

  it('offline, a navigation gets the cached app shell; without one it fails like the network', async () => {
    const shell = new Response('<html>shell</html>');
    const offline = loadWorker(async () => Promise.reject(new TypeError('Failed to fetch')), shell);
    const respondWith = offline.fetchEvent(`${PUBLIC_URL}/scan`, { mode: 'navigate' });
    expect(await respondWith.mock.calls[0][0]).toBe(shell);

    const empty = loadWorker(async () => Promise.reject(new TypeError('Failed to fetch')), undefined);
    await expect(empty.fetchEvent(`${PUBLIC_URL}/scan`, { mode: 'navigate' }).mock.calls[0][0]).rejects.toThrow('Offline and no cached scanner app');
  });

  describe('served by the app', () => {
    let dir = '';
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('revalidates sw.js and the manifest on every load and serves the manifest with its media type', async () => {
      dir = mkdtempSync(path.join(tmpdir(), 'gatepass-client-'));
      writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>x</title>');
      writeFileSync(path.join(dir, 'sw.js'), readFileSync(path.join(root, 'sw.js')));
      writeFileSync(path.join(dir, 'manifest.webmanifest'), JSON.stringify(manifest));
      const h = createHarness();
      try {
        const app = createApp({ service: h.service, adminToken: ADMIN_TOKEN, publicUrl: PUBLIC_URL, clientDir: dir });
        const sw = await request(app).get('/sw.js').expect(200);
        expect(sw.headers['cache-control']).toBe('no-cache');
        expect(sw.headers['content-type']).toMatch(/javascript/);
        // Same-origin worker scripts and manifests are allowed by the CSP (default-src 'self').
        expect(sw.headers['content-security-policy']).toContain("default-src 'self'");
        const served = await request(app).get('/manifest.webmanifest').expect(200);
        expect(served.headers['cache-control']).toBe('no-cache');
        expect(served.headers['content-type']).toMatch(/^application\/manifest\+json/);
        expect((await request(app).get('/scan').expect(200)).text).toContain('<title>x</title>');
      } finally {
        h.close();
      }
    });
  });
});
