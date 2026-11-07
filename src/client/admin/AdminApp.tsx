import { CalendarPlus, LogOut, ScanLine } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { EventSummary } from '../../shared/types';
import { api, ApiError, formatDateTime } from '../api';
import { ErrorNote, errorMessage } from '../ui';
import { EventDetail } from './EventDetail';
import { EventForm } from './EventForm';

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
  return <Dashboard token={token} onSignOut={signOut} />;
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
        <h1>GatePass admin</h1>
        <p className="muted">Sign in with the server's <code>ADMIN_TOKEN</code>. It is kept for this browser tab only.</p>
        <label>
          Admin token
          <input type="password" autoComplete="current-password" value={value} onChange={(e) => setValue(e.target.value)} required />
        </label>
        <ErrorNote message={error} />
        <button className="btn btn-primary" disabled={busy || !value.trim()}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>
        <p className="muted small">
          Door staff: open <a href="/scan">the scanner</a> instead.
        </p>
      </form>
    </main>
  );
}

function selectedFromHash(): string | null {
  const match = /^#\/events\/([\w-]+)$/.exec(window.location.hash);
  return match ? match[1] : null;
}

function Dashboard({ token, onSignOut }: { token: string; onSignOut: () => void }) {
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(selectedFromHash);
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
    const onHash = () => setSelectedId(selectedFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  function select(id: string) {
    setCreating(false);
    window.location.hash = `/events/${id}`;
  }

  const selected = events.find((event) => event.id === selectedId) ?? null;

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">GatePass</span>
        <nav className="topbar-actions">
          <a className="btn btn-ghost" href="/scan">
            <ScanLine size={16} aria-hidden /> Scanner
          </a>
          <button className="btn btn-ghost" onClick={onSignOut}>
            <LogOut size={16} aria-hidden /> Sign out
          </button>
        </nav>
      </header>
      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar-head">
            <h2>Events</h2>
            <button className="btn btn-primary btn-small" onClick={() => setCreating(true)}>
              <CalendarPlus size={16} aria-hidden /> New
            </button>
          </div>
          <ErrorNote message={error} />
          {events.length === 0 && !error ? <p className="muted">No events yet. Create one to start issuing passes.</p> : null}
          <ul className="event-list">
            {events.map((event) => (
              <li key={event.id}>
                <button className={`event-item${event.id === selectedId && !creating ? ' selected' : ''}`} onClick={() => select(event.id)}>
                  <span className="event-item-name">
                    {event.name}
                    {event.status === 'archived' ? <span className="badge badge-muted">Archived</span> : null}
                  </span>
                  <span className="muted small">{formatDateTime(event.startsAt)}</span>
                  <span className="event-item-counts small">
                    {event.passCount} passes · {event.attendeeCount} attendees · {event.redeemedCount} checked in
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <main className="content">
          {creating ? (
            <section className="card">
              <h2>New event</h2>
              <EventForm
                token={token}
                onCancel={() => setCreating(false)}
                onSaved={async (event) => {
                  await loadEvents();
                  select(event.id);
                }}
              />
            </section>
          ) : selected ? (
            <EventDetail key={selected.id} token={token} event={selected} onChanged={loadEvents} />
          ) : (
            <section className="card empty">
              <p className="muted">Select an event, or create a new one.</p>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
