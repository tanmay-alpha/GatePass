import { Copy } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { EventStatus, EventSummary } from '../../shared/types';
import { useConfirm, type ConfirmOptions } from '../dialog';
import { ErrorNote, FieldError, SectionHead, ToneBadge, errorMessage, focusFirstInvalid } from '../ui';
import { fromZoneInput, toZoneInput, zoneLabel } from '../time';
import { EventForm } from './EventForm';
import { adminApi } from './http';
import { ARCHIVED_NOTE, STATUS_META, TRANSITIONS, can } from './model';
import { useToast } from './toast';

interface Props {
  event: EventSummary;
  onChanged: () => Promise<void>;
  onOpenEvent: (eventId: string) => Promise<void>;
}

export function SettingsPanel({ event, onChanged, onOpenEvent }: Props) {
  const notify = useToast();
  const editable = can(event, 'edit');
  return (
    <div className="stack-lg">
      <LifecycleSection event={event} onChanged={onChanged} />
      <section className="card" aria-labelledby="details-title">
        <SectionHead id="details-title" title="Event details" description={event.status === 'archived' ? ARCHIVED_NOTE : undefined} />
        {editable ? (
          <EventForm
            event={event}
            onSaved={async () => {
              await onChanged();
              notify('Event details saved');
            }}
          />
        ) : (
          <p className="muted small">You can view this event but not change its details.</p>
        )}
      </section>
      {editable ? <CloneSection event={event} onOpenEvent={onOpenEvent} /> : null}
    </div>
  );
}

const ACTION: Record<EventStatus, { label: string; busy: string; done: string }> = {
  draft: { label: 'Back to draft', busy: 'Saving…', done: 'Event is a draft' },
  active: { label: 'Open the event', busy: 'Opening…', done: 'Event is open: scanners admit valid passes' },
  ended: { label: 'End the event', busy: 'Ending…', done: 'Event ended: scanners refuse every pass' },
  archived: { label: 'Archive', busy: 'Archiving…', done: 'Event archived' }
};

function confirmation(event: EventSummary, to: EventStatus): ConfirmOptions {
  switch (to) {
    case 'active':
      return {
        title: `Open “${event.name}”?`,
        body: 'Scanners start admitting valid passes inside the event and policy windows. Check that passes, gates and devices are ready.',
        confirmLabel: 'Open the event'
      };
    case 'ended':
      return event.status === 'archived'
        ? { title: `Restore “${event.name}”?`, body: 'The event becomes Ended: still closed to entry, but editable again. Reopen it afterwards if doors should open.', confirmLabel: 'Restore as ended' }
        : {
            title: `End “${event.name}”?`,
            body: 'Every scanner refuses every pass from now on and no new passes can be issued. You can reopen the event later.',
            confirmLabel: 'End the event',
            danger: true
          };
    case 'archived':
      return {
        title: `Archive “${event.name}”?`,
        body: 'The event becomes read-only history: no one is admitted and nothing can be changed. Scans, passes and the audit log stay available. You can restore it as Ended later.',
        confirmLabel: 'Archive event',
        danger: true
      };
    case 'draft':
      return { title: 'Back to draft?', body: 'Scanners refuse every pass while the event is a draft.', confirmLabel: 'Back to draft' };
  }
}

