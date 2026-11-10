import { Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuditEntry, EventSummary } from '../../shared/types';
import { ErrorNote, SectionHead, TableMessage, errorMessage } from '../ui';
import { formatDateTimeInZone, zoneLabel } from '../time';
import { useDebounced } from './hooks';
import { adminApi } from './http';

const PAGE_SIZE = 100;

const ACTION_LABEL: Record<string, string> = {
  'event.created': 'Event created',
  'event.updated': 'Event updated',
  'event.status_changed': 'Event status changed',
  'event.cloned': 'Event cloned',
  'passes.issued': 'Passes issued',
  'passes.imported': 'Passes imported',
  'passes.revoked': 'Passes revoked',
  'pass.revoked': 'Pass revoked',
  'pass.reissued': 'Pass reissued',
  'pass.policy_changed': 'Pass policy changed',
  'scanner.created': 'Scanner added',
  'scanner.revoked': 'Scanner revoked',
  'scanner.rotated': 'Scanner key rotated',
  'gate.created': 'Gate added',
  'gate.updated': 'Gate renamed',
  'gate.deleted': 'Gate deleted',
  'policy.created': 'Policy created',
  'policy.updated': 'Policy updated',
  'policy.deleted': 'Policy deleted',
  'member.removed': 'Manager removed',
  'member.added': 'Manager added',
  'member.owner_transferred': 'Ownership transferred',
  'invitation.created': 'Invitation created',
  'invitation.accepted': 'Invitation accepted',
  'invitation.revoked': 'Invitation revoked'
};

/** Prefix filters accepted by the server (`action` ending in "."). */
const ACTION_FILTERS = [
  ['event.', 'Event changes'],
  ['pass.', 'Single passes'],
  ['passes.', 'Batches of passes'],
  ['policy.', 'Policies'],
  ['gate.', 'Gates'],
  ['scanner.', 'Scanner devices'],
  ['member.', 'Team members'],
  ['invitation.', 'Invitations']
] as const;

/** "some.new_action" → "Some new action" for actions this client does not know yet. */
function actionLabel(action: string): string {
  if (ACTION_LABEL[action]) return ACTION_LABEL[action];
  const words = action.replace(/[._]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function describe(entry: AuditEntry): string {
  const details = entry.details;
  if (typeof details.count === 'number') return `${details.count} pass(es)`;
  if (typeof details.from === 'string' && typeof details.to === 'string') return `${details.from} → ${details.to}`;
  if (Array.isArray(details.fields)) return details.fields.join(', ');
  if (typeof details.email === 'string') return details.email;
  if (typeof details.label === 'string') return details.label;
  if (typeof details.name === 'string') return details.name;
  return entry.entityId ? entry.entityId.slice(0, 8) : '';
}

export function AuditPanel({ event }: { event: EventSummary }) {
  const [action, setAction] = useState('');
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query.trim(), 250);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const latest = useRef(0);

  const load = useCallback(
    async (before: number | null) => {
      const request = ++latest.current;
      setLoading(true);
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (action) params.set('action', action);
      if (debouncedQuery) params.set('q', debouncedQuery);
      if (before !== null) params.set('before', String(before));
      try {
        const page = await adminApi<AuditEntry[]>(`/api/events/${event.id}/audit?${params}`);
        if (request !== latest.current) return;
        setEntries((current) => (before === null ? page : [...(current ?? []), ...page]));
        setHasMore(page.length === PAGE_SIZE);
        setError('');
      } catch (err) {
        if (request === latest.current) setError(errorMessage(err));
      } finally {
        if (request === latest.current) setLoading(false);
      }
    },
    [event.id, action, debouncedQuery]
  );

  useEffect(() => {
    setEntries(null);
    void load(null);
  }, [load]);

  const filtered = Boolean(action || debouncedQuery);
  const oldest = entries?.length ? entries[entries.length - 1].id : null;

  return (
    <section className="card" aria-labelledby="audit-title">
      <SectionHead id="audit-title" title="Audit log" description="Every change to this event and who made it, newest first." />
      <div className="toolbar">
        <label className="grow search">
          <span className="sr-only">Search the audit log</span>
          <Search size={15} className="search-icon" aria-hidden />
          <input type="search" placeholder="Search person, name or ID" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <label>
          <span className="sr-only">Filter by action</span>
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">All actions</option>
            {ACTION_FILTERS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorNote message={error} />
      <div className="table-wrap">
        <table aria-busy={loading}>
          <thead>
            <tr>
              <th scope="col">Time ({zoneLabel(event.timeZone, event.startsAt)})</th>
              <th scope="col">Action</th>
              <th scope="col">Details</th>
              <th scope="col">By</th>
            </tr>
          </thead>
          <tbody>
            {entries?.map((entry) => (
              <tr key={entry.id}>
                <td className="num muted nowrap">{formatDateTimeInZone(entry.createdAt, event.timeZone, false)}</td>
                <td className="strong">{actionLabel(entry.action)}</td>
                <td>{describe(entry)}</td>
                <td className="muted">{entry.actorLabel}</td>
              </tr>
            ))}
            {entries === null && !error ? <TableMessage colSpan={4}>Loading audit log…</TableMessage> : null}
            {entries?.length === 0 ? <TableMessage colSpan={4}>{filtered ? 'No entries match this search or filter.' : 'No changes recorded yet.'}</TableMessage> : null}
          </tbody>
        </table>
      </div>
      {hasMore || error ? (
        <div className="actions">
          <button type="button" className="btn btn-secondary btn-small" onClick={() => void load(error && entries === null ? null : oldest)} disabled={loading}>
            {loading ? 'Loading…' : error ? 'Retry' : 'Load older'}
          </button>
        </div>
      ) : null}
    </section>
  );
}
