import { Worker } from 'node:worker_threads';
import type { AuthenticatedScanner } from '../src/server/gatepass';

/**
 * Runs each redemption in its own worker thread with its own SQLite
 * connection, releasing all of them at the same instant so their
 * transactions genuinely contend for the write lock.
 */
export async function redeemInThreads(dbFile: string, jobs: Array<{ code: string; scanner: AuthenticatedScanner }>): Promise<string[]> {
  const barrier = new SharedArrayBuffer(4);
  const ready: Promise<void>[] = [];
  const results = jobs.map(({ code, scanner }) => {
    const worker = new Worker(new URL('./fixtures/redeem-worker.mjs', import.meta.url), { workerData: { dbFile, barrier, code, scanner } });
    const isReady = Promise.withResolvers<void>();
    const done = Promise.withResolvers<{ outcome?: string; error?: string }>();
    worker.on('message', (message: { ready?: boolean; outcome?: string; error?: string }) => (message.ready ? isReady.resolve() : done.resolve(message)));
    worker.once('error', (error) => {
      isReady.reject(error);
      done.reject(error);
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
  return outcomes.map((result) => result.outcome!);
}

export function count(values: string[], value: string): number {
  return values.filter((item) => item === value).length;
}
