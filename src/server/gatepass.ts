import { randomUUID } from 'node:crypto';
import { normalizeDesignConfig } from '../qr/design';
import type {
  AuditEntry,
  AuditQuery,
  DesignConfig,
  EventPermission,
  EventRole,
  EventStatus,
  EventReport,
  EventSummary,
  ImportReport,
  IssuedPass,
  OperationsSummary,
  Pass,
  PassStatus,
  ScanMethod,
  ScanOutcome,
  ScanRecord,
  ScanResult,
  Scanner,
  ScannerEnrollment,
  ScannerSession,
  ScannerSetupLink,
  StoredScanOutcome
} from '../shared/types';
import { isDiagnosticPayload } from '../shared/diagnostic';
import { Accounts } from './accounts';
import { evaluateAdmission } from './admission';
import { AttendeeAssist } from './assist';
import { listAudit, recordAudit } from './audit';
import { SCHEMA_VERSION, schemaVersion, transaction, type Database } from './db';
import { PassDeliveries } from './deliveries';
import { httpError } from './http';
import type { Mailer } from './mailer';
import { eventReport, OperationsMemo, operationsEvent, type OperationsEvent, operationsSummary } from './operations';
import { ROLE_PERMISSIONS, type Principal } from './permissions';
import { AccessControl } from './policies';
import { EventTemplates } from './templates';
import { extractPassToken, generateToken, hashToken, isWellFormedToken } from './tokens';
import { assertTimeZone, assertWindow, isoDate } from './values';

export interface GatePassOptions {
  /** Base URL encoded into pass QR codes, without trailing slash. */
  publicUrl: string;
  now?: () => Date;
  /** Injected for tests; defaults to 256-bit random tokens. */
  generateToken?: () => string;
  /** Transactional email for invitations, password resets and pass emails; disabled when absent. */
  mailer?: Mailer;
  /** PASS_DELIVERY_KEY: seals pass links waiting in the email outbox. Passes cannot be emailed without it. */
  passDeliveryKey?: Buffer | null;
  /** PASS_DELIVERY_PREVIOUS_KEYS: open links sealed before a key rotation. */
  passDeliveryPreviousKeys?: readonly Buffer[];
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
  /** Queue an email with the pass link to every attendee with an address (src/server/deliveries.ts). */
  emailPasses?: boolean;
}

export interface ImportInput {
  rows: Array<{ name?: string | null; email?: string | null }>;
  policyId?: string;
  expiresAt?: string;
  dryRun: boolean;
  /** Queue an email with the pass link to every issued attendee with an address. */
  emailPasses?: boolean;
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

export type ExportKind = 'attendance' | 'scans' | 'audit' | 'summary';

/** A CSV export opened by `GatePass.openExport` and written by `streamCsv`. */
export interface CsvExport {
  header: string[];
  /** Data rows in the export, as recorded in its `export.downloaded` audit entry. */
  rows: number;
  /** The next rows in export order; empty when every row has been returned. Synchronous and bounded. */
  next: () => unknown[][];
}

/** Rows read per export chunk: about 1–3 ms of work on a laptop, so a redeem waits at most that long behind a download. */
export const EXPORT_CHUNK_ROWS = 500;

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
  readonly templates: EventTemplates;
  readonly assist: AttendeeAssist;
  readonly deliveries: PassDeliveries;
  private readonly operationsMemo: OperationsMemo;
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
    this.accounts = new Accounts(db, { now: this.now, publicUrl: this.publicUrl, generateToken: this.newToken, mailer: options.mailer });
    this.templates = new EventTemplates(db, { access: this.access, accounts: this.accounts, now: this.now, getEvent: (id) => this.getEvent(id) });
    this.operationsMemo = new OperationsMemo(db);
    this.assist = new AttendeeAssist(db, this.access, this.now);
    this.deliveries = new PassDeliveries(db, {
      now: this.now,
      publicUrl: this.publicUrl,
      generateToken: this.newToken,
      key: options.passDeliveryKey,
      previousKeys: options.passDeliveryPreviousKeys,
      emailEnabled: this.accounts.mailer.enabled
    });
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

