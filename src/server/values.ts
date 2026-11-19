import type { Database } from './db';
import { httpError } from './http';

/** RFC 3339 date-time with an explicit offset or Z; offset-less strings would be read in the server's local zone. */
export const RFC3339_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

export function isRfc3339(value: string): boolean {
  return RFC3339_DATE_TIME.test(value) && !Number.isNaN(Date.parse(value));
}

/** All timestamps are stored as UTC ISO-8601 so string comparison orders them correctly. */
export function isoDate(value: string): string {
  if (!isRfc3339(value)) throw httpError(400, `Invalid date: ${value}`);
  return new Date(value).toISOString();
}

/** Archived events are read-only. Call inside the write transaction. 404 for unknown events. */
export function assertEventWritable(db: Database, eventId: string): void {
  const row = db.prepare('SELECT status FROM events WHERE id = ?').get(eventId) as { status: string } | undefined;
  if (!row) throw httpError(404, 'Event not found');
  if (row.status === 'archived') throw httpError(409, 'An archived event is read-only. Restore it to Ended first.');
}

/** node:sqlite reports constraint failures as errors whose message names the constraint. */
export function isConstraintError(error: unknown, kind: 'UNIQUE' | 'CHECK'): boolean {
  return error instanceof Error && error.message.includes(`${kind} constraint failed`);
}

export function assertWindow(startsAt: string, endsAt: string): void {
  if (endsAt <= startsAt) throw httpError(400, 'The event must end after it starts.');
}

/** IANA zone names only; Intl rejects anything else with a RangeError. */
export function assertTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    throw httpError(400, `Unknown time zone: ${timeZone}`);
  }
}
