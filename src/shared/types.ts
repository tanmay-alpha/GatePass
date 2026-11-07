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
}

/** Derived at read time: a pass is never stored as "expired". */
export type PassStatus = 'active' | 'redeemed' | 'revoked' | 'expired';

export interface Pass {
  id: string;
  eventId: string;
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

export interface Scanner {
  id: string;
  eventId: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export type ScanOutcome = 'admitted' | 'already_redeemed' | 'expired' | 'revoked' | 'invalid' | 'event_closed';

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
}

export interface ScanRecord {
  id: number;
  eventId: string;
  scannerId: string;
  scannerLabel: string;
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
  event: { id: string; name: string; venue: string | null; startsAt: string; endsAt: string; status: EventStatus };
}
