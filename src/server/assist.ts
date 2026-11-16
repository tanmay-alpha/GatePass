import { z } from 'zod';
import type { AttendeeMatch, AttendeeSearch, EventStatus, PassStatus } from '../shared/types';
import { evaluateAdmission, type AdmissionInput } from './admission';
import { recordAudit } from './audit';
import { transaction, type Database } from './db';
import type { AuthenticatedScanner } from './gatepass';
import type { AccessControl } from './policies';

/** At most this many matches go back to the door; more means "refine the search". */
export const ASSIST_MAX_RESULTS = 10;
export const ASSIST_MIN_QUERY = 3;

/** `GET /api/scanner/attendees?q=`: a name fragment, an exact email address, or the start of a pass reference. */
export const attendeeQuerySchema = z.object({
  q: z.string().trim().min(ASSIST_MIN_QUERY, `Enter at least ${ASSIST_MIN_QUERY} characters.`).max(100)
});

const HEX_PREFIX = /^[0-9a-f]{3,8}$/i;
const LIKE_ESCAPE = /[\\%_]/g;

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
 */
export class AttendeeAssist {
  constructor(
    private readonly db: Database,
    private readonly access: AccessControl,
    private readonly now: () => Date
  ) {}

  search(scanner: AuthenticatedScanner, query: string): AttendeeSearch {
    const q = query.trim();
    const checkedAt = this.now().toISOString();
    const reference = HEX_PREFIX.test(q) ? q.toLowerCase() : null;
    return transaction(this.db, () => {
      const rows = this.db
        .prepare(
          `SELECT p.id, p.policy_id, p.attendee_name, p.attendee_email, p.expires_at, p.revoked_at,
                  r.redeemed_at, r.scanner_id AS redeemed_by, (SELECT name FROM gates WHERE id = r.gate_id) AS redeemed_gate,
                  (SELECT name FROM admission_policies WHERE id = p.policy_id) AS policy_name,
                  (SELECT COUNT(*) FROM passes o WHERE o.event_id = p.event_id AND o.id >= substr(p.id, 1, 8) AND o.id < substr(p.id, 1, 8) || 'g') AS same_reference
           FROM passes p LEFT JOIN redemptions r ON r.pass_id = p.id
           WHERE p.event_id = :eventId
             AND (p.attendee_name LIKE :like ESCAPE '\\'
                  OR (:email IS NOT NULL AND lower(p.attendee_email) = :email)
                  OR (:reference IS NOT NULL AND p.id >= :reference AND p.id < :reference || 'g'))
           ORDER BY CASE WHEN :reference IS NOT NULL AND p.id >= :reference AND p.id < :reference || 'g' THEN 0 ELSE 1 END,
                    p.attendee_name COLLATE NOCASE, p.id
           LIMIT :limit`
        )
        .all({
          eventId: scanner.eventId,
          like: `%${q.replace(LIKE_ESCAPE, (c) => `\\${c}`)}%`,
          email: q.includes('@') ? q.toLowerCase() : null,
          reference,
          limit: ASSIST_MAX_RESULTS + 1
        }) as Row[];

      const eventRow = this.db.prepare('SELECT starts_at, ends_at, status, capacity, admitted_count FROM events WHERE id = ?').get(scanner.eventId) as Row;
      const event: AdmissionInput['event'] = {
        startsAt: eventRow.starts_at as string,
        endsAt: eventRow.ends_at as string,
        status: eventRow.status as EventStatus,
        capacity: eventRow.capacity === null ? null : Number(eventRow.capacity),
        admittedCount: Number(eventRow.admitted_count)
      };
      const policies = new Map<string, AdmissionInput['policy']>();
      const policyOf = (id: string | null) => {
        if (!id) return null;
        if (!policies.has(id)) policies.set(id, this.access.admissionPolicy(id));
        return policies.get(id) ?? null;
      };

      const matches = rows.slice(0, ASSIST_MAX_RESULTS).map((row): AttendeeMatch => {
        const redeemedAt = (row.redeemed_at as string | null) ?? null;
        const status: PassStatus = redeemedAt ? 'redeemed' : row.revoked_at ? 'revoked' : (row.expires_at as string) <= checkedAt ? 'expired' : 'active';
        const redeemedAtGate = (row.redeemed_gate as string | null) ?? null;
        const decision = evaluateAdmission({
          now: checkedAt,
          scanner,
          event,
          pass: { eventId: scanner.eventId, status },
          policy: policyOf((row.policy_id as string | null) ?? null)
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
      });

      recordAudit(this.db, {
        eventId: scanner.eventId,
        actor: `scanner:${scanner.id}`,
        action: 'scanner.attendee_lookup',
        entityId: scanner.id,
        details: { results: matches.length, more: rows.length > ASSIST_MAX_RESULTS, references: matches.map((match) => match.reference) },
        at: checkedAt
      });
      return { matches, more: rows.length > ASSIST_MAX_RESULTS };
    });
  }
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