  /** 404 unless the event exists. One primary-key read, unlike `getEvent`, whose per-event counts cost O(passes + scans). */
  private assertEvent(eventId: string): void {
    if (!this.db.prepare('SELECT 1 FROM events WHERE id = ?').get(eventId)) throw httpError(404, 'Event not found');
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

  /**
   * Filtering, ordering and paging run in SQL; status is derived at read time. Only the filters in use are
   * part of the statement, so an unfiltered count reads `passes_event_idx` alone, and the page is picked by
   * rowid first: an offset skips index entries, not joined rows.
   */
  listPasses(eventId: string, filter: PassFilter = {}): { passes: Pass[]; total: number } {
    this.assertEvent(eventId);
    const now = this.timestamp();
    const conditions = ['p.event_id = :eventId'];
    const params: Record<string, string | number> = { eventId };
    if (filter.q) {
      conditions.push(`(p.attendee_name LIKE :q ESCAPE '\\' OR p.attendee_email LIKE :q ESCAPE '\\' OR p.id LIKE :q ESCAPE '\\')`);
      params.q = `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    }
    if (filter.policyId) {
      conditions.push('p.policy_id = :policyId');
      params.policyId = filter.policyId;
    }
    let from = 'FROM passes p';
    if (filter.status) {
      from = PASS_FROM;
      conditions.push(`${PASS_STATUS_SQL} = :status`);
      Object.assign(params, { status: filter.status, now });
    }
    const where = `${from} WHERE ${conditions.join(' AND ')}`;
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n ${where}`).get(params) as Row).n);
    const rows = this.db
      .prepare(
        `SELECT ${PASS_COLUMNS} FROM (SELECT p.rowid AS page_rowid ${where} ORDER BY p.created_at DESC, p.rowid DESC LIMIT :limit OFFSET :offset) page
         JOIN passes p ON p.rowid = page.page_rowid LEFT JOIN redemptions r ON r.pass_id = p.id
         ORDER BY p.created_at DESC, p.rowid DESC`
      )
      .all({ ...params, limit: filter.limit ?? 1000, offset: filter.offset ?? 0 }) as Row[];
    return { passes: rows.map((row) => toPass(row, now)), total };
  }

  issuePasses(eventId: string, input: IssueInput, actor: string): IssuedPass[] {
    const attendees: NonNullable<IssueInput['attendees']> = input.attendees?.length ? input.attendees : Array.from({ length: input.count ?? 1 }, () => ({}));
    if (input.emailPasses) this.deliveries.assertAvailable();
    const issued = transaction(this.db, () => this.insertPasses(eventId, attendees, input, actor, 'passes.issued'));
    if (input.emailPasses) this.deliveries.notify();
    return issued;
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
    if (input.emailPasses) this.deliveries.assertAvailable();
    if (input.dryRun) return run();
    const report = transaction(this.db, run);
    if (input.emailPasses) this.deliveries.notify();
    return report;
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
    const now = this.timestamp();
    return (this.db.prepare(`${SCANNER_SELECT} WHERE s.event_id = ? ORDER BY s.created_at DESC`).all(eventId) as Row[]).map((row) => toScanner(row, now));
  }

  /**
   * Creates the device record and a one-time setup link. The permanent key is
   * minted only when a device claims the link (`enrollScanner`), so the link
   * that travels by chat or screen is single-use and expires.
   */
  createScanner(eventId: string, label: string, gateId: string | null, actor: string): ScannerSetupLink {
    const id = randomUUID();
    const code = this.newToken();
    const enrollment = transaction(this.db, () => {
      this.getEvent(eventId);
      if (gateId) this.access.assertGate(eventId, gateId);
      // Placeholder key nobody holds: the device gets its real key on enrollment.
      this.db
        .prepare('INSERT INTO scanners (id, event_id, gate_id, label, key_hash, created_at, key_issued_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, eventId, gateId, label, hashToken(`unclaimed_${this.newToken()}`), this.timestamp(), actor);
      this.audit(eventId, actor, 'scanner.created', id, { label, gateId });
      return this.insertEnrollment(id, code, actor);
    });
    return { scanner: this.getScanner(id), enrollment };
  }

  /**
   * Stops the current key at once and returns a new one-time setup link for
   * the same device record (gate, label and history kept). Also the way to
   * replace a setup link that expired unused.
   */
  rotateScanner(id: string, actor: string): ScannerSetupLink {
    const code = this.newToken();
    const enrollment = transaction(this.db, () => {
      const scanner = this.getScanner(id);
      if (scanner.revokedAt) throw httpError(409, 'A revoked scanner cannot be rotated. Create a new one.');
      this.db.prepare('UPDATE scanners SET key_hash = ?, key_issued_by = ?, enrolled_at = NULL WHERE id = ?').run(hashToken(`unclaimed_${this.newToken()}`), actor, id);
      this.audit(scanner.eventId, actor, 'scanner.rotated', id, {});
      return this.insertEnrollment(id, code, actor);
    });
    return { scanner: this.getScanner(id), enrollment };
  }

  revokeScanner(id: string, actor: string): Scanner {
    transaction(this.db, () => {
      const scanner = this.getScanner(id);
      if (scanner.revokedAt) return;
      const at = this.timestamp();
      this.db.prepare('UPDATE scanners SET revoked_at = ? WHERE id = ?').run(at, id);
      this.db.prepare('UPDATE scanner_enrollments SET invalidated_at = ? WHERE scanner_id = ? AND used_at IS NULL AND invalidated_at IS NULL').run(at, id);
      this.audit(scanner.eventId, actor, 'scanner.revoked', id, {});
    });
    return this.getScanner(id);
  }

  /**
   * Claims a one-time setup code: exactly one device gets a fresh permanent
   * key, returned once. Unknown, used, expired or invalidated codes and
   * revoked scanners all return null (the caller answers 410).
   *
   * `claim` is a secret the device generates and keeps until it has its key.
   * If the answer to the first claim was lost, the same code with the same
   * claim (before the code expires, while no newer link exists for the
   * scanner) gets a replacement key; the key minted before stops working.
   * Without a claim a code works exactly once.
   */
  enrollScanner(code: string, claim?: string): { key: string; session: ScannerSession } | null {
    if (!isWellFormedToken(code) || (claim !== undefined && !isWellFormedToken(claim))) return null;
    const key = `gps_${this.newToken()}`;
    const codeHash = hashToken(code);
    const claimHash = claim === undefined ? null : hashToken(claim);
    // The session is built inside the claim: if building it fails, the code is not spent and the device can retry.
    return transaction(this.db, () => {
      const at = this.timestamp();
      const row = this.db
        .prepare(
          `SELECT s.id, s.event_id, s.gate_id, s.label, s.enrolled_at, e.created_by, e.used_at, e.claim_hash,
             EXISTS (SELECT 1 FROM scanner_enrollments n WHERE n.scanner_id = e.scanner_id AND n.rowid > e.rowid) AS superseded
           FROM scanner_enrollments e JOIN scanners s ON s.id = e.scanner_id
           WHERE e.token_hash = ? AND e.invalidated_at IS NULL AND e.expires_at > ? AND s.revoked_at IS NULL`
        )
        .get(codeHash, at) as Row | undefined;
      if (!row) return null;
      const scannerId = row.id as string;
      if (row.used_at === null) {
        this.db.prepare('UPDATE scanner_enrollments SET used_at = ?, claim_hash = ? WHERE token_hash = ?').run(at, claimHash, codeHash);
        // The person who created the link stays the key's issuer: removing them from the team revokes it.
        this.db.prepare('UPDATE scanners SET key_hash = ?, key_issued_by = ?, enrolled_at = ? WHERE id = ?').run(hashToken(key), row.created_by as string, at, scannerId);
        this.audit(row.event_id as string, `scanner:${scannerId}`, 'scanner.enrolled', scannerId, {});
      } else {
        // A retry is only for the device that made the first claim, and only while that claim's key is still the scanner's
        // current one: a rotation (newer link, enrolled_at cleared) ends it.
        if (claimHash === null || row.claim_hash !== claimHash || Number(row.superseded) || row.enrolled_at === null) return null;
        this.db.prepare('UPDATE scanners SET key_hash = ? WHERE id = ?').run(hashToken(key), scannerId);
        this.audit(row.event_id as string, `scanner:${scannerId}`, 'scanner.enroll_retried', scannerId, {});
      }
      return { key, session: this.scannerSession({ id: scannerId, eventId: row.event_id as string, gateId: (row.gate_id as string | null) ?? null, label: row.label as string }) };
    });
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
      event: { id: event.id, name: event.name, venue: event.venue, timeZone: event.timeZone, startsAt: event.startsAt, endsAt: event.endsAt, status: event.status },
      serverTime: now
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
   *
   * `method` (camera, manual, lookup) is recorded on the scan row only; it never
   * changes the decision. A replay keeps the method of the original attempt.
   */
  redeem(scanner: AuthenticatedScanner, code: string, requestId?: string, method?: ScanMethod): ScanResult {
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
        .prepare('INSERT INTO scans (event_id, scanner_id, gate_id, pass_id, outcome, created_at, request_id, method) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(scanner.eventId, scanner.id, scanner.gateId, pass?.id ?? null, outcome, checkedAt, requestId ?? null, method ?? null);
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
    this.assertEvent(eventId);
    const rows = this.db
      .prepare(
        `SELECT s.id, s.event_id, s.scanner_id, sc.label AS scanner_label, s.gate_id, g.name AS gate_name, s.pass_id, p.attendee_name, s.outcome, s.created_at, s.method
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
      createdAt: row.created_at as string,
      method: (row.method as ScanMethod | null) ?? null
    }));
  }

  /** Served from a ≤2 s per-event memo (see `OperationsMemo`); the caller has already authorized the event. */
  operations(eventId: string): Promise<OperationsSummary> {
    const now = this.now();
    return this.operationsMemo.get(eventId, now, () => operationsSummary(this.db, this.access, operationsEvent(this.db, eventId), now));
  }

  /** Post-event figures (`GET …/report`, `exports/summary.csv`); computed on request, not memoised. */
  report(eventId: string): Promise<EventReport> {
    return eventReport(this.db, this.access, operationsEvent(this.db, eventId), this.now());
  }

  listAudit(eventId: string, query: AuditQuery = {}): AuditEntry[] {
    this.assertEvent(eventId);
    return listAudit(this.db, eventId, query);
  }

  // ---------------------------------------------------------------- exports

  /**
   * Opens a CSV export for streaming (`streamCsv` in src/server/csv.ts). The export covers the rows that
   * exist now: everything up to the current highest row id, so the audited row count is exact even while
   * scans keep arriving. The `export.downloaded` entry, with that count, is written here, before the first
   * byte leaves, as before streaming: a download that the client abandons is still on record. Each `next()`
   * reads one keyset chunk of at most `EXPORT_CHUNK_ROWS` rows to completion, so no statement stays open
   * between chunks; a row shows its state when its chunk was read (a pass admitted mid-download appears as
   * redeemed if its chunk comes later).
   */
  async openExport(eventId: string, kind: ExportKind, actor: string): Promise<CsvExport> {
    const event = operationsEvent(this.db, eventId);
    const exported = kind === 'summary' ? await this.summaryExport(event.id) : this.tableExport(event, kind);
    this.recordExport(event.id, actor, kind, exported.rows);
    return exported;
  }

  private tableExport(event: OperationsEvent, kind: Exclude<ExportKind, 'summary'>): CsvExport {
    const now = this.timestamp();
    const maxId = (table: string, column: string) => Number((this.db.prepare(`SELECT COALESCE(MAX(${column}), 0) AS id FROM ${table}`).get() as Row).id);
    if (kind === 'attendance') {
      const last = maxId('passes', 'rowid');
      let after: { createdAt: string; rowid: number } = { createdAt: '', rowid: 0 };
      return {
        header: ['pass_id', 'reference', 'attendee_name', 'attendee_email', 'policy', 'status', 'issued_at', 'expires_at', 'revoked_at', 'admitted_at', 'gate', 'scanner', 'time_zone'],
        rows: Number((this.db.prepare('SELECT COUNT(*) AS n FROM passes WHERE event_id = ? AND rowid <= ?').get(event.id, last) as Row).n),
        next: () => {
          const rows = this.db
            .prepare(
              `SELECT p.rowid AS row_key, p.id, p.attendee_name, p.attendee_email, ap.name AS policy, p.created_at, p.expires_at, p.revoked_at, r.redeemed_at,
                      g.name AS gate, sc.label AS scanner, ${PASS_STATUS_SQL} AS status
               FROM passes p LEFT JOIN redemptions r ON r.pass_id = p.id LEFT JOIN admission_policies ap ON ap.id = p.policy_id
               LEFT JOIN gates g ON g.id = r.gate_id LEFT JOIN scanners sc ON sc.id = r.scanner_id
               WHERE p.event_id = :eventId AND p.rowid <= :last AND (p.created_at, p.rowid) > (:createdAt, :rowid)
               ORDER BY p.created_at, p.rowid LIMIT :limit`
            )
            .all({ eventId: event.id, now, last, createdAt: after.createdAt, rowid: after.rowid, limit: EXPORT_CHUNK_ROWS }) as Row[];
          if (rows.length) after = { createdAt: rows.at(-1)!.created_at as string, rowid: Number(rows.at(-1)!.row_key) };
          return rows.map((row) => [
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
          ]);
        }
      };
    }
    if (kind === 'scans') {
      const last = maxId('scans', 'id');
      let after = 0;
      return {
        header: ['scan_id', 'time_utc', 'outcome', 'gate', 'scanner', 'pass_reference', 'attendee_name', 'method'],
        rows: Number((this.db.prepare('SELECT COUNT(*) AS n FROM scans WHERE event_id = ? AND id <= ?').get(event.id, last) as Row).n),
        next: () => {
          const rows = this.db
            .prepare(
              `SELECT s.id, s.created_at, s.outcome, g.name AS gate, sc.label AS scanner, s.pass_id, p.attendee_name, s.method
               FROM scans s JOIN scanners sc ON sc.id = s.scanner_id LEFT JOIN gates g ON g.id = s.gate_id LEFT JOIN passes p ON p.id = s.pass_id
               WHERE s.event_id = ? AND s.id > ? AND s.id <= ? ORDER BY s.id LIMIT ?`
            )
            .all(event.id, after, last, EXPORT_CHUNK_ROWS) as Row[];
          if (rows.length) after = Number(rows.at(-1)!.id);
          return rows.map((row) => [
            row.id,
            row.created_at,
            row.outcome,
            row.gate,
            row.scanner,
            row.pass_id ? (row.pass_id as string).slice(0, 8).toUpperCase() : null,
            row.attendee_name,
            row.method
          ]);
        }
      };
    }
    // Oldest first, every entry of the event (the previous export stopped at the newest 100,000).
    const last = maxId('audit_log', 'id');
    let after = 0;
    return {
      header: ['id', 'time_utc', 'actor', 'action', 'entity_id', 'details'],
      rows: Number((this.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE event_id = ? AND id <= ?').get(event.id, last) as Row).n),
      next: () => {
        // Actor labels as in listAudit (src/server/audit.ts): account email, device label, or the raw actor.
        const rows = this.db
          .prepare(
            `SELECT a.id, a.created_at, COALESCE(u.email, sc.label, a.actor) AS actor_label, a.action, a.entity_id, a.details_json
             FROM audit_log a
             LEFT JOIN users u ON u.id = CASE WHEN a.actor LIKE 'user:%' THEN substr(a.actor, 6) END
             LEFT JOIN scanners sc ON sc.id = CASE WHEN a.actor LIKE 'scanner:%' THEN substr(a.actor, 9) END
             WHERE a.event_id = ? AND a.id > ? AND a.id <= ? ORDER BY a.id LIMIT ?`
          )
          .all(event.id, after, last, EXPORT_CHUNK_ROWS) as Row[];
        if (rows.length) after = Number(rows.at(-1)!.id);
        return rows.map((row) => [row.id, row.created_at, row.actor_label, row.action, row.entity_id, JSON.stringify(JSON.parse(row.details_json as string))]);
      }
    };
  }

  /** The post-event report as `section,item,metric,value` rows: small, so it is built at once. */
  private async summaryExport(eventId: string): Promise<CsvExport> {
    const report = await this.report(eventId);
    const rows: unknown[][] = [
      ['event', report.event.name, 'time_zone', report.event.timeZone],
      ['event', report.event.name, 'starts_at', report.event.startsAt],
      ['event', report.event.name, 'ends_at', report.event.endsAt],
      ['event', report.event.name, 'status', report.event.status],
      ...Object.entries(report.passes).map(([metric, value]) => ['passes', '', metric, value]),
      ['attendance', '', 'expected', report.attendance.expected],
      ['attendance', '', 'admitted', report.attendance.admitted],
      ['attendance', '', 'rate', report.attendance.rate === null ? null : report.attendance.rate.toFixed(4)],
      ['attendance', '', 'assisted_admissions', report.assistedAdmissions]
    ];
    if (report.peak) {
      rows.push(
        ['peak', report.peak.timeZone, 'local_start', report.peak.localStart],
        ['peak', report.peak.timeZone, 'local_end', report.peak.localEnd],
        ['peak', 'UTC', 'start', report.peak.start],
        ['peak', '', 'admitted', report.peak.admitted]
      );
    }
    for (const gate of report.gates) rows.push(['gate', gate.name, 'admitted', gate.admitted], ['gate', gate.name, 'denied', gate.denied]);
    for (const denial of report.denials) rows.push(['denial', denial.outcome, 'count', denial.count]);
    for (const scanner of report.scanners) {
      rows.push(
        ['scanner', scanner.label, 'gate', scanner.gateName],
        ['scanner', scanner.label, 'scans', scanner.scans],
        ['scanner', scanner.label, 'admitted', scanner.admitted],
        ['scanner', scanner.label, 'first_scan_at', scanner.firstScanAt],
        ['scanner', scanner.label, 'last_scan_at', scanner.lastScanAt],
        ['scanner', scanner.label, 'last_contact_at', scanner.lastContactAt],
        ['scanner', scanner.label, 'revoked', scanner.revoked ? 'yes' : 'no']
      );
    }
    let pending: unknown[][] = rows;
    return {
      header: ['section', 'item', 'metric', 'value'],
      rows: rows.length,
      next: () => {
        const chunk = pending;
        pending = [];
        return chunk;
      }
    };
  }

  /**
   * Readiness probe for /api/health: the connection is open, the schema is
   * the one this build expects, and the admission tables answer an indexed
   * read. Throws otherwise. Cheap enough to run on every health check.
   */
  ping(): number {
    const version = schemaVersion(this.db);
    if (version !== SCHEMA_VERSION) throw new Error(`Database schema version ${version} differs from this build (${SCHEMA_VERSION})`);
    this.db.prepare('SELECT (SELECT 1 FROM events LIMIT 1), (SELECT 1 FROM redemptions LIMIT 1), (SELECT 1 FROM scanners LIMIT 1)').get();
    return version;
  }

  // ---------------------------------------------------------------- internals

  /**
   * Pass for a scanned value: full URL or token (any event), or an 8-character reference resolved only within the scanner's event.
   * A camera test code (`gatepass:diagnostic:…`) is never a pass, whatever follows the prefix.
   */
  private findScannedPass(eventId: string, code: string): Row | undefined {
    if (isDiagnosticPayload(code)) return undefined;
    const token = extractPassToken(code);
    if (token) return this.db.prepare(`SELECT ${PASS_COLUMNS} ${PASS_FROM} WHERE p.token_hash = ?`).get(hashToken(token)) as Row | undefined;
    const reference = code.trim();
    if (!REFERENCE.test(reference)) return undefined;
    // `+p.event_id` keeps SQLite on the id range (one or two rows): without statistics it would otherwise read
    // every pass of the event through passes_event_idx, inside the write lock (about 14 ms at 25,000 passes).
    const rows = this.db
      .prepare(`SELECT ${PASS_COLUMNS} ${PASS_FROM} WHERE +p.event_id = ? AND p.id >= ? AND p.id < ? LIMIT 2`)
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
    input: { expiresAt?: string; policyId?: string; emailPasses?: boolean },
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
    if (input.emailPasses) this.deliveries.queueIssuedInTransaction(eventId, issued, actor);
    return issued;
  }

  private recordExport(eventId: string, actor: string, kind: string, rows: number): void {
    transaction(this.db, () => this.audit(eventId, actor, 'export.downloaded', null, { kind, rows }));
  }

  private getScanner(id: string): Scanner {
    const row = this.db.prepare(`${SCANNER_SELECT} WHERE s.id = ?`).get(id) as Row | undefined;
    if (!row) throw httpError(404, 'Scanner not found');
    return toScanner(row, this.timestamp());
  }

  /**
   * Must run inside a transaction. Only the newest setup link of a device works.
   * The code travels in the URL fragment, which browsers never send to a server or proxy log;
   * the returned expiry is the one stored, so the link never claims more time than the server allows.
   */
  private insertEnrollment(scannerId: string, code: string, actor: string): ScannerEnrollment {
    const now = this.now();
    const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_MS).toISOString();
    this.db.prepare('UPDATE scanner_enrollments SET invalidated_at = ? WHERE scanner_id = ? AND used_at IS NULL AND invalidated_at IS NULL').run(now.toISOString(), scannerId);
    this.db
      .prepare('INSERT INTO scanner_enrollments (token_hash, scanner_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(hashToken(code), scannerId, actor, now.toISOString(), expiresAt);
    return { url: `${this.publicUrl}/scan#enroll=${code}`, expiresAt };
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
  (SELECT COUNT(*) FROM scanners s WHERE s.event_id = e.id AND s.revoked_at IS NULL
     AND (s.enrolled_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM scanner_enrollments n WHERE n.scanner_id = s.id))) AS ready_scanner_count,
  (SELECT COUNT(*) FROM scans sc WHERE sc.event_id = e.id) AS scan_count`;
const EVENT_SELECT = `SELECT ${EVENT_COLUMNS} FROM events e`;

const SCANNER_SELECT = `SELECT s.*, g.name AS gate_name,
  (SELECT MAX(e.expires_at) FROM scanner_enrollments e WHERE e.scanner_id = s.id AND e.used_at IS NULL AND e.invalidated_at IS NULL) AS setup_expires_at,
  EXISTS (SELECT 1 FROM scanner_enrollments e WHERE e.scanner_id = s.id) AS has_enrollments
  FROM scanners s LEFT JOIN gates g ON g.id = s.gate_id`;

/** Lifetime of a one-time scanner setup link. */
export const ENROLLMENT_TTL_MS = 60 * 60_000;

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
    readyScannerCount: Number(row.ready_scanner_count),
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

function toScanner(row: Row, now: string): Scanner {
  const enrolledAt = (row.enrolled_at as string | null) ?? null;
  const pendingUntil = (row.setup_expires_at as string | null) ?? null;
  const pending = pendingUntil !== null && pendingUntil > now;
  return {
    id: row.id as string,
    eventId: row.event_id as string,
    label: row.label as string,
    gateId: (row.gate_id as string | null) ?? null,
    gateName: (row.gate_name as string | null) ?? null,
    createdAt: row.created_at as string,
    revokedAt: (row.revoked_at as string | null) ?? null,
    lastUsedAt: (row.last_used_at as string | null) ?? null,
    enrolledAt,
    setup: pending ? 'pending' : enrolledAt ? 'enrolled' : Number(row.has_enrollments) ? 'expired' : 'legacy',
    setupExpiresAt: pending ? pendingUntil : null
  };
}
