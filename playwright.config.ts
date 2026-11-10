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
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    // Phone-sized admin: the guided first-event flow must work at phone width.
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] }, testMatch: /onboarding\.spec\.ts$/ }
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
          HOST: '127.0.0.1',
          APP_PUBLIC_URL: BASE_URL,
          DATABASE_FILE: path.join(dataDir, 'gatepass.db')
        }
      }
});
