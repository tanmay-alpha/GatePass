import type { ReactNode } from 'react';
import type { PassStatus, StoredScanOutcome } from '../shared/types';

export const OUTCOME_LABEL: Record<StoredScanOutcome, string> = {
  admitted: 'Admitted',
  already_redeemed: 'Already used',
  expired: 'Expired',
  revoked: 'Revoked',
  invalid: 'Invalid',
  event_closed: 'Event closed',
  wrong_event: 'Other event'
};

/** Maps an outcome or pass status onto the four visual tones used across the UI. */
export function tone(value: StoredScanOutcome | PassStatus): 'ok' | 'warn' | 'bad' | 'muted' {
  if (value === 'admitted' || value === 'active') return 'ok';
  if (value === 'already_redeemed' || value === 'redeemed') return 'warn';
  if (value === 'event_closed') return 'muted';
  return 'bad';
}

export function Badge({ value }: { value: StoredScanOutcome | PassStatus }) {
  const label = value in OUTCOME_LABEL ? OUTCOME_LABEL[value as StoredScanOutcome] : value[0].toUpperCase() + value.slice(1);
  return <span className={`badge badge-${tone(value)}`}>{label}</span>;
}

export function ErrorNote({ message }: { message: string }) {
  return message ? (
    <p className="error" role="alert">
      {message}
    </p>
  ) : null;
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong';
}
