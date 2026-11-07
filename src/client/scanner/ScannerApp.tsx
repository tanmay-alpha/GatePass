import { Camera, CameraOff, Keyboard, LogOut } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { ScanResult, ScannerSession } from '../../shared/types';
import { api, ApiError, formatDateTime } from '../api';
import { createQrDetector } from '../qr-detector';
import { ErrorNote, OUTCOME_LABEL, errorMessage, tone } from '../ui';

const KEY_STORAGE = 'gatepass.scannerKey';
/** Ignore the same code for this long so a QR held in frame is not re-submitted every frame. */
const REPEAT_COOLDOWN_MS = 4000;
const RESULT_HOLD_MS = 2500;
const DETECT_INTERVAL_MS = 150;

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

  const signOut = useCallback(() => {
    localStorage.removeItem(KEY_STORAGE);
    setKey('');
    setSession(null);
  }, []);

  useEffect(() => {
    if (!key) return;
    api<ScannerSession>('/api/scanner/session', key)
      .then((value) => {
        setSession(value);
        setError('');
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          signOut();
          setError('This scanner key is not valid or has been revoked.');
        } else setError(errorMessage(err));
      });
  }, [key, signOut]);

  if (!key) return <ScannerLogin error={error} onKey={(value) => (localStorage.setItem(KEY_STORAGE, value), setKey(value))} />;
  if (!session) {
    return (
      <main className="scanner scanner-center">
        <ErrorNote message={error} />
        {!error ? <p className="muted">Connecting…</p> : null}
      </main>
    );
  }
  return <ScannerStation scannerKey={key} session={session} onSignOut={signOut} onUnauthorized={() => (signOut(), setError('Scanner key was revoked.'))} />;
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
          <input value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" spellCheck={false} placeholder="gps_…" />
        </label>
        <ErrorNote message={error} />
        <button className="btn btn-primary" disabled={!value.trim()}>
          Start scanning
        </button>
      </form>
    </main>
  );
}

type Display = { kind: 'result'; result: ScanResult } | { kind: 'error'; message: string } | null;

