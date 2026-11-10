import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './app';
import { loadConfig, trustProxySetting } from './config';
import { backupDatabase, openDatabase } from './db';
import { GatePass } from './gatepass';
import { restoreDatabase, verifyDatabase } from './integrity';

// Maintenance commands. Run `restore` only while the server is stopped.
// `backup` and `verify` never migrate the file they read: verifying an old
// `.pre-vN.bak` must not turn it into a newer schema.
//   node dist/server/index.js backup <file>    consistent, integrity-checked copy of the live database
//   node dist/server/index.js verify [file]    integrity, foreign keys and admission invariants (read-only)
//   node dist/server/index.js restore <backup> replace DATABASE_FILE with a verified backup (old files kept)
const command = process.argv[2];
if (command === 'backup' || command === 'verify' || command === 'restore') {
  const databaseFile = process.env.DATABASE_FILE || '.local/data/gatepass.db';
  const argument = process.argv[3];
  try {
    if (command === 'backup') {
      if (!argument) throw new Error('Usage: backup <destination-file>');
      if (!existsSync(databaseFile)) throw new Error(`Database not found: ${databaseFile}`);
      const db = new DatabaseSync(databaseFile);
      try {
        db.exec('PRAGMA busy_timeout = 5000');
        backupDatabase(db, argument);
      } finally {
        db.close();
      }
      console.log(`Backup written and verified: ${argument}`);
    } else if (command === 'verify') {
      const file = argument ?? databaseFile;
      if (!existsSync(file)) throw new Error(`Database not found: ${file}`);
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const report = verifyDatabase(db);
        console.log(JSON.stringify(report, null, 2));
        process.exitCode = report.ok ? 0 : 1;
      } finally {
        db.close();
      }
    } else {
      if (!argument) throw new Error('Usage: restore <backup-file> (with the server stopped)');
      const report = restoreDatabase(argument, databaseFile);
      console.log(`Restored ${argument} into ${databaseFile}; previous files kept with a .replaced-<time> suffix.`);
      console.log(JSON.stringify(report, null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
} else {
  start();
}

function start(): void {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }

  if (process.env.NODE_ENV === 'production' && !config.APP_PUBLIC_URL.startsWith('https://')) {
    console.warn(`Warning: APP_PUBLIC_URL (${config.APP_PUBLIC_URL}) is not HTTPS. Pass links will travel in clear text and phone cameras cannot scan from /scan.`);
  }

  const db = openDatabase(config.DATABASE_FILE);
  const service = new GatePass(db, { publicUrl: config.APP_PUBLIC_URL });
  const app = createApp({
    service,
    adminToken: config.ADMIN_TOKEN,
    publicUrl: config.APP_PUBLIC_URL,
    allowSignup: config.ALLOW_SIGNUP,
    trustProxy: trustProxySetting(config.TRUST_PROXY),
    clientDir: config.CLIENT_DIR,
    originSecret: config.ORIGIN_SECRET,
    clientIpHeader: config.CLIENT_IP_HEADER,
    demoMode: config.DEMO_MODE
  });

  const tls = config.HTTPS_CERT_FILE && config.HTTPS_KEY_FILE ? { cert: readFileSync(config.HTTPS_CERT_FILE), key: readFileSync(config.HTTPS_KEY_FILE) } : null;
  const server = tls ? https.createServer(tls, app) : http.createServer(app);

  server.listen(config.PORT, config.HOST, () => {
    console.log(`GatePass listening on ${tls ? 'https' : 'http'}://${config.HOST}:${config.PORT} (public URL ${config.APP_PUBLIC_URL})`);
  });

  // Stop accepting connections, let in-flight requests finish (each redeem is
  // one synchronous transaction, so none is ever half-applied), then close the
  // database, which checkpoints the WAL. Idle keep-alive sockets from a proxy
  // would otherwise hold server.close() open until the hard deadline.
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, shutting down`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 5_000).unref();
    setTimeout(() => {
      if (db.isOpen) db.close();
      process.exit(1);
    }, 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
