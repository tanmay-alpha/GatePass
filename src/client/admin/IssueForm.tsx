import { Ticket } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { AdmissionPolicy, EventSummary, IssuedPass } from '../../shared/types';
import { attendeesFromCsv, parseCsv } from '../csv';
import { ErrorNote, FieldError, SectionHead, errorMessage, focusFirstInvalid } from '../ui';
import { formatDateTimeInZone, fromZoneInput, zoneLabel } from '../time';
import { adminApi } from './http';

const MAX_PASSES = 500;

interface Errors {
  attendees?: string;
  count?: string;
  expiresAt?: string;
}

function validate(mode: 'named' | 'count', lineCount: number, count: string, expiresAt: string, expiresIso: string | null): Errors {
  const errors: Errors = {};
  if (mode === 'named') {
    if (lineCount === 0) errors.attendees = 'Add at least one attendee, one per line.';
    else if (lineCount > MAX_PASSES) errors.attendees = `Up to ${MAX_PASSES} attendees at a time; this list has ${lineCount}. Use Import CSV for longer lists.`;
  } else {
    const value = Number(count);
    if (!count.trim() || !Number.isInteger(value) || value < 1 || value > MAX_PASSES) errors.count = `Enter a whole number from 1 to ${MAX_PASSES}.`;
  }
  if (expiresAt && (!expiresIso || new Date(expiresIso).getTime() <= Date.now())) errors.expiresAt = 'Choose an expiry in the future, or leave it empty.';
  return errors;
}

interface Props {
  event: EventSummary;
  policies: AdmissionPolicy[];
  onIssued: (passes: IssuedPass[]) => Promise<void>;
}

export function IssueForm({ event, policies, onIssued }: Props) {
  const [mode, setMode] = useState<'named' | 'count'>('named');
  const [attendees, setAttendees] = useState('');
  const [count, setCount] = useState('10');
  const [expiresAt, setExpiresAt] = useState('');
  const [policyId, setPolicyId] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Same parser as CSV import, so quoted names with commas ("Lovelace, Ada") survive.
  const lines = attendeesFromCsv(parseCsv(attendees)).rows;
  const countValue = Number(count);
  const total = mode === 'named' ? lines.length : Number.isInteger(countValue) && countValue > 0 ? countValue : 0;
  const expiresIso = expiresAt ? fromZoneInput(expiresAt, event.timeZone) : null;
  const errors = showErrors ? validate(mode, lines.length, count, expiresAt, expiresIso) : {};

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (Object.keys(validate(mode, lines.length, count, expiresAt, expiresIso)).length) {
      setShowErrors(true);
      focusFirstInvalid(e.currentTarget);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const body = {
        ...(mode === 'named' ? { attendees: lines } : { count: countValue }),
        ...(expiresIso ? { expiresAt: expiresIso } : {}),
        ...(policyId ? { policyId } : {})
      };
      await onIssued(await adminApi<IssuedPass[]>(`/api/events/${event.id}/passes`, { body }));
      setAttendees('');
      setShowErrors(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="issue-passes" className="card" aria-labelledby="issue-title">
      <SectionHead id="issue-title" title="Issue passes" />
      <form className="stack" onSubmit={submit} noValidate>
        <div className="segmented segmented-block" role="radiogroup" aria-label="Who the passes are for">
          <button type="button" role="radio" aria-checked={mode === 'named'} className={mode === 'named' ? 'active' : ''} onClick={() => setMode('named')}>
            Named attendees
          </button>
          <button type="button" role="radio" aria-checked={mode === 'count'} className={mode === 'count' ? 'active' : ''} onClick={() => setMode('count')}>
            Unnamed batch
          </button>
        </div>
        {mode === 'named' ? (
          <label>
            Attendees
            <textarea
              rows={4}
              value={attendees}
              onChange={(e) => setAttendees(e.target.value)}
              placeholder={'Ada Lovelace, ada@example.com\nGrace Hopper'}
              required
              aria-invalid={errors.attendees ? true : undefined}
              aria-describedby="attendees-hint attendees-error"
            />
            <span id="attendees-hint" className="field-hint">
              One per line: <code>Name, email</code>. Email is optional; quote names that contain commas. Up to {MAX_PASSES} lines.
            </span>
            <FieldError id="attendees-error" message={errors.attendees} />
          </label>
        ) : (
          <label>
            Number of passes
            <input
              type="number"
              min={1}
              max={MAX_PASSES}
              step={1}
              inputMode="numeric"
              value={count}
              onChange={(e) => setCount(e.target.value)}
              required
              aria-invalid={errors.count ? true : undefined}
              aria-describedby="count-hint count-error"
            />
            <span id="count-hint" className="field-hint">
              1–{MAX_PASSES}
            </span>
            <FieldError id="count-error" message={errors.count} />
          </label>
        )}
        <PolicySelect id="issue-policy" policies={policies} value={policyId} onChange={setPolicyId} />
        <label>
          Expires
          <input
            type="datetime-local"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            aria-invalid={errors.expiresAt ? true : undefined}
            aria-describedby="issue-expiry-hint issue-expiry-error"
          />
          <span id="issue-expiry-hint" className="field-hint">
            In {zoneLabel(event.timeZone, event.endsAt)}. Empty: event end ({formatDateTimeInZone(event.endsAt, event.timeZone, false)})
          </span>
          <FieldError id="issue-expiry-error" message={errors.expiresAt} />
        </label>
        <ErrorNote message={error} />
        <button className="btn btn-primary btn-block" disabled={busy}>
          <Ticket size={16} aria-hidden /> {busy ? 'Issuing…' : total > 0 ? `Issue ${total} pass${total === 1 ? '' : 'es'}` : 'Issue passes'}
        </button>
      </form>
    </section>
  );
}

/** Admission policy picker shared by issuing and CSV import. */
export function PolicySelect({ id, policies, value, onChange }: { id: string; policies: AdmissionPolicy[]; value: string; onChange: (value: string) => void }) {
  return (
    <label>
      Admission policy
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={`${id}-hint`}>
        <option value="">No policy</option>
        {policies.map((policy) => (
          <option key={policy.id} value={policy.id}>
            {policy.name}
          </option>
        ))}
      </select>
      <span id={`${id}-hint`} className="field-hint">
        {policies.length ? 'No policy: any gate, any time during the event.' : 'Create policies on the Access tab to restrict gates, times or capacity.'}
      </span>
    </label>
  );
}