function ScannerStation({ scannerKey, session, onSignOut, onUnauthorized }: { scannerKey: string; session: ScannerSession; onSignOut: () => void; onUnauthorized: () => void }) {
  const [cameraOn, setCameraOn] = useState(true);
  const [cameraError, setCameraError] = useState('');
  const [display, setDisplay] = useState<Display>(null);
  const [history, setHistory] = useState<ScanResult[]>([]);
  const [manual, setManual] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const busy = useRef(false);
  const lastCode = useRef({ value: '', at: 0 });
  const clearTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const submit = useCallback(
    async (code: string) => {
      if (busy.current) return;
      busy.current = true;
      clearTimeout(clearTimer.current);
      try {
        const result = await api<ScanResult>('/api/scanner/redeem', scannerKey, { body: { code } });
        setDisplay({ kind: 'result', result });
        setHistory((current) => [result, ...current].slice(0, 15));
        navigator.vibrate?.(result.outcome === 'admitted' ? 120 : [80, 60, 80, 60, 80]);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return onUnauthorized();
        // Never imply admission on failure: the server is the only authority.
        setDisplay({ kind: 'error', message: `Not verified — ${errorMessage(err)}. Try again.` });
      } finally {
        busy.current = false;
        clearTimer.current = setTimeout(() => setDisplay(null), RESULT_HOLD_MS);
      }
    },
    [scannerKey, onUnauthorized]
  );

  useEffect(() => {
    if (!cameraOn) return;
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError('Camera access needs HTTPS (or localhost). Use manual entry below.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stopped) return stream.getTracks().forEach((track) => track.stop());
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play();
        setCameraError('');
        const detector = await createQrDetector();
        const tick = async () => {
          if (stopped) return;
          if (!busy.current && video.readyState >= 2) {
            try {
              const [code] = await detector.detect(video);
              const now = Date.now();
              if (code && !(code.rawValue === lastCode.current.value && now - lastCode.current.at < REPEAT_COOLDOWN_MS)) {
                lastCode.current = { value: code.rawValue, at: now };
                await submit(code.rawValue);
              }
            } catch {
              // A single bad frame is not an error worth surfacing.
            }
          }
          timer = setTimeout(tick, DETECT_INTERVAL_MS);
        };
        void tick();
      } catch (err) {
        setCameraError(err instanceof DOMException && err.name === 'NotAllowedError' ? 'Camera permission was denied. Use manual entry below.' : `Camera unavailable: ${errorMessage(err)}`);
      }
    }
    void start();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [cameraOn, submit]);

  function submitManual(e: FormEvent) {
    e.preventDefault();
    if (!manual.trim()) return;
    void submit(manual.trim());
    setManual('');
  }

  return (
    <main className="scanner">
      <header className="scanner-bar">
        <div>
          <div className="scanner-event">{session.event.name}</div>
          <div className="muted small">{session.scanner.label}</div>
        </div>
        <div className="actions">
          <button className="btn btn-ghost btn-small" onClick={() => setCameraOn((on) => !on)} aria-label={cameraOn ? 'Turn camera off' : 'Turn camera on'}>
            {cameraOn ? <CameraOff size={18} aria-hidden /> : <Camera size={18} aria-hidden />}
          </button>
          <button className="btn btn-ghost btn-small" onClick={onSignOut} aria-label="Sign out">
            <LogOut size={18} aria-hidden />
          </button>
        </div>
      </header>
      {session.event.status !== 'active' ? <p className="error">This event is archived. Every pass will be rejected.</p> : null}

      <div className="viewfinder">
        {cameraOn ? <video ref={videoRef} playsInline muted /> : <div className="viewfinder-off">Camera off</div>}
        {cameraOn && !cameraError ? <div className="reticle" aria-hidden /> : null}
        {display ? <ResultOverlay display={display} /> : null}
      </div>
      <ErrorNote message={cameraError} />

      <form className="inline-form" onSubmit={submitManual}>
        <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Pass link or code" aria-label="Pass link or code" autoComplete="off" spellCheck={false} />
        <button className="btn btn-primary">
          <Keyboard size={16} aria-hidden /> Check
        </button>
      </form>

      <section>
        <h2 className="small-heading">Recent</h2>
        <ul className="history">
          {history.map((item) => (
            <li key={item.scanId} className={`history-item tone-${tone(item.outcome)}`}>
              <span className="history-outcome">{OUTCOME_LABEL[item.outcome]}</span>
              <span>{item.pass?.attendeeName ?? ''}</span>
              <span className="muted small">{new Date(item.checkedAt).toLocaleTimeString()}</span>
            </li>
          ))}
          {history.length === 0 ? <li className="muted">No scans yet.</li> : null}
        </ul>
      </section>
    </main>
  );
}

const OUTCOME_HELP: Record<ScanResult['outcome'], string> = {
  admitted: 'Let them in.',
  already_redeemed: 'This pass was already used.',
  expired: 'This pass has expired.',
  revoked: 'This pass was revoked by the organiser.',
  invalid: 'Not a valid pass for this event.',
  event_closed: 'Check-in for this event is closed.'
};

function ResultOverlay({ display }: { display: NonNullable<Display> }) {
  if (display.kind === 'error') {
    return (
      <div className="result tone-bad" role="alert">
        <div className="result-title">Not verified</div>
        <div className="result-detail">{display.message}</div>
      </div>
    );
  }
  const { result } = display;
  return (
    <div className={`result tone-${tone(result.outcome)}`} role="alert" aria-live="assertive">
      <div className="result-title">{OUTCOME_LABEL[result.outcome]}</div>
      {result.pass?.attendeeName ? <div className="result-name">{result.pass.attendeeName}</div> : null}
      <div className="result-detail">{OUTCOME_HELP[result.outcome]}</div>
      {result.outcome === 'already_redeemed' && result.pass?.redeemedAt ? <div className="result-detail">First used {formatDateTime(result.pass.redeemedAt)}</div> : null}
    </div>
  );
}
