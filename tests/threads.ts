import { Worker } from 'node:worker_threads';
import type { AuthenticatedScanner } from '../src/server/gatepass';

export interface RedeemJob {
  code: string;
  scanner: AuthenticatedScanner;
  requestId?: string;
  /** Instead of redeeming, hold the write lock this long (adversarial delay). */
  holdLockMs?: number;
  /** Instead of redeeming, revoke this pass (organizer action racing the door). */
  revokePassId?: string;
}

/** One completed operation: outcome plus invocation/response instants on a shared clock. */
export interface HistoryEntry {
  job: number;
  outcome: string;
  invokedAt: number;
  respondedAt: number;
}

/**
 * Runs each job in its own worker thread with its own SQLite connection,
 * releasing all of them at the same instant so their transactions genuinely
 * contend for the write lock. Resolves only after every worker has exited,
 * so no thread still has the database files open when the caller removes them.
 */
export async function redeemHistory(dbFile: string, jobs: RedeemJob[]): Promise<HistoryEntry[]> {
  const barrier = new SharedArrayBuffer(4);
  const ready: Promise<void>[] = [];
  type Message = { ready?: boolean; outcome?: string; error?: string; invokedAt?: number; respondedAt?: number };
  const results = jobs.map((job) => {
    const worker = new Worker(new URL('./fixtures/redeem-worker.mjs', import.meta.url), { workerData: { dbFile, barrier, ...job } });
    const isReady = Promise.withResolvers<void>();
    const done = Promise.withResolvers<Message>();
    let result: Message | undefined;
    worker.on('message', (message: Message) => (message.ready ? isReady.resolve() : (result = message)));
    worker.once('error', (error) => {
      isReady.reject(error);
      done.reject(error);
    });
    worker.once('exit', (code) => {
      const error = new Error(`Redeem worker exited with code ${code} before reporting a result`);
      isReady.reject(error);
      if (result) done.resolve(result);
      else done.reject(error);
    });
    ready.push(isReady.promise);
    return done.promise;
  });
  await Promise.all(ready);
  const flags = new Int32Array(barrier);
  Atomics.store(flags, 0, 1);
  Atomics.notify(flags, 0);
  const outcomes = await Promise.all(results);
  const errors = outcomes.filter((result) => result.error);
  if (errors.length) throw new Error(`Worker errors: ${errors.map((result) => result.error).join('; ')}`);
  return outcomes.map((result, job) => ({ job, outcome: result.outcome!, invokedAt: result.invokedAt!, respondedAt: result.respondedAt! }));
}

export async function redeemInThreads(dbFile: string, jobs: RedeemJob[]): Promise<string[]> {
  return (await redeemHistory(dbFile, jobs)).map((entry) => entry.outcome);
}

export function count(values: string[], value: string): number {
  return values.filter((item) => item === value).length;
}

/**
 * Checks a concurrent history of redemptions of ONE pass against the
 * sequential specification "the first redemption admits, every later one is
 * already_redeemed", using the real-time order constraint from Herlihy & Wing
 * (1990): if operation A responded before operation B was invoked, A must
 * precede B in the linearization. A history is linearizable for this object
 * iff exactly one operation admitted and no `already_redeemed` operation
 * responded before the admitting operation was invoked (it would then have
 * to be ordered before the admission, where the pass was still unused).
 * Returns a list of violations (empty = linearizable).
 */
export function singlePassViolations(history: HistoryEntry[]): string[] {
  const admitted = history.filter((entry) => entry.outcome === 'admitted');
  if (admitted.length !== 1) return [`expected exactly one admission, got ${admitted.length}`];
  const [winner] = admitted;
  return history
    .filter((entry) => entry.outcome === 'already_redeemed' && entry.respondedAt < winner.invokedAt)
    .map((entry) => `job ${entry.job} answered already_redeemed at ${entry.respondedAt} before the admitting job ${winner.job} was invoked at ${winner.invokedAt}`)
    .concat(history.filter((entry) => !['admitted', 'already_redeemed', 'busy'].includes(entry.outcome)).map((entry) => `job ${entry.job}: unexpected ${entry.outcome}`));
}
