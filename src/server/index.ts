import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createApp } from './app';
import { loadConfig, trustProxySetting } from './config';
import { backupDatabase, openDatabase } from './db';
import { GatePass } from './gatepass';

// `node dist/server/index.js backup <file>`: consistent, integrity-checked copy of the live database.
if (process.argv[2] === 'backup') {
  const destination = process.argv[3];
  if (!destination) {
    console.error('Usage: backup <destination-file>');
    process.exit(2);
  }
  const db = openDatabase(process.env.DATABASE_FILE || '.local/data/gatepass.db', { backupBeforeMigrate: false });
  try {
    backupDatabase(db, destination);
    console.log(`Backup written and verified: ${destination}`);
  } finally {
    db.close();
  }
  process.exit(0);
}

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
  trustProxy: trustProxySetting(config.TRUST_PROXY),
  clientDir: config.CLIENT_DIR,
  originSecret: config.ORIGIN_SECRET,
  clientIpHeader: config.CLIENT_IP_HEADER
});

const tls = config.HTTPS_CERT_FILE && config.HTTPS_KEY_FILE
  ? { cert: readFileSync(config.HTTPS_CERT_FILE), key: readFileSync(config.HTTPS_KEY_FILE) }
  : null;
const server = tls ? https.createServer(tls, app) : http.createServer(app);

server.listen(config.PORT, config.HOST, () => {
  console.log(`GatePass listening on ${tls ? 'https' : 'http'}://${config.HOST}:${config.PORT} (public URL ${config.APP_PUBLIC_URL})`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
