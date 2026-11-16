/**
 * Saturation server for scripts/perf-phase7.ts. Bundled by that script with
 * the same `vite build --ssr` step as the production server
 * (`npm run build:server`) and run with plain `node`, not tsx.
 *
 * It mirrors `start()` in src/server/index.ts with exactly one difference:
 * `rateLimits: false` (the documented benchmark option of `createApp`). With
 * limits on, each scanner device is capped at 240 redeems/min, so a
 * throughput test would measure the limiter, not the server. Request logging
 * stays on (as in production) and goes to stdout.
 *
 * Env: ADMIN_TOKEN, DATABASE_FILE, PORT, APP_PUBLIC_URL, CLIENT_DIR.
 */
import http from 'node:http';
import { createApp } from '../src/server/app';
import { openDatabase } from '../src/server/db';
import { GatePass } from '../src/server/gatepass';
import { disabledMailer } from '../src/server/mailer';

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const publicUrl = env('APP_PUBLIC_URL');
const db = openDatabase(env('DATABASE_FILE'));
const service = new GatePass(db, { publicUrl, mailer: disabledMailer });
const app = createApp({ service, adminToken: env('ADMIN_TOKEN'), publicUrl, clientDir: env('CLIENT_DIR'), rateLimits: false, requestLog: true });
const server = http.createServer(app);
server.listen(Number(env('PORT')), '127.0.0.1', () => {
  console.log(JSON.stringify({ level: 'info', msg: 'listening', port: Number(env('PORT')), rateLimits: false }));
});

// Parent sends 'stop' over IPC (Windows has no catchable SIGTERM for child processes).
process.on('message', (message) => {
  if (message !== 'stop') return;
  server.closeAllConnections();
  server.close(() => {
    db.close();
    process.exit(0);
  });
});
