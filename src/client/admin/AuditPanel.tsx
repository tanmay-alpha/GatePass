import { useEffect, useState } from 'react';
import type { AuditEntry, EventSummary } from '../../shared/types';
import { api, formatDateTime } from '../api';
import { ErrorNote, errorMessage } from '../ui';

const ACTION_LABEL: Record<string, string> = {
  'event.created': 'Event created',
  'event.updated': 'Event updated',
  'passes.issued': 'Passes issued',
  'pass.revoked': 'Pass revoked',
  'pass.reissued': 'Pass reissued',
  'scanner.created': 'Scanner added',
  'scanner.revoked': 'Scanner revoked'
};

function describe(entry: AuditEntry): string {
  const details = entry.details;
  if (entry.action === 'passes.issued') return `${String(details.count)} pass(es)`;
  if (entry.action === 'event.updated' && Array.isArray(details.fields)) return details.fields.join(', ');
  if (entry.action === 'scanner.created') return String(details.label ?? '');
  return entry.entityId ? entry.entityId.slice(0, 8) : '';
}

export function AuditPanel({ token, event }: { token: string; event: EventSummary }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api<AuditEntry[]>(`/api/events/${event.id}/audit`, token)
      .then(setEntries)
      .catch((err) => setError(errorMessage(err)));
  }, [event.id, event.updatedAt, event.passCount, event.revokedCount, token]);

  return (
    <div className="stack">
      <ErrorNote message={error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Action</th>
              <th>Details</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td className="small">{formatDateTime(entry.createdAt)}</td>
                <td>{ACTION_LABEL[entry.action] ?? entry.action}</td>
                <td className="small">{describe(entry)}</td>
                <td className="small">{entry.actor}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
