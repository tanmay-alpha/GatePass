import { z } from 'zod';
import type { AttendeeMatch, AttendeeSearch, EventStatus, PassStatus } from '../shared/types';
import { evaluateAdmission, type AdmissionInput } from './admission';
import { recordAudit } from './audit';
import { transaction, type Database } from './db';
import type { AuthenticatedScanner } from './gatepass';
import { httpError } from './http';
import type { AccessControl } from './policies';

/** A search matching more passes than this returns none of them: "refine the search". */
export const ASSIST_MAX_RESULTS = 10;
export const ASSIST_MIN_QUERY = 3;
/** Searches one device may make in any 24 hours (a stolen key cannot page through the guest list). */
export const ASSIST_DAILY_LIMIT = 300;
const DAY_MS = 86_400_000;
/** Words of a name query that are matched; more words only narrow a search that already found few. */
const MAX_WORDS = 6;

/** `GET /api/scanner/attendees?q=`: the start of words in a name, an exact email address, or the start of a pass reference. */
export const attendeeQuerySchema = z.object({
  q: z.string().trim().min(ASSIST_MIN_QUERY, `Enter at least ${ASSIST_MIN_QUERY} characters.`).max(100)
});

const HEX_PREFIX = /^[0-9a-f]{3,8}$/i;
const LIKE_ESCAPE = /[\\%_]/g;
const LOOKUP_ACTION = 'scanner.attendee_lookup';

type Row = Record<string, unknown>;

/**
 * Event-day help at the door when an attendee's QR code is lost or unreadable
 * (docs/decisions/0013-scanner-readiness-and-door-assistance.md).
 *
 * A scanner device may search the passes of its own event only. A match carries
 * the printed reference, the name, a masked email and the pass state with what a
 * scan at this device would say now; never a token, a token hash or a full email
 * address. Admitting is not done here: the door sends the reference through
 * `POST /api/scanner/redeem`, so the same atomic checks, capacity claims and scan
 * row apply. Each search is recorded in the audit log (result references only;
 * the query text may be a person's name and is not stored).
 *
 * The guest list must not be readable through a door phone's key: names match
 * from the start of a word only, a search that matches more than
 * {@link ASSIST_MAX_RESULTS} passes returns none of them, and each device has a
 * budget of {@link ASSIST_DAILY_LIMIT} searches per 24 hours, counted from the
 * audit log so a restart does not reset it.
 *
 * The search reads without the write lock (it never delays a redemption on
 * another connection); only the audit row is written, in its own short transaction.
 */
export class AttendeeAssist {
  constructor(
    private readonly db: Database,
    private readonly access: AccessControl,
    private readonly now: () => Date
  ) {}

  search(scanner: AuthenticatedScanner, query: string): AttendeeSearch {
    const q = query.trim();
    const at = this.now();
    const checkedAt = at.toISOString();
    this.assertBudget(scanner, at);

    const reference = HEX_PREFIX.test(q) ? q.toLowerCase() : null;
    const words = [...new Set(q.toLowerCase().split(/\s+/))].slice(0, MAX_WORDS);
    // `' ' || name` with hyphens as spaces: each word of the query must start a word of the name ("lov" finds "Ada Lovelace", "luc" finds "Jean-Luc").
    const nameMatch = words.map((_, i) => `(' ' || replace(p.attendee_name, '-', ' ')) LIKE :w${i} ESCAPE '\\'`).join(' AND ');
    const params: Record<string, string | number | null> = {
      eventId: scanner.eventId,
      email: q.includes('@') ? q.toLowerCase() : null,
      reference,
      limit: ASSIST_MAX_RESULTS + 1
    };
    words.forEach((word, i) => (params[`w${i}`] = `% ${word.replace(LIKE_ESCAPE, (c) => `\\${c}`)}%`));
    // No ORDER BY: the scan stops at the first match too many, so a broad query costs no more than a narrow one.
    // `+o.event_id` keeps the reference count on the id range (a few rows) instead of every pass of the event.
    const rows = this.db
      .prepare(
        `SELECT p.id, p.policy_id, p.attendee_name, p.attendee_email, p.expires_at, p.revoked_at,
                r.redeemed_at, r.scanner_id AS redeemed_by, (SELECT name FROM gates WHERE id = r.gate_id) AS redeemed_gate,
                (SELECT name FROM admission_policies WHERE id = p.policy_id) AS policy_name,
                (SELECT COUNT(*) FROM passes o WHERE +o.event_id = p.event_id AND o.id >= substr(p.id, 1, 8) AND o.id < substr(p.id, 1, 8) || 'g') AS same_reference
         FROM passes p LEFT JOIN redemptions r ON r.pass_id = p.id
         WHERE p.event_id = :eventId
           AND ((${nameMatch})
                OR (:email IS NOT NULL AND lower(p.attendee_email) = :email)
                OR (:reference IS NOT NULL AND p.id >= :reference AND p.id < :reference || 'g'))
         LIMIT :limit`
      )
      .all(params) as Row[];
    const more = rows.length > ASSIST_MAX_RESULTS;
    const shown = more ? [] : rows.sort(byRelevance(reference));
    const event = this.event(scanner.eventId);
    const matches = shown.map((row) => this.toMatch(scanner, event, row, checkedAt));

    transaction(this.db, () =>
      recordAudit(this.db, {
        eventId: scanner.eventId,
        actor: `scanner:${scanner.id}`,
        action: LOOKUP_ACTION,
        entityId: scanner.id,
        details: { results: matches.length, more, references: matches.map((match) => match.reference) },
        at: checkedAt
      })
    );
    return { matches, more };
  }

