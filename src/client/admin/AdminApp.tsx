import { CalendarPlus, Plus, ScanLine, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { AccountUser, EventSummary, SessionInfo } from '../../shared/types';
import { api, ApiError, WAKING_MESSAGE } from '../api';
import { EmptyState, ErrorNote, SectionHead, ToneBadge, errorMessage } from '../ui';
import { formatDateInZone } from '../time';
import { AccountMenu } from './AccountMenu';
import { CurrentUserContext } from './current-user';
import { AuthLayout, InvitePage, ResetPassword, SignIn, SignUp, WAKE_TIMEOUT_MS } from './AuthScreens';
import { DemoBanner } from './DemoBanner';
import { EVENT_TABS, EventDetail, type EventTab } from './EventDetail';
import { EventForm } from './EventForm';
import { UNAUTHORIZED_EVENT, adminApi } from './http';
import { STATUS_META } from './model';
import { PlatformPage } from './PlatformPage';
import { ToastProvider, useToast } from './toast';

/** `GET /api/health`. */
interface Health {
  demo?: boolean;
  /** Self-registration is allowed. */
  signup: boolean;
}

type Boot = { state: 'loading'; slow: boolean } | { state: 'error'; message: string } | { state: 'ready'; health: Health; session: SessionInfo | null };

type Route =
  | { kind: 'events'; eventId: string | null; tab: EventTab }
  | { kind: 'platform' }
  | { kind: 'invite'; token: string }
  | { kind: 'reset'; token: string }
  | { kind: 'signup' };

/**
 * `#/events/<id>[/<tab>]`, `#/platform`, `#/invite/<token>`, `#/reset/<token>`,
 * `#/signup`; anything else is the event list. Unknown tabs fall back to Operations.
 */
function routeFromHash(): Route {
  const hash = window.location.hash;
  const token = /^#\/(invite|reset)\/([\w-]+)$/.exec(hash);
  if (token) return { kind: token[1] as 'invite' | 'reset', token: token[2] };
  if (hash === '#/platform') return { kind: 'platform' };
  if (hash === '#/signup') return { kind: 'signup' };
  const match = /^#\/events\/([\w-]+)(?:\/([\w-]+))?$/.exec(hash);
  const tab = EVENT_TABS.find((item) => item.id === match?.[2])?.id ?? 'operations';
  return { kind: 'events', eventId: match ? match[1] : null, tab };
}

/** The current session, or null when signed out (401). */
async function loadSession(options: { timeoutMs?: number; onSlow?: () => void } = {}): Promise<SessionInfo | null> {
  try {
    return await api<SessionInfo>('/api/auth/session', options);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export function AdminApp() {
  return (
    <ToastProvider>
      <AdminRoot />
    </ToastProvider>
  );
}

function AdminRoot() {
  const [boot, setBoot] = useState<Boot>({ state: 'loading', slow: false });
  const [attempt, setAttempt] = useState(0);
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [notice, setNotice] = useState('');
  const notify = useToast();

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // First contact may wake a sleeping free-tier backend: allow 70 s and say why it is slow.
  useEffect(() => {
    let live = true;
    setBoot({ state: 'loading', slow: false });
    const options = { timeoutMs: WAKE_TIMEOUT_MS, onSlow: () => live && setBoot((current) => (current.state === 'loading' ? { state: 'loading', slow: true } : current)) };
    Promise.all([api<Health>('/api/health', options), loadSession(options)])
      .then(([health, session]) => live && setBoot({ state: 'ready', health, session }))
      .catch((err) => live && setBoot({ state: 'error', message: errorMessage(err) }));
    return () => {
      live = false;
    };
  }, [attempt]);

  const setSession = useCallback((session: SessionInfo | null) => {
    setBoot((current) => (current.state === 'ready' ? { ...current, session } : current));
    if (session) setNotice('');
  }, []);

  useEffect(() => {
    const onUnauthorized = () => {
      setBoot((current) => (current.state === 'ready' && current.session ? { ...current, session: null } : current));
      setNotice('Your session has ended. Sign in again to continue.');
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch (err) {
      // 401: already signed out. Anything else: the cookie may still be valid, so stay signed in.
      if (!(err instanceof ApiError && err.status === 401)) {
        notify(`Could not sign out: ${errorMessage(err)}`, 'bad');
        return;
      }
    }
    setSession(null);
    setNotice('You are signed out.');
  }, [notify, setSession]);

  if (boot.state === 'loading') {
    return (
      <AuthLayout title="Opening GatePass" demo={false}>
        <p className="muted" role="status">
          {boot.slow ? WAKING_MESSAGE : 'Loading…'}
        </p>
      </AuthLayout>
    );
  }
  if (boot.state === 'error') {
    return (
      <AuthLayout title="GatePass is unavailable" demo={false}>
        <ErrorNote message={boot.message} />
        <button type="button" className="btn btn-primary btn-block" onClick={() => setAttempt((value) => value + 1)}>
          Try again
        </button>
      </AuthLayout>
    );
  }

  const demo = boot.health.demo === true;
  const user = boot.session?.user ?? null;
  const signedIn = (session: SessionInfo) => {
    setSession(session);
    if (route.kind === 'signup') window.location.hash = '/';
  };

  if (route.kind === 'invite') {
    return (
      <InvitePage
        demo={demo}
        token={route.token}
        user={user}
        onSignOut={signOut}
        onAccepted={async (eventId) => {
          setSession(await loadSession());
          notify('Invitation accepted');
          window.location.hash = eventId ? `/events/${eventId}` : '/';
        }}
      />
    );
  }
  if (route.kind === 'reset') {
    return (
      <ResetPassword
        demo={demo}
        token={route.token}
        onReset={() => {
          setSession(null);
          setNotice('Password updated and every device signed out. Sign in with your new password.');
          window.location.hash = '/';
        }}
      />
    );
  }
  if (!user) {
    if (route.kind === 'signup' && boot.health.signup) return <SignUp demo={demo} onSignedIn={signedIn} />;
    return <SignIn demo={demo} signupAllowed={boot.health.signup} notice={notice} onSignedIn={signedIn} />;
  }
  return (
    <CurrentUserContext.Provider value={user}>
      <Dashboard user={user} demo={demo} route={route} onSignOut={signOut} onSession={setSession} />
    </CurrentUserContext.Provider>
  );
}

interface DashboardProps {
  user: AccountUser;
  demo: boolean;
  route: Route;
  onSignOut: () => Promise<void>;
  onSession: (session: SessionInfo) => void;
}

function Dashboard({ user, demo, route, onSignOut, onSession }: DashboardProps) {
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const isPlatformAdmin = user.platformRole === 'platform_admin';
  const eventRoute = route.kind === 'events' ? route : null;

  const loadEvents = useCallback(async () => {
    try {
      setEvents(await adminApi<EventSummary[]>('/api/events'));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  function navigate(eventId: string, tab: EventTab = 'operations') {
    setCreating(false);
    window.location.hash = tab === 'operations' ? `/events/${eventId}` : `/events/${eventId}/${tab}`;
  }

  const selected = events?.find((event) => event.id === eventRoute?.eventId) ?? null;

  let content;
  if (creating) {
    content = (
      <section className="card form-card" aria-labelledby="new-event-title">
        <SectionHead id="new-event-title" title="New event" description="Name, venue, time zone and the time window passes are valid in. Gates, policies and devices come next." />
        <EventForm
          onCancel={() => setCreating(false)}
          onSaved={async (event) => {
            await loadEvents();
            navigate(event.id);
          }}
        />
      </section>
    );
  } else if (route.kind === 'platform') {
    content = isPlatformAdmin ? (
      <PlatformPage user={user} />
    ) : (
      <section className="card">
        <EmptyState title="Platform administration is for platform admins">
          <p>Your account can create and run events. Ask a platform admin if you need another account managed.</p>
        </EmptyState>
      </section>
    );
  } else if (selected && eventRoute) {
    content = (
      <EventDetail
        key={selected.id}
        event={selected}
        tab={eventRoute.tab}
        onTab={(tab) => navigate(selected.id, tab)}
        onChanged={loadEvents}
        onOpenEvent={async (eventId) => {
          await loadEvents();
          navigate(eventId);
        }}
      />
    );
  } else if (events !== null) {
    content = (
      <section className="card">
        <EmptyState title={eventRoute?.eventId ? 'Event not found' : events.length ? 'Select an event' : 'Create your first event'}>
          <p>
            {eventRoute?.eventId
              ? 'It may have been removed, or you are not on its team. Choose another event from the list.'
              : events.length
                ? 'Choose an event from the list to manage passes, gates and check-ins.'
                : 'An event holds its passes, gates, admission policies and door devices. Events you are invited to manage also appear here.'}
          </p>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <CalendarPlus size={16} aria-hidden /> New event
          </button>
        </EmptyState>
      </section>
    );
  } else content = null;

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#/">
          GatePass
        </a>
        <nav className="topbar-actions" aria-label="Account">
          {isPlatformAdmin ? (
            <a className="btn btn-ghost btn-small" href="#/platform" aria-current={route.kind === 'platform' ? 'page' : undefined}>
              <ShieldCheck size={15} aria-hidden /> <span className="topbar-label">Platform</span>
            </a>
          ) : null}
          <a className="btn btn-ghost btn-small" href="/scan">
            <ScanLine size={15} aria-hidden /> <span className="topbar-label">Scanner</span>
          </a>
          <AccountMenu user={user} onSignOut={onSignOut} onSession={onSession} />
        </nav>
      </header>
      <DemoBanner demo={demo} />
      <div className="layout">
        <aside className="sidebar" aria-label="Events">
          <div className="sidebar-head">
            <h2 className="label">Events</h2>
            <button className="btn btn-ghost btn-icon sidebar-new" onClick={() => setCreating(true)} aria-label="New event" title="New event">
              <Plus size={16} aria-hidden />
              <span className="sidebar-new-text" aria-hidden>
                New event
              </span>
            </button>
          </div>
          {events?.length ? (
            /* Narrow screens show this picker instead of the list. */
            <label className="event-select">
              <span className="sr-only">Event</span>
              <select value={creating ? '' : (selected?.id ?? '')} onChange={(e) => e.target.value && navigate(e.target.value)}>
                {creating || !selected ? <option value="">{creating ? 'New event' : 'Choose an event'}</option> : null}
                {events.map((event) => (
                  <option key={event.id} value={event.id}>
                    {event.status === 'active' ? event.name : `${event.name} (${STATUS_META[event.status].label.toLowerCase()})`}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <ErrorNote message={error} />
          {error ? (
            <button type="button" className="btn btn-secondary btn-small sidebar-note" onClick={() => void loadEvents()}>
              Retry
            </button>
          ) : null}
          {events === null && !error ? (
            <p className="muted small sidebar-note" role="status">
              Loading events…
            </p>
          ) : null}
          {events?.length === 0 ? <p className="muted small sidebar-note">No events yet.</p> : null}
          <ul className="event-list">
            {events?.map((event) => {
              const current = event.id === eventRoute?.eventId && !creating;
              return (
                <li key={event.id}>
                  <button className={`event-item${current ? ' selected' : ''}`} aria-current={current ? 'page' : undefined} onClick={() => navigate(event.id)}>
                    <span className="event-item-name">
                      <span className="event-item-title">{event.name}</span>
                      {event.status === 'active' ? null : <ToneBadge tone={STATUS_META[event.status].tone}>{STATUS_META[event.status].label}</ToneBadge>}
                    </span>
                    <span className="event-item-meta num">
                      {formatDateInZone(event.startsAt, event.timeZone)}
                      {event.myRole === 'manager' ? ' · Manager' : ''}
                    </span>
                    <span className="event-item-meta num">
                      {event.passCount} passes · {event.redeemedCount} checked in
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
        <main className="content">{content}</main>
      </div>
    </div>
  );
}
