import type { ScanResult } from '../../shared/types';
import { ApiError, formatTime } from '../api';
import { OUTCOME_LABEL } from '../ui';

/** What door staff should do. Each verdict has its own colour, icon and headline. */
export type Verdict = 'admit' | 'warn' | 'deny' | 'error';

export const VERDICT_HEADLINE: Record<Verdict, string> = {
  admit: 'Admit',
  warn: 'Already used',
  deny: 'Denied',
  error: 'Not verified'
};

export function verdictOf(outcome: ScanResult['outcome']): Verdict {
  if (outcome === 'admitted') return 'admit';
  if (outcome === 'already_redeemed') return 'warn';
  return 'deny';
}

/** Staff-facing explanation. Uses only the safe `detail` fields the server returns for policy denials. */
export function explain(result: ScanResult): string {
  const detail = result.detail ?? {};
  switch (result.outcome) {
    case 'admitted':
      return 'Let them in.';
    case 'already_redeemed':
      return result.pass?.redeemedAt ? `First used at ${formatTime(result.pass.redeemedAt)}.` : 'This pass was already used.';
    case 'expired':
      return 'This pass has expired.';
    case 'revoked':
      return 'This pass was revoked by the organiser.';
    case 'invalid':
      return 'Not a valid pass for this event.';
    case 'event_closed':
      return 'Check-in for this event is closed.';
    case 'too_early':
      return detail.opensAt ? `Entry opens at ${formatTime(detail.opensAt)}` : 'Entry for this pass has not opened yet.';
    case 'too_late':
      return detail.closesAt ? `Entry closed at ${formatTime(detail.closesAt)}` : 'Entry for this pass has closed.';
    case 'wrong_gate':
      return detail.allowedGates?.length ? `Use gate: ${detail.allowedGates.join(', ')}` : 'This pass is not valid at this gate.';
    case 'capacity_full':
      return `${detail.policyName ?? 'This entry group'} is full${detail.capacity !== undefined ? ` (${detail.capacity})` : ''}`;
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
    if (error.status === 429) return error.retryAfter ? `Too many scans, wait ${error.retryAfter} s` : 'Too many scans, wait a moment';
    if (error.status >= 500) return 'Server error. Do not admit; scan again.';
    return `${error.message.replace(/\.$/, '')}. Do not admit; scan again.`;
  }
  return 'No connection to the server. Do not admit; scan again.';
}
