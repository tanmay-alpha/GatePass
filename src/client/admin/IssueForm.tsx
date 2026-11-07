import { Ticket } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { AdmissionPolicy, EventSummary, IssuedPass } from '../../shared/types';
import { api, formatDateTime, fromLocalInput } from '../api';
import { ErrorNote, FieldError, SectionHead, errorMessage, focusFirstInvalid } from '../ui';

const MAX_PASSES = 500;

/** Parses "Name, email" lines; either part may be empty. */
function parseAttendees(text: string): Array<{ name: string; email: string }> {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = '', email = ''] = line.split(',').map((part) => part.trim());
      return name.includes('@') && !email ? { name: '', email: name } : { name, email };
    });
}

interface Errors {
  attendees?: string;
  count?: string;
  expiresAt?: string;
}

function validate(mode: 'named' | 'count', lineCount: number, count: string, expiresAt: string): Errors {
  const errors: Errors = {};
  if (mode === 'named') {
    if (lineCount === 0) errors.attendees = 'Add at least one attendee, one per line.';
    else if (lineCount > MAX_PASSES) errors.attendees = `Up to ${MAX_PASSES} attendees at a time; this list has ${lineCount}. Split it into smaller batches.`;
  } else {
    const value = Number(count);
    if (!count.trim() || !Number.isInteger(value) || value < 1 || value > MAX_PASSES) errors.count = `Enter a whole number from 1 to ${MAX_PASSES}.`;
  }
  if (expiresAt) {
    const expiry = new Date(expiresAt).getTime();
    if (Number.isNaN(expiry) || expiry <= Date.now()) errors.expiresAt = 'Choose an expiry in the future, or leave it empty.';
  }
  return errors;
}

interface Props {
  token: string;
  event: EventSummary;
  policies: AdmissionPolicy[];
  onIssued: (passes: IssuedPass[]) => Promise<void>;
}

export function IssueForm({ token, event, policies, onIssued }: Props) {
  const [mode, setMode] = useState<'named' | 'count'>('named');
  const [attendees, setAttendees] = useState('');
  const [count, setCount] = useState('10');
  const [expiresAt, setExpiresAt] = useState('');
  const [policyId, setPolicyId] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lines = parseAttendees(attendees);
  const countValue = Number(count);
  const total = mode === 'named' ? lines.length : Number.isInteger(countValue) && countValue > 0 ? countValue : 0;
  const errors = showErrors ? validate(mode, lines.length, count, expiresAt) : {};

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (Object.keys(validate(mode, lines.length, count, expiresAt)).length) {
      setShowErrors(true);
      focusFirstInvalid(e.currentTarget);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const body = {
        ...(mode === 'named' ? { attendees: lines } : { count: countValue }),
        ...(expiresAt ? { expiresAt: fromLocalInput(expiresAt) } : {}),
        ...(policyId ? { policyId } : {})
      };
      await onIssued(await api<IssuedPass[]>(`/api/events/${event.id}/passes`, token, { body }));
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
              One per line: <code>Name, email</code>. Email is optional; up to {MAX_PASSES} lines.
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
        <label>
          Admission policy
          <select value={policyId} onChange={(e) => setPolicyId(e.target.value)} aria-describedby="issue-policy-hint">
            <option value="">No policy</option>
            {policies.map((policy) => (
              <option key={policy.id} value={policy.id}>
                {policy.name}
              </option>
            ))}
          </select>
          <span id="issue-policy-hint" className="field-hint">
            {policies.length ? 'No policy: any gate, any time during the event.' : 'Create policies on the Access tab to restrict gates, times or capacity.'}
          </span>
        </label>
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
            Empty: event end ({formatDateTime(event.endsAt)})
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
