import { httpError } from './http';

/** All timestamps are stored as UTC ISO-8601 so string comparison orders them correctly. */
export function isoDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw httpError(400, `Invalid date: ${value}`);
  return date.toISOString();
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
