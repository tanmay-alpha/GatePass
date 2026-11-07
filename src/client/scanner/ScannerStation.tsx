import { Camera, CameraOff, LogOut, MapPin, Smartphone, Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { ScanResult, ScannerSession } from '../../shared/types';
import { api, ApiError } from '../api';
import { useConfirm } from '../dialog';
import { createQrDetector } from '../qr-detector';
import { ErrorNote, errorMessage } from '../ui';
import { beep, loadMuted, saveMuted, unlockAudio } from './beep';
import { VERDICT_HEADLINE, explain, explainFailure, reasonLabel, verdictOf, type Verdict } from './outcome';
import { ResultOverlay, type ScanDisplay } from './ResultOverlay';

/** Ignore the same code for this long so a QR held in frame is not re-submitted every frame. */
const REPEAT_COOLDOWN_MS = 4000;
const RESULT_HOLD_MS = 2500;
const DETECT_INTERVAL_MS = 150;
const HISTORY_SIZE = 15;

/** Short verdict words for the recent list. */
const HISTORY_WORD: Record<Verdict, string> = { admit: 'Admit', warn: 'Used', deny: 'Denied', error: 'Not verified' };

interface Props {
  scannerKey: string;
  session: ScannerSession;
  onSignOut: () => void;
  onUnauthorized: () => void;
}

export function ScannerStation({ scannerKey, session, onSignOut, onUnauthorized }: Props) {
  const [cameraOn, setCameraOn] = useState(true);
  const [cameraError, setCameraError] = useState('');
  const [display, setDisplay] = useState<ScanDisplay | null>(null);
  const [history, setHistory] = useState<ScanDisplay[]>([]);
  const [manual, setManual] = useState('');
  const [checking, setChecking] = useState(false);
  const [muted, setMuted] = useState(loadMuted);
  const [confirm, dialog] = useConfirm();
  const online = useOnline();
  const videoRef = useRef<HTMLVideoElement>(null);
  const busy = useRef(false);
  const lastCode = useRef({ value: '', at: 0 });
  /** After a 429, hold camera submissions until the server's Retry-After passes. */
  const blockedUntil = useRef(0);
  const clearTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    window.addEventListener('pointerdown', unlockAudio);
    window.addEventListener('keydown', unlockAudio);
    return () => {
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };
  }, []);

  const show = useCallback((item: ScanDisplay) => {
    clearTimeout(clearTimer.current);
    setDisplay(item);
    setHistory((current) => [item, ...current].slice(0, HISTORY_SIZE));
    const ok = item.verdict === 'admit';
    if (!loadMuted()) beep(ok ? 'ok' : 'fail');
    navigator.vibrate?.(ok ? 120 : [80, 60, 80, 60, 80]);
    clearTimer.current = setTimeout(() => setDisplay(null), RESULT_HOLD_MS);
  }, []);

  const submit = useCallback(
    async (code: string) => {
      if (busy.current) return;
      busy.current = true;
      setChecking(true);
      try {
        const result = await api<ScanResult>('/api/scanner/redeem', scannerKey, { body: { code } });
        show({
          id: `scan-${result.scanId}`,
          at: result.checkedAt,
          verdict: verdictOf(result.outcome),
          reason: reasonLabel(result),
          name: result.pass?.attendeeName ?? null,
          explanation: explain(result)
        });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return onUnauthorized();
        if (err instanceof ApiError && err.status === 429) blockedUntil.current = Date.now() + (err.retryAfter ?? 5) * 1000;
        // Never imply admission on failure: the server is the only authority.
        show({ id: `error-${Date.now()}`, at: new Date().toISOString(), verdict: 'error', reason: null, name: null, explanation: explainFailure(err) });
      } finally {
        busy.current = false;
        setChecking(false);
      }
    },
    [scannerKey, onUnauthorized, show]
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
          if (!busy.current && video.readyState >= 2 && Date.now() >= blockedUntil.current) {
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

  useEffect(() => () => clearTimeout(clearTimer.current), []);

  function submitManual(e: FormEvent) {
    e.preventDefault();
    if (!manual.trim()) return;
    void submit(manual.trim());
    setManual('');
  }

  function toggleMute() {
    setMuted((current) => {
      saveMuted(!current);
      return !current;
    });
  }

  async function signOut() {
    const ok = await confirm({
      title: 'Sign out this device?',
      body: 'This phone forgets its scanner key. To scan again you need the setup link or key from the organiser.',
      confirmLabel: 'Sign out',
      danger: true
    });
    if (ok) onSignOut();
  }

  const latest = history[0];

  return (
    <main className="scanner">
      <header className="scanner-bar">
        <div className="scanner-bar-top">
          <h1 className="scanner-event">{session.event.name}</h1>
          <div className="scanner-tools">
            <button className="icon-btn" onClick={toggleMute} aria-pressed={!muted} aria-label="Sound">
              {muted ? <VolumeX size={18} aria-hidden /> : <Volume2 size={18} aria-hidden />}
            </button>
            <button className="icon-btn" onClick={() => setCameraOn((on) => !on)} aria-pressed={cameraOn} aria-label="Camera">
              {cameraOn ? <Camera size={18} aria-hidden /> : <CameraOff size={18} aria-hidden />}
            </button>
            <button className="icon-btn" onClick={() => void signOut()} aria-label="Sign out">
              <LogOut size={18} aria-hidden />
            </button>
          </div>
        </div>
        <div className="scanner-meta">
          <span className="scanner-device">
            <Smartphone size={14} aria-hidden />
            <span>{session.scanner.label}</span>
          </span>
          <span className="scanner-gate">
            <MapPin size={14} aria-hidden />
            {session.gate ? `Gate: ${session.gate.name}` : 'Any gate'}
          </span>
          <span className={`scanner-net ${online ? 'is-online' : 'is-offline'}`} role="status">
            <span className="scanner-net-dot" aria-hidden />
            {online ? 'Online' : 'Offline'}
          </span>
        </div>
      </header>

      <div className="scanner-body">
        {session.event.status !== 'active' ? <p className="error">This event is archived. Every pass will be rejected.</p> : null}

        <div className="viewfinder">
          {cameraOn ? <video ref={videoRef} playsInline muted aria-label="Camera view" /> : <div className="viewfinder-off">Camera off. Use manual entry below.</div>}
          {cameraOn && !cameraError ? (
            <>
              <div className="reticle" aria-hidden>
                <span className="reticle-corner reticle-tl" />
                <span className="reticle-corner reticle-tr" />
                <span className="reticle-corner reticle-bl" />
                <span className="reticle-corner reticle-br" />
              </div>
              <p className="viewfinder-caption">Point at a pass QR code</p>
            </>
          ) : null}
        </div>
        <p className="sr-only" aria-live="assertive" aria-atomic>
          {latest ? [VERDICT_HEADLINE[latest.verdict], latest.reason, latest.name, latest.explanation].filter(Boolean).join('. ') : ''}
        </p>
        <ErrorNote message={cameraError} />

        <form className="manual-form" onSubmit={submitManual}>
          <label className="grow">
            <span className="sr-only">Pass link or code</span>
            <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Pass link or code" autoComplete="off" autoCapitalize="off" spellCheck={false} enterKeyHint="go" />
          </label>
          <button className="btn btn-primary" disabled={checking || !manual.trim()}>
            {checking ? 'Checking…' : 'Check'}
          </button>
        </form>

        <section className="recent" aria-labelledby="recent-title">
          <h2 id="recent-title" className="recent-title">
            Recent
          </h2>
          <ul className="history">
            {history.map((item) => (
              <li key={item.id} className={`history-item history-${item.verdict}`}>
                <span className="history-dot" aria-hidden />
                <div className="history-main">
                  <div className="history-name">{item.name ?? 'Unknown code'}</div>
                  <div className="history-detail">{[item.reason, item.explanation].filter(Boolean).join(' · ')}</div>
                </div>
                <span className="history-verdict">{HISTORY_WORD[item.verdict]}</span>
                <time className="history-time" dateTime={item.at}>
                  {new Date(item.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                </time>
              </li>
            ))}
            {history.length === 0 ? <li className="history-empty">No scans yet.</li> : null}
          </ul>
        </section>
      </div>

      {display ? <ResultOverlay display={display} onDismiss={() => setDisplay(null)} /> : null}
      {dialog}
    </main>
  );
}

/** True while the browser reports a network connection; the server is still the only authority. */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}
