// Runs in a separate thread with its own SQLite connection, then redeems the
// same code as its siblings once the main thread releases the barrier.
// Reports invocation and response instants on the shared process clock
// (performance.timeOrigin + performance.now()) for history checks.
import { parentPort, workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

register();
const { openDatabase } = await import('../../src/server/db.ts');
const { GatePass } = await import('../../src/server/gatepass.ts');

const db = openDatabase(workerData.dbFile);
const service = new GatePass(db, { publicUrl: 'https://gate.example' });
const barrier = new Int32Array(workerData.barrier);
const clock = () => performance.timeOrigin + performance.now();

parentPort.postMessage({ ready: true });
Atomics.wait(barrier, 0, 0);

// Close the connection before reporting, so once the main thread has every
// result no worker still holds the database, -wal or -shm file open (on
// Windows an open handle makes the harness's temp-directory cleanup fail).
let result;
const invokedAt = clock();
try {
  if (workerData.holdLockMs) {
    // Adversarial delay: take the write lock and sit on it, as a slow
    // transaction would, while the other workers try to redeem.
    db.exec('BEGIN IMMEDIATE');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdLockMs);
    db.exec('COMMIT');
    result = { outcome: 'held_lock', invokedAt, respondedAt: clock() };
  } else if (workerData.revokePassId) {
    // Organizer revoking the pass while scanners redeem it.
    try {
      service.revokePass(workerData.revokePassId, 'test');
      result = { outcome: 'revoke_applied', invokedAt, respondedAt: clock() };
    } catch (error) {
      if (error?.status !== 409) throw error;
      result = { outcome: 'revoke_refused', invokedAt, respondedAt: clock() };
    }
  } else {
    const outcome = service.redeem(workerData.scanner, workerData.code, workerData.requestId).outcome;
    result = { outcome, invokedAt, respondedAt: clock() };
  }
} catch (error) {
  // Lock wait beyond busy_timeout: the server answers 503 and the door shows
  // "not verified" — a fail-closed outcome, recorded so tests can count it.
  result = /database is locked/.test(String(error)) ? { outcome: 'busy', invokedAt, respondedAt: clock() } : { error: String(error), invokedAt, respondedAt: clock() };
} finally {
  db.close();
}
parentPort.postMessage(result);
