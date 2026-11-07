import { useId, useState, type FormEvent } from 'react';
import type { EventSummary } from '../../shared/types';
import { api, fromLocalInput, toLocalInput } from '../api';
import { ErrorNote, FieldError, errorMessage, focusFirstInvalid } from '../ui';

interface Props {
  token: string;
  event?: EventSummary;
  onSaved: (event: EventSummary) => void | Promise<void>;
  onCancel?: () => void;
}

interface Errors {
  name?: string;
  startsAt?: string;
  endsAt?: string;
}

function validate(name: string, startsAt: string, endsAt: string): Errors {
  const errors: Errors = {};
  if (!name.trim()) errors.name = 'Enter a name for the event.';
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();
  if (!startsAt || Number.isNaN(start)) errors.startsAt = 'Enter when the doors open.';
  if (!endsAt || Number.isNaN(end)) errors.endsAt = 'Enter when the event ends.';
  else if (!errors.startsAt && end <= start) errors.endsAt = 'The event must end after it starts.';
  return errors;
}

/** Create (no `event`) or edit an event's name, venue and time window. */
export function EventForm({ token, event, onSaved, onCancel }: Props) {
  const defaultStart = new Date(Date.now() + 86_400_000);
  defaultStart.setMinutes(0, 0, 0);
  const [name, setName] = useState(event?.name ?? '');
  const [venue, setVenue] = useState(event?.venue ?? '');
  const [startsAt, setStartsAt] = useState(toLocalInput(event?.startsAt ?? defaultStart.toISOString()));
  const [endsAt, setEndsAt] = useState(toLocalInput(event?.endsAt ?? new Date(defaultStart.getTime() + 4 * 3_600_000).toISOString()));
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useId();
  const errors = showErrors ? validate(name, startsAt, endsAt) : {};

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (Object.keys(validate(name, startsAt, endsAt)).length) {
      setShowErrors(true);
      focusFirstInvalid(e.currentTarget);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const body = { name: name.trim(), venue: venue.trim() || null, startsAt: fromLocalInput(startsAt), endsAt: fromLocalInput(endsAt) };
      const saved = event
        ? await api<EventSummary>(`/api/events/${event.id}`, token, { method: 'PATCH', body })
        : await api<EventSummary>('/api/events', token, { body });
      setShowErrors(false);
      await onSaved(saved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form-grid" onSubmit={submit} noValidate>
      <label className="span-2">
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
          required
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={`${id}-name-error`}
        />
        <FieldError id={`${id}-name-error`} message={errors.name} />
      </label>
      <label className="span-2">
        <span>Venue (optional)</span>
        <input value={venue} onChange={(e) => setVenue(e.target.value)} maxLength={200} />
      </label>
      <label>
        Starts
        <input
          type="datetime-local"
          value={startsAt}
          onChange={(e) => setStartsAt(e.target.value)}
          required
          aria-invalid={errors.startsAt ? true : undefined}
          aria-describedby={`${id}-starts-error`}
        />
        <FieldError id={`${id}-starts-error`} message={errors.startsAt} />
      </label>
      <label>
        Ends
        <input
          type="datetime-local"
          value={endsAt}
          onChange={(e) => setEndsAt(e.target.value)}
          required
          aria-invalid={errors.endsAt ? true : undefined}
          aria-describedby={`${id}-ends-error`}
        />
        <FieldError id={`${id}-ends-error`} message={errors.endsAt} />
      </label>
      <p className="muted small span-2">Passes expire when the event ends unless you set another expiry when issuing them.</p>
      <ErrorNote message={error} />
      <div className="actions span-2">
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : event ? 'Save changes' : 'Create event'}
        </button>
        {onCancel ? (
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
