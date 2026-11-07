import { useState } from 'react';
import type { EventSummary } from '../../shared/types';
import { api, formatDateTime } from '../api';
import { ErrorNote, Stat, errorMessage } from '../ui';
import { AuditPanel } from './AuditPanel';
import { DesignPanel } from './DesignPanel';
import { EventForm } from './EventForm';
import { PassesPanel } from './PassesPanel';
import { ScannersPanel } from './ScannersPanel';
import { ScansPanel } from './ScansPanel';

const TABS = ['Passes', 'Live scans', 'Scanners', 'Pass design', 'Settings', 'Audit log'] as const;
type Tab = (typeof TABS)[number];

export function EventDetail({ token, event, onChanged }: { token: string; event: EventSummary; onChanged: () => Promise<void> }) {
  const [tab, setTab] = useState<Tab>('Passes');
  const [error, setError] = useState('');
  const active = event.passCount - event.redeemedCount - event.revokedCount;

  async function setStatus(status: EventSummary['status']) {
    if (status === 'archived' && !window.confirm('Archive this event? Scanners will reject every pass and no new passes can be issued.')) return;
    try {
      await api(`/api/events/${event.id}`, token, { method: 'PATCH', body: { status } });
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="stack">
      <section className="card">
        <div className="event-head">
          <div>
            <h1>
              {event.name} {event.status === 'archived' ? <span className="badge badge-muted">Archived</span> : null}
            </h1>
            <p className="muted">
              {formatDateTime(event.startsAt)} – {formatDateTime(event.endsAt)}
              {event.venue ? ` · ${event.venue}` : ''}
            </p>
          </div>
        </div>
        <div className="stats">
          <Stat label="Passes issued" value={event.passCount} />
          <Stat label="Named attendees" value={event.attendeeCount} />
          <Stat label="Checked in" value={event.redeemedCount} />
          <Stat label="Not yet used" value={Math.max(active, 0)} />
          <Stat label="Revoked" value={event.revokedCount} />
        </div>
        <ErrorNote message={error} />
      </section>

      <nav className="tabs" role="tablist">
        {TABS.map((name) => (
          <button key={name} role="tab" aria-selected={tab === name} className={`tab${tab === name ? ' active' : ''}`} onClick={() => setTab(name)}>
            {name}
          </button>
        ))}
      </nav>

      <section className="card" role="tabpanel">
        {tab === 'Passes' && <PassesPanel token={token} event={event} onChanged={onChanged} />}
        {tab === 'Live scans' && <ScansPanel token={token} event={event} onChanged={onChanged} />}
        {tab === 'Scanners' && <ScannersPanel token={token} event={event} />}
        {tab === 'Pass design' && <DesignPanel token={token} event={event} onChanged={onChanged} />}
        {tab === 'Settings' && (
          <div className="stack">
            <EventForm token={token} event={event} onSaved={onChanged} />
            <hr />
            {event.status === 'active' ? (
              <div>
                <h3>Archive event</h3>
                <p className="muted">Stops all check-ins and issuance. History stays available.</p>
                <button className="btn btn-danger" onClick={() => void setStatus('archived')}>
                  Archive event
                </button>
              </div>
            ) : (
              <div>
                <h3>Reopen event</h3>
                <button className="btn btn-secondary" onClick={() => void setStatus('active')}>
                  Reopen event
                </button>
              </div>
            )}
          </div>
        )}
        {tab === 'Audit log' && <AuditPanel token={token} event={event} />}
      </section>
    </div>
  );
}
