import { CalendarPlus, LogOut, Plus, ScanLine } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { EventSummary } from '../../shared/types';
import { api, ApiError } from '../api';
import { EmptyState, ErrorNote, SectionHead, ToneBadge, errorMessage, formatDate } from '../ui';
import { EVENT_TABS, EventDetail, type EventTab } from './EventDetail';
import { EventForm } from './EventForm';
import { ToastProvider } from './toast';

const TOKEN_KEY = 'gatepass.adminToken';

export function AdminApp() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? '');
  const signOut = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken('');
  }, []);

  if (!token) {
    return (
      <AdminLogin
        onSignIn={(value) => {
          sessionStorage.setItem(TOKEN_KEY, value);
          setToken(value);
        }}
      />
    );
  }
  return (
    <ToastProvider>
      <Dashboard token={token} onSignOut={signOut} />
    </ToastProvider>
  );
}

function AdminLogin({ onSignIn }: { onSignIn: (token: string) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/admin/session', value.trim());
      onSignIn(value.trim());
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'That admin token is not valid.' : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form className="card login-card" onSubmit={submit}>
        <div className="login-head">
          <span className="brand">GatePass</span>
          <h1>Sign in to admin</h1>
          <p className="muted small">
            Use the server's <code>ADMIN_TOKEN</code>. It is kept for this browser tab only.
          </p>
        </div>
        <label>
          Admin token
          <input type="password" autoComplete="current-password" value={value} onChange={(e) => setValue(e.target.value)} required />
        </label>
        <ErrorNote message={error} />
        <button className="btn btn-primary btn-block" disabled={busy || !value.trim()}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>
        <p className="muted small login-foot">
          Door staff: open <a href="/scan">the scanner</a> instead.
        </p>
      </form>
    </main>
  );
}

interface Route {
  eventId: string | null;
  tab: EventTab;
}

/** `#/events/<id>` or `#/events/<id>/<tab>`; unknown tabs fall back to Operations. */
function routeFromHash(): Route {
  const match = /^#\/events\/([\w-]+)(?:\/([\w-]+))?$/.exec(window.location.hash);
  const tab = EVENT_TABS.find((item) => item.id === match?.[2])?.id ?? 'operations';
  return { eventId: match ? match[1] : null, tab };
}

function Dashboard({ token, onSignOut }: { token: string; onSignOut: () => void }) {
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const loadEvents = useCallback(async () => {
    try {
      setEvents(await api<EventSummary[]>('/api/events', token));
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onSignOut();
      setError(errorMessage(err));
    }
  }, [token, onSignOut]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  function navigate(eventId: string, tab: EventTab = 'operations') {
    setCreating(false);
    window.location.hash = tab === 'operations' ? `/events/${eventId}` : `/events/${eventId}/${tab}`;
  }

  const selected = events?.find((event) => event.id === route.eventId) ?? null;

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">GatePass</span>
        <nav className="topbar-actions" aria-label="Account">
          <a className="btn btn-ghost btn-small" href="/scan">
            <ScanLine size={15} aria-hidden /> Scanner
          </a>
          <button className="btn btn-ghost btn-small" onClick={onSignOut}>
            <LogOut size={15} aria-hidden /> Sign out
          </button>
        </nav>
      </header>
      <div className="layout">
        <aside className="sidebar" aria-label="Events">
          <div className="sidebar-head">
            <h2 className="label">Events</h2>
            <button className="btn btn-ghost btn-icon" onClick={() => setCreating(true)} aria-label="New event" title="New event">
              <Plus size={16} aria-hidden />
            </button>
          </div>
          <ErrorNote message={error} />
          {events === null && !error ? <p className="muted small sidebar-note" role="status">Loading events…</p> : null}
          {events?.length === 0 ? <p className="muted small sidebar-note">No events yet.</p> : null}
          <ul className="event-list">
            {events?.map((event) => {
              const current = event.id === route.eventId && !creating;
              return (
                <li key={event.id}>
                  <button className={`event-item${current ? ' selected' : ''}`} aria-current={current ? 'page' : undefined} onClick={() => navigate(event.id)}>
                    <span className="event-item-name">
                      <span className="event-item-title">{event.name}</span>
                      {event.status === 'archived' ? <ToneBadge tone="muted">Archived</ToneBadge> : null}
                    </span>
                    <span className="event-item-meta num">{formatDate(event.startsAt)}</span>
                    <span className="event-item-meta num">
                      {event.passCount} passes · {event.redeemedCount} checked in
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
        <main className="content">
          {creating ? (
            <section className="card form-card" aria-labelledby="new-event-title">
              <SectionHead id="new-event-title" title="New event" description="Name, venue and the time window passes are valid in. Gates, policies and devices come next." />
              <EventForm
                token={token}
                onCancel={() => setCreating(false)}
                onSaved={async (event) => {
                  await loadEvents();
                  navigate(event.id, 'passes');
                }}
              />
            </section>
          ) : selected ? (
            <EventDetail key={selected.id} token={token} event={selected} tab={route.tab} onTab={(tab) => navigate(selected.id, tab)} onChanged={loadEvents} />
          ) : events === null ? null : (
            <section className="card">
              <EmptyState title={route.eventId ? 'Event not found' : events.length ? 'Select an event' : 'Create your first event'}>
                <p>{events.length ? 'Choose an event from the list to manage passes, gates and check-ins.' : 'An event holds its passes, gates, admission policies and door devices.'}</p>
                <button className="btn btn-primary" onClick={() => setCreating(true)}>
                  <CalendarPlus size={16} aria-hidden /> New event
                </button>
              </EmptyState>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
