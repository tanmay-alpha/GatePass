import { useState } from 'react';
import type { EventSummary } from '../../shared/types';
import { api } from '../api';
import { useConfirm } from '../dialog';
import { ErrorNote, SectionHead, errorMessage } from '../ui';
import { EventForm } from './EventForm';
import { useToast } from './toast';

export function SettingsPanel({ token, event, onChanged }: { token: string; event: EventSummary; onChanged: () => Promise<void> }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, dialog] = useConfirm();
  const notify = useToast();
  const archiving = event.status === 'active';

  async function toggleStatus() {
    const ok = await confirm(
      archiving
        ? {
            title: `Archive “${event.name}”?`,
            body: 'Every scanner will reject every pass for this event, and no new passes can be issued. Scan history and the audit log stay available, and you can reopen the event later.',
            confirmLabel: 'Archive event',
            danger: true
          }
        : {
            title: `Reopen “${event.name}”?`,
            body: 'Scanners will start admitting valid passes again, and you can issue new passes.',
            confirmLabel: 'Reopen event'
          }
    );
    if (!ok) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/events/${event.id}`, token, { method: 'PATCH', body: { status: archiving ? 'archived' : 'active' } });
      await onChanged();
      notify(archiving ? 'Event archived' : 'Event reopened');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack-lg">
      <section className="card">
        <SectionHead title="Event details" />
        <EventForm
          token={token}
          event={event}
          onSaved={async () => {
            await onChanged();
            notify('Event details saved');
          }}
        />
      </section>
      <section className="card">
        <SectionHead
          title={archiving ? 'Archive event' : 'Reopen event'}
          description={archiving ? 'Stops all check-ins and issuance. History stays available.' : 'This event is archived. Reopening resumes check-ins and issuance.'}
        />
        <ErrorNote message={error} />
        <div className="actions">
          <button className={`btn ${archiving ? 'btn-danger' : 'btn-secondary'}`} onClick={() => void toggleStatus()} disabled={busy}>
            {busy ? (archiving ? 'Archiving…' : 'Reopening…') : archiving ? 'Archive event' : 'Reopen event'}
          </button>
        </div>
      </section>
      {dialog}
    </div>
  );
}
