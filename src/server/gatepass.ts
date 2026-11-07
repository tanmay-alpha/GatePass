import { randomUUID } from 'node:crypto';
import { normalizeDesignConfig } from '../qr/design';
import type {
  AuditEntry,
  DesignConfig,
  EventStatus,
  EventSummary,
  IssuedPass,
  OperationsSummary,
  Pass,
  PassStatus,
  ScanOutcome,
  ScanRecord,
  ScanResult,
  Scanner,
  ScannerSession,
  StoredScanOutcome
} from '../shared/types';
import { evaluateAdmission } from './admission';
import { listAudit, recordAudit } from './audit';
import { transaction, type Database } from './db';
import { httpError } from './http';
import { operationsSummary } from './operations';
import { AccessControl } from './policies';
import { extractPassToken, generateToken, hashToken, isWellFormedToken } from './tokens';
import { isoDate } from './values';

export interface GatePassOptions {
  /** Base URL encoded into pass QR codes, without trailing slash. */
  publicUrl: string;
  now?: () => Date;
  /** Injected for tests; defaults to 256-bit random tokens. */
  generateToken?: () => string;
}

export interface EventInput {
  name: string;
  venue?: string | null;
  startsAt: string;
  endsAt: string;
  design?: Partial<DesignConfig>;
}

export interface EventPatch extends Partial<EventInput> {
  status?: EventStatus;
}

export interface IssueInput {
  attendees?: Array<{ name?: string | null; email?: string | null }>;
  count?: number;
  expiresAt?: string;
  policyId?: string;
}

export interface AuthenticatedScanner {
  id: string;
  eventId: string;
  gateId: string | null;
  label: string;
}

type Row = Record<string, unknown>;

const PASS_COLUMNS = `
  p.id, p.event_id, p.policy_id, p.attendee_name, p.attendee_email, p.expires_at, p.created_at, p.revoked_at,
  r.redeemed_at, r.scanner_id AS redeemed_by`;
const PASS_FROM = 'FROM passes p LEFT JOIN redemptions r ON r.pass_id = p.id';

export class GatePass {
  readonly access: AccessControl;
  private readonly now: () => Date;
  private readonly newToken: () => string;
  private readonly publicUrl: string;

  constructor(private readonly db: Database, options: GatePassOptions) {
    this.now = options.now ?? (() => new Date());
    this.newToken = options.generateToken ?? generateToken;
    this.publicUrl = options.publicUrl.replace(/\/+$/, '');
    this.access = new AccessControl(db, () => this.timestamp());
  }

  passUrl(token: string): string {
    return `${this.publicUrl}/p/${token}`;
  }

  // ---------------------------------------------------------------- events

  listEvents(): EventSummary[] {
    return (this.db.prepare(`${EVENT_SELECT} ORDER BY e.starts_at DESC, e.created_at DESC`).all() as Row[]).map(toEvent);
  }

  getEvent(id: string): EventSummary {
    const row = this.db.prepare(`${EVENT_SELECT} WHERE e.id = ?`).get(id) as Row | undefined;
    if (!row) throw httpError(404, 'Event not found');
    return toEvent(row);
  }

