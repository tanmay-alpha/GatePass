import type { ReactNode } from 'react';
import type { PassStatus, StoredScanOutcome } from '../shared/types';

export type Tone = 'ok' | 'warn' | 'bad' | 'muted' | 'info';

export const OUTCOME_LABEL: Record<StoredScanOutcome, string> = {
  admitted: 'Admitted',
  already_redeemed: 'Already used',
  expired: 'Expired',
  revoked: 'Revoked',
  invalid: 'Invalid',
  event_closed: 'Event closed',
  too_early: 'Too early',
  too_late: 'Too late',
  wrong_gate: 'Wrong gate',
  capacity_full: 'Capacity full',
  wrong_event: 'Other event'
};

/** Maps an outcome or pass status onto the visual tones used across the UI. */
export function tone(value: StoredScanOutcome | PassStatus): Tone {
  if (value === 'admitted' || value === 'active') return 'ok';
  if (value === 'already_redeemed' || value === 'redeemed') return 'warn';
  if (value === 'event_closed') return 'muted';
  return 'bad';
}

export function Badge({ value }: { value: StoredScanOutcome | PassStatus }) {
  const label = value in OUTCOME_LABEL ? OUTCOME_LABEL[value as StoredScanOutcome] : value[0].toUpperCase() + value.slice(1);
  return <ToneBadge tone={tone(value)}>{label}</ToneBadge>;
}

export function ToneBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function ErrorNote({ message }: { message: string }) {
  return message ? (
    <p className="error" role="alert">
      {message}
    </p>
  ) : null;
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: Tone }) {
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ''}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

/** Heading row for a section: title and optional description on the left, actions on the right. */
export function SectionHead({ id, title, description, children }: { id?: string; title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="section-head">
      <div>
        <h2 id={id}>{title}</h2>
        {description ? <p className="muted small">{description}</p> : null}
      </div>
      {children ? <div className="actions">{children}</div> : null}
    </div>
  );
}

/** Says what is missing and what to do next. */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <p className="empty-title">{title}</p>
      {children ? <div className="muted small">{children}</div> : null}
    </div>
  );
}

/** Single full-width table row for loading and empty states. */
export function TableMessage({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr className="table-message">
      <td colSpan={colSpan}>{children}</td>
    </tr>
  );
}

/** Usage bar. The value is always also rendered as text, so the bar itself is decorative. */
export function Bar({ value, max, tone = 'info' }: { value: number; max: number; tone?: Tone }) {
  const percent = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <span className="bar" aria-hidden>
      <span className={`bar-fill bar-${tone}`} style={{ width: `${percent}%` }} />
    </span>
  );
}

/** "admitted / capacity" with a bar; amber from 90 %, red when full. */
export function CapacityLine({ admitted, capacity }: { admitted: number; capacity: number | null }) {
  if (capacity === null) return <div className="small num">{admitted} admitted · no capacity limit</div>;
  const ratio = admitted / capacity;
  return (
    <div className="capacity-line">
      <Bar value={admitted} max={capacity} tone={ratio >= 1 ? 'bad' : ratio >= 0.9 ? 'warn' : 'info'} />
      <span className="small num">
        {admitted} / {capacity}
      </span>
    </div>
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong';
}
