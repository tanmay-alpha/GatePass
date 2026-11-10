import { useId, useMemo, useState, type FormEvent } from 'react';
import type { EventSummary } from '../../shared/types';
import { ErrorNote, FieldError, errorMessage, focusFirstInvalid } from '../ui';
import { browserTimeZone, fromZoneInput, listTimeZones, toZoneInput, zoneLabel } from '../time';
import { adminApi } from './http';

interface Props {
  event?: EventSummary;
  onSaved: (event: EventSummary) => void | Promise<void>;
  onCancel?: () => void;
}

interface Errors {
  name?: string;
  startsAt?: string;
  endsAt?: string;
  capacity?: string;
}

function validate(name: string, startsAt: string | null, endsAt: string | null, capacity: string, admitted: number): Errors {
  const errors: Errors = {};
  if (!name.trim()) errors.name = 'Enter a name for the event.';
  if (!startsAt) errors.startsAt = 'Enter when the doors open.';
  if (!endsAt) errors.endsAt = 'Enter when the event ends.';
  else if (startsAt && endsAt <= startsAt) errors.endsAt = 'The event must end after it starts.';
  if (capacity.trim()) {
    const value = Number(capacity);
    if (!Number.isInteger(value) || value < 1) errors.capacity = 'Capacity must be a whole number of at least 1. Leave it empty for no limit.';
    else if (value < admitted) errors.capacity = `${admitted} people are already admitted, so capacity cannot be lower than ${admitted}.`;
  }
  return errors;
}

/** Create (no `event`) or edit an event's name, venue, time zone, time window and capacity. */
export function EventForm({ event, onSaved, onCancel }: Props) {
  const [timeZone, setTimeZone] = useState(event?.timeZone ?? browserTimeZone());
  const zones = useMemo(() => listTimeZones(timeZone), [timeZone]);
  const [defaults] = useState(() => {
    const start = new Date(Date.now() + 86_400_000);
    start.setUTCMinutes(0, 0, 0);
    return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 4 * 3_600_000).toISOString() };
  });
  const [name, setName] = useState(event?.name ?? '');
  const [venue, setVenue] = useState(event?.venue ?? '');
  const [startsAt, setStartsAt] = useState(toZoneInput(event?.startsAt ?? defaults.startsAt, timeZone));
  const [endsAt, setEndsAt] = useState(toZoneInput(event?.endsAt ?? defaults.endsAt, timeZone));
  const [capacity, setCapacity] = useState(event?.capacity ? String(event.capacity) : '');
  const [status, setStatus] = useState<'draft' | 'active'>('draft');
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useId();
  const admitted = event?.admittedCount ?? 0;
  const readOnly = event?.status === 'archived';
  const startIso = fromZoneInput(startsAt, timeZone);
  const endIso = fromZoneInput(endsAt, timeZone);
  const errors = showErrors ? validate(name, startIso, endIso, capacity, admitted) : {};
  const zoneHint = startIso ? `${zoneLabel(timeZone, startIso)}. Start and end are times on a clock in this zone.` : 'Start and end are times on a clock in this zone.';

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (Object.keys(validate(name, startIso, endIso, capacity, admitted)).length || !startIso || !endIso) {
      setShowErrors(true);
      focusFirstInvalid(e.currentTarget);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const body = {
        name: name.trim(),
        venue: venue.trim() || null,
        timeZone,
        startsAt: startIso,
        endsAt: endIso,
        capacity: capacity.trim() ? Number(capacity) : null
      };
      const saved = event
        ? await adminApi<EventSummary>(`/api/events/${event.id}`, { method: 'PATCH', body })
        : await adminApi<EventSummary>('/api/events', { body: { ...body, status } });
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
      <fieldset className="form-grid span-2" disabled={readOnly}>
        <label className="span-2">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required aria-invalid={errors.name ? true : undefined} aria-describedby={`${id}-name-error`} />
          <FieldError id={`${id}-name-error`} message={errors.name} />
        </label>
        <label className="span-2">
          <span>Venue (optional)</span>
          <input value={venue} onChange={(e) => setVenue(e.target.value)} maxLength={200} />
        </label>
        <label className="span-2">
          Time zone
          <select value={timeZone} onChange={(e) => setTimeZone(e.target.value)} aria-describedby={`${id}-zone-hint`}>
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          <span id={`${id}-zone-hint`} className="field-hint">
            {zoneHint}
          </span>
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
          <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} required aria-invalid={errors.endsAt ? true : undefined} aria-describedby={`${id}-ends-error`} />
          <FieldError id={`${id}-ends-error`} message={errors.endsAt} />
        </label>
        <label className="span-2">
          Event capacity (optional)
          <input
            type="number"
            min={Math.max(1, admitted)}
            step={1}
            inputMode="numeric"
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            aria-invalid={errors.capacity ? true : undefined}
            aria-describedby={`${id}-capacity-hint ${id}-capacity-error`}
          />
          <span id={`${id}-capacity-hint`} className="field-hint">
            Most people admitted across every gate and policy, e.g. the venue limit. Empty: no limit.{admitted ? ` ${admitted} already admitted.` : ''}
          </span>
          <FieldError id={`${id}-capacity-error`} message={errors.capacity} />
        </label>
        {event ? null : (
          <fieldset className="span-2">
            <legend>Start as</legend>
            <div className="segmented segmented-block" role="radiogroup" aria-label="Start as">
              <button type="button" role="radio" aria-checked={status === 'draft'} className={status === 'draft' ? 'active' : ''} onClick={() => setStatus('draft')}>
                Draft
              </button>
              <button type="button" role="radio" aria-checked={status === 'active'} className={status === 'active' ? 'active' : ''} onClick={() => setStatus('active')}>
                Active
              </button>
            </div>
            <p className="field-hint">
              {status === 'draft' ? 'Set up gates, passes and devices first; scanners refuse every pass until you open the event.' : 'Scanners admit valid passes as soon as the event window starts.'}
            </p>
          </fieldset>
        )}
        <p className="muted small span-2">Passes expire when the event ends unless you set another expiry when issuing them.</p>
      </fieldset>
      <ErrorNote message={error} />
      {readOnly ? null : (
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
      )}
    </form>
  );
}
