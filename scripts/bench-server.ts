/** Server half of `npm run bench`, run in its own process so the load generator does not share its event loop. */
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/app';
import { openDatabase } from '../src/server/db';
import { GatePass } from '../src/server/gatepass';

const dir = mkdtempSync(path.join(os.tmpdir(), 'gatepass-bench-'));
const db = openDatabase(path.join(dir, 'bench.db'));
const service = new GatePass(db, { publicUrl: 'https://gate.example' });
const server = createApp({ service, adminToken: process.env.BENCH_ADMIN_TOKEN!, rateLimits: false }).listen(0, '127.0.0.1', () => {
  const sqlite = (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;
  process.send!({ port: (server.address() as AddressInfo).port, sqlite });
});

process.on('message', (message) => {
  if (message !== 'stop') return;
  server.close(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  });
});
