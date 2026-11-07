import type { AuditEntry } from '../shared/types';
import type { Database } from './db';

/** Admin actions only; scan attempts live in the `scans` table. Call inside the mutating transaction. */
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

export function listAudit(db: Database, eventId: string, limit = 100): AuditEntry[] {
  const rows = db.prepare('SELECT * FROM audit_log WHERE event_id = ? ORDER BY id DESC LIMIT ?').all(eventId, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: Number(row.id),
    eventId: (row.event_id as string | null) ?? null,
    actor: row.actor as string,
    action: row.action as string,
    entityId: (row.entity_id as string | null) ?? null,
    details: JSON.parse(row.details_json as string) as Record<string, unknown>,
    createdAt: row.created_at as string
  }));
}
