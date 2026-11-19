import { Plus, ScanLine, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountUser, EventSummary, SecurityNotice, SessionInfo } from '../../shared/types';
import { api, ApiError, WAKING_MESSAGE } from '../api';
import { EmptyState, ErrorNote, SectionHead, ToneBadge, errorMessage, formatShortDateTime } from '../ui';
import { formatDateInZone } from '../time';
import { AccountMenu } from './AccountMenu';
import { CurrentUserContext } from './current-user';
import { AuthLayout, ForgotPassword, InvitePage, ResetPassword, SignIn, SignUp, WAKE_TIMEOUT_MS } from './AuthScreens';
import { DemoBanner } from './DemoBanner';
import { EVENT_TABS, EventDetail, type EventTab } from './EventDetail';
import { EventForm } from './EventForm';
import { UNAUTHORIZED_EVENT, adminApi } from './http';
import { STATUS_META } from './model';
import { EventsOverview } from './EventsOverview';
import { PlatformPage } from './PlatformPage';
import { ToastProvider, useToast } from './toast';

/** `GET /api/health`. */
interface Health {
  demo?: boolean;
  /** Self-registration is allowed. */
  signup: boolean;
  /** Invitations and reset links can be emailed (self-service recovery). */
  email?: boolean;
}

type Boot = { state: 'loading'; slow: boolean } | { state: 'error'; message: string } | { state: 'ready'; health: Health; session: SessionInfo | null };

type Route =
  | { kind: 'events'; eventId: string | null; tab: EventTab }
  | { kind: 'platform' }
  | { kind: 'invite'; token: string }
  | { kind: 'reset'; token: string }
  | { kind: 'signup' }
  | { kind: 'forgot' };

/**
 * `#/events/<id>[/<tab>]`, `#/platform`, `#/invite/<token>`, `#/reset/<token>`,
 * `#/signup`, `#/forgot`; anything else is the event list. Unknown tabs fall back to Operations.
 */
function routeFromHash(): Route {
  const hash = window.location.hash;
  const token = /^#\/(invite|reset)\/([\w-]+)$/.exec(hash);
  if (token) return { kind: token[1] as 'invite' | 'reset', token: token[2] };
  if (hash === '#/platform') return { kind: 'platform' };
  if (hash === '#/signup') return { kind: 'signup' };
  if (hash === '#/forgot') return { kind: 'forgot' };
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
    if (route.kind === 'forgot') return <ForgotPassword demo={demo} emailEnabled={boot.health.email === true} />;
    return <SignIn demo={demo} signupAllowed={boot.health.signup} emailEnabled={boot.health.email === true} notice={notice} onSignedIn={signedIn} />;
  }
  return (
    <CurrentUserContext.Provider value={user}>
      <Dashboard user={user} demo={demo} route={route} securityNotice={boot.session?.securityNotice ?? null} onSignOut={signOut} onSession={setSession} />
    </CurrentUserContext.Provider>
  );
}

interface DashboardProps {
  user: AccountUser;
  demo: boolean;
  route: Route;
  securityNotice: SecurityNotice | null;
  onSignOut: () => Promise<void>;
  onSession: (session: SessionInfo) => void;
}

function Dashboard({ user, demo, route, securityNotice, onSignOut, onSession }: DashboardProps) {
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const canCreate = user.canCreateEvents;
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const isPlatformAdmin = user.platformRole === 'platform_admin';
  const eventRoute = route.kind === 'events' ? route : null;

  // Overlapping reloads: only the latest request's answer is applied, so an older response never overwrites a newer one.
  const eventsRequest = useRef(0);
  const loadEvents = useCallback(async () => {
    const id = ++eventsRequest.current;
    try {
      const next = await adminApi<EventSummary[]>('/api/events');
      if (id !== eventsRequest.current) return;
      setEvents(next);
      setError('');
    } catch (err) {
      if (id === eventsRequest.current) setError(errorMessage(err));
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
  // A link to an event the list does not have yet (created in another tab, or opened from an invitation after the list
  // loaded) fetches the list once more before saying the event is not found.
  const missing = events !== null && eventRoute?.eventId && !selected ? eventRoute.eventId : null;
  const [recheck, setRecheck] = useState<{ eventId: string; done: boolean } | null>(null);
  useEffect(() => {
    if (!missing || recheck?.eventId === missing) return;
    setRecheck({ eventId: missing, done: false });
    void loadEvents().finally(() => setRecheck({ eventId: missing, done: true }));
  }, [missing, recheck, loadEvents]);

  let content;
  if (creating) {
    content = (
      <section className="card form-card" aria-labelledby="new-event-title">
        <SectionHead id="new-event-title" level={1} title="New event" description="Name, venue, time zone and the time window passes are valid in. Gates, policies and devices come next." />
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
  } else if (missing && !(recheck?.eventId === missing && recheck.done)) {
    content = (
      <p className="muted" role="status">
        Loading event…
      </p>
    );
  } else if (events !== null && eventRoute?.eventId) {
    content = (
      <section className="card">
        <EmptyState title="Event not found">
          <p>It may have been removed, or you are not on its team. Choose another event from the list.</p>
          <a className="btn btn-secondary" href="#/">
            All events
          </a>
        </EmptyState>
      </section>
    );
  } else if (events !== null) {
    content = <EventsOverview events={events} canCreate={canCreate} onCreate={() => setCreating(true)} />;
  } else content = null;

  return (
    <div className="shell">
      {/* Moves focus rather than following the fragment: the hash is the app's route. */}
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        Skip to content
      </a>
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
      {securityNotice && !noticeDismissed ? (
        <div className="notice security-notice" role="alert">
          <p>
            The password of this account was last set through a reset link that {securityNotice.by === 'operator' ? 'the GatePass operator' : securityNotice.by} created (
            {formatShortDateTime(securityNotice.at)}). If you did not ask for this, change your password now and tell your administrator.
          </p>
          <button
            type="button"
            className="btn btn-ghost btn-small"
            onClick={() => {
              // Recorded on the server, so the notice does not return on other devices.
              adminApi('/api/auth/security-notice/acknowledge', { method: 'POST' }).then(
                () => setNoticeDismissed(true),
                (err: unknown) => setError(errorMessage(err))
              );
            }}
          >
            I asked for this
          </button>
        </div>
      ) : null}
      <div className="layout">
        <aside className="sidebar" aria-label="Events">
          <div className="sidebar-head">
            <h2 className="label">Events</h2>
            {canCreate ? (
              <button className="btn btn-ghost btn-icon sidebar-new" onClick={() => setCreating(true)} aria-label="New event" title="New event">
                <Plus size={16} aria-hidden />
                <span className="sidebar-new-text" aria-hidden>
                  New event
                </span>
              </button>
            ) : null}
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
        <main id="main-content" className="content" tabIndex={-1}>
          {content}
        </main>
      </div>
    </div>
  );
}
