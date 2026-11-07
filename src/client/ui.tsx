import type { ReactNode } from 'react';
import type { PassStatus, StoredScanOutcome } from '../shared/types';

/** `info` is the accent colour; the rest are status colours. */
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

const PASS_STATUS: Record<PassStatus, { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'info' },
  redeemed: { label: 'Redeemed', tone: 'ok' },
  revoked: { label: 'Revoked', tone: 'bad' },
  expired: { label: 'Expired', tone: 'muted' }
};

/** Admitted is green, a repeat scan amber, a closed event grey, every other refusal red. */
function outcomeTone(outcome: StoredScanOutcome): Tone {
  if (outcome === 'admitted') return 'ok';
  if (outcome === 'already_redeemed') return 'warn';
  if (outcome === 'event_closed') return 'muted';
  return 'bad';
}

export function OutcomeBadge({ outcome }: { outcome: StoredScanOutcome }) {
  return <ToneBadge tone={outcomeTone(outcome)}>{OUTCOME_LABEL[outcome]}</ToneBadge>;
}

export function PassStatusBadge({ status }: { status: PassStatus }) {
  const { label, tone } = PASS_STATUS[status];
  return <ToneBadge tone={tone}>{label}</ToneBadge>;
}

/** Pill with a coloured dot; the label always carries the meaning on its own. */
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

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

/** Card header: title and optional description on the left, actions or meta on the right. */
export function SectionHead({ id, title, description, children }: { id?: string; title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="section-head">
      <div className="section-title">
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

/** Thin usage bar. The value is always also rendered as text, so the bar itself is decorative. */
export function Bar({ value, max, tone = 'info' }: { value: number; max: number; tone?: Tone }) {
  const percent = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <span className="bar" aria-hidden>
      <span className={`bar-fill bar-${tone}`} style={{ width: `${percent}%` }} />
    </span>
  );
}

/** Accent bar, amber from 90 %, red when full. */
export function capacityTone(admitted: number, capacity: number): Tone {
  const ratio = admitted / capacity;
  return ratio >= 1 ? 'bad' : ratio >= 0.9 ? 'warn' : 'info';
}

/** "admitted/capacity" with a bar. */
export function CapacityLine({ admitted, capacity }: { admitted: number; capacity: number | null }) {
  if (capacity === null) return <div className="small muted num">{admitted} admitted · no limit</div>;
  return (
    <div className="capacity-line">
      <Bar value={admitted} max={capacity} tone={capacityTone(admitted, capacity)} />
      <span className="small muted num">
        {admitted}/{capacity}
      </span>
    </div>
  );
}

/** "Nov 7, 2026" */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** "Nov 7, 18:00": compact date and time for dense tables. */
export function formatShortDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  const day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${day}, ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

/** "Nov 7, 18:00 – 23:30", or both dates when the range spans days. */
export function formatDateRange(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const time = (date: Date) => date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return start.toDateString() === end.toDateString() ? `${formatShortDateTime(startIso)} – ${time(end)}` : `${formatShortDateTime(startIso)} – ${formatShortDateTime(endIso)}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong';
}
