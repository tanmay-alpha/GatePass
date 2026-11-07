import { useCallback, useEffect, useState } from 'react';
import type { ScannerSession } from '../../shared/types';
import { api, ApiError } from '../api';
import { ErrorNote, errorMessage } from '../ui';
import { ScannerStation } from './ScannerStation';

const KEY_STORAGE = 'gatepass.scannerKey';

/** Reads a key from `#key=...` (setup link) once, then removes it from the address bar and history. */
function takeKeyFromFragment(): string | null {
  const match = /^#key=([\w-]+)$/.exec(window.location.hash);
  if (!match) return null;
  window.history.replaceState(null, '', window.location.pathname);
  return match[1];
}

export function ScannerApp() {
  const [key, setKey] = useState(() => {
    const fromLink = takeKeyFromFragment();
    if (fromLink) localStorage.setItem(KEY_STORAGE, fromLink);
    return fromLink ?? localStorage.getItem(KEY_STORAGE) ?? '';
  });
  const [session, setSession] = useState<ScannerSession | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  const signOut = useCallback(() => {
    localStorage.removeItem(KEY_STORAGE);
    setKey('');
    setSession(null);
  }, []);

  useEffect(() => {
    if (!key) return;
    setError('');
    api<ScannerSession>('/api/scanner/session', key)
      .then(setSession)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          signOut();
          setError('This scanner key is not valid or has been revoked. Ask the organiser for a new setup link.');
        } else setError(`Could not reach the server: ${errorMessage(err)}`);
      });
  }, [key, signOut, attempt]);

  const onUnauthorized = useCallback(() => {
    signOut();
    setError('This device was revoked by the organiser. Ask for a new setup link.');
  }, [signOut]);

  if (!key) {
    return (
      <ScannerLogin
        error={error}
        onKey={(value) => {
          localStorage.setItem(KEY_STORAGE, value);
          setKey(value);
        }}
      />
    );
  }
  if (!session) {
    return (
      <main className="scanner scanner-center">
        {error ? (
          <div className="card login-card">
            <ErrorNote message={error} />
            <button className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        ) : (
          <p className="muted" role="status">
            Connecting…
          </p>
        )}
      </main>
    );
  }
  return <ScannerStation scannerKey={key} session={session} onSignOut={signOut} onUnauthorized={onUnauthorized} />;
}

function ScannerLogin({ error, onKey }: { error: string; onKey: (key: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <main className="scanner scanner-center">
      <form
        className="card login-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onKey(value.trim());
        }}
      >
        <h1>GatePass scanner</h1>
        <p className="muted">Open the setup link from the organiser, or paste the scanner key.</p>
        <label>
          Scanner key
          <input value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="gps_…" />
        </label>
        <ErrorNote message={error} />
        <button className="btn btn-primary" disabled={!value.trim()}>
          Start scanning
        </button>
      </form>
    </main>
  );
}