  createEvent(input: EventInput, actor: string): EventSummary {
    const startsAt = isoDate(input.startsAt);
    const endsAt = isoDate(input.endsAt);
    assertWindow(startsAt, endsAt);
    const design = normalizeDesignConfig(input.design);
    const id = randomUUID();
    const now = this.timestamp();
    transaction(this.db, () => {
      this.db
        .prepare('INSERT INTO events (id, name, venue, starts_at, ends_at, design_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, input.name, input.venue || null, startsAt, endsAt, JSON.stringify(design), now, now);
      this.audit(id, actor, 'event.created', id, { name: input.name, startsAt, endsAt });
    });
    return this.getEvent(id);
  }

  updateEvent(id: string, patch: EventPatch, actor: string): EventSummary {
    transaction(this.db, () => {
      const current = this.getEvent(id);
      const startsAt = patch.startsAt ? isoDate(patch.startsAt) : current.startsAt;
      const endsAt = patch.endsAt ? isoDate(patch.endsAt) : current.endsAt;
      assertWindow(startsAt, endsAt);
      const design = patch.design ? normalizeDesignConfig(patch.design) : current.design;
      const venue = patch.venue === undefined ? current.venue : patch.venue || null;
      this.db
        .prepare('UPDATE events SET name = ?, venue = ?, starts_at = ?, ends_at = ?, status = ?, design_json = ?, updated_at = ? WHERE id = ?')
        .run(patch.name ?? current.name, venue, startsAt, endsAt, patch.status ?? current.status, JSON.stringify(design), this.timestamp(), id);
      this.audit(id, actor, 'event.updated', id, { fields: Object.keys(patch) });
    });
    return this.getEvent(id);
  }

  // ---------------------------------------------------------------- passes

  listPasses(eventId: string, filter: { status?: PassStatus; q?: string; limit?: number } = {}): Pass[] {
    this.getEvent(eventId);
    const now = this.timestamp();
    const query = filter.q ? `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const rows = this.db
      .prepare(
        `SELECT ${PASS_COLUMNS} ${PASS_FROM}
         WHERE p.event_id = :eventId
           AND (:q IS NULL OR p.attendee_name LIKE :q ESCAPE '\\' OR p.attendee_email LIKE :q ESCAPE '\\' OR p.id LIKE :q ESCAPE '\\')
         ORDER BY p.created_at DESC, p.rowid DESC`
      )
      .all({ eventId, q: query }) as Row[];
    const passes = rows.map((row) => toPass(row, now));
    const filtered = filter.status ? passes.filter((pass) => pass.status === filter.status) : passes;
    return filtered.slice(0, filter.limit ?? 1000);
  }

  issuePasses(eventId: string, input: IssueInput, actor: string): IssuedPass[] {
    const attendees: NonNullable<IssueInput['attendees']> = input.attendees?.length ? input.attendees : Array.from({ length: input.count ?? 1 }, () => ({}));
    const now = this.timestamp();
    const issued = transaction(this.db, () => {
      const event = this.getEvent(eventId);
      if (event.status !== 'active') throw httpError(409, 'Passes cannot be issued for an archived event');
      const expiresAt = input.expiresAt ? isoDate(input.expiresAt) : event.endsAt;
      if (expiresAt <= now) throw httpError(400, 'The pass expiry must be in the future.');
      if (expiresAt <= event.startsAt) throw httpError(400, 'The pass expiry must be after the event starts, or the pass could never be used.');
      if (input.policyId) this.access.assertPolicy(eventId, input.policyId);
      const insert = this.db.prepare(
        'INSERT INTO passes (id, event_id, policy_id, token_hash, attendee_name, attendee_email, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
      const result = attendees.map((attendee) => {
        const id = randomUUID();
        const token = this.newToken();
        insert.run(id, eventId, input.policyId ?? null, hashToken(token), attendee.name || null, attendee.email || null, expiresAt, now);
        return { id, token };
      });
      this.audit(eventId, actor, 'passes.issued', null, { count: result.length, policyId: input.policyId ?? null, passIds: result.map((pass) => pass.id) });
      return result;
    });
    return issued.map(({ id, token }) => ({ ...this.getPass(id), token, passUrl: this.passUrl(token) }));
  }

  getPass(id: string): Pass {
    const row = this.db.prepare(`SELECT ${PASS_COLUMNS} ${PASS_FROM} WHERE p.id = ?`).get(id) as Row | undefined;
    if (!row) throw httpError(404, 'Pass not found');
    return toPass(row, this.timestamp());
  }

  /** Moves an unused pass to another admission policy (or the default with `null`). */
  setPassPolicy(id: string, policyId: string | null, actor: string): Pass {
    transaction(this.db, () => {
      const pass = this.getPass(id);
      if (pass.status === 'redeemed' || pass.status === 'revoked') throw httpError(409, `A ${pass.status} pass cannot change policy`);
      if (policyId) this.access.assertPolicy(pass.eventId, policyId);
      this.db.prepare('UPDATE passes SET policy_id = ? WHERE id = ?').run(policyId, id);
      this.audit(pass.eventId, actor, 'pass.policy_changed', id, { from: pass.policyId, to: policyId });
    });
    return this.getPass(id);
  }

  revokePass(id: string, actor: string): Pass {
    transaction(this.db, () => {
      const pass = this.getPass(id);
      if (pass.status === 'redeemed') throw httpError(409, 'A redeemed pass cannot be revoked');
      if (pass.status === 'revoked') return;
      this.db.prepare('UPDATE passes SET revoked_at = ? WHERE id = ?').run(this.timestamp(), id);
      this.audit(pass.eventId, actor, 'pass.revoked', id, {});
    });
    return this.getPass(id);
  }

  /** Replaces a lost token. The previous QR code stops working immediately. */
  reissuePass(id: string, actor: string): IssuedPass {
    const token = this.newToken();
    transaction(this.db, () => {
      const pass = this.getPass(id);
      if (pass.status !== 'active') throw httpError(409, `A ${pass.status} pass cannot be reissued`);
      this.db.prepare('UPDATE passes SET token_hash = ? WHERE id = ?').run(hashToken(token), id);
      this.audit(pass.eventId, actor, 'pass.reissued', id, {});
    });
    return { ...this.getPass(id), token, passUrl: this.passUrl(token) };
  }

  /** Read-only lookup for the attendee-facing pass page. Never redeems. */
  viewPass(token: string): { pass: Pass; event: EventSummary } | null {
    if (!isWellFormedToken(token)) return null;
    const row = this.db.prepare(`SELECT ${PASS_COLUMNS} ${PASS_FROM} WHERE p.token_hash = ?`).get(hashToken(token)) as Row | undefined;
    if (!row) return null;
    const pass = toPass(row, this.timestamp());
    return { pass, event: this.getEvent(pass.eventId) };
  }

  // ---------------------------------------------------------------- scanners

  listScanners(eventId: string): Scanner[] {
    this.getEvent(eventId);
    return (this.db.prepare(`${SCANNER_SELECT} WHERE s.event_id = ? ORDER BY s.created_at DESC`).all(eventId) as Row[]).map(toScanner);
  }

  createScanner(eventId: string, label: string, gateId: string | null, actor: string): { scanner: Scanner; key: string } {
    const id = randomUUID();
    const key = `gps_${this.newToken()}`;
    transaction(this.db, () => {
      this.getEvent(eventId);
      if (gateId) this.access.assertGate(eventId, gateId);
      this.db
        .prepare('INSERT INTO scanners (id, event_id, gate_id, label, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, eventId, gateId, label, hashToken(key), this.timestamp());
      this.audit(eventId, actor, 'scanner.created', id, { label, gateId });
    });
    return { scanner: this.getScanner(id), key };
  }

  revokeScanner(id: string, actor: string): Scanner {
    transaction(this.db, () => {
      const scanner = this.getScanner(id);
      if (scanner.revokedAt) return;
      this.db.prepare('UPDATE scanners SET revoked_at = ? WHERE id = ?').run(this.timestamp(), id);
      this.audit(scanner.eventId, actor, 'scanner.revoked', id, {});
    });
    return this.getScanner(id);
  }

  /** Read-only: resolves a scanner key without recording use (use is recorded on redeem). */
  authenticateScanner(key: string): AuthenticatedScanner | null {
    const row = this.db
      .prepare('SELECT id, event_id, gate_id, label FROM scanners WHERE key_hash = ? AND revoked_at IS NULL')
      .get(hashToken(key)) as Row | undefined;
    if (!row) return null;
    return { id: row.id as string, eventId: row.event_id as string, gateId: (row.gate_id as string | null) ?? null, label: row.label as string };
  }

  scannerSession(scanner: AuthenticatedScanner): ScannerSession {
    const event = this.getEvent(scanner.eventId);
    const gate = scanner.gateId ? this.access.assertGate(scanner.eventId, scanner.gateId) : null;
    return {
      scanner: { id: scanner.id, label: scanner.label },
      gate,
      event: { id: event.id, name: event.name, venue: event.venue, startsAt: event.startsAt, endsAt: event.endsAt, status: event.status }
    };
  }

  // ---------------------------------------------------------------- redemption

  /**
   * Verifies and redeems a scanned code. The whole check-and-write runs in one
   * IMMEDIATE transaction. Two database guarantees back the application rules:
   * `redemptions.pass_id` is a primary key (one redemption per pass) and
   * `admission_policies` has `CHECK (admitted_count <= capacity)`.
   */
  redeem(scanner: AuthenticatedScanner, code: string): ScanResult {
    const checkedAt = this.timestamp();
    return transaction(this.db, () => {
      const token = extractPassToken(code);
      const row = token ? (this.db.prepare(`SELECT ${PASS_COLUMNS} ${PASS_FROM} WHERE p.token_hash = ?`).get(hashToken(token)) as Row | undefined) : undefined;
      let pass = row ? toPass(row, checkedAt) : null;
      const sameEvent = pass?.eventId === scanner.eventId;
      // Only the columns the rules need: getEvent() also computes per-event
      // counts, which costs O(passes) and must not run on every scan.
      const event = this.db.prepare('SELECT starts_at AS startsAt, ends_at AS endsAt, status FROM events WHERE id = ?').get(scanner.eventId) as {
        startsAt: string;
        endsAt: string;
        status: EventStatus;
      };
      const policy = sameEvent && pass ? this.access.admissionPolicy(pass.policyId) : null;

      const decision = evaluateAdmission({ now: checkedAt, scanner, event, pass, policy });
      let outcome: StoredScanOutcome;
      let detail = decision.admit ? undefined : decision.detail;
      if (!decision.admit) {
        outcome = decision.outcome;
      } else if (policy && !this.access.claimCapacity(policy.id)) {
        outcome = 'capacity_full';
        detail = { policyName: policy.name, capacity: policy.capacity ?? undefined };
      } else {
        const inserted = this.db
          .prepare('INSERT INTO redemptions (pass_id, scanner_id, gate_id, policy_id, redeemed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (pass_id) DO NOTHING')
          .run(pass!.id, scanner.id, scanner.gateId, policy?.id ?? null, checkedAt);
        if (inserted.changes !== 1) throw new Error('Redemption conflict inside the write lock'); // unreachable: status was checked under the lock
        outcome = 'admitted';
        pass = this.getPass(pass!.id);
      }
      if (outcome === 'wrong_event') pass = null; // Never link or reveal a pass from another event.

      const scan = this.db
        .prepare('INSERT INTO scans (event_id, scanner_id, gate_id, pass_id, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(scanner.eventId, scanner.id, scanner.gateId, pass?.id ?? null, outcome, checkedAt);
      this.db.prepare('UPDATE scanners SET last_used_at = ? WHERE id = ?').run(checkedAt, scanner.id);

      const reported: ScanOutcome = outcome === 'wrong_event' ? 'invalid' : outcome;
      return {
        outcome: reported,
        scanId: Number(scan.lastInsertRowid),
        checkedAt,
        ...(pass && reported !== 'invalid' ? { pass: { id: pass.id, attendeeName: pass.attendeeName, redeemedAt: pass.redeemedAt } } : {}),
        ...(detail && reported !== 'invalid' ? { detail } : {})
      };
    });
  }

  listScans(eventId: string, options: { after?: number; limit?: number } = {}): ScanRecord[] {
    this.getEvent(eventId);
    const rows = this.db
      .prepare(
        `SELECT s.id, s.event_id, s.scanner_id, sc.label AS scanner_label, s.gate_id, g.name AS gate_name, s.pass_id, p.attendee_name, s.outcome, s.created_at
         FROM scans s JOIN scanners sc ON sc.id = s.scanner_id LEFT JOIN gates g ON g.id = s.gate_id LEFT JOIN passes p ON p.id = s.pass_id
         WHERE s.event_id = ? AND s.id > ? ORDER BY s.id DESC LIMIT ?`
      )
      .all(eventId, options.after ?? 0, options.limit ?? 50) as Row[];
    return rows.map((row) => ({
      id: Number(row.id),
      eventId: row.event_id as string,
      scannerId: row.scanner_id as string,
      scannerLabel: row.scanner_label as string,
      gateId: (row.gate_id as string | null) ?? null,
      gateName: (row.gate_name as string | null) ?? null,
      passId: (row.pass_id as string | null) ?? null,
      attendeeName: (row.attendee_name as string | null) ?? null,
      outcome: row.outcome as StoredScanOutcome,
      createdAt: row.created_at as string
    }));
  }

  operations(eventId: string): OperationsSummary {
    return operationsSummary(this.db, this.access, this.getEvent(eventId), this.now());
  }

  listAudit(eventId: string, limit = 100): AuditEntry[] {
    this.getEvent(eventId);
    return listAudit(this.db, eventId, limit);
  }

  /** Cheap liveness probe used by /api/health. */
  ping(): void {
    this.db.prepare('SELECT 1').get();
  }

  // ---------------------------------------------------------------- internals

  private getScanner(id: string): Scanner {
    const row = this.db.prepare(`${SCANNER_SELECT} WHERE s.id = ?`).get(id) as Row | undefined;
    if (!row) throw httpError(404, 'Scanner not found');
    return toScanner(row);
  }

  private audit(eventId: string | null, actor: string, action: string, entityId: string | null, details: Record<string, unknown>): void {
    recordAudit(this.db, { eventId, actor, action, entityId, details, at: this.timestamp() });
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

const EVENT_SELECT = `
  SELECT e.*,
    (SELECT COUNT(*) FROM passes p WHERE p.event_id = e.id) AS pass_count,
    (SELECT COUNT(*) FROM passes p WHERE p.event_id = e.id AND (p.attendee_name IS NOT NULL OR p.attendee_email IS NOT NULL)) AS attendee_count,
    (SELECT COUNT(*) FROM redemptions r JOIN passes p ON p.id = r.pass_id WHERE p.event_id = e.id) AS redeemed_count,
    (SELECT COUNT(*) FROM passes p WHERE p.event_id = e.id AND p.revoked_at IS NOT NULL) AS revoked_count,
    (SELECT COUNT(*) FROM gates g WHERE g.event_id = e.id) AS gate_count,
    (SELECT COUNT(*) FROM admission_policies ap WHERE ap.event_id = e.id) AS policy_count,
    (SELECT COUNT(*) FROM scanners s WHERE s.event_id = e.id AND s.revoked_at IS NULL) AS scanner_count,
    (SELECT COUNT(*) FROM scans sc WHERE sc.event_id = e.id) AS scan_count
  FROM events e`;

const SCANNER_SELECT = 'SELECT s.*, g.name AS gate_name FROM scanners s LEFT JOIN gates g ON g.id = s.gate_id';

function toEvent(row: Row): EventSummary {
  return {
    id: row.id as string,
    name: row.name as string,
    venue: (row.venue as string | null) ?? null,
    startsAt: row.starts_at as string,
    endsAt: row.ends_at as string,
    status: row.status as EventStatus,
    design: normalizeDesignConfig(JSON.parse(row.design_json as string)),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    passCount: Number(row.pass_count),
    attendeeCount: Number(row.attendee_count),
    redeemedCount: Number(row.redeemed_count),
    revokedCount: Number(row.revoked_count),
    gateCount: Number(row.gate_count),
    policyCount: Number(row.policy_count),
    scannerCount: Number(row.scanner_count),
    scanCount: Number(row.scan_count)
  };
}

function toPass(row: Row, now: string): Pass {
  const redeemedAt = (row.redeemed_at as string | null) ?? null;
  const revokedAt = (row.revoked_at as string | null) ?? null;
  const expiresAt = row.expires_at as string;
  const status: PassStatus = redeemedAt ? 'redeemed' : revokedAt ? 'revoked' : expiresAt <= now ? 'expired' : 'active';
  return {
    id: row.id as string,
    eventId: row.event_id as string,
    policyId: (row.policy_id as string | null) ?? null,
    attendeeName: (row.attendee_name as string | null) ?? null,
    attendeeEmail: (row.attendee_email as string | null) ?? null,
    expiresAt,
    createdAt: row.created_at as string,
    revokedAt,
    redeemedAt,
    redeemedBy: (row.redeemed_by as string | null) ?? null,
    status
  };
}

function toScanner(row: Row): Scanner {
  return {
    id: row.id as string,
    eventId: row.event_id as string,
    label: row.label as string,
    gateId: (row.gate_id as string | null) ?? null,
    gateName: (row.gate_name as string | null) ?? null,
    createdAt: row.created_at as string,
    revokedAt: (row.revoked_at as string | null) ?? null,
    lastUsedAt: (row.last_used_at as string | null) ?? null
  };
}

function assertWindow(startsAt: string, endsAt: string): void {
  if (endsAt <= startsAt) throw httpError(400, 'The event must end after it starts.');
}
