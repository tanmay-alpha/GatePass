export type OutputFormat = 'png' | 'svg' | 'pdf' | 'eps';

export interface DesignConfig {
  body: string;
  eye: string;
  eyeBall: string;
  erf1: string[];
  erf2: string[];
  erf3: string[];
  brf1: string[];
  brf2: string[];
  brf3: string[];
  bodyColor: string;
  bgColor: string;
  eye1Color: string;
  eye2Color: string;
  eye3Color: string;
  eyeBall1Color: string;
  eyeBall2Color: string;
  eyeBall3Color: string;
  gradientColor1: string | null;
  gradientColor2: string | null;
  gradientType: 'linear' | 'radial';
  gradientOnEyes: boolean;
  logo: string | null;
  logoMode: 'default' | 'clean';
}

export type EventStatus = 'active' | 'archived';

export interface EventSummary {
  id: string;
  name: string;
  venue: string | null;
  startsAt: string;
  endsAt: string;
  status: EventStatus;
  design: DesignConfig;
  createdAt: string;
  updatedAt: string;
  passCount: number;
  attendeeCount: number;
  redeemedCount: number;
  revokedCount: number;
  /** Setup progress, for the guided checklist. */
  gateCount: number;
  policyCount: number;
  /** Scanner devices that are not revoked. */
  scannerCount: number;
  scanCount: number;
}

/** Derived at read time: a pass is never stored as "expired". */
export type PassStatus = 'active' | 'redeemed' | 'revoked' | 'expired';

export interface Pass {
  id: string;
  eventId: string;
  /** Admission policy; null = default (any gate, event window, no capacity limit). */
  policyId: string | null;
  attendeeName: string | null;
  attendeeEmail: string | null;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  redeemedAt: string | null;
  redeemedBy: string | null;
  status: PassStatus;
}

/** Returned once, at issuance or reissue. The token is never retrievable again. */
export interface IssuedPass extends Pass {
  token: string;
  passUrl: string;
}

export interface Gate {
  id: string;
  eventId: string;
  name: string;
  createdAt: string;
  admittedCount: number;
}

/**
 * Who may enter, where and when. A pass with a policy is admitted only through
 * the policy's gates (any gate when `gateIds` is empty), inside its window, and
 * while `admittedCount < capacity`.
 */
export interface AdmissionPolicy {
  id: string;
  eventId: string;
  name: string;
  /** null = event start. */
  opensAt: string | null;
  /** null = event end. */
  closesAt: string | null;
  /** null = unlimited. */
  capacity: number | null;
  admittedCount: number;
  gateIds: string[];
  passCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Scanner {
  id: string;
  eventId: string;
  label: string;
  /** null = may scan at any gate (also the state of scanners created before gates existed). */
  gateId: string | null;
  gateName: string | null;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export type ScanOutcome =
  | 'admitted'
  | 'already_redeemed'
  | 'expired'
  | 'revoked'
  | 'invalid'
  | 'event_closed'
  | 'too_early'
  | 'too_late'
  | 'wrong_gate'
  | 'capacity_full';

/** Stored outcome; `wrong_event` is reported to scanners as `invalid` to avoid cross-event disclosure. */
export type StoredScanOutcome = ScanOutcome | 'wrong_event';

export interface ScanResult {
  outcome: ScanOutcome;
  scanId: number;
  checkedAt: string;
  pass?: {
    id: string;
    attendeeName: string | null;
    redeemedAt: string | null;
  };
  /** Safe, staff-facing reason details for policy denials. Never present for `invalid`. */
  detail?: {
    policyName?: string;
    opensAt?: string;
    closesAt?: string;
    allowedGates?: string[];
    capacity?: number;
  };
}

export interface ScanRecord {
  id: number;
  eventId: string;
  scannerId: string;
  scannerLabel: string;
  gateId: string | null;
  gateName: string | null;
  passId: string | null;
  attendeeName: string | null;
  outcome: StoredScanOutcome;
  createdAt: string;
}

export interface AuditEntry {
  id: number;
  eventId: string | null;
  actor: string;
  action: string;
  entityId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ScannerSession {
  scanner: { id: string; label: string };
  gate: { id: string; name: string } | null;
  event: { id: string; name: string; venue: string | null; startsAt: string; endsAt: string; status: EventStatus };
}

export type AlertKind = 'repeated_duplicate' | 'multi_gate' | 'invalid_burst' | 'capacity_near';

export interface OperationsAlert {
  kind: AlertKind;
  severity: 'info' | 'warning';
  /** Plain-language summary for the dashboard. */
  message: string;
  count: number;
  lastAt: string;
  passId?: string;
  scannerId?: string;
  policyId?: string;
}

/** GET /api/events/:eventId/operations */
export interface OperationsSummary {
  generatedAt: string;
  totals: { scans: number; admitted: number; denied: number };
  outcomes: Partial<Record<StoredScanOutcome, number>>;
  /** `id: null` groups scans from scanners not bound to a gate. */
  gates: Array<{ id: string | null; name: string; admitted: number; denied: number; lastScanAt: string | null }>;
  policies: Array<{
    id: string;
    name: string;
    capacity: number | null;
    admitted: number;
    opensAt: string;
    closesAt: string;
    state: 'upcoming' | 'open' | 'full' | 'closed';
  }>;
  /** 15-minute buckets covering the event's scans, oldest first, at most 96. */
  timeline: Array<{ bucketStart: string; admitted: number; denied: number }>;
  alerts: OperationsAlert[];
}
