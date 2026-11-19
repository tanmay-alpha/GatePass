import { Search, UserCheck } from 'lucide-react';
import { useCallback, useRef, useState, type FormEvent } from 'react';
import type { AttendeeMatch, AttendeeSearch } from '../../shared/types';
import { api, ApiError } from '../api';
import { useConfirm } from '../dialog';
import { ErrorNote } from '../ui';
import { explain, formatEventTime } from './outcome';

const MIN_QUERY = 3;
const SEARCH_TIMEOUT_MS = 10_000;

interface Props {
  scannerKey: string;
  timeZone: string;
  online: boolean;
  /** A verification is in flight; admitting waits for it. */
  checking: boolean;
  /** Sends the reference through the normal redeem path (same requestId handling, same verdict overlay). */
  onAdmit: (reference: string) => Promise<void>;
  onUnauthorized: () => void;
}

const STATUS_WORD: Record<AttendeeMatch['status'], string> = { active: 'Valid', redeemed: 'Used', revoked: 'Revoked', expired: 'Expired' };

/** The safe next step for staff, from the server's advisory check. Never an override: only "Admit" reaches the server. */
function nextStep(match: AttendeeMatch, timeZone: string): string {
  if (match.ambiguous) return 'Two passes share this reference. Scan their QR code or open their pass link instead.';
  if (match.check.admit) return 'Check their ID matches this name, then admit.';
  const reason = explain(
    { outcome: match.check.outcome, scanId: 0, checkedAt: '', pass: { id: '', attendeeName: match.attendeeName, redeemedAt: match.redeemedAt }, detail: match.check.detail },
    timeZone
  );
  switch (match.check.outcome) {
    case 'already_redeemed':
      return `${reason} Do not admit again; if they say they have not entered, call a supervisor.`;
    case 'wrong_gate':
      return `${reason}.`;
    case 'too_early':
      return `${reason}. Ask them to wait.`;
    case 'revoked':
    case 'expired':
      return `${reason} Do not admit; send them to the organiser.`;
    default:
      return `${reason.replace(/\.$/, '')}. Do not admit.`;
  }
}

/**
 * "Find attendee": door help when a QR code is lost, damaged or unreadable.
 * Searches this device's event by name, reference or exact email; "Admit" sends
 * the printed reference through `POST /api/scanner/redeem`, the same atomic
 * check a scan gets. There is no way to admit without the server's answer.
 */
export function AttendeeFinder({ scannerKey, timeZone, online, checking, onAdmit, onUnauthorized }: Props) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<{ query: string; search: AttendeeSearch } | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [confirm, dialog] = useConfirm();
  const latest = useRef(0);

  const run = useCallback(
    async (q: string) => {
      const id = ++latest.current;
      setSearching(true);
      setError('');
      try {
        const search = await api<AttendeeSearch>(`/api/scanner/attendees?q=${encodeURIComponent(q)}`, { bearer: scannerKey, timeoutMs: SEARCH_TIMEOUT_MS });
        if (id === latest.current) setResult({ query: q, search });
      } catch (err) {
        if (id !== latest.current) return;
        if (err instanceof ApiError && err.status === 401) return onUnauthorized();
        // A wait of more than a minute is the device's 24-hour search budget, whose message says what to do instead.
        if (err instanceof ApiError && err.status === 429)
          setError(err.retryAfter !== null && err.retryAfter > 60 ? err.message : `Too many searches. Wait ${err.retryAfter ?? 'a few'} seconds and try again.`);
        else setError(err instanceof Error ? err.message : 'Search failed.');
      } finally {
        if (id === latest.current) setSearching(false);
      }
    },
    [scannerKey, onUnauthorized]
  );

  function submit(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (q.length < MIN_QUERY || !online) return;
    void run(q);
  }

  async function admit(match: AttendeeMatch) {
    const ok = await confirm({
      title: `Admit ${match.attendeeName ?? `pass ${match.reference}`}?`,
      body: 'Only if their ID matches the name on the pass. The server checks the pass now; follow its answer.',
      confirmLabel: 'Yes, admit'
    });
    if (!ok) return;
    await onAdmit(match.reference);
    // Show the pass as the server now sees it.
    if (result) void run(result.query);
  }

  const short = query.trim().length < MIN_QUERY;
  return (
    <section className="finder" aria-labelledby="finder-title">
      <h2 id="finder-title" className="recent-title finder-title">
        Find attendee
      </h2>
      <form className="manual-form" onSubmit={submit} role="search">
        <div className="manual-row">
          <label className="grow">
            <span className="sr-only">Name, reference or email</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name, reference or email"
              aria-describedby="finder-help"
              autoComplete="off"
              autoCapitalize="words"
              spellCheck={false}
              enterKeyHint="search"
              maxLength={100}
            />
          </label>
          <button className="btn btn-secondary" disabled={!online || searching || short}>
            <Search size={16} aria-hidden /> {searching ? 'Searching…' : 'Search'}
          </button>
        </div>
        <p id="finder-help" className="manual-help">
          {online ? 'For a lost or unreadable QR code. The start of their first name or surname, their full email, or the pass reference; at least 3 characters.' : 'Search needs a connection.'}
        </p>
      </form>
      <ErrorNote message={error} />
      {result ? (
        <ul className="finder-results" aria-label={`Matches for ${result.query}`}>
          {result.search.matches.map((match) => {
            const admittable = match.check.admit && !match.ambiguous;
            return (
              <li key={match.reference} className={`finder-match is-${match.status}`}>
                <div className="finder-head">
                  <span className="finder-name">{match.attendeeName ?? 'No name on pass'}</span>
                  <span className={`finder-status is-${match.status}`}>
                    {STATUS_WORD[match.status]}
                    {match.status === 'redeemed' && match.redeemedAt ? ` ${formatEventTime(match.redeemedAt, timeZone)}` : ''}
                  </span>
                </div>
                <div className="finder-meta">
                  <span className="finder-ref">{match.reference}</span>
                  {match.emailHint ? <span>{match.emailHint}</span> : null}
                  {match.policyName ? <span>{match.policyName}</span> : null}
                </div>
                <p className="finder-step">{nextStep(match, timeZone)}</p>
                {admittable ? (
                  <button
                    type="button"
                    className="btn btn-primary finder-admit"
                    disabled={!online || checking}
                    onClick={() => void admit(match)}
                    aria-label={`Admit ${match.attendeeName ?? match.reference}`}
                  >
                    <UserCheck size={16} aria-hidden /> Admit
                  </button>
                ) : null}
              </li>
            );
          })}
          {result.search.more ? (
            <li className="history-empty">Too many passes match “{result.query}”. Add more of the name (first name and surname), or search by email or reference.</li>
          ) : result.search.matches.length === 0 ? (
            <li className="history-empty">No pass for this event matches “{result.query}”.</li>
          ) : null}
        </ul>
      ) : null}
      {dialog}
    </section>
  );
}
