import type { EventSummary, OperationsAlert, OperationsCompletion, OperationsSummary, StoredScanOutcome } from '../shared/types';
import type { Database } from './db';
import type { AccessControl } from './policies';

/** Thresholds for suspicious-pattern alerts. Deliberately simple and explainable. */
export const ALERT_RULES = {
  /** A pass rejected as already used this many times suggests a shared screenshot. */
  repeatedDuplicates: 2,
  /** Repeated duplicates and passes seen at several gates are reported for scans in this window. */
  patternWindowMinutes: 60,
  /** Invalid codes from one device within the window suggest probing or a broken printout. */
  invalidBurst: { count: 5, windowMinutes: 10 },
  /** Capacity usage ratio that raises a warning. */
  capacityNear: 0.9
} as const;

/** How long a computed summary is served again: dashboards poll every 5 s, so ≤2 s old data is still fresh. */
export const OPERATIONS_MEMO_MS = 2_000;

/**
 * Per-event memo of the dashboard summary. Several dashboards polling one
 * busy event would otherwise each rerun every aggregate while the door is
 * redeeming. Scans never invalidate it (that is the load it absorbs: admissions
 * show within `OPERATIONS_MEMO_MS`), but every admin write to the event does,
 * because each one writes an audit row: the newest audit id for the event is
 * one seek on `audit_event_idx`. `generatedAt` stays the time the summary was
 * computed, so the client's stale indicator remains truthful.
 */
export class OperationsMemo {
  private readonly entries = new Map<string, { at: number; auditId: number; summary: OperationsSummary }>();

  constructor(
    private readonly db: Database,
    private readonly ttlMs = OPERATIONS_MEMO_MS
  ) {}