  /** Throws 429 once this device has searched {@link ASSIST_DAILY_LIMIT} times in the last 24 hours. */
  private assertBudget(scanner: AuthenticatedScanner, at: Date): void {
    const since = new Date(at.getTime() - DAY_MS).toISOString();
    const used = this.db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM audit_log
         WHERE event_id = ? AND action = '${LOOKUP_ACTION}' AND entity_id = ? AND created_at > ?`
      )
      .get(scanner.eventId, scanner.id, since) as { n: number; oldest: string | null };
    if (Number(used.n) < ASSIST_DAILY_LIMIT) return;
    const freesAt = new Date(used.oldest!).getTime() + DAY_MS;
    // The route sends this as Retry-After.
    throw Object.assign(
      httpError(429, `This device has used its ${ASSIST_DAILY_LIMIT} attendee searches for the last 24 hours. Check passes by their reference or link, or ask the organiser.`),
      { retryAfter: Math.max(1, Math.ceil((freesAt - at.getTime()) / 1000)) }
    );
  }

  private toMatch(scanner: AuthenticatedScanner, event: AdmissionInput['event'], row: Row, checkedAt: string): AttendeeMatch {
    const redeemedAt = (row.redeemed_at as string | null) ?? null;
    const status: PassStatus = redeemedAt ? 'redeemed' : row.revoked_at ? 'revoked' : (row.expires_at as string) <= checkedAt ? 'expired' : 'active';
    const redeemedAtGate = (row.redeemed_gate as string | null) ?? null;
    const decision = evaluateAdmission({
      now: checkedAt,
      scanner,
      event,
      pass: { eventId: scanner.eventId, status },
      policy: row.policy_id ? this.access.admissionPolicy(row.policy_id as string) : null
    });
    let check: AttendeeMatch['check'];
    if (decision.admit) check = { admit: true };
    else if (decision.outcome === 'already_redeemed') check = { admit: false, outcome: 'already_redeemed', detail: { redeemedAtGate, sameDevice: row.redeemed_by === scanner.id } };
    else check = { admit: false, outcome: decision.outcome === 'wrong_event' ? 'invalid' : decision.outcome, ...(decision.detail ? { detail: decision.detail } : {}) };
    return {
      reference: (row.id as string).slice(0, 8).toUpperCase(),
      attendeeName: (row.attendee_name as string | null) ?? null,
      emailHint: maskEmail((row.attendee_email as string | null) ?? null),
      status,
      redeemedAt,
      redeemedAtGate,
      policyName: (row.policy_name as string | null) ?? null,
      check,
      ambiguous: Number(row.same_reference) > 1
    };
  }

  private event(eventId: string): AdmissionInput['event'] {
    const row = this.db.prepare('SELECT starts_at, ends_at, status, capacity, admitted_count FROM events WHERE id = ?').get(eventId) as Row;
    return {
      startsAt: row.starts_at as string,
      endsAt: row.ends_at as string,
      status: row.status as EventStatus,
      capacity: row.capacity === null ? null : Number(row.capacity),
      admittedCount: Number(row.admitted_count)
    };
  }
}

/** Reference matches first, then by name (case-insensitive), then by pass id. */
function byRelevance(reference: string | null): (a: Row, b: Row) => number {
  const isReference = (row: Row) => (reference !== null && (row.id as string).startsWith(reference) ? 0 : 1);
  const name = (row: Row) => ((row.attendee_name as string | null) ?? '').toLowerCase();
  return (a, b) => isReference(a) - isReference(b) || name(a).localeCompare(name(b)) || (a.id as string).localeCompare(b.id as string);
}

/** `ada@example.org` → `a***@e***.org`: enough to tell namesakes apart, not enough to contact anyone. */
export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local[0]}***@${domain[0] ?? ''}***${tld}`;
}
