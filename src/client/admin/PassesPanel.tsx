import { Ban, RefreshCw, Ticket } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { EventSummary, IssuedPass, Pass, PassStatus } from '../../shared/types';
import { api, formatDateTime, fromLocalInput } from '../api';
import { Badge, ErrorNote, errorMessage } from '../ui';
import { IssuedPasses } from './IssuedPasses';

interface Props {
  token: string;
  event: EventSummary;
  onChanged: () => Promise<void>;
}

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

export function PassesPanel({ token, event, onChanged }: Props) {
  const [passes, setPasses] = useState<Pass[]>([]);
  const [status, setStatus] = useState<PassStatus | ''>('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [issued, setIssued] = useState<IssuedPass[]>([]);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (query.trim()) params.set('q', query.trim());
    try {
      setPasses(await api<Pass[]>(`/api/events/${event.id}/passes?${params}`, token));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [event.id, token, status, query]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 200);
    return () => clearTimeout(timer);
  }, [load]);

  async function act(pass: Pass, action: 'revoke' | 'reissue') {
    const prompt =
      action === 'revoke'
        ? `Revoke the pass${pass.attendeeName ? ` for ${pass.attendeeName}` : ''}? It will be rejected at the door.`
        : 'Issue a new code for this pass? The current QR code stops working immediately.';
    if (!window.confirm(prompt)) return;
    try {
      const result = await api<Pass | IssuedPass>(`/api/passes/${pass.id}/${action}`, token, { method: 'POST' });
      if ('token' in result) setIssued([result]);
      await Promise.all([load(), onChanged()]);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="stack">
      {event.status === 'active' ? (
        <IssueForm
          token={token}
          event={event}
          onIssued={async (result) => {
            setIssued(result);
            await Promise.all([load(), onChanged()]);
          }}
        />
      ) : (
        <p className="muted">This event is archived; no new passes can be issued.</p>
      )}

      {issued.length > 0 ? <IssuedPasses event={event} passes={issued} onClose={() => setIssued([])} /> : null}

      <div className="toolbar">
        <input type="search" placeholder="Search name, email or pass ID" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search passes" />
        <select value={status} onChange={(e) => setStatus(e.target.value as PassStatus | '')} aria-label="Filter by status">
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="redeemed">Redeemed</option>
          <option value="revoked">Revoked</option>
          <option value="expired">Expired</option>
        </select>
      </div>
      <ErrorNote message={error} />

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Attendee</th>
              <th>Status</th>
              <th>Expires</th>
              <th>Checked in</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {passes.map((pass) => (
              <tr key={pass.id}>
                <td>
                  <div>{pass.attendeeName || <span className="muted">Unnamed</span>}</div>
                  <div className="muted small">{pass.attendeeEmail || <code>{pass.id.slice(0, 8)}</code>}</div>
                </td>
                <td>
                  <Badge value={pass.status} />
                </td>
                <td className="small">{formatDateTime(pass.expiresAt)}</td>
                <td className="small">{formatDateTime(pass.redeemedAt)}</td>
                <td className="row-actions">
                  {pass.status === 'active' ? (
                    <>
                      <button className="btn btn-ghost btn-small" title="Issue a replacement code" onClick={() => void act(pass, 'reissue')}>
                        <RefreshCw size={14} aria-hidden /> Reissue
                      </button>
                      <button className="btn btn-ghost btn-small danger" onClick={() => void act(pass, 'revoke')}>
                        <Ban size={14} aria-hidden /> Revoke
                      </button>
                    </>
                  ) : pass.status === 'expired' ? (
                    <button className="btn btn-ghost btn-small danger" onClick={() => void act(pass, 'revoke')}>
                      <Ban size={14} aria-hidden /> Revoke
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
            {passes.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  No passes match.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function IssueForm({ token, event, onIssued }: { token: string; event: EventSummary; onIssued: (passes: IssuedPass[]) => Promise<void> }) {
  const [mode, setMode] = useState<'named' | 'count'>('named');
  const [attendees, setAttendees] = useState('');
  const [count, setCount] = useState(10);
  const [expiresAt, setExpiresAt] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = {
        ...(mode === 'named' ? { attendees: parseAttendees(attendees) } : { count }),
        ...(expiresAt ? { expiresAt: fromLocalInput(expiresAt) } : {})
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
        <div className="segmented" role="radiogroup" aria-label="Issue mode">
          <button type="button" role="radio" aria-checked={mode === 'named'} className={mode === 'named' ? 'active' : ''} onClick={() => setMode('named')}>
            Named attendees
          </button>
          <button type="button" role="radio" aria-checked={mode === 'count'} className={mode === 'count' ? 'active' : ''} onClick={() => setMode('count')}>
            Unnamed batch
          </button>
        </div>
        {mode === 'named' ? (
          <label>
            <span>
              One attendee per line: <code>Name, email</code> (email optional, up to 500)
            </span>
            <textarea rows={4} value={attendees} onChange={(e) => setAttendees(e.target.value)} placeholder={'Ada Lovelace, ada@example.com\nGrace Hopper'} required />
          </label>
        ) : (
          <label>
            Number of passes (1–500)
            <input type="number" min={1} max={500} value={count} onChange={(e) => setCount(Number(e.target.value))} required />
          </label>
        )}
        <label>
          <span>Expires (default: event end)</span>
          <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
        </label>
        <ErrorNote message={error} />
        <div className="actions">
          <button className="btn btn-primary" disabled={busy}>
            <Ticket size={16} aria-hidden /> {busy ? 'Issuing…' : 'Issue passes'}
          </button>
        </div>
      </form>
    </details>
  );
}
