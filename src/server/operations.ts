import type { EventSummary, OperationsAlert, OperationsSummary, StoredScanOutcome } from '../shared/types';
import type { Database } from './db';
import type { AccessControl } from './policies';

/** Thresholds for suspicious-pattern alerts. Deliberately simple and explainable. */
export const ALERT_RULES = {
  /** A pass rejected as already used this many times suggests a shared screenshot. */
  repeatedDuplicates: 2,
  /** Invalid codes from one device within the window suggest probing or a broken printout. */
  invalidBurst: { count: 5, windowMinutes: 10 },
  /** Capacity usage ratio that raises a warning. */
  capacityNear: 0.9
} as const;

const BUCKET_SQL = `strftime('%Y-%m-%dT%H:', created_at) || printf('%02d', (CAST(strftime('%M', created_at) AS INTEGER) / 15) * 15) || ':00.000Z'`;

type Row = Record<string, unknown>;

/** Read-only aggregates for the operations dashboard; all queries use the scans/redemptions indexes. */
export function operationsSummary(db: Database, access: AccessControl, event: EventSummary, now: Date): OperationsSummary {
  const nowIso = now.toISOString();
  const outcomes: Partial<Record<StoredScanOutcome, number>> = {};
  for (const row of db.prepare('SELECT outcome, COUNT(*) AS n FROM scans WHERE event_id = ? GROUP BY outcome').all(event.id) as Row[]) {
    outcomes[row.outcome as StoredScanOutcome] = Number(row.n);
  }
  const scans = Object.values(outcomes).reduce((sum, n) => sum + (n ?? 0), 0);
  const admitted = outcomes.admitted ?? 0;

  const gateRows = db
    .prepare(
      `SELECT s.gate_id, SUM(s.outcome = 'admitted') AS admitted, SUM(s.outcome <> 'admitted') AS denied, MAX(s.created_at) AS last_at
       FROM scans s WHERE s.event_id = ? GROUP BY s.gate_id`
    )
    .all(event.id) as Row[];
  const byGate = new Map(gateRows.map((row) => [(row.gate_id as string | null) ?? null, row]));
  const gates: OperationsSummary['gates'] = access.listGates(event.id).map((gate) => {
    const row = byGate.get(gate.id);
    return { id: gate.id, name: gate.name, admitted: Number(row?.admitted ?? 0), denied: Number(row?.denied ?? 0), lastScanAt: (row?.last_at as string) ?? null };
  });
  const ungated = byGate.get(null);
  if (ungated) gates.push({ id: null, name: 'Any gate', admitted: Number(ungated.admitted), denied: Number(ungated.denied), lastScanAt: ungated.last_at as string });

  const policies: OperationsSummary['policies'] = access.listPolicies(event.id).map((policy) => {
    const opensAt = policy.opensAt ?? event.startsAt;
    const closesAt = policy.closesAt ?? event.endsAt;
    const full = policy.capacity !== null && policy.admittedCount >= policy.capacity;
    const state = nowIso < opensAt ? 'upcoming' : nowIso >= closesAt ? 'closed' : full ? 'full' : 'open';
    return { id: policy.id, name: policy.name, capacity: policy.capacity, admitted: policy.admittedCount, opensAt, closesAt, state };
  });

  const timeline = (
    db
      .prepare(
        `SELECT ${BUCKET_SQL} AS bucket, SUM(outcome = 'admitted') AS admitted, SUM(outcome <> 'admitted') AS denied
         FROM scans WHERE event_id = ? GROUP BY bucket ORDER BY bucket DESC LIMIT 96`
      )
      .all(event.id) as Row[]
  )
    .reverse()
    .map((row) => ({ bucketStart: row.bucket as string, admitted: Number(row.admitted), denied: Number(row.denied) }));

  return {
    generatedAt: nowIso,
    totals: { scans, admitted, denied: scans - admitted },
    outcomes,
    gates,
    policies,
    timeline,
    alerts: alerts(db, event.id, policies, now)
  };
}

function alerts(db: Database, eventId: string, policies: OperationsSummary['policies'], now: Date): OperationsAlert[] {
  const result: OperationsAlert[] = [];

  for (const row of db
    .prepare(
      `SELECT s.pass_id, p.attendee_name, COUNT(*) AS n, MAX(s.created_at) AS last_at
       FROM scans s JOIN passes p ON p.id = s.pass_id
       WHERE s.event_id = ? AND s.outcome = 'already_redeemed'
       GROUP BY s.pass_id HAVING n >= ? ORDER BY n DESC LIMIT 20`
    )
    .all(eventId, ALERT_RULES.repeatedDuplicates) as Row[]) {
    const who = (row.attendee_name as string | null) ?? `pass ${(row.pass_id as string).slice(0, 8)}`;
    result.push({
      kind: 'repeated_duplicate',
      severity: 'warning',
      message: `${who}: presented ${row.n} more times after entry (possible shared screenshot)`,
      count: Number(row.n),
      lastAt: row.last_at as string,
      passId: row.pass_id as string
    });
  }

  for (const row of db
    .prepare(
      `SELECT s.pass_id, p.attendee_name, COUNT(DISTINCT s.gate_id) AS gates, COUNT(*) AS n, MAX(s.created_at) AS last_at
       FROM scans s JOIN passes p ON p.id = s.pass_id
       WHERE s.event_id = ? AND s.gate_id IS NOT NULL
       GROUP BY s.pass_id HAVING gates >= 2 ORDER BY last_at DESC LIMIT 20`
    )
    .all(eventId) as Row[]) {
    const who = (row.attendee_name as string | null) ?? `pass ${(row.pass_id as string).slice(0, 8)}`;
    result.push({
      kind: 'multi_gate',
      severity: 'info',
      message: `${who}: scanned at ${row.gates} different gates`,
      count: Number(row.gates),
      lastAt: row.last_at as string,
      passId: row.pass_id as string
    });
  }

  const since = new Date(now.getTime() - ALERT_RULES.invalidBurst.windowMinutes * 60_000).toISOString();
  for (const row of db
    .prepare(
      `SELECT s.scanner_id, sc.label, COUNT(*) AS n, MAX(s.created_at) AS last_at
       FROM scans s JOIN scanners sc ON sc.id = s.scanner_id
       WHERE s.event_id = ? AND s.outcome IN ('invalid', 'wrong_event') AND s.created_at >= ?
       GROUP BY s.scanner_id HAVING n >= ? ORDER BY n DESC`
    )
    .all(eventId, since, ALERT_RULES.invalidBurst.count) as Row[]) {
    result.push({
      kind: 'invalid_burst',
      severity: 'warning',
      message: `${row.label}: ${row.n} invalid codes in the last ${ALERT_RULES.invalidBurst.windowMinutes} minutes`,
      count: Number(row.n),
      lastAt: row.last_at as string,
      scannerId: row.scanner_id as string
    });
  }

  for (const policy of policies) {
    if (policy.capacity === null || policy.admitted < policy.capacity * ALERT_RULES.capacityNear) continue;
    result.push({
      kind: 'capacity_near',
      severity: policy.admitted >= policy.capacity ? 'warning' : 'info',
      message: `${policy.name}: ${policy.admitted} of ${policy.capacity} admitted`,
      count: policy.admitted,
      lastAt: now.toISOString(),
      policyId: policy.id
    });
  }
  return result;
}
