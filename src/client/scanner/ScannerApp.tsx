import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScannerEnrollResult, ScannerSession } from '../../shared/types';
import { api, ApiError, WAKING_MESSAGE } from '../api';
import { ErrorNote, errorMessage } from '../ui';
import { ScannerStation } from './ScannerStation';
import './scanner.css';

const KEY_STORAGE = 'gatepass.scannerKey';
/** Long enough for the free demo backend to wake from sleep; then offer a retry. */
const SESSION_TIMEOUT_MS = 60_000;
const SETUP_CODE = /^[A-Za-z0-9_-]{43}$/;

/** What the setup link or the pasted text holds: a one-time setup code, or (older links) a device key. */
type Credential = { kind: 'code'; value: string } | { kind: 'key'; value: string };

/** Reads `#enroll=<code>` (or a legacy `#key=<key>`) once, then removes it from the address bar and history. */
function takeCredentialFromFragment(): Credential | null {
  const match = /^#(enroll|key)=([\w-]+)$/.exec(window.location.hash);
  if (!match) return null;
  window.history.replaceState(null, '', window.location.pathname);
  return match[1] === 'enroll' ? { kind: 'code', value: match[2] } : { kind: 'key', value: match[2] };
}

/** Accepts a pasted setup link, a bare setup code, or a device key. */
function parseCredential(text: string): Credential | null {
  const value = text.trim();
  const fromLink = /#(enroll|key)=([\w-]+)/.exec(value);
  if (fromLink) return fromLink[1] === 'enroll' ? { kind: 'code', value: fromLink[2] } : { kind: 'key', value: fromLink[2] };
  if (value.startsWith('gps_')) return { kind: 'key', value };
  if (SETUP_CODE.test(value)) return { kind: 'code', value };
  return null;
}

