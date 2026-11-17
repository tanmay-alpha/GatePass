import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './app';
import { buildCommit, loadConfig, trustProxySetting } from './config';
import { backupDatabase, openDatabase } from './db';
import { deliveryWorkerFor } from './deliveries';
import { GatePass } from './gatepass';
import { disabledMailer, resendMailer } from './mailer';
import { restoreDatabase, verifyDatabase } from './integrity';
import { gracefulShutdown } from './shutdown';

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
  const mailer =
    config.RESEND_API_KEY && config.MAIL_FROM ? resendMailer({ apiKey: config.RESEND_API_KEY, from: config.MAIL_FROM, url: config.RESEND_API_URL }) : disabledMailer;
  const service = new GatePass(db, {
    publicUrl: config.APP_PUBLIC_URL,
    mailer,
    passDeliveryKey: config.PASS_DELIVERY_KEY,
    passDeliveryPreviousKeys: config.PASS_DELIVERY_PREVIOUS_KEYS
  });
  const worker = deliveryWorkerFor(service.deliveries, mailer, { perSecond: config.PASS_EMAIL_PER_SECOND, maxAttempts: config.PASS_EMAIL_MAX_ATTEMPTS });
  if (mailer.enabled && !worker) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'pass emails disabled: set PASS_DELIVERY_KEY to let organizers email passes' }));
  }
  const commit = buildCommit(config);
  const app = createApp({
    service,
    adminToken: config.ADMIN_TOKEN,
    publicUrl: config.APP_PUBLIC_URL,
    allowSignup: config.ALLOW_SIGNUP,
    trustProxy: trustProxySetting(config.TRUST_PROXY),
    clientDir: config.CLIENT_DIR,
    originSecret: config.ORIGIN_SECRET,
    clientIpHeader: config.CLIENT_IP_HEADER,
    demoMode: config.DEMO_MODE,
    buildCommit: commit,
    requestLog: true
  });

  const tls = config.HTTPS_CERT_FILE && config.HTTPS_KEY_FILE ? { cert: readFileSync(config.HTTPS_CERT_FILE), key: readFileSync(config.HTTPS_KEY_FILE) } : null;
  const server = tls ? https.createServer(tls, app) : http.createServer(app);

  server.listen(config.PORT, config.HOST, () => {
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'listening',
        url: `${tls ? 'https' : 'http'}://${config.HOST}:${config.PORT}`,
        publicUrl: config.APP_PUBLIC_URL,
        commit,
        demo: config.DEMO_MODE,
        email: mailer.enabled,
        passEmail: worker !== null,
        database: config.DATABASE_FILE
      })
    );
    worker?.start();
  });

  // Bounded drain: requests, the pass email in flight and emails started
  // after a response finish and are recorded before the database closes
  // (src/server/shutdown.ts).
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ level: 'info', msg: 'shutting down', signal }));
    void gracefulShutdown({
      server,
      stopWorkers: () => worker?.stop() ?? Promise.resolve(),
      abortWorkers: () => worker?.abort(),
      idle: () => service.accounts.idle(),
      db,
      exit: (code) => process.exit(code)
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
