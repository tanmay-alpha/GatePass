import type { ScanOutcome, ScanResult } from '../../shared/types';
import { ApiError } from '../api';
import { OUTCOME_LABEL } from '../ui';

/** What door staff should do. Each verdict has its own colour, icon and headline. */
export type Verdict = 'admit' | 'warn' | 'deny' | 'error';

export const VERDICT_HEADLINE: Record<Verdict, string> = {
  admit: 'Admit',
  warn: 'Already used',
  deny: 'Denied',
  error: 'Not verified'
};

/** Shown with a replayed result: the original answer to a request whose response was lost. */
export const REPLAYED_NOTE = 'Confirmed after reconnect';

/** Every outcome the scanner understands; a new server outcome fails type-checking here. */
const OUTCOMES: Record<ScanOutcome, true> = {
  admitted: true,
  already_redeemed: true,
  expired: true,
  revoked: true,
  invalid: true,
  event_closed: true,
  too_early: true,
  too_late: true,
  wrong_gate: true,
  capacity_full: true
};

/** Guards the one place a verdict comes from: anything but a well-formed server result is "Not verified". */
export function isScanResult(value: unknown): value is ScanResult {
  return typeof value === 'object' && value !== null && 'outcome' in value && typeof value.outcome === 'string' && Object.hasOwn(OUTCOMES, value.outcome);
}

/** Only an explicit `admitted` from the server is ever "Admit". */
export function verdictOf(outcome: ScanOutcome): Verdict {
  if (outcome === 'admitted') return 'admit';
  if (outcome === 'already_redeemed') return 'warn';
  return 'deny';
}

/** Formats in the event's zone; falls back to UTC if the zone is unknown to this browser. */
function zoned(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone });
  } catch {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' });
  }
}

/** "19:02" in the event's zone, with the date when it is not the event-local today. */
export function formatEventTime(iso: string, timeZone: string, now = new Date()): string {
  const date = new Date(iso);
  const day = zoned(timeZone, { year: 'numeric', month: 'short', day: 'numeric' });
  const time = zoned(timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  return day.format(date) === day.format(now) ? time : `${day.format(date)} ${time}`;
}

/** Event-local wall clock for the header: "19:02 GMT+5:30". */
export function formatEventClock(now: Date, timeZone: string): string {
  return zoned(timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).format(now);
}

/** Staff-facing explanation. Uses only the safe `detail` fields the server returns. Times are event-local. */
export function explain(result: ScanResult, timeZone: string): string {
  const detail = result.detail ?? {};
  switch (result.outcome) {
    case 'admitted':
      return 'Let them in.';
    case 'already_redeemed': {
      if (!result.pass?.redeemedAt) return 'This pass was already used.';
      const gate = detail.redeemedAtGate ? ` at ${detail.redeemedAtGate}` : '';
      const device = detail.sameDevice ? ' on this device' : '';
      return `First used at ${formatEventTime(result.pass.redeemedAt, timeZone)}${gate}${device}.`;
    }
    case 'expired':
      return 'This pass has expired.';
    case 'revoked':
      return 'This pass was revoked by the organiser.';
    case 'invalid':
      return 'Not a valid pass for this event.';
    case 'event_closed':
      return 'Check-in for this event is closed.';
    case 'too_early':
      return detail.opensAt ? `Entry opens at ${formatEventTime(detail.opensAt, timeZone)}` : 'Entry for this pass has not opened yet.';
    case 'too_late':
      return detail.closesAt ? `Entry closed at ${formatEventTime(detail.closesAt, timeZone)}` : 'Entry for this pass has closed.';
    case 'wrong_gate':
      return detail.allowedGates?.length ? `Use gate: ${detail.allowedGates.join(', ')}` : 'This pass is not valid at this gate.';
    case 'capacity_full': {
      const limit = detail.capacity !== undefined ? ` (${detail.capacity})` : '';
      return detail.eventCapacity ? `The event is full${limit}` : `${detail.policyName ?? 'This entry group'} is full${limit}`;
    }
  }
}

/** Reason shown under the headline; omitted when it would repeat the headline. */
export function reasonLabel(result: ScanResult): string | null {
  return verdictOf(result.outcome) === 'deny' ? OUTCOME_LABEL[result.outcome] : null;
}

/**
 * Failures never imply admission: the server is the only authority. Rate
 * limiting gets its own wording so staff know to pause rather than retry.
 */
export function explainFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.failure === 'timeout') return 'No response from the server. Do not admit. Tap Retry verification.';
    if (error.failure === 'network') return 'No connection to the server. Do not admit. Tap Retry verification when back online.';
    if (error.status === 429) return error.retryAfter ? `Too many scans, wait ${error.retryAfter} s` : 'Too many scans, wait a moment';
    if (error.status >= 500) return 'Server error. Do not admit; scan again.';
    return `${error.message.replace(/\.$/, '')}. Do not admit; scan again.`;
  }
  return 'The server sent an unexpected answer. Do not admit; scan again.';
}
