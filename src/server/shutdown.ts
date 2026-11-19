import type { Server } from 'node:http';
import type { Database } from './db';

export interface ShutdownTargets {
  server: Pick<Server, 'close' | 'closeIdleConnections' | 'closeAllConnections'>;
  /** Stops background senders; resolves once the work they have in flight is recorded. */
  stopWorkers: () => Promise<void>;
  /** Cancels provider requests still in flight; they are recorded as interrupted and retried after the restart. */
  abortWorkers: () => void;
  /** Work requests started after their response (Accounts.runInBackground). */
  idle: () => Promise<void>;
  db: Database;
  exit: (code: number) => void;
  log?: (entry: Record<string, unknown>) => void;
}

export interface ShutdownTimings {
  /** Keep-alive and slow connections are cut after this. */
  closeConnectionsMs: number;
  /** Provider requests still running are cancelled after this, leaving time to record them. */
  abortSendsMs: number;
  /** Hard stop: the database is closed and the process exits 1 whatever is still running. */
  deadlineMs: number;
}

/** Inside the 10 s a container runtime (docker stop) waits before SIGKILL. */
export const SHUTDOWN_TIMINGS: ShutdownTimings = { closeConnectionsMs: 5_000, abortSendsMs: 7_000, deadlineMs: 10_000 };

/**
 * Stops accepting connections and lets in-flight requests finish (each redeem
 * is one synchronous transaction, so none is ever half-applied); stops the
 * pass email worker and lets the email in flight be answered and recorded;
 * waits for emails requests started after responding; then closes the
 * database, which checkpoints the WAL, and exits 0. Idle keep-alive sockets
 * from a proxy would otherwise hold `server.close()` open, so they are closed
 * at once and every connection after `closeConnectionsMs`. Exits 1 at
 * `deadlineMs` with whatever is still running abandoned: committed writes are
 * durable (synchronous=FULL) and an email left `sending` is queued again with
 * the same idempotency key on the next start.
 */
export async function gracefulShutdown(targets: ShutdownTargets, timings: ShutdownTimings = SHUTDOWN_TIMINGS): Promise<void> {
  const log = targets.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const { promise: closed, resolve: serverClosed } = Promise.withResolvers<void>();
  targets.server.close(() => serverClosed());
  targets.server.closeIdleConnections();
  // Not unref'd: the deadline must fire even if nothing else keeps the process alive.
  const { promise: deadline, resolve: expire } = Promise.withResolvers<'deadline'>();
  const timers = [
    setTimeout(() => targets.server.closeAllConnections(), timings.closeConnectionsMs),
    setTimeout(() => targets.abortWorkers(), timings.abortSendsMs),
    setTimeout(() => expire('deadline'), timings.deadlineMs)
  ];
  const drained = Promise.all([closed, targets.stopWorkers()])
    .then(() => targets.idle())
    .then(
      () => 'drained' as const,
      (error: unknown) => {
        log({ level: 'error', msg: 'shutdown drain failed', error: error instanceof Error ? error.message : String(error) });
        return 'failed' as const;
      }
    );
  const outcome = await Promise.race([drained, deadline]);
  for (const timer of timers) clearTimeout(timer);
  if (outcome === 'deadline') log({ level: 'error', msg: 'shutdown deadline reached; stopping with work still running', deadlineMs: timings.deadlineMs });
  if (targets.db.isOpen) targets.db.close();
  const code = outcome === 'drained' ? 0 : 1;
  log({ level: 'info', msg: 'stopped', code });
  targets.exit(code);
}
