import type { AuditEntry, AuditQuery } from '../shared/types';
import type { Database } from './db';

/** Admin and security actions; scan attempts live in the `scans` table. Call inside the mutating transaction. */
export function recordAudit(
  db: Database,
  entry: { eventId: string | null; actor: string; action: string; entityId: string | null; details: Record<string, unknown>; at: string }
): void {
  db.prepare('INSERT INTO audit_log (event_id, actor, action, entity_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    entry.eventId,
    entry.actor,
    entry.action,
    entry.entityId,
    JSON.stringify(entry.details),
    entry.at
  );
}

const LIKE_ESCAPE = /[\\%_]/g;

/**
 * Newest first. `eventId` null lists platform-level entries (accounts,
 * sign-ins, organizer invitations). Actor labels resolve `user:<id>` to the
 * account email and `scanner:<id>` to the device label.
 */
export function listAudit(db: Database, eventId: string | null, query: AuditQuery = {}): AuditEntry[] {
  const action = query.action?.trim() || null;
  const prefix = action?.endsWith('.') ? `${action.replace(LIKE_ESCAPE, (c) => `\\${c}`)}%` : null;
  const q = query.q?.trim() ? `%${query.q.trim().replace(LIKE_ESCAPE, (c) => `\\${c}`)}%` : null;
  const rows = db
    .prepare(
      `SELECT a.*, COALESCE(u.email, sc.label, a.actor) AS actor_label
       FROM audit_log a
       LEFT JOIN users u ON u.id = CASE WHEN a.actor LIKE 'user:%' THEN substr(a.actor, 6) END
       LEFT JOIN scanners sc ON sc.id = CASE WHEN a.actor LIKE 'scanner:%' THEN substr(a.actor, 9) END
       WHERE a.event_id IS :eventId
         AND (:before IS NULL OR a.id < :before)
         AND (:action IS NULL OR (:prefix IS NULL AND a.action = :action) OR (:prefix IS NOT NULL AND a.action LIKE :prefix ESCAPE '\\'))
         AND (:q IS NULL OR a.entity_id LIKE :q ESCAPE '\\' OR a.details_json LIKE :q ESCAPE '\\' OR COALESCE(u.email, sc.label, a.actor) LIKE :q ESCAPE '\\')
       ORDER BY a.id DESC LIMIT :limit`
    )
    .all({ eventId, before: query.before ?? null, action, prefix, q, limit: query.limit ?? 100 }) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: Number(row.id),
    eventId: (row.event_id as string | null) ?? null,
    actor: row.actor as string,
    actorLabel: row.actor_label as string,
    action: row.action as string,
    entityId: (row.entity_id as string | null) ?? null,
    details: JSON.parse(row.details_json as string) as Record<string, unknown>,
    createdAt: row.created_at as string
  }));
}
