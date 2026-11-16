import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = '3410';
// E2E_BASE_URL runs the same specs against an already deployed instance
// (which must allow self-registration: the specs sign up fresh organizer
// accounts); otherwise a local built server is started.
const deployed = process.env.E2E_BASE_URL;
const BASE_URL = deployed ?? `http://127.0.0.1:${PORT}`;

// Fresh database for every local run; the -wal/-shm files live in the same directory.
// Workers re-evaluate this file, so only the main runner process resets it.
const dataDir = path.resolve('.local/e2e');
if (!deployed && !process.env.TEST_WORKER_INDEX) {
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
}

/**
 * The local server trusts loopback as a reverse proxy (`TRUST_PROXY=loopback`, as behind Caddy), so
 * each project presents its own client address. Per-address limits (20 sign-ups a minute, among
 * others) stay switched on and are counted per project, as they are per CI job; without this a
 * local run of all projects shares one address and runs into them. A deployed instance ignores
 * the header: its CDN sets the client address.
 */
const from = (address: string) => ({ extraHTTPHeaders: { 'X-Forwarded-For': address } });

export default defineConfig({
  testDir: 'e2e',
  reporter: 'list',
  timeout: deployed ? 120_000 : 30_000,
  // A deployed instance adds network and cold-start latency (e.g. a free Render instance).
  expect: { timeout: deployed ? 20_000 : 5_000 },
  use: {
    baseURL: BASE_URL
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], ...from('10.64.0.1') } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], ...from('10.64.0.2') } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], ...from('10.64.0.3') } },
    // Phone-sized admin: the guided first-event flow must work at phone width.
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'], ...from('10.64.0.4') }, testMatch: /onboarding\.spec\.ts$/ }
  ],
  webServer: deployed
    ? undefined
    : {
        // Runs the built server; `npm run build` must run first.
        command: 'node --disable-warning=ExperimentalWarning dist/server/index.js',
        url: `${BASE_URL}/api/health`,
        reuseExistingServer: false,
        env: {
          ADMIN_TOKEN: 'e2e-admin-token-0123456789abcdef',
          ALLOW_SIGNUP: 'true',
          PORT,
          TRUST_PROXY: 'loopback',
          HOST: '127.0.0.1',
          APP_PUBLIC_URL: BASE_URL,
          DATABASE_FILE: path.join(dataDir, 'gatepass.db')
        }
      }
});
