import { randomUUID } from 'node:crypto';
import { normalizeDesignConfig } from '../qr/design';
import type {
  AuditEntry,
  AuditQuery,
  DesignConfig,
  EventPermission,
  EventRole,
  EventStatus,
  EventSummary,
  ImportReport,
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
import { Accounts } from './accounts';
import { evaluateAdmission } from './admission';
import { listAudit, recordAudit } from './audit';
import { toCsv } from './csv';
import { transaction, type Database } from './db';
import { httpError } from './http';
import { operationsSummary } from './operations';
import { ROLE_PERMISSIONS, type Principal } from './permissions';
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
  timeZone?: string;
  startsAt: string;
  endsAt: string;
  capacity?: number | null;
  /** New events start `active` unless created as a draft. */
  status?: 'draft' | 'active';
  design?: Partial<DesignConfig>;
}

export interface EventPatch extends Partial<Omit<EventInput, 'status'>> {
  status?: EventStatus;
}

export interface IssueInput {
  attendees?: Array<{ name?: string | null; email?: string | null }>;
  count?: number;
  expiresAt?: string;
  policyId?: string;
}

export interface ImportInput {
  rows: Array<{ name?: string | null; email?: string | null }>;
  policyId?: string;
  expiresAt?: string;
  dryRun: boolean;
}

export interface PassFilter {
  status?: PassStatus;
  q?: string;
  policyId?: string;
  limit?: number;
  offset?: number;
}

export interface AuthenticatedScanner {
  id: string;
  eventId: string;
  gateId: string | null;
  label: string;
}

type Row = Record<string, unknown>;

/** Lifecycle moves an owner may make. Only `active` admits at the door. */
const STATUS_TRANSITIONS: Record<EventStatus, readonly EventStatus[]> = {
  draft: ['active', 'archived'],
  active: ['ended', 'archived'],
  ended: ['active', 'archived'],
  archived: ['ended']
};

const PASS_COLUMNS = `
  p.id, p.event_id, p.policy_id, p.attendee_name, p.attendee_email, p.expires_at, p.created_at, p.revoked_at,
  r.redeemed_at, r.scanner_id AS redeemed_by, (SELECT name FROM gates WHERE id = r.gate_id) AS redeemed_gate`;
