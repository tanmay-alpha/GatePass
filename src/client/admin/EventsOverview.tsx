import { Calendar, CalendarPlus, MapPin } from 'lucide-react';
import type { EventSummary } from '../../shared/types';
import { Bar, ToneBadge } from '../ui';
import { formatRangeInZone } from '../time';
import { STATUS_META } from './model';
import { isReadyForDoors, needsSetup } from './SetupChecklist';

interface Props {
  events: EventSummary[];
  canCreate: boolean;
  onCreate: () => void;
}

/** Landing page when no event is open: every event as a card, or a first-run guide when there are none. */
export function EventsOverview({ events, canCreate, onCreate }: Props) {
  const newEvent = canCreate ? (
    <button type="button" className="btn btn-primary" onClick={onCreate}>
      <CalendarPlus size={16} aria-hidden /> New event
    </button>
  ) : null;

  if (events.length === 0) {
    return (
      <section className="first-run" aria-labelledby="overview-title">
        <div className="stack-sm">
          <h1 id="overview-title">Welcome to GatePass</h1>
          <p className="muted">
            {canCreate
              ? 'Three steps take an event from nothing to people walking through the door.'
              : 'Your account works on events you are invited to; they appear here once you accept an invitation. Ask a platform administrator if you need to create your own.'}
          </p>
        </div>
        {canCreate ? (
          <>
            <ol className="first-run-steps">
              <li>
                <span className="setup-marker num" aria-hidden>
                  1
                </span>
                <span className="strong">Create the event</span>
                <span className="muted small">Name, venue and the hours the doors are open.</span>
              </li>
              <li>
                <span className="setup-marker num" aria-hidden>
                  2
                </span>
                <span className="strong">Issue passes</span>
                <span className="muted small">Type or import attendees; each gets a QR pass link.</span>
              </li>
              <li>
                <span className="setup-marker num" aria-hidden>
                  3
                </span>
                <span className="strong">Set up the door</span>
                <span className="muted small">Add a scanner device and open its setup link on the door phone.</span>
              </li>
            </ol>
            <div className="actions">{newEvent}</div>
          </>
        ) : null}
      </section>
    );
  }
  // Soonest first for what is running or coming up; most recent first for the past.
  const current = events.filter((event) => event.status === 'draft' || event.status === 'active').sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const past = events.filter((event) => event.status === 'ended' || event.status === 'archived').sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));

  return (
    <div className="overview">
      <div className="page-head">
        <div>
          <h1>Your events</h1>
          <p className="muted">
            {events.length} event{events.length === 1 ? '' : 's'}. Open one to issue passes, set up the doors and follow check-ins.
          </p>
        </div>
        {newEvent}
      </div>
      {current.length ? <EventGroup title={past.length ? 'Current and upcoming' : null} events={current} /> : null}
      {past.length ? <EventGroup title="Past" events={past} /> : null}
    </div>
  );
}

function EventGroup({ title, events }: { title: string | null; events: EventSummary[] }) {
  const list = (
    <ul className="event-cards">
      {events.map((event) => (
        <li key={event.id}>
          <EventCard event={event} />
        </li>
      ))}
    </ul>
  );
  if (!title) return list;
  return (
    <section className="stack-sm" aria-label={title}>
      <h2 className="label">{title}</h2>
      {list}
    </section>
  );
}

function EventCard({ event }: { event: EventSummary }) {
  const status = STATUS_META[event.status];
  const setupPending = needsSetup(event) && !isReadyForDoors(event);
  const share = event.passCount ? Math.round((event.redeemedCount / event.passCount) * 100) : 0;
  return (
    <a className="event-card" href={`#/events/${event.id}`}>
      <div className="event-card-head">
        <h2 className="event-card-name">{event.name}</h2>
        <ToneBadge tone={status.tone}>{status.label}</ToneBadge>
      </div>
      <div className="event-card-meta">
        <span className="num">
          <Calendar size={14} aria-hidden /> {formatRangeInZone(event.startsAt, event.endsAt, event.timeZone)}
        </span>
        {event.venue ? (
          <span>
            <MapPin size={14} aria-hidden /> <span className="truncate">{event.venue}</span>
          </span>
        ) : null}
        {event.myRole === 'manager' ? <span>You manage this event</span> : null}
      </div>
      <div className="event-card-foot">
        {event.passCount ? (
          <>
            <span className="num">
              <span className="strong">{event.redeemedCount}</span> of {event.passCount} checked in <span className="muted">· {share}%</span>
            </span>
            <Bar value={event.redeemedCount} max={event.passCount} />
          </>
        ) : (
          <span className="muted">No passes issued yet</span>
        )}
        {setupPending ? (
          <span>
            <ToneBadge tone="warn">Setup not finished</ToneBadge>
          </span>
        ) : null}
      </div>
    </a>
  );
}