/** Draft → Active → Ended → Archived, with only the moves the server allows. Only Active admits anyone. */
function LifecycleSection({ event, onChanged }: { event: EventSummary; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState<EventStatus | null>(null);
  const [error, setError] = useState('');
  const [confirm, dialog] = useConfirm();
  const notify = useToast();
  const allowed = can(event, 'lifecycle');
  const current = STATUS_META[event.status];

  async function move(to: EventStatus) {
    if (!(await confirm(confirmation(event, to)))) return;
    setBusy(to);
    setError('');
    try {
      await adminApi(`/api/events/${event.id}`, { method: 'PATCH', body: { status: to } });
      await onChanged();
      notify(ACTION[to].done);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card" aria-labelledby="lifecycle-title">
      <SectionHead id="lifecycle-title" title="Event status" description="Only an Active event admits anyone. Draft, Ended and Archived events refuse every pass at the door.">
        <ToneBadge tone={current.tone}>{current.label}</ToneBadge>
      </SectionHead>
      <ol className="lifecycle" aria-label="Lifecycle">
        {(Object.keys(STATUS_META) as EventStatus[]).map((status) => (
          <li key={status} className={status === event.status ? 'lifecycle-current' : undefined} aria-current={status === event.status ? 'step' : undefined}>
            <span className="strong">{STATUS_META[status].label}</span>
            <span className="muted small">{STATUS_META[status].summary}</span>
          </li>
        ))}
      </ol>
      <ErrorNote message={error} />
      {allowed ? (
        <div className="actions">
          {TRANSITIONS[event.status].map((to) => (
            <button
              key={to}
              id={`status-to-${to}`}
              type="button"
              className={`btn ${to === 'active' ? 'btn-primary' : to === 'archived' || (to === 'ended' && event.status === 'active') ? 'btn-secondary danger' : 'btn-secondary'}`}
              onClick={() => void move(to)}
              disabled={busy !== null}
            >
              {busy === to ? ACTION[to].busy : to === 'ended' && event.status === 'archived' ? 'Restore as ended' : to === 'active' && event.status === 'ended' ? 'Reopen the event' : ACTION[to].label}
            </button>
          ))}
        </div>
      ) : (
        <p className="muted small">Only the event owner can change its status.</p>
      )}
      {dialog}
    </section>
  );
}

/** Copies venue, zone, capacity, design, gates and policies (shifted to the new dates); not passes, devices or team. */
function CloneSection({ event, onOpenEvent }: { event: EventSummary; onOpenEvent: (eventId: string) => Promise<void> }) {
  const zone = event.timeZone;
  const [name, setName] = useState(`${event.name} (copy)`);
  const [startsAt, setStartsAt] = useState(() => toZoneInput(new Date(new Date(event.startsAt).getTime() + 7 * 86_400_000).toISOString(), zone));
  const [endsAt, setEndsAt] = useState(() => toZoneInput(new Date(new Date(event.endsAt).getTime() + 7 * 86_400_000).toISOString(), zone));
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const notify = useToast();
  const startIso = fromZoneInput(startsAt, zone);
  const endIso = fromZoneInput(endsAt, zone);
  const validate = () => {
    const errors: { name?: string; startsAt?: string; endsAt?: string } = {};
    if (!name.trim()) errors.name = 'Enter a name for the new event.';
    if (!startIso) errors.startsAt = 'Enter when the new event starts.';
    if (!endIso) errors.endsAt = 'Enter when the new event ends.';
    else if (startIso && endIso <= startIso) errors.endsAt = 'The event must end after it starts.';
    return errors;
  };
  const errors = showErrors ? validate() : {};

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (Object.keys(validate()).length) {
      setShowErrors(true);
      focusFirstInvalid(e.currentTarget);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const created = await adminApi<EventSummary>(`/api/events/${event.id}/clone`, { body: { name: name.trim(), startsAt: startIso, endsAt: endIso } });
      notify(`“${created.name}” created as a draft`);
      await onOpenEvent(created.id);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="clone-title">
      <SectionHead
        id="clone-title"
        title="Clone event"
        description="Creates a draft with the same venue, time zone, capacity, pass design, gates and policies (policy windows move with the new start). Passes, devices and the team are not copied; you become its owner."
      />
      <form className="form-grid" onSubmit={submit} noValidate>
        <label className="span-2">
          New event name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} aria-invalid={errors.name ? true : undefined} aria-describedby="clone-name-error" />
          <FieldError id="clone-name-error" message={errors.name} />
        </label>
        <label>
          New start
          <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} aria-invalid={errors.startsAt ? true : undefined} aria-describedby="clone-zone clone-starts-error" />
          <FieldError id="clone-starts-error" message={errors.startsAt} />
        </label>
        <label>
          New end
          <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} aria-invalid={errors.endsAt ? true : undefined} aria-describedby="clone-zone clone-ends-error" />
          <FieldError id="clone-ends-error" message={errors.endsAt} />
        </label>
        <p id="clone-zone" className="field-hint span-2">
          Times in {zone.replace(/_/g, ' ')} ({zoneLabel(zone, startIso ?? event.startsAt)}).
        </p>
        <ErrorNote message={error} />
        <div className="actions span-2">
          <button className="btn btn-secondary" disabled={busy}>
            <Copy size={15} aria-hidden /> {busy ? 'Cloning…' : 'Clone event'}
          </button>
        </div>
      </form>
    </section>
  );
}
