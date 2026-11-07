import type { AuditEntry, EventSummary } from '../../shared/types';
import { formatDateTime } from '../api';
import { ErrorNote, SectionHead, TableMessage } from '../ui';
import { useResource } from './hooks';

const ACTION_LABEL: Record<string, string> = {
  'event.created': 'Event created',
  'event.updated': 'Event updated',
  'passes.issued': 'Passes issued',
  'pass.revoked': 'Pass revoked',
  'pass.reissued': 'Pass reissued',
  'pass.policy_changed': 'Pass policy changed',
  'scanner.created': 'Scanner added',
  'scanner.revoked': 'Scanner revoked',
  'gate.created': 'Gate added',
  'policy.created': 'Policy created',
  'policy.updated': 'Policy updated'
};

/** "some.new_action" → "Some new action" for actions this client does not know yet. */
function actionLabel(action: string): string {
  if (ACTION_LABEL[action]) return ACTION_LABEL[action];
  const words = action.replace(/[._]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function describe(entry: AuditEntry): string {
  const details = entry.details;
  if (entry.action === 'passes.issued') return `${String(details.count)} pass(es)`;
  if (Array.isArray(details.fields)) return details.fields.join(', ');
  if (typeof details.label === 'string') return details.label;
  if (typeof details.name === 'string') return details.name;
  return entry.entityId ? entry.entityId.slice(0, 8) : '';
}

export function AuditPanel({ token, event }: { token: string; event: EventSummary }) {
  const audit = useResource<AuditEntry[]>(`/api/events/${event.id}/audit`, token);

  return (
    <section className="card" aria-labelledby="audit-title">
      <SectionHead id="audit-title" title="Audit log" description="Every admin action on this event, newest first." />
      <ErrorNote message={audit.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Action</th>
              <th scope="col">Details</th>
              <th scope="col">By</th>
            </tr>
          </thead>
          <tbody>
            {audit.data?.map((entry) => (
              <tr key={entry.id}>
                <td className="num muted nowrap">{formatDateTime(entry.createdAt)}</td>
                <td className="strong">{actionLabel(entry.action)}</td>
                <td>{describe(entry)}</td>
                <td className="muted">{entry.actor}</td>
              </tr>
            ))}
            {audit.data === null && !audit.error ? <TableMessage colSpan={4}>Loading audit log…</TableMessage> : null}
            {audit.data?.length === 0 ? <TableMessage colSpan={4}>No admin actions recorded yet.</TableMessage> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
