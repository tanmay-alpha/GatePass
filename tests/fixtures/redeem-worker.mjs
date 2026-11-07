// Runs in a separate thread with its own SQLite connection, then redeems the
// same code as its siblings once the main thread releases the barrier.
import { parentPort, workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

register();
const { openDatabase } = await import('../../src/server/db.ts');
const { GatePass } = await import('../../src/server/gatepass.ts');

const db = openDatabase(workerData.dbFile);
const service = new GatePass(db, { publicUrl: 'https://gate.example' });
const barrier = new Int32Array(workerData.barrier);

parentPort.postMessage({ ready: true });
Atomics.wait(barrier, 0, 0);

try {
  parentPort.postMessage({ outcome: service.redeem(workerData.scanner, workerData.code).outcome });
} catch (error) {
  parentPort.postMessage({ error: String(error) });
} finally {
  db.close();
}