export function ScannerApp() {
  const [initial] = useState(takeCredentialFromFragment);
  const [stored] = useState(() => localStorage.getItem(KEY_STORAGE) ?? '');
  // A link opened on a phone that is already a scanner must not silently re-point it at another
  // event or gate: staff confirm the replacement first.
  const [replacement, setReplacement] = useState<Credential | null>(stored && initial && initial.value !== stored ? initial : null);
  const [code, setCode] = useState(!stored && initial?.kind === 'code' ? initial.value : '');
  const [key, setKey] = useState(() => {
    if (stored || initial?.kind !== 'key') return stored;
    localStorage.setItem(KEY_STORAGE, initial.value);
    return initial.value;
  });
  const [session, setSession] = useState<ScannerSession | null>(null);
  const [error, setError] = useState('');
  /** A new setup link failed on a phone that already has a working key: the key was kept. */
  const [kept, setKept] = useState('');
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const signOut = useCallback(() => {
    localStorage.removeItem(KEY_STORAGE);
    setKey('');
    setSession(null);
  }, []);

  /**
   * Starts using a setup code or key. A setup code replaces the key this phone already holds only
   * once the server has accepted it: a used or expired link must not leave a working scanner without a key.
   */
  const adopt = useCallback((credential: Credential) => {
    setReplacement(null);
    setError('');
    if (credential.kind === 'code') return setCode(credential.value);
    localStorage.setItem(KEY_STORAGE, credential.value);
    setSession(null);
    setKey(credential.value);
  }, []);

  // Claim a one-time setup code. The code works once: if the answer is lost,
  // a retry gets "already used" and the organiser issues a new link. The
  // request is kept in a ref so a re-run effect (React StrictMode, re-render)
  // reuses it instead of spending the code twice.
  const enrollRequest = useRef<{ id: string; promise: Promise<ScannerEnrollResult> } | null>(null);
  useEffect(() => {
    if (!code) return;
    let live = true;
    setError('');
    setSlow(false);
    const id = `${code}:${attempt}`;
    if (enrollRequest.current?.id !== id) {
      enrollRequest.current = { id, promise: api<ScannerEnrollResult>('/api/scanner/enroll', { body: { code }, timeoutMs: SESSION_TIMEOUT_MS, onSlow: () => setSlow(true) }) };
    }
    enrollRequest.current.promise
      .then((result) => {
        if (!live) return;
        localStorage.setItem(KEY_STORAGE, result.key);
        setCode('');
        setKey(result.key);
        setSession(result.session);
      })
      .catch((err) => {
        if (!live) return;
        if (err instanceof ApiError && (err.status === 410 || err.status === 400)) {
          setCode('');
          if (localStorage.getItem(KEY_STORAGE)) setKept('That setup link is invalid, expired or already used, so this phone keeps its current setup. Ask the organiser for a new link if you meant to change it.');
          else setError('This setup link is invalid, expired or already used. Ask the organiser for a new setup link.');
        } else if (err instanceof ApiError && err.status === 0) setError(`${err.message} If this keeps failing, ask the organiser for a new setup link.`);
        else setError(`Could not set up this device: ${errorMessage(err)}`);
      })
      .finally(() => {
        if (live) setSlow(false);
      });
    return () => {
      live = false;
    };
  }, [code, attempt]);

  useEffect(() => {
    if (!key || code || session) return;
    let live = true;
    setError('');
    setSlow(false);
    api<ScannerSession>('/api/scanner/session', { bearer: key, timeoutMs: SESSION_TIMEOUT_MS, onSlow: () => live && setSlow(true) })
      .then((value) => {
        if (live) setSession(value);
      })
      .catch((err) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 401) {
          signOut();
          setError('This scanner key is not valid or has been revoked. Ask the organiser for a new setup link.');
        } else if (err instanceof ApiError && err.status === 0) setError(err.message);
        else setError(`Could not reach the server: ${errorMessage(err)}`);
      })
      .finally(() => {
        if (live) setSlow(false);
      });
    return () => {
      live = false;
    };
    // `session` is only read to skip the fetch right after enrollment, so it is not a dependency.
  }, [key, code, signOut, attempt]);

  const onUnauthorized = useCallback(() => {
    signOut();
    setError('This device was revoked by the organiser. Ask for a new setup link.');
  }, [signOut]);

  if (replacement) {
    return (
      <main className="scanner scanner-center">
        <div className="card login-card" role="alertdialog" aria-labelledby="replace-title" aria-describedby="replace-text">
          <h1 id="replace-title">Replace this scanner's setup?</h1>
          <p id="replace-text" className="muted">
            This phone is already set up as a scanner{session ? ` for ${session.event.name} (${session.scanner.label})` : ''}. The link you opened would set it up again, possibly for a different event or gate.
            Only continue if an organiser of your event gave you this link.
          </p>
          <button className="btn btn-primary" onClick={() => adopt(replacement)}>
            Use the new setup
          </button>
          <button className="btn btn-secondary" onClick={() => setReplacement(null)}>
            Keep the current setup
          </button>
        </div>
      </main>
    );
  }
  if (kept) {
    return (
      <main className="scanner scanner-center">
        <div className="card login-card">
          <ErrorNote message={kept} />
          <button className="btn btn-primary" onClick={() => setKept('')}>
            Continue with the current setup
          </button>
        </div>
      </main>
    );
  }
  if (!key && !code) return <ScannerLogin error={error} onCredential={adopt} />;
  if (code || !session) {
    return (
      <main className="scanner scanner-center">
        {error ? (
          <div className="card login-card">
            <ErrorNote message={error} />
            <button className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
            {code && key ? (
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setCode('');
                  setError('');
                }}
              >
                Keep the current setup
              </button>
            ) : null}
          </div>
        ) : (
          <p className="muted" role="status">
            {slow ? WAKING_MESSAGE : code ? 'Setting up this device…' : 'Connecting…'}
          </p>
        )}
      </main>
    );
  }
  return <ScannerStation scannerKey={key} session={session} onSignOut={signOut} onUnauthorized={onUnauthorized} />;
}

function ScannerLogin({ error, onCredential }: { error: string; onCredential: (credential: Credential) => void }) {
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState('');
  return (
    <main className="scanner scanner-center">
      <form
        className="card login-card"
        onSubmit={(e) => {
          e.preventDefault();
          const credential = parseCredential(value);
          if (!credential) {
            setProblem('That is not a GatePass setup link, setup code or scanner key.');
            return;
          }
          setProblem('');
          onCredential(credential);
        }}
      >
        <h1>GatePass scanner</h1>
        <p className="muted">Open the setup link from the organiser on this phone. If you cannot open it, paste it here.</p>
        <label>
          Setup link or code
          <input value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="https://…/scan#enroll=…" />
        </label>
        <ErrorNote message={problem || error} />
        <button className="btn btn-primary" disabled={!value.trim()}>
          Set up this device
        </button>
      </form>
    </main>
  );
}