const PASS_FROM = 'FROM passes p LEFT JOIN redemptions r ON r.pass_id = p.id';
const PASS_STATUS_SQL = `CASE WHEN r.redeemed_at IS NOT NULL THEN 'redeemed' WHEN p.revoked_at IS NOT NULL THEN 'revoked' WHEN p.expires_at <= :now THEN 'expired' ELSE 'active' END`;
/** Simple, permissive syntax check; deliverability is not verified (no email is sent). */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REFERENCE = /^[0-9a-f]{8}$/i;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export class GatePass {
  readonly access: AccessControl;
  readonly accounts: Accounts;
  private readonly now: () => Date;
  private readonly newToken: () => string;
  private readonly publicUrl: string;

  constructor(
    private readonly db: Database,
    options: GatePassOptions
  ) {
    this.now = options.now ?? (() => new Date());
    this.newToken = options.generateToken ?? generateToken;
    this.publicUrl = options.publicUrl.replace(/\/+$/, '');
    this.access = new AccessControl(db, () => this.timestamp());
    this.accounts = new Accounts(db, { now: this.now, publicUrl: this.publicUrl, generateToken: this.newToken });
  }

  passUrl(token: string): string {
    return `${this.publicUrl}/p/${token}`;
  }

  // ---------------------------------------------------------------- authorization

  /**
   * Resolves the caller's role on an event and checks one permission. Events
   * the caller is not on answer 404 (indistinguishable from a missing event,
   * so ids cannot be probed); members without the permission get 403.
   */
  authorize(principal: Principal, eventId: string, permission: EventPermission): EventRole | 'operator' {
    if (principal.kind === 'operator') {
      if (!this.db.prepare('SELECT 1 FROM events WHERE id = ?').get(eventId)) throw httpError(404, 'Event not found');
      return 'operator';
    }
    const role = this.accounts.eventRole(principal.user.id, eventId);
    if (!role) throw httpError(404, 'Event not found');
    if (!ROLE_PERMISSIONS[role].includes(permission)) throw httpError(403, `Your role (${role}) cannot do this on this event.`);
    return role;
  }

  passEventId(passId: string): string {
    const row = this.db.prepare('SELECT event_id FROM passes WHERE id = ?').get(passId) as Row | undefined;
    if (!row) throw httpError(404, 'Pass not found');
    return row.event_id as string;
  }

  scannerEventId(scannerId: string): string {
    const row = this.db.prepare('SELECT event_id FROM scanners WHERE id = ?').get(scannerId) as Row | undefined;
    if (!row) throw httpError(404, 'Scanner not found');
    return row.event_id as string;
  }

  // ---------------------------------------------------------------- events

  /** Operator: every event. Accounts: only events they are on. */
  listEvents(principal: Principal = { kind: 'operator' }): EventSummary[] {
    if (principal.kind === 'operator') {
      return (this.db.prepare(`${EVENT_SELECT} ORDER BY e.starts_at DESC, e.created_at DESC`).all() as Row[]).map((row) => toEvent(row, 'operator'));
    }
    const rows = this.db
      .prepare(`SELECT ${EVENT_COLUMNS}, m.role AS member_role FROM events e JOIN event_members m ON m.event_id = e.id AND m.user_id = ? ORDER BY e.starts_at DESC, e.created_at DESC`)
      .all(principal.user.id) as Row[];
    return rows.map((row) => toEvent(row, row.member_role as EventRole));
  }

  getEvent(id: string, principal: Principal = { kind: 'operator' }): EventSummary {
    const row = this.db.prepare(`${EVENT_SELECT} WHERE e.id = ?`).get(id) as Row | undefined;
    if (!row) throw httpError(404, 'Event not found');
    if (principal.kind === 'operator') return toEvent(row, 'operator');
    const role = this.accounts.eventRole(principal.user.id, id);
    if (!role) throw httpError(404, 'Event not found');
    return toEvent(row, role);
  }

  /** `ownerId` (the creating account) becomes the event owner in the same transaction. */
  createEvent(input: EventInput, actor: string, ownerId: string | null = null): EventSummary {
    const startsAt = isoDate(input.startsAt);
    const endsAt = isoDate(input.endsAt);
    assertWindow(startsAt, endsAt);
    const timeZone = assertTimeZone(input.timeZone ?? 'UTC');
    const design = normalizeDesignConfig(input.design);
    const id = randomUUID();
    const now = this.timestamp();
    transaction(this.db, () => {
      this.db
        .prepare(
          'INSERT INTO events (id, name, venue, time_zone, starts_at, ends_at, status, capacity, design_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(id, input.name, input.venue || null, timeZone, startsAt, endsAt, input.status ?? 'active', input.capacity ?? null, JSON.stringify(design), now, now);
      this.audit(id, actor, 'event.created', id, { name: input.name, startsAt, endsAt, timeZone, status: input.status ?? 'active' });
      if (ownerId) this.accounts.setOwnerInTransaction(id, ownerId, actor);
    });
    return this.getEvent(id);
  }

  updateEvent(id: string, patch: EventPatch, actor: string): EventSummary {
    transaction(this.db, () => {
      const current = this.getEvent(id);
      const contentFields = Object.entries(patch).filter(([key, value]) => key !== 'status' && value !== undefined);
      if (current.status === 'archived' && contentFields.length) throw httpError(409, 'An archived event is read-only. Restore it to Ended first.');
      if (patch.status && patch.status !== current.status && !STATUS_TRANSITIONS[current.status].includes(patch.status)) {
        throw httpError(409, `An event cannot move from ${current.status} to ${patch.status}.`);
      }
      const startsAt = patch.startsAt ? isoDate(patch.startsAt) : current.startsAt;
      const endsAt = patch.endsAt ? isoDate(patch.endsAt) : current.endsAt;
      assertWindow(startsAt, endsAt);
      const timeZone = patch.timeZone ? assertTimeZone(patch.timeZone) : current.timeZone;
      const capacity = patch.capacity === undefined ? current.capacity : patch.capacity;
      if (capacity !== null && capacity < current.admittedCount) {
        throw httpError(409, `Capacity cannot be lower than the ${current.admittedCount} people already admitted.`);
      }
      const design = patch.design ? normalizeDesignConfig(patch.design) : current.design;
      const venue = patch.venue === undefined ? current.venue : patch.venue || null;
      this.db
        .prepare(
          'UPDATE events SET name = ?, venue = ?, time_zone = ?, starts_at = ?, ends_at = ?, status = ?, capacity = ?, design_json = ?, updated_at = ? WHERE id = ?'
        )
        .run(patch.name ?? current.name, venue, timeZone, startsAt, endsAt, patch.status ?? current.status, capacity, JSON.stringify(design), this.timestamp(), id);
      const details: Record<string, unknown> = { fields: Object.entries(patch).filter(([, value]) => value !== undefined).map(([key]) => key) };
      if (patch.status && patch.status !== current.status) details.status = { from: current.status, to: patch.status };
      if (capacity !== current.capacity) details.capacity = { from: current.capacity, to: capacity };
      if (startsAt !== current.startsAt || endsAt !== current.endsAt) details.window = { from: [current.startsAt, current.endsAt], to: [startsAt, endsAt] };
      this.audit(id, actor, patch.status && patch.status !== current.status ? 'event.status_changed' : 'event.updated', id, details);
    });
    return this.getEvent(id);
  }

  /**
   * Copies an event's configuration (venue, zone, capacity, design, gates and
   * policies with windows shifted by the start-time difference) into a new
   * draft. Passes, scanners, scans and the team are never copied.
   */
  cloneEvent(sourceId: string, input: { name: string; startsAt: string; endsAt: string }, actor: string, ownerId: string | null): EventSummary {
    const startsAt = isoDate(input.startsAt);
    const endsAt = isoDate(input.endsAt);
    assertWindow(startsAt, endsAt);
    const id = randomUUID();
    const now = this.timestamp();
    transaction(this.db, () => {
      const source = this.getEvent(sourceId);
      const shift = Date.parse(startsAt) - Date.parse(source.startsAt);
      const shifted = (value: string | null) => (value ? new Date(Date.parse(value) + shift).toISOString() : null);
      this.db
        .prepare(
          "INSERT INTO events (id, name, venue, time_zone, starts_at, ends_at, status, capacity, design_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)"
        )
        .run(id, input.name, source.venue, source.timeZone, startsAt, endsAt, source.capacity, JSON.stringify(source.design), now, now);
      const gateIds = new Map<string, string>();
      for (const gate of this.access.listGates(sourceId)) {
        const gateId = randomUUID();
        gateIds.set(gate.id, gateId);
        this.db.prepare('INSERT INTO gates (id, event_id, name, created_at) VALUES (?, ?, ?, ?)').run(gateId, id, gate.name, now);
      }
      for (const policy of this.access.listPolicies(sourceId)) {
        const policyId = randomUUID();
        this.db
          .prepare('INSERT INTO admission_policies (id, event_id, name, opens_at, closes_at, capacity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(policyId, id, policy.name, shifted(policy.opensAt), shifted(policy.closesAt), policy.capacity, now, now);
        for (const gateId of policy.gateIds) {
          this.db.prepare('INSERT INTO policy_gates (policy_id, gate_id) VALUES (?, ?)').run(policyId, gateIds.get(gateId)!);
        }
      }
      this.audit(id, actor, 'event.created', id, { name: input.name, startsAt, endsAt, clonedFrom: sourceId });
      this.audit(sourceId, actor, 'event.cloned', id, { name: input.name });
      if (ownerId) this.accounts.setOwnerInTransaction(id, ownerId, actor);
    });
    return this.getEvent(id);
  }

  /** Owner change. Accounts may only hand ownership to an existing team member; the operator may assign anyone. */
  setOwner(eventId: string, userId: string, actor: string, requireMember: boolean): void {
    transaction(this.db, () => {
      this.getEvent(eventId);
      if (requireMember && !this.accounts.eventRole(userId, eventId)) throw httpError(400, 'Ownership can only move to someone already on the event team.');
      this.accounts.setOwnerInTransaction(eventId, userId, actor);
    });
  }

  // ---------------------------------------------------------------- passes

  /** Filtering, ordering and paging run in SQL; status is derived at read time. */
  listPasses(eventId: string, filter: PassFilter = {}): { passes: Pass[]; total: number } {
    this.getEvent(eventId);
    const now = this.timestamp();
    const q = filter.q ? `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const where = `WHERE p.event_id = :eventId
      AND (:q IS NULL OR p.attendee_name LIKE :q ESCAPE '\\' OR p.attendee_email LIKE :q ESCAPE '\\' OR p.id LIKE :q ESCAPE '\\')
      AND (:policyId IS NULL OR p.policy_id = :policyId)
      AND (:status IS NULL OR ${PASS_STATUS_SQL} = :status)`;
    const params = { eventId, q, now, policyId: filter.policyId ?? null, status: filter.status ?? null };
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n ${PASS_FROM} ${where}`).get(params) as Row).n);
    const rows = this.db
      .prepare(`SELECT ${PASS_COLUMNS} ${PASS_FROM} ${where} ORDER BY p.created_at DESC, p.rowid DESC LIMIT :limit OFFSET :offset`)
      .all({ ...params, limit: filter.limit ?? 1000, offset: filter.offset ?? 0 }) as Row[];
    return { passes: rows.map((row) => toPass(row, now)), total };
  }

  issuePasses(eventId: string, input: IssueInput, actor: string): IssuedPass[] {
    const attendees: NonNullable<IssueInput['attendees']> = input.attendees?.length ? input.attendees : Array.from({ length: input.count ?? 1 }, () => ({}));
    return transaction(this.db, () => this.insertPasses(eventId, attendees, input, actor, 'passes.issued'));
  }

  /**
   * Validates attendee rows, removes duplicates (same email within the file
   * or an existing non-revoked pass of this event) and, unless `dryRun`,
   * issues the accepted rows in one transaction, so the duplicate check and
   * the inserts see the same state.
   */
  importPasses(eventId: string, input: ImportInput, actor: string): ImportReport {
    const run = (): ImportReport => {
      const event = this.getEvent(eventId);
      if (input.policyId) this.access.assertPolicy(eventId, input.policyId);
      const existing = new Set(
        (this.db.prepare('SELECT lower(attendee_email) AS email FROM passes WHERE event_id = ? AND attendee_email IS NOT NULL AND revoked_at IS NULL').all(event.id) as Row[]).map(
          (row) => row.email as string
        )
      );
      const seen = new Set<string>();
      const accepted: Array<{ name: string | null; email: string | null }> = [];
      const rejected: ImportReport['rejected'] = [];
      input.rows.forEach((raw, index) => {
        const row = index + 1;
        const name = raw.name?.trim() || null;
        const email = raw.email?.trim() || null;
        if (!name && !email) return rejected.push({ row, reason: 'empty', detail: 'No name or email' });
        if ((name?.length ?? 0) > 200 || (email?.length ?? 0) > 254) return rejected.push({ row, reason: 'too_long', detail: 'Name over 200 or email over 254 characters' });
        if (email && !EMAIL.test(email)) return rejected.push({ row, reason: 'invalid_email', detail: email });
        const key = email?.toLowerCase();
        if (key && seen.has(key)) return rejected.push({ row, reason: 'duplicate_in_file', detail: email! });
        if (key && existing.has(key)) return rejected.push({ row, reason: 'already_has_pass', detail: email! });
        if (key) seen.add(key);
        accepted.push({ name, email });
      });
      if (input.dryRun || accepted.length === 0) return { dryRun: input.dryRun, accepted: accepted.length, rejected, ...(input.dryRun ? {} : { issued: [] }) };
      const issued = this.insertPasses(eventId, accepted, input, actor, 'passes.imported');
      return { dryRun: false, accepted: accepted.length, rejected, issued };
    };
    return input.dryRun ? run() : transaction(this.db, run);
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

  /** Revokes every listed pass of this event that is still unused; ids of other events or used passes are skipped. */
  revokePasses(eventId: string, passIds: string[], actor: string): { revoked: number; skipped: number } {
    return transaction(this.db, () => {
      const at = this.timestamp();
      const revoke = this.db.prepare('UPDATE passes SET revoked_at = ? WHERE id = ? AND event_id = ? AND revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM redemptions WHERE pass_id = passes.id)');
      let revoked = 0;
      for (const id of new Set(passIds)) {
        if (revoke.run(at, id, eventId).changes === 1) {
          revoked += 1;
          this.audit(eventId, actor, 'pass.revoked', id, { bulk: true });
        }
      }
      return { revoked, skipped: passIds.length - revoked };
    });
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

  /** Read-only lookup for the attendee-facing pass page. Never redeems; reads one event row, no aggregates. */
  viewPass(token: string): { pass: Pass; event: Pick<EventSummary, 'name' | 'venue' | 'timeZone' | 'startsAt' | 'endsAt' | 'status' | 'design'> } | null {
    if (!isWellFormedToken(token)) return null;
    const row = this.db.prepare(`SELECT ${PASS_COLUMNS} ${PASS_FROM} WHERE p.token_hash = ?`).get(hashToken(token)) as Row | undefined;
    if (!row) return null;
    const pass = toPass(row, this.timestamp());
    const event = this.db.prepare('SELECT name, venue, time_zone, starts_at, ends_at, status, design_json FROM events WHERE id = ?').get(pass.eventId) as Row;
    return {
      pass,
      event: {
        name: event.name as string,
        venue: (event.venue as string | null) ?? null,
        timeZone: event.time_zone as string,
        startsAt: event.starts_at as string,
        endsAt: event.ends_at as string,
        status: event.status as EventStatus,
        design: normalizeDesignConfig(JSON.parse(event.design_json as string))
      }
    };
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
        .prepare('INSERT INTO scanners (id, event_id, gate_id, label, key_hash, created_at, key_issued_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, eventId, gateId, label, hashToken(key), this.timestamp(), actor);
      this.audit(eventId, actor, 'scanner.created', id, { label, gateId });
    });
    return { scanner: this.getScanner(id), key };
  }

  /** New key for the same device record (gate, label and history kept); the old key stops working at once. */
  rotateScanner(id: string, actor: string): { scanner: Scanner; key: string } {
    const key = `gps_${this.newToken()}`;
    transaction(this.db, () => {
      const scanner = this.getScanner(id);
      if (scanner.revokedAt) throw httpError(409, 'A revoked scanner cannot be rotated. Create a new one.');
      this.db.prepare('UPDATE scanners SET key_hash = ?, key_issued_by = ? WHERE id = ?').run(hashToken(key), actor, id);
      this.audit(scanner.eventId, actor, 'scanner.rotated', id, {});
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

  /** Also records a heartbeat (at most once a minute) for the device-health view. */
  scannerSession(scanner: AuthenticatedScanner): ScannerSession {
    const event = this.getEvent(scanner.eventId);
    const gate = scanner.gateId ? this.access.assertGate(scanner.eventId, scanner.gateId) : null;
    const now = this.timestamp();
    const minuteAgo = new Date(this.now().getTime() - 60_000).toISOString();
    this.db.prepare('UPDATE scanners SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)').run(now, scanner.id, minuteAgo);
    return {
      scanner: { id: scanner.id, label: scanner.label },
      gate,
      event: { id: event.id, name: event.name, venue: event.venue, timeZone: event.timeZone, startsAt: event.startsAt, endsAt: event.endsAt, status: event.status }
    };
  }

  // ---------------------------------------------------------------- redemption

  /**
   * Verifies and redeems a scanned code. The whole check-and-write runs in one
   * IMMEDIATE transaction, so redemptions are serialised by SQLite's single
   * write lock; the commit is the linearization point. Database guarantees
   * back the application rules: `redemptions.pass_id` is a primary key (one
   * redemption per pass), and policy and event `admitted_count` columns carry
   * `CHECK (admitted_count <= capacity)`.
   *
   * `requestId` makes retries safe: a second request with the same id from
   * the same scanner returns the stored result of the first (`replayed`)
   * instead of a fresh judgement, which would say `already_redeemed`.
   */
  redeem(scanner: AuthenticatedScanner, code: string, requestId?: string): ScanResult {
    if (requestId !== undefined && !REQUEST_ID.test(requestId)) throw httpError(400, 'requestId must be 8-64 characters of A-Z, a-z, 0-9, _ or -');
    return transaction(this.db, () => {
      // The key was checked before the lock was taken; re-check under it so a revocation that committed in between wins.
      const current = this.db.prepare('SELECT revoked_at FROM scanners WHERE id = ?').get(scanner.id) as Row | undefined;
      if (!current || current.revoked_at) throw httpError(401, 'Scanner authentication required');

      if (requestId) {
        const previous = this.db.prepare('SELECT id, pass_id, outcome, created_at FROM scans WHERE scanner_id = ? AND request_id = ?').get(scanner.id, requestId) as Row | undefined;
        if (previous) {
          // The id belongs to one attempt at one code: reusing it for a different pass is a client bug, not a retry.
          const scanned = this.findScannedPass(scanner.eventId, code);
          const samePass = previous.pass_id ? scanned?.id === previous.pass_id : !scanned || scanned.event_id !== scanner.eventId;
          if (!samePass) throw httpError(409, 'This requestId was already used for a different code. Generate a new one per scan.');
          return this.replay(previous);
        }
      }

      const checkedAt = this.timestamp();
      const row = this.findScannedPass(scanner.eventId, code);
      let pass = row ? toPass(row, checkedAt) : null;
      const sameEvent = pass?.eventId === scanner.eventId;
      // Only the columns the rules need: getEvent() also computes per-event
      // counts, which costs O(passes) and must not run on every scan.
      const eventRow = this.db.prepare('SELECT starts_at, ends_at, status, capacity, admitted_count FROM events WHERE id = ?').get(scanner.eventId) as Row;
      const event = {
        startsAt: eventRow.starts_at as string,
        endsAt: eventRow.ends_at as string,
        status: eventRow.status as EventStatus,
        capacity: eventRow.capacity === null ? null : Number(eventRow.capacity),
        admittedCount: Number(eventRow.admitted_count)
      };
      const policy = sameEvent && pass ? this.access.admissionPolicy(pass.policyId) : null;

      const decision = evaluateAdmission({ now: checkedAt, scanner, event, pass, policy });
      let outcome: StoredScanOutcome;
      let detail = decision.admit ? undefined : decision.detail;
      if (!decision.admit) {
        outcome = decision.outcome;
        if (outcome === 'already_redeemed' && row) detail = { redeemedAtGate: (row.redeemed_gate as string | null) ?? null, sameDevice: row.redeemed_by === scanner.id };
      } else if (policy && !this.access.claimCapacity(policy.id)) {
        outcome = 'capacity_full';
        detail = { policyName: policy.name, capacity: policy.capacity ?? undefined };
      } else if (this.db.prepare('UPDATE events SET admitted_count = admitted_count + 1 WHERE id = ? AND (capacity IS NULL OR admitted_count < capacity)').run(scanner.eventId).changes !== 1) {
        // Undo the policy claim made above; still inside the same write transaction.
        if (policy) this.db.prepare('UPDATE admission_policies SET admitted_count = admitted_count - 1 WHERE id = ?').run(policy.id);
        outcome = 'capacity_full';
        detail = { capacity: event.capacity ?? undefined, eventCapacity: true };
      } else {
        const inserted = this.db
          .prepare('INSERT INTO redemptions (pass_id, scanner_id, gate_id, policy_id, redeemed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (pass_id) DO NOTHING')
          .run(pass!.id, scanner.id, scanner.gateId, policy?.id ?? null, checkedAt);
        // Unreachable (status was checked under the lock); throwing rolls back every claim above and the door sees "not verified".
        if (inserted.changes !== 1) throw new Error('Redemption conflict inside the write lock');
        outcome = 'admitted';
        pass = this.getPass(pass!.id);
      }
      if (outcome === 'wrong_event') pass = null; // Never link or reveal a pass from another event.

      const scan = this.db
        .prepare('INSERT INTO scans (event_id, scanner_id, gate_id, pass_id, outcome, created_at, request_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(scanner.eventId, scanner.id, scanner.gateId, pass?.id ?? null, outcome, checkedAt, requestId ?? null);
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

  listAudit(eventId: string, query: AuditQuery = {}): AuditEntry[] {
    this.getEvent(eventId);
    return listAudit(this.db, eventId, query);
  }

  // ---------------------------------------------------------------- exports

  /** Every pass with its current state and where it was admitted. Recorded in the audit log by the caller's route. */
  attendanceCsv(eventId: string, actor: string): string {
    const event = this.getEvent(eventId);
    const now = this.timestamp();
    const rows = this.db
      .prepare(
        `SELECT p.id, p.attendee_name, p.attendee_email, ap.name AS policy, p.created_at, p.expires_at, p.revoked_at, r.redeemed_at,
                g.name AS gate, sc.label AS scanner, ${PASS_STATUS_SQL} AS status
         FROM passes p LEFT JOIN redemptions r ON r.pass_id = p.id LEFT JOIN admission_policies ap ON ap.id = p.policy_id
         LEFT JOIN gates g ON g.id = r.gate_id LEFT JOIN scanners sc ON sc.id = r.scanner_id
         WHERE p.event_id = :eventId ORDER BY p.created_at, p.rowid`
      )
      .all({ eventId, now }) as Row[];
    this.recordExport(event.id, actor, 'attendance', rows.length);
    return toCsv(
      ['pass_id', 'reference', 'attendee_name', 'attendee_email', 'policy', 'status', 'issued_at', 'expires_at', 'revoked_at', 'admitted_at', 'gate', 'scanner', 'time_zone'],
      rows.map((row) => [
        row.id,
        (row.id as string).slice(0, 8).toUpperCase(),
        row.attendee_name,
        row.attendee_email,
        row.policy,
        row.status,
        row.created_at,
        row.expires_at,
        row.revoked_at,
        row.redeemed_at,
        row.gate,
        row.scanner,
        event.timeZone
      ])
    );
  }

  scansCsv(eventId: string, actor: string): string {
    this.getEvent(eventId);
    const rows = this.db
      .prepare(
        `SELECT s.id, s.created_at, s.outcome, g.name AS gate, sc.label AS scanner, s.pass_id, p.attendee_name
         FROM scans s JOIN scanners sc ON sc.id = s.scanner_id LEFT JOIN gates g ON g.id = s.gate_id LEFT JOIN passes p ON p.id = s.pass_id
         WHERE s.event_id = ? ORDER BY s.id`
      )
      .all(eventId) as Row[];
    this.recordExport(eventId, actor, 'scans', rows.length);
    return toCsv(
      ['scan_id', 'time_utc', 'outcome', 'gate', 'scanner', 'pass_reference', 'attendee_name'],
      rows.map((row) => [row.id, row.created_at, row.outcome, row.gate, row.scanner, row.pass_id ? (row.pass_id as string).slice(0, 8).toUpperCase() : null, row.attendee_name])
    );
  }

  auditCsv(eventId: string, actor: string): string {
    this.getEvent(eventId);
    const entries = listAudit(this.db, eventId, { limit: 100_000 });
    this.recordExport(eventId, actor, 'audit', entries.length);
    return toCsv(
      ['id', 'time_utc', 'actor', 'action', 'entity_id', 'details'],
      entries.reverse().map((entry) => [entry.id, entry.createdAt, entry.actorLabel, entry.action, entry.entityId, JSON.stringify(entry.details)])
    );
  }

  /** Cheap liveness probe used by /api/health. */
  ping(): void {
    this.db.prepare('SELECT 1').get();
  }

  // ---------------------------------------------------------------- internals

  /** Pass for a scanned value: full URL or token (any event), or an 8-character reference resolved only within the scanner's event. */
  private findScannedPass(eventId: string, code: string): Row | undefined {
    const token = extractPassToken(code);
    if (token) return this.db.prepare(`SELECT ${PASS_COLUMNS} ${PASS_FROM} WHERE p.token_hash = ?`).get(hashToken(token)) as Row | undefined;
    const reference = code.trim();
    if (!REFERENCE.test(reference)) return undefined;
    const rows = this.db
      .prepare(`SELECT ${PASS_COLUMNS} ${PASS_FROM} WHERE p.event_id = ? AND p.id >= ? AND p.id < ? LIMIT 2`)
      .all(eventId, reference.toLowerCase(), `${reference.toLowerCase()}g`) as Row[];
    return rows.length === 1 ? rows[0] : undefined;
  }

  /** The stored answer for a repeated requestId. No new scan row: the attempt already happened. */
  private replay(previous: Row): ScanResult {
    const stored = previous.outcome as StoredScanOutcome;
    const reported: ScanOutcome = stored === 'wrong_event' ? 'invalid' : stored;
    const pass = previous.pass_id ? this.getPass(previous.pass_id as string) : null;
    return {
      outcome: reported,
      scanId: Number(previous.id),
      checkedAt: previous.created_at as string,
      replayed: true,
      ...(pass && reported !== 'invalid' ? { pass: { id: pass.id, attendeeName: pass.attendeeName, redeemedAt: pass.redeemedAt } } : {})
    };
  }

  /** Must run inside a transaction. Builds results in memory instead of re-reading every inserted pass. */
  private insertPasses(
    eventId: string,
    attendees: Array<{ name?: string | null; email?: string | null }>,
    input: { expiresAt?: string; policyId?: string },
    actor: string,
    action: string
  ): IssuedPass[] {
    const now = this.timestamp();
    const event = this.getEvent(eventId);
    if (event.status === 'ended' || event.status === 'archived') throw httpError(409, `Passes cannot be issued for an ${event.status} event`);
    const expiresAt = input.expiresAt ? isoDate(input.expiresAt) : event.endsAt;
    if (expiresAt <= now) throw httpError(400, 'The pass expiry must be in the future.');
    if (expiresAt <= event.startsAt) throw httpError(400, 'The pass expiry must be after the event starts, or the pass could never be used.');
    if (input.policyId) this.access.assertPolicy(eventId, input.policyId);
    const insert = this.db.prepare(
      'INSERT INTO passes (id, event_id, policy_id, token_hash, attendee_name, attendee_email, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const issued = attendees.map((attendee): IssuedPass => {
      const id = randomUUID();
      const token = this.newToken();
      const attendeeName = attendee.name || null;
      const attendeeEmail = attendee.email || null;
      insert.run(id, eventId, input.policyId ?? null, hashToken(token), attendeeName, attendeeEmail, expiresAt, now);
      return {
        id,
        eventId,
        policyId: input.policyId ?? null,
        attendeeName,
        attendeeEmail,
        expiresAt,
        createdAt: now,
        revokedAt: null,
        redeemedAt: null,
        redeemedBy: null,
        status: 'active',
        token,
        passUrl: this.passUrl(token)
      };
    });
    this.audit(eventId, actor, action, null, { count: issued.length, policyId: input.policyId ?? null, passIds: issued.map((pass) => pass.id) });
    return issued;
  }

  private recordExport(eventId: string, actor: string, kind: string, rows: number): void {
    transaction(this.db, () => this.audit(eventId, actor, 'export.downloaded', null, { kind, rows }));
  }

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

const EVENT_COLUMNS = `
  e.*,
  (SELECT COUNT(*) FROM passes p WHERE p.event_id = e.id) AS pass_count,
  (SELECT COUNT(*) FROM passes p WHERE p.event_id = e.id AND (p.attendee_name IS NOT NULL OR p.attendee_email IS NOT NULL)) AS attendee_count,
  (SELECT COUNT(*) FROM redemptions r JOIN passes p ON p.id = r.pass_id WHERE p.event_id = e.id) AS redeemed_count,
  (SELECT COUNT(*) FROM passes p WHERE p.event_id = e.id AND p.revoked_at IS NOT NULL) AS revoked_count,
  (SELECT COUNT(*) FROM gates g WHERE g.event_id = e.id) AS gate_count,
  (SELECT COUNT(*) FROM admission_policies ap WHERE ap.event_id = e.id) AS policy_count,
  (SELECT COUNT(*) FROM scanners s WHERE s.event_id = e.id AND s.revoked_at IS NULL) AS scanner_count,
  (SELECT COUNT(*) FROM scans sc WHERE sc.event_id = e.id) AS scan_count`;
const EVENT_SELECT = `SELECT ${EVENT_COLUMNS} FROM events e`;

const SCANNER_SELECT = 'SELECT s.*, g.name AS gate_name FROM scanners s LEFT JOIN gates g ON g.id = s.gate_id';

const ALL_PERMISSIONS = ROLE_PERMISSIONS.owner;

function toEvent(row: Row, role: EventRole | 'operator'): EventSummary {
  return {
    id: row.id as string,
    name: row.name as string,
    venue: (row.venue as string | null) ?? null,
    timeZone: row.time_zone as string,
    startsAt: row.starts_at as string,
    endsAt: row.ends_at as string,
    status: row.status as EventStatus,
    capacity: row.capacity === null ? null : Number(row.capacity),
    admittedCount: Number(row.admitted_count),
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
    scanCount: Number(row.scan_count),
    myRole: role,
    permissions: [...(role === 'operator' ? ALL_PERMISSIONS : ROLE_PERMISSIONS[role])]
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

/** IANA zone names only; Intl rejects anything else with a RangeError. */
function assertTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    throw httpError(400, `Unknown time zone: ${timeZone}`);
  }
}