  get(eventId: string, now: Date, compute: () => OperationsSummary): OperationsSummary {
    const auditId = Number((this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM audit_log WHERE event_id = ?').get(eventId) as Row).id);
    const at = now.getTime();
    const cached = this.entries.get(eventId);
    if (cached && cached.auditId === auditId && at >= cached.at && at - cached.at < this.ttlMs) return cached.summary;
    const summary = compute();
    for (const [id, entry] of this.entries) if (at - entry.at >= this.ttlMs) this.entries.delete(id);
    this.entries.set(eventId, { at, auditId, summary });
    return summary;
  }
}

const BUCKET_SQL = `strftime('%Y-%m-%dT%H:', created_at) || printf('%02d', (CAST(strftime('%M', created_at) AS INTEGER) / 15) * 15) || ':00.000Z'`;

/** Recent-activity resolution: the last hour in 5-minute buckets. */
const RECENT_BUCKET_MINUTES = 5;
const RECENT_BUCKETS = 12;
const RECENT_BUCKET_SQL = `(CAST(strftime('%s', created_at) AS INTEGER) / ${RECENT_BUCKET_MINUTES * 60}) * ${RECENT_BUCKET_MINUTES * 60}`;
/**
 * Every stored outcome. Naming them all lets a time-bounded query seek
 * `scans_alerts_idx (event_id, outcome, created_at)` once per outcome instead
 * of reading every scan of the event.
 */
const ALL_OUTCOMES: readonly StoredScanOutcome[] = [
  'admitted',
  'already_redeemed',
  'expired',
  'revoked',
  'invalid',
  'event_closed',
  'wrong_event',
  'too_early',
  'too_late',
  'wrong_gate',
  'capacity_full'
];
const ALL_OUTCOMES_SQL = ALL_OUTCOMES.map((outcome) => `'${outcome}'`).join(', ');

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

  const passRow = db
    .prepare(
      `SELECT COUNT(*) AS issued,
              COALESCE(SUM(r.pass_id IS NOT NULL), 0) AS redeemed,
              COALESCE(SUM(r.pass_id IS NULL AND p.revoked_at IS NOT NULL), 0) AS revoked,
              COALESCE(SUM(r.pass_id IS NULL AND p.revoked_at IS NULL AND p.expires_at <= ?), 0) AS expired
       FROM passes p LEFT JOIN redemptions r ON r.pass_id = p.id WHERE p.event_id = ?`
    )
    .get(nowIso, event.id) as Row;
  const issued = Number(passRow.issued);
  const redeemed = Number(passRow.redeemed);
  const revoked = Number(passRow.revoked);
  const expired = Number(passRow.expired);

  const recentSince = new Date(now.getTime() - 15 * 60_000).toISOString();
  const idleSince = new Date(now.getTime() - SCANNER_IDLE_MINUTES * 60_000).toISOString();
  const scanners: OperationsSummary['scanners'] = (
    db
      .prepare(
        `SELECT sc.id, sc.label, g.name AS gate_name, sc.revoked_at,
                MAX(COALESCE(sc.last_used_at, ''), COALESCE(sc.last_seen_at, '')) AS last_activity,
                (SELECT COUNT(*) FROM scans s WHERE s.scanner_id = sc.id AND s.created_at >= ?) AS recent
         FROM scanners sc LEFT JOIN gates g ON g.id = sc.gate_id
         WHERE sc.event_id = ? ORDER BY sc.revoked_at IS NOT NULL, sc.label`
      )
      .all(recentSince, event.id) as Row[]
  ).map((row) => {
    const lastUsedAt = (row.last_activity as string) || null;
    const revokedScanner = row.revoked_at !== null;
    const state = revokedScanner ? 'revoked' : !lastUsedAt ? 'never_used' : lastUsedAt >= idleSince ? 'recent' : 'idle';
    return { id: row.id as string, label: row.label as string, gateName: (row.gate_name as string | null) ?? null, lastUsedAt, revoked: revokedScanner, scansLast15m: Number(row.recent), state };
  });

  // Doors can open before the event starts (early-entry policies) and stay open after it.
  const doorsOpen = policies.reduce((earliest, policy) => (policy.opensAt < earliest ? policy.opensAt : earliest), event.startsAt);
  const doorsClose = policies.reduce((latest, policy) => (policy.closesAt > latest ? policy.closesAt : latest), event.endsAt);
  const phase: OperationsSummary['phase'] =
    event.status === 'ended' || event.status === 'archived' || nowIso >= doorsClose ? 'finished' : nowIso < doorsOpen ? 'upcoming' : event.status === 'active' ? 'live' : 'paused';
  const expected = issued - revoked;
  const attendance = { expected, admitted: redeemed, rate: expected ? redeemed / expected : null };

  return {
    generatedAt: nowIso,
    totals: { scans, admitted, denied: scans - admitted },
    outcomes,
    passes: { issued, active: issued - redeemed - revoked - expired, redeemed, revoked, expired },
    capacity: { limit: event.capacity, admitted: event.admittedCount, remaining: event.capacity === null ? null : event.capacity - event.admittedCount },
    gates,
    policies,
    scanners,
    timeline,
    alerts: alerts(db, event.id, policies, phase === 'live' ? scanners : [], now),
    phase,
    attendance,
    recent: recentActivity(db, event.id, now),
    // Seeks the admitted scans through scans_alerts_idx, then filters on method.
    assistedAdmissions: Number(
      (db.prepare("SELECT COUNT(*) AS n FROM scans WHERE event_id = ? AND outcome = 'admitted' AND method = 'lookup'").get(event.id) as Row).n
    ),
    completion: phase === 'finished' ? completion(db, event.id, attendance, outcomes, gates) : null
  };
}

/** A device with no scan or heartbeat for this long is shown as idle. */
export const SCANNER_IDLE_MINUTES = 10;

/** The last hour in clock-aligned 5-minute buckets, zero-filled so the chart has a fixed width. */
function recentActivity(db: Database, eventId: string, now: Date): OperationsSummary['recent'] {
  const size = RECENT_BUCKET_MINUTES * 60_000;
  const first = Math.floor(now.getTime() / size) * size - (RECENT_BUCKETS - 1) * size;
  const rows = db
    .prepare(
      `SELECT ${RECENT_BUCKET_SQL} AS bucket, SUM(outcome = 'admitted') AS admitted, SUM(outcome <> 'admitted') AS denied
       FROM scans WHERE event_id = ? AND outcome IN (${ALL_OUTCOMES_SQL}) AND created_at >= ? GROUP BY bucket`
    )
    .all(eventId, new Date(first).toISOString()) as Row[];
  const byBucket = new Map(rows.map((row) => [Number(row.bucket) * 1000, row]));
  const buckets = Array.from({ length: RECENT_BUCKETS }, (_, index) => {
    const start = first + index * size;
    const row = byBucket.get(start);
    return { bucketStart: new Date(start).toISOString(), admitted: Number(row?.admitted ?? 0), denied: Number(row?.denied ?? 0) };
  });
  return { bucketMinutes: RECENT_BUCKET_MINUTES, buckets };
}

function completion(
  db: Database,
  eventId: string,
  attendance: OperationsSummary['attendance'],
  outcomes: OperationsSummary['outcomes'],
  gates: OperationsSummary['gates']
): OperationsCompletion {
  const span = db.prepare("SELECT MIN(created_at) AS first_at, MAX(created_at) AS last_at FROM scans WHERE event_id = ? AND outcome = 'admitted'").get(eventId) as Row;
  const peak = db
    .prepare(`SELECT ${RECENT_BUCKET_SQL} AS bucket, COUNT(*) AS n FROM scans WHERE event_id = ? AND outcome = 'admitted' GROUP BY bucket ORDER BY n DESC, bucket LIMIT 1`)
    .get(eventId) as Row | undefined;
  const devices = db
    .prepare('SELECT COUNT(*) AS n FROM scanners sc WHERE sc.event_id = ? AND EXISTS (SELECT 1 FROM scans s WHERE s.scanner_id = sc.id)')
    .get(eventId) as Row;
  const denials = (Object.entries(outcomes) as Array<[StoredScanOutcome, number]>).filter(([outcome]) => outcome !== 'admitted').sort((a, b) => b[1] - a[1]);
  return {
    expected: attendance.expected,
    admitted: attendance.admitted,
    noShows: Math.max(0, attendance.expected - attendance.admitted),
    rate: attendance.rate,
    firstAdmissionAt: (span.first_at as string | null) ?? null,
    lastAdmissionAt: (span.last_at as string | null) ?? null,
    peak: peak ? { bucketStart: new Date(Number(peak.bucket) * 1000).toISOString(), admitted: Number(peak.n) } : null,
    denied: denials.reduce((sum, [, count]) => sum + count, 0),
    topDenial: denials.length ? { outcome: denials[0][0], count: denials[0][1] } : null,
    devicesUsed: Number(devices.n),
    gatesUsed: gates.filter((gate) => gate.id !== null && gate.admitted + gate.denied > 0).length
  };
}

/**
 * `liveScanners` is empty unless the doors are open: silence only matters then. Only devices that were in
 * contact and went quiet raise an alert; a device never set up is shown in the device list instead.
 */
function alerts(db: Database, eventId: string, policies: OperationsSummary['policies'], liveScanners: OperationsSummary['scanners'], now: Date): OperationsAlert[] {
  const result: OperationsAlert[] = [];
  // Bounded by time so the cost follows recent traffic, not the event's whole scan history.
  const patternSince = new Date(now.getTime() - ALERT_RULES.patternWindowMinutes * 60_000).toISOString();
  const patternWindow = `in the last ${ALERT_RULES.patternWindowMinutes} minutes`;

  for (const scanner of liveScanners) {
    if (scanner.state !== 'idle' || !scanner.lastUsedAt) continue;
    const minutes = Math.floor((now.getTime() - Date.parse(scanner.lastUsedAt)) / 60_000);
    result.push({
      kind: 'device_idle',
      severity: 'warning',
      message: `${scanner.label}: no contact for ${minutes} min while the doors are open. Check the phone's connection and that the scanner page is open.`,
      count: minutes,
      lastAt: scanner.lastUsedAt,
      scannerId: scanner.id
    });
  }

  // Group the windowed scans first and look up names only for the (few) passes that form a pattern.
  for (const row of db
    .prepare(
      `SELECT d.pass_id, p.attendee_name, d.n, d.last_at
       FROM (SELECT pass_id, COUNT(*) AS n, MAX(created_at) AS last_at FROM scans
             WHERE event_id = ? AND outcome = 'already_redeemed' AND created_at >= ? AND pass_id IS NOT NULL
             GROUP BY pass_id HAVING n >= ? ORDER BY n DESC LIMIT 20) d
       JOIN passes p ON p.id = d.pass_id ORDER BY d.n DESC`
    )
    .all(eventId, patternSince, ALERT_RULES.repeatedDuplicates) as Row[]) {
    const who = (row.attendee_name as string | null) ?? `pass ${(row.pass_id as string).slice(0, 8)}`;
    result.push({
      kind: 'repeated_duplicate',
      severity: 'warning',
      message: `${who}: presented ${row.n} more times after entry ${patternWindow} (possible shared screenshot)`,
      count: Number(row.n),
      lastAt: row.last_at as string,
      passId: row.pass_id as string
    });
  }

  // Naming every outcome lets the time bound seek scans_alerts_idx once per outcome.
  for (const row of db
    .prepare(
      `SELECT m.pass_id, p.attendee_name, m.gates, m.n, m.last_at
       FROM (SELECT pass_id, COUNT(DISTINCT gate_id) AS gates, COUNT(*) AS n, MAX(created_at) AS last_at FROM scans
             WHERE event_id = ? AND outcome IN (${ALL_OUTCOMES_SQL}) AND created_at >= ? AND gate_id IS NOT NULL AND pass_id IS NOT NULL
             GROUP BY pass_id HAVING gates >= 2 ORDER BY last_at DESC LIMIT 20) m
       JOIN passes p ON p.id = m.pass_id ORDER BY m.last_at DESC`
    )
    .all(eventId, patternSince) as Row[]) {
    const who = (row.attendee_name as string | null) ?? `pass ${(row.pass_id as string).slice(0, 8)}`;
    result.push({
      kind: 'multi_gate',
      severity: 'info',
      message: `${who}: scanned at ${row.gates} different gates ${patternWindow}`,
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
