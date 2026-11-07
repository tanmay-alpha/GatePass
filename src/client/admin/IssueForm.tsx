import { Ticket } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { AdmissionPolicy, EventSummary, IssuedPass } from '../../shared/types';
import { api, formatDateTime, fromLocalInput } from '../api';
import { ErrorNote, errorMessage } from '../ui';

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

interface Props {
  token: string;
  event: EventSummary;
  policies: AdmissionPolicy[];
  onIssued: (passes: IssuedPass[]) => Promise<void>;
}

export function IssueForm({ token, event, policies, onIssued }: Props) {
  const [mode, setMode] = useState<'named' | 'count'>('named');
  const [attendees, setAttendees] = useState('');
  const [count, setCount] = useState(10);
  const [expiresAt, setExpiresAt] = useState('');
  const [policyId, setPolicyId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lines = parseAttendees(attendees);
  const total = mode === 'named' ? lines.length : count;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = {
        ...(mode === 'named' ? { attendees: lines } : { count }),
        ...(expiresAt ? { expiresAt: fromLocalInput(expiresAt) } : {}),
        ...(policyId ? { policyId } : {})
      };
      await onIssued(await api<IssuedPass[]>(`/api/events/${event.id}/passes`, token, { body }));
      setAttendees('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="issue-panel" open={event.passCount === 0}>
      <summary>
        <Ticket size={16} aria-hidden /> Issue passes
      </summary>
      <form className="issue-form" onSubmit={submit}>
        <div className="segmented" role="radiogroup" aria-label="Who the passes are for">
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
              aria-describedby="attendees-hint"
            />
            <span id="attendees-hint" className="field-hint">
              One per line: <code>Name, email</code>. Email is optional; up to 500 lines.
            </span>
          </label>
        ) : (
          <label>
            Number of passes
            <input type="number" min={1} max={500} value={count} onChange={(e) => setCount(Number(e.target.value))} required aria-describedby="count-hint" />
            <span id="count-hint" className="field-hint">
              1–500
            </span>
          </label>
        )}
        <div className="form-grid">
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
            <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} aria-describedby="issue-expiry-hint" />
            <span id="issue-expiry-hint" className="field-hint">
              Empty: event end ({formatDateTime(event.endsAt)})
            </span>
          </label>
        </div>
        <ErrorNote message={error} />
        <div className="actions">
          <button className="btn btn-primary" disabled={busy || total < 1}>
            <Ticket size={16} aria-hidden /> {busy ? 'Issuing…' : total > 0 ? `Issue ${total} pass${total === 1 ? '' : 'es'}` : 'Issue passes'}
          </button>
        </div>
      </form>
    </details>
  );
}
