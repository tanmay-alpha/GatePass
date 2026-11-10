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

/**
 * draft: being set up, scanners refuse entry. active: doors open within the
 * event and policy windows. ended: closed early or after the event. archived:
 * read-only history. Only `active` admits.
 */
export type EventStatus = 'draft' | 'active' | 'ended' | 'archived';

export interface EventSummary {
  id: string;
  name: string;
  venue: string | null;
  /** IANA zone, e.g. "Asia/Kolkata". Times are stored in UTC and shown in this zone. */
  timeZone: string;
  startsAt: string;
  endsAt: string;
  status: EventStatus;
  /** Event-wide admission limit across every policy; null = unlimited. */
  capacity: number | null;
  admittedCount: number;
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
  /** The caller's role on this event; `operator` for the break-glass token. */
  myRole: EventRole | 'operator';
  /** What the caller may do; the server enforces the same list. */
  permissions: EventPermission[];
}

export type EventRole = 'owner' | 'manager';
export type EventPermission = 'view' | 'edit' | 'lifecycle' | 'team' | 'access' | 'passes' | 'scanners' | 'audit' | 'export';
export type PlatformRole = 'organizer' | 'platform_admin';

export interface AccountUser {
  id: string;
  email: string;
  name: string;
  platformRole: PlatformRole;
  createdAt: string;
  disabledAt: string | null;
}

/** GET /api/auth/session */
export interface SessionInfo {
  user: AccountUser;
  expiresAt: string;
}

export interface EventMember {
  userId: string;
  email: string;
  name: string;
  role: EventRole;
  createdAt: string;
}

export type InvitationRole = 'organizer' | 'platform_admin' | 'manager';

export interface Invitation {
  id: string;
  role: InvitationRole;
  email: string;
  eventId: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
}

/** Returned once when an invitation or reset is created; the link is never retrievable again. */
export interface InvitationLink {
  invitation: Invitation;
  url: string;
}

/** GET /api/invitations/:token — what the invitee sees before accepting. */
export interface InvitationPreview {
  role: InvitationRole;
  email: string;
  eventName: string | null;
  expiresAt: string;
  /** An account with this email exists: sign in to accept instead of creating one. */
  accountExists: boolean;
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
  /** True when this is the stored answer to an earlier request with the same `requestId` (a retry), not a new judgement. */
  replayed?: boolean;
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
    /** `capacity_full` from the event-wide limit rather than a policy. */
    eventCapacity?: boolean;
    /** `already_redeemed`: where and by which device the pass was used. */
    redeemedAtGate?: string | null;
    sameDevice?: boolean;
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
  /** Human-readable actor (account email, scanner label, `operator`). */
  actorLabel: string;
  action: string;
  entityId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface AuditQuery {
  /** Exact action, e.g. `pass.revoked`, or a prefix ending in `.`, e.g. `pass.`. */
  action?: string;
  /** Substring of the entity id, actor or details. */
  q?: string;
  /** Return entries with id lower than this (pagination, newest first). */
  before?: number;
  limit?: number;
}

export interface ScannerSession {
  scanner: { id: string; label: string };
  gate: { id: string; name: string } | null;
  event: { id: string; name: string; venue: string | null; timeZone: string; startsAt: string; endsAt: string; status: EventStatus };
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
  /** Pass states, from the passes table (not from scans). */
  passes: { issued: number; active: number; redeemed: number; revoked: number; expired: number };
  /** Event-wide capacity; `remaining` is null when unlimited. */
  capacity: { limit: number | null; admitted: number; remaining: number | null };
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
  /** Device health: `idle` = no request for 10 minutes while the event is active. */
  scanners: Array<{
    id: string;
    label: string;
    gateName: string | null;
    lastUsedAt: string | null;
    revoked: boolean;
    scansLast15m: number;
    state: 'revoked' | 'never_used' | 'recent' | 'idle';
  }>;
  /** 15-minute buckets covering the event's scans, oldest first, at most 96. */
  timeline: Array<{ bucketStart: string; admitted: number; denied: number }>;
  alerts: OperationsAlert[];
}

/** POST /api/events/:eventId/passes/import */
export interface ImportReport {
  dryRun: boolean;
  /** Rows that will be (or were) issued. */
  accepted: number;
  /** 1-based row numbers with the reason they were skipped. */
  rejected: Array<{ row: number; reason: 'invalid_email' | 'too_long' | 'empty' | 'duplicate_in_file' | 'already_has_pass'; detail: string }>;
  /** Present when `dryRun` is false. Tokens are returned only here, once. */
  issued?: IssuedPass[];
}
