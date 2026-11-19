// Runs in a separate thread with its own SQLite connection and claims the
// same one-time scanner setup code as its siblings once the main thread
// releases the barrier (concurrent enrollment: exactly one may get a key).
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

// The connection is closed before reporting, so no file handle outlives the test (Windows cleanup).
let result;
try {
  const enrolled = service.enrollScanner(workerData.code, workerData.claim);
  result = enrolled ? { outcome: 'enrolled', key: enrolled.key, eventId: enrolled.session.event.id } : { outcome: 'refused' };
} catch (error) {
  result = /database is locked/.test(String(error)) ? { outcome: 'busy' } : { error: String(error) };
} finally {
  db.close();
}
parentPort.postMessage(result);
