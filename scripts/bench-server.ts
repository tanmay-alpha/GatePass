/**
 * Server half of `npm run bench` and `npm run load-test`, run in its own
 * process so the load generator does not share its event loop. It runs the
 * real Express app (`createApp`) over a file-backed database opened by the
 * production `openDatabase` (WAL, synchronous=FULL) in a fresh temp
 * directory. Rate limits are off through the documented `rateLimits: false`
 * app option; nothing else differs from production code.
 *
 * Ready message to the parent: `BenchServerReady` (port, database file,
 * database settings as read back from the server's own connection, host).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/app';
import { openDatabase, type Database } from '../src/server/db';
import { GatePass } from '../src/server/gatepass';

export interface DatabaseSettings {
  sqlite: string;
  journalMode: string;
  synchronous: string;
  busyTimeoutMs: number;
}

export interface HostInfo {
  os: string;
  cpu: string;
  logicalCores: number;
  memoryGiB: number;
  node: string;
  /** Disk holding the temp directory with the database; best effort, `unknown` when the OS cannot tell. */
  disk: string;
  tempDir: string;
}

export interface BenchServerReady {
  port: number;
  dbFile: string;
  database: DatabaseSettings;
  host: HostInfo;
}

const SYNCHRONOUS = ['OFF', 'NORMAL', 'FULL', 'EXTRA'];

export function databaseSettings(db: Database): DatabaseSettings {
  const get = (sql: string) => Object.values(db.prepare(sql).get() as Record<string, unknown>)[0];
  return {
    sqlite: String(get('SELECT sqlite_version()')),
    journalMode: String(get('PRAGMA journal_mode')),
    synchronous: SYNCHRONOUS[Number(get('PRAGMA synchronous'))] ?? 'unknown',
    busyTimeoutMs: Number(get('PRAGMA busy_timeout'))
  };
}

function diskOf(dir: string): string {
  try {
    if (process.platform === 'win32') {
      const letter = path.parse(path.resolve(dir)).root.charAt(0);
      const script =
        `$p = Get-Partition -DriveLetter ${letter}; $d = Get-Disk -Number $p.DiskNumber; ` +
        `$pd = Get-PhysicalDisk | Where-Object DeviceId -eq "$($d.Number)"; ` +
        `"$($d.FriendlyName) | bus $($d.BusType) | media $($pd.MediaType)"`;
      return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 20_000 }).trim() || 'unknown';
    }
    if (process.platform === 'linux') {
      const source = execFileSync('findmnt', ['-no', 'SOURCE', '--target', dir], { encoding: 'utf8', timeout: 10_000 }).trim();
      const [rota, ...model] = execFileSync('lsblk', ['-ndo', 'ROTA,MODEL', source], { encoding: 'utf8', timeout: 10_000 }).trim().split(/\s+/);
      return `${source} | ${model.join(' ') || 'unknown model'} | ${rota === '0' ? 'non-rotational' : 'rotational'}`;
    }
  } catch {
    // Fall through: not knowing the disk is not a reason to fail a benchmark.
  }
  return 'unknown';
}

export function hostInfo(dir: string): HostInfo {
  const cpus = os.cpus();
  return {
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: cpus[0]?.model.trim() ?? 'unknown',
    logicalCores: cpus.length,
    memoryGiB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    node: process.version,
    disk: diskOf(dir),
    tempDir: os.tmpdir()
  };
}

// Only start a server when forked by bench.ts / load-test.ts (an IPC channel exists).
if (process.send) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gatepass-bench-'));
  const dbFile = path.join(dir, 'bench.db');
  const db = openDatabase(dbFile);
  const service = new GatePass(db, { publicUrl: 'https://gate.example' });
  const server = createApp({ service, adminToken: process.env.BENCH_ADMIN_TOKEN!, rateLimits: false }).listen(0, '127.0.0.1', () => {
    const ready: BenchServerReady = { port: (server.address() as AddressInfo).port, dbFile, database: databaseSettings(db), host: hostInfo(dir) };
    process.send!(ready);
  });

  process.on('message', (message) => {
    if (message !== 'stop') return;
    server.closeAllConnections();
    server.close(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
      process.exit(0);
    });
  });
}
