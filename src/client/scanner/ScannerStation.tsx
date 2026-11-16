import { Camera, CameraOff, Clock, Flashlight, FlashlightOff, ListChecks, LoaderCircle, LogOut, MapPin, RotateCcw, ScanLine, Smartphone, Volume2, VolumeX, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { isDiagnosticPayload, isValidDiagnosticCode } from '../../shared/diagnostic';
import type { EventStatus, ScannerSession, ScanResult } from '../../shared/types';
import { api, ApiError } from '../api';
import { useConfirm } from '../dialog';
import { createQrDetector, type DecoderPath, type QrDetector } from '../qr-detector';
import { ErrorNote } from '../ui';
import { AttendeeFinder } from './AttendeeFinder';
import { beep, loadMuted, saveMuted, unlockAudio } from './beep';
import { INSECURE_CAMERA_MESSAGE, cameraErrorMessage, listCameras, loadCameraChoice, openCamera, saveCameraChoice, setTorch, supportsTorch, type CameraChoice } from './camera';
import { REPLAYED_NOTE, VERDICT_HEADLINE, explain, explainFailure, formatEventClock, formatEventTime, isScanResult, reasonLabel, verdictOf, type Verdict } from './outcome';
import { useOfflineShell } from './pwa';
import { readinessItems, type CameraPermission, type DiagnosticState, type Probe } from './readiness';
import { ReadinessPanel } from './ReadinessPanel';
import { RepeatFilter } from './repeat';
import { ResultOverlay, type ScanDisplay } from './ResultOverlay';
import { PendingScans, isUnanswered, mayHaveBeenJudged } from './retry';

/** How long a verdict stays up before scanning resumes; "Not verified" stays until staff act on it. */
const RESULT_HOLD_MS: Record<Verdict, number | null> = { admit: 2500, warn: 4000, deny: 4000, error: null };
const DETECT_INTERVAL_MS = 150;
const HISTORY_SIZE = 15;
/** A door cannot wait on a hung request: give up and show "Not verified". */
const REDEEM_TIMEOUT_MS = 12_000;
/** After this long a pending check is shown as a slow connection. */
const SLOW_CHECK_MS = 1500;
/** Heartbeat: keeps the organiser's device health current and refreshes the event status. */
const HEARTBEAT_MS = 60_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const CLOCK_TICK_MS = 15_000;
const OFFLINE_MESSAGE = 'Scanning paused — offline. Do not admit anyone until the connection returns.';
const SLOW_MESSAGE = 'Checking… slow connection';
/** The 8-character reference printed on the pass (a pass id prefix); the server matches it case-insensitively. */
const REFERENCE = /^[0-9a-f]{8}$/i;
/** A camera test code is read on this device only; it is never sent to the server. */
const DIAGNOSTIC_NOTICE = 'Camera test code read: the camera works. It is not a pass, so nothing was sent to the server.';
const NOT_THE_TEST_CODE = 'That is not the camera test code. Passes are checked once you start scanning.';
const NOTICE_HOLD_MS = 5000;

/** Short verdict words for the recent list. */
const HISTORY_WORD: Record<Verdict, string> = { admit: 'Admit', warn: 'Used', deny: 'Denied', error: 'Not verified' };

const EVENT_STATUS_WARNING: Record<Exclude<EventStatus, 'active'>, string> = {
  draft: 'This event is still a draft. Every pass will be refused until the organiser opens check-in.',
  ended: 'This event has ended. Every pass will be refused.',
  archived: 'This event is archived. Every pass will be refused.'
};

type Connection = 'online' | 'slow' | 'offline';
const CONNECTION_LABEL: Record<Connection, string> = { online: 'Online', slow: 'Slow connection', offline: 'Offline' };

interface Props {
  scannerKey: string;
  session: ScannerSession;
  onSignOut: () => void;
  onUnauthorized: () => void;
}

export function ScannerStation({ scannerKey, session: initialSession, onSignOut, onUnauthorized }: Props) {
  const [session, setSession] = useState(initialSession);
  /** The camera starts on a tap, which also unlocks audio for the verdict tones. */
  const [started, setStarted] = useState(false);
  const [cameraOn, setCameraOn] = useState(true);
  const [cameraAttempt, setCameraAttempt] = useState(0);
  const [cameraError, setCameraError] = useState('');
  const [cameraRetryable, setCameraRetryable] = useState(false);
  const [cameras, setCameras] = useState<CameraChoice[]>([]);
  const [cameraId, setCameraId] = useState<string | null>(null);
  const [torch, setTorchState] = useState({ supported: false, on: false });
  const [decoderPath, setDecoderPath] = useState<DecoderPath | null>(null);
  const [display, setDisplay] = useState<ScanDisplay | null>(null);
  const [history, setHistory] = useState<ScanDisplay[]>([]);
  const [manual, setManual] = useState('');
  const [checking, setChecking] = useState(false);
  const [slow, setSlow] = useState(false);
  const [quality, setQuality] = useState<'good' | 'slow'>('good');
  const [muted, setMuted] = useState(loadMuted);
  const [now, setNow] = useState(() => new Date());
  const [confirm, dialog] = useConfirm();
  const online = useOnline();
  const offlineShell = useOfflineShell();
  /** The readiness checklist opens with the station and again from the header. While it is open the camera only looks for the test code. */
  const [readinessOpen, setReadinessOpen] = useState(true);
  const [diagnostic, setDiagnostic] = useState<DiagnosticState>('idle');
  const [diagnosticHint, setDiagnosticHint] = useState('');
  const [probe, setProbe] = useState<Probe>({ state: 'checking' });
  const [probeAttempt, setProbeAttempt] = useState(0);
  const [cameraPermission, setCameraPermission] = useState<CameraPermission>('unknown');
  /** Frames are arriving in the viewfinder. */
  const [streaming, setStreaming] = useState(false);
  /** A short local message (a camera test code was read during scanning); never a verdict. */
  const [notice, setNotice] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const detectorRef = useRef<QrDetector | null>(null);
  const busy = useRef(false);
  const displayRef = useRef<ScanDisplay | null>(null);
  const onlineRef = useRef(online);
  const repeat = useRef(new RepeatFilter());
  const pending = useRef(new PendingScans());
  /** After a 429, hold camera submissions until the server's Retry-After passes. */
  const blockedUntil = useRef(0);
  const clearTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const readinessRef = useRef(readinessOpen);
  const diagnosticPassed = useRef(false);
  const timeZone = session.event.timeZone;
  const connection: Connection = !online ? 'offline' : quality === 'slow' ? 'slow' : 'online';

  onlineRef.current = online;
  displayRef.current = display;
  readinessRef.current = readinessOpen;

  useEffect(() => {
    window.addEventListener('pointerdown', unlockAudio);
    window.addEventListener('keydown', unlockAudio);
    return () => {
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const dismiss = useCallback(() => {
    clearTimeout(clearTimer.current);
    setDisplay(null);
  }, []);

  const show = useCallback((item: ScanDisplay) => {
    clearTimeout(clearTimer.current);
    setDisplay(item);
    setHistory((current) => [item, ...current].slice(0, HISTORY_SIZE));
    const ok = item.verdict === 'admit';
    if (!loadMuted()) beep(ok ? 'ok' : 'fail');
    navigator.vibrate?.(ok ? 120 : [80, 60, 80, 60, 80]);
    const hold = RESULT_HOLD_MS[item.verdict];
    if (hold !== null) clearTimer.current = setTimeout(() => setDisplay(null), hold);
  }, []);

  const showNotice = useCallback((message: string) => {
    clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = setTimeout(() => setNotice(''), NOTICE_HOLD_MS);
  }, []);

  /**
   * A code the camera read that never leaves this device: the camera test code at
   * any time, and anything at all while the checklist is open (no pass is checked then).
   */
  const readLocally = useCallback(
    (code: string) => {
      const testCode = isValidDiagnosticCode(code);
      if (!readinessRef.current) {
        if (isDiagnosticPayload(code)) showNotice(DIAGNOSTIC_NOTICE);
        return;
      }
      if (!testCode) {
        setDiagnosticHint(isDiagnosticPayload(code) ? 'Unrecognised camera test code. Show the one on the event’s Scanners page.' : NOT_THE_TEST_CODE);
        return;
      }
      setDiagnosticHint('');
      setDiagnostic('passed');
      if (diagnosticPassed.current) return;
      diagnosticPassed.current = true;
      if (!loadMuted()) beep('ok');
      navigator.vibrate?.(120);
    },
    [showNotice]
  );

  const submit = useCallback(
    async (code: string) => {
      // Camera test codes are never sent for verification, whatever path they come from.
      if (isDiagnosticPayload(code)) return showNotice(DIAGNOSTIC_NOTICE);
      // One request at a time: a scan is never sent twice while its result is pending.
      if (busy.current) return;
      busy.current = true;
      setChecking(true);
      setSlow(false);
      // Same code after an attempt without a usable verdict: same requestId, so the server replays its original verdict.
      const requestId = pending.current.requestIdFor(code, Date.now());
      const sentAt = Date.now();
      try {
        const result = await api<ScanResult | null>('/api/scanner/redeem', {
          bearer: scannerKey,
          body: { code, requestId },
          timeoutMs: REDEEM_TIMEOUT_MS,
          slowAfterMs: SLOW_CHECK_MS,
          onSlow: () => setSlow(true)
        });
        setQuality(Date.now() - sentAt > SLOW_CHECK_MS ? 'slow' : 'good');
        if (!isScanResult(result)) throw new Error('Unexpected response');
        pending.current.forget(code);
        show({
          id: `scan-${result.scanId}-${sentAt}`,
          at: result.checkedAt,
          verdict: verdictOf(result.outcome),
          reason: reasonLabel(result),
          name: result.pass?.attendeeName ?? null,
          explanation: explain(result, timeZone),
          replayed: result.replayed === true,
          retryCode: null
        });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return onUnauthorized();
        if (err instanceof ApiError && err.status === 429) blockedUntil.current = Date.now() + (err.retryAfter ?? 5) * 1000;
        const unanswered = isUnanswered(err);
        if (mayHaveBeenJudged(err)) pending.current.remember(code, requestId, Date.now());
        if (unanswered) setQuality('slow');
        // Presenting the same pass again must be checked again, not ignored as a repeat.
        repeat.current.reset();
        // Never imply admission on failure: the server is the only authority.
        show({
          id: `error-${sentAt}`,
          at: new Date().toISOString(),
          verdict: 'error',
          reason: null,
          name: null,
          explanation: explainFailure(err),
          replayed: false,
          retryCode: unanswered ? code : null
        });
      } finally {
        busy.current = false;
        setChecking(false);
        setSlow(false);
      }
    },
    [scannerKey, onUnauthorized, show, showNotice, timeZone]
  );

  // Camera and detection loop. Frames are only decoded while nothing else needs the door's attention.
  useEffect(() => {
    if (!started || !cameraOn) return;
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    async function start() {
      setCameraError('');
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setCameraError(INSECURE_CAMERA_MESSAGE);
        setCameraRetryable(false);
        return;
      }
      try {
        const opened = await openCamera(navigator.mediaDevices, loadCameraChoice());
        stream = opened.stream;
        if (stopped) return stream.getTracks().forEach((track) => track.stop());
        if (!opened.usedPreferred) saveCameraChoice(null);
        const track = stream.getVideoTracks()[0] ?? null;
        trackRef.current = track;
        setCameraId(track?.getSettings().deviceId ?? null);
        setTorchState({ supported: track ? supportsTorch(track) : false, on: false });
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play();
        setStreaming(true);
        // Device labels are only readable once permission was granted.
        listCameras(navigator.mediaDevices).then((found) => !stopped && setCameras(found), () => undefined);
        detectorRef.current ??= await createQrDetector();
        const detector = detectorRef.current;
        setDecoderPath(detector.path);
        const tick = async () => {
          if (stopped) return;
          // The camera test works offline too: it never needs the server.
          const testing = readinessRef.current;
          const ready =
            !busy.current &&
            !displayRef.current &&
            (testing || onlineRef.current) &&
            !document.hidden &&
            video.readyState >= 2 &&
            (testing || Date.now() >= blockedUntil.current);
          if (ready) {
            try {
              const code = await detector.detect(video);
              // Test codes, and anything read while the checklist is open, stay on this device.
              if (code && !stopped && (readinessRef.current || isDiagnosticPayload(code))) readLocally(code);
              else if (code && !stopped && !displayRef.current && onlineRef.current && repeat.current.accept(code, Date.now())) await submit(code);
            } catch {
              // A single bad frame is not an error worth surfacing.
            }
            setDecoderPath(detector.path);
          }
          timer = setTimeout(tick, DETECT_INTERVAL_MS);
        };
        void tick();
      } catch (err) {
        if (stopped) return;
        setCameraError(cameraErrorMessage(err));
        setCameraRetryable(true);
      }
    }
    void start();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
      trackRef.current = null;
      setTorchState({ supported: false, on: false });
      setStreaming(false);
    };
  }, [started, cameraOn, cameraAttempt, submit, readLocally]);

  // Readiness: one timed round trip to the server each time the checklist opens or staff test the connection again.
  useEffect(() => {
    if (!readinessOpen) return;
    let live = true;
    setProbe({ state: 'checking' });
    const sentAt = performance.now();
    api<ScannerSession>('/api/scanner/session', { bearer: scannerKey, timeoutMs: HEARTBEAT_TIMEOUT_MS }).then(
      (value) => {
        if (!live) return;
        const latencyMs = Math.round(performance.now() - sentAt);
        setSession(value);
        setProbe({ state: 'ok', latencyMs, serverTime: value.serverTime, receivedAt: Date.now() });
        setQuality(latencyMs > SLOW_CHECK_MS ? 'slow' : 'good');
      },
      (err: unknown) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 401) return onUnauthorized();
        setProbe({ state: 'failed', message: err instanceof Error ? err.message : 'The server did not answer.' });
      }
    );
    return () => {
      live = false;
    };
  }, [readinessOpen, probeAttempt, scannerKey, onUnauthorized]);

  // Camera permission, where the browser can report it without asking (not every browser can).
  useEffect(() => {
    let status: PermissionStatus | null = null;
    let live = true;
    const update = () => {
      if (live && status) setCameraPermission(status.state === 'granted' || status.state === 'denied' || status.state === 'prompt' ? status.state : 'unknown');
    };
    navigator.permissions?.query({ name: 'camera' as PermissionName }).then(
      (value) => {
        status = value;
        update();
        value.addEventListener('change', update);
      },
      () => undefined
    );
    return () => {
      live = false;
      status?.removeEventListener('change', update);
    };
  }, []);

  // Heartbeat: shows the device as alive to the organiser, measures the connection, picks up event status changes.
  useEffect(() => {
    if (!online) return;
    let live = true;
    const beat = async () => {
      const sentAt = Date.now();
      try {
        const value = await api<ScannerSession>('/api/scanner/session', { bearer: scannerKey, timeoutMs: HEARTBEAT_TIMEOUT_MS });
        if (!live) return;
        setSession(value);
        setQuality(Date.now() - sentAt > SLOW_CHECK_MS ? 'slow' : 'good');
      } catch (err) {
        if (!live) return;
        if (err instanceof ApiError && err.status === 401) onUnauthorized();
        else if (isUnanswered(err)) setQuality('slow');
      }
    };
    const timer = setInterval(() => void beat(), HEARTBEAT_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [online, scannerKey, onUnauthorized]);

  // Back online: check the connection straight away rather than at the next heartbeat.
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current) {
      api<ScannerSession>('/api/scanner/session', { bearer: scannerKey, timeoutMs: HEARTBEAT_TIMEOUT_MS }).then(
        (value) => {
          setSession(value);
          setQuality('good');
        },
        (err: unknown) => {
          if (err instanceof ApiError && err.status === 401) onUnauthorized();
          else setQuality('slow');
        }
      );
    }
    wasOnline.current = online;
  }, [online, scannerKey, onUnauthorized]);

  useEffect(
    () => () => {
      clearTimeout(clearTimer.current);
      clearTimeout(noticeTimer.current);
    },
    []
  );

  function startScanning() {
    unlockAudio();
    setStarted(true);
  }

  /** Leaves the checklist: from now on the camera looks for passes. */
  function finishReadiness() {
    unlockAudio();
    setReadinessOpen(false);
    setDiagnosticHint('');
    setStarted(true);
  }

  function testCamera() {
    unlockAudio();
    setCameraOn(true);
    setStarted(true);
    setDiagnosticHint('');
    setDiagnostic((current) => (current === 'passed' ? current : 'running'));
  }

  function submitManual(e: FormEvent) {
    e.preventDefault();
    const value = manual.trim();
    if (!online || busy.current || !value) return;
    void submit(REFERENCE.test(value) ? value.toUpperCase() : value);
    setManual('');
  }

  function chooseCamera(deviceId: string) {
    saveCameraChoice(deviceId);
    setCameraId(deviceId);
    setCameraAttempt((n) => n + 1);
  }

  async function toggleTorch() {
    const track = trackRef.current;
    if (!track) return;
    const next = !torch.on;
    try {
      await setTorch(track, next);
      setTorchState({ supported: true, on: next });
    } catch {
      // The track advertised a torch it cannot switch: hide the control rather than show a broken one.
      setTorchState({ supported: false, on: false });
    }
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
  const announcement = latest
    ? [VERDICT_HEADLINE[latest.verdict], latest.reason, latest.name, latest.explanation, latest.replayed ? REPLAYED_NOTE : null].filter(Boolean).join('. ')
    : '';
  const cameraLive = started && cameraOn && !cameraError;
  const statusWarning = session.event.status === 'active' ? null : EVENT_STATUS_WARNING[session.event.status];
  const retryCode = display?.retryCode ?? null;
  const retry = retryCode ? { onRetry: () => void submit(retryCode), disabled: !online || checking, checking } : undefined;
  const readiness = readinessOpen
    ? readinessItems({
        session,
        online,
        probe,
        camera: { supported: window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia), permission: cameraPermission, live: streaming, error: cameraError },
        diagnostic,
        nowMs: now.getTime()
      })
    : [];

  return (
    <main className="scanner">
      <header className="scanner-bar">
        <h1 className="scanner-event" title={session.event.name}>
          {session.event.name}
        </h1>
        <div className="scanner-meta">
          <span className="scanner-device" title="This device">
            <Smartphone size={14} aria-hidden />
            <span>{session.scanner.label}</span>
          </span>
          <span className="scanner-gate">
            <MapPin size={14} aria-hidden />
            {session.gate ? `Gate: ${session.gate.name}` : 'Any gate'}
          </span>
          <span className="scanner-clock" title={`Event time (${timeZone})`}>
            <Clock size={14} aria-hidden />
            <span className="sr-only">Event time </span>
            <time dateTime={now.toISOString()}>{formatEventClock(now, timeZone)}</time>
          </span>
          <span className={`scanner-net is-${connection}`} role="status">
            <span className="scanner-net-dot" aria-hidden />
            {CONNECTION_LABEL[connection]}
          </span>
        </div>
        <div className="scanner-tools">
          {torch.supported ? (
            <button className="icon-btn" onClick={() => void toggleTorch()} aria-pressed={torch.on} aria-label="Flashlight">
              {torch.on ? <Flashlight size={18} aria-hidden /> : <FlashlightOff size={18} aria-hidden />}
            </button>
          ) : null}
          <button className="icon-btn" onClick={toggleMute} aria-pressed={!muted} aria-label="Sound">
            {muted ? <VolumeX size={18} aria-hidden /> : <Volume2 size={18} aria-hidden />}
          </button>
          <button className="icon-btn" onClick={() => setCameraOn((on) => !on)} aria-pressed={cameraOn} aria-label="Camera">
            {cameraOn ? <Camera size={18} aria-hidden /> : <CameraOff size={18} aria-hidden />}
          </button>
          <button className="icon-btn" onClick={() => setReadinessOpen(true)} aria-pressed={readinessOpen} aria-label="Before you scan" title="Readiness checklist">
            <ListChecks size={18} aria-hidden />
          </button>
          <button className="icon-btn" onClick={() => void signOut()} aria-label="Sign out">
            <LogOut size={18} aria-hidden />
          </button>
        </div>
      </header>

      {online ? null : (
        <p id="scanner-offline" className="scanner-offline" role="alert">
          <WifiOff size={18} aria-hidden />
          <span>
            {OFFLINE_MESSAGE} <span className="scanner-offline-shell">{offlineShell ? 'The app is loaded from this phone, but passes need the server.' : 'Passes need the server.'}</span>
          </span>
        </p>
      )}

      <div className="scanner-body">
        <div className="scanner-scan">
          {statusWarning ? <p className="error">{statusWarning}</p> : null}

          {readinessOpen ? (
            <ReadinessPanel
              items={readiness}
              online={online}
              serverOk={probe.state === 'ok'}
              offlineShell={offlineShell}
              checking={probe.state === 'checking'}
              testing={started && cameraOn && !cameraError && diagnostic === 'running'}
              hint={diagnosticHint}
              onCheckAgain={() => setProbeAttempt((n) => n + 1)}
              onTestCamera={testCamera}
              onStart={finishReadiness}
            />
          ) : null}

          {/* While the checklist is open the viewfinder appears only for the camera test, or to show a slow check. */}
          <div className="viewfinder" hidden={readinessOpen && !started && !slow}>
            {!cameraOn ? (
              <div className="viewfinder-off">Camera off. Use manual entry below.</div>
            ) : !started ? (
              <button type="button" className="viewfinder-start" onClick={startScanning}>
                <ScanLine size={40} aria-hidden />
                <span className="viewfinder-start-title">Tap to start scanning</span>
                <span className="viewfinder-start-hint">Turns on the camera and the sound for results.</span>
              </button>
            ) : (
              <video ref={videoRef} playsInline muted aria-label="Camera view" />
            )}
            {cameraLive && (online || readinessOpen) ? (
              <>
                <div className="reticle" aria-hidden>
                  <span className="reticle-corner reticle-tl" />
                  <span className="reticle-corner reticle-tr" />
                  <span className="reticle-corner reticle-bl" />
                  <span className="reticle-corner reticle-br" />
                </div>
                <p className="viewfinder-caption">{readinessOpen ? 'Camera test: hold the test code in the frame' : 'Point at a pass QR code'}</p>
              </>
            ) : null}
            {cameraLive && !online && !readinessOpen ? (
              <div className="viewfinder-paused" aria-hidden>
                <WifiOff size={28} />
                <span>Paused — offline</span>
              </div>
            ) : null}
            {slow ? (
              <div className="viewfinder-pending" role="status">
                <LoaderCircle size={28} aria-hidden />
                <span>{SLOW_MESSAGE}</span>
              </div>
            ) : null}
          </div>

          {notice ? (
            <p className="scanner-notice" role="status">
              {notice}
            </p>
          ) : null}

          {cameraError ? (
            <div className="camera-error">
              <ErrorNote message={cameraError} />
              {cameraRetryable ? (
                <button type="button" className="btn btn-secondary camera-retry" onClick={() => setCameraAttempt((n) => n + 1)}>
                  <RotateCcw size={16} aria-hidden />
                  Retry camera
                </button>
              ) : null}
            </div>
          ) : null}

          {started && cameraOn && cameras.length > 1 ? (
            <label className="camera-select">
              <span>Camera</span>
              <select value={cameraId ?? ''} onChange={(e) => chooseCamera(e.target.value)}>
                {cameraId && !cameras.some((camera) => camera.deviceId === cameraId) ? <option value={cameraId}>Current camera</option> : null}
                {cameras.map((camera) => (
                  <option key={camera.deviceId} value={camera.deviceId}>
                    {camera.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        <div className="scanner-side">
          <p className="sr-only" aria-live="polite" aria-atomic>
            {/* The alternating no-break space makes identical consecutive verdicts announce again. */}
            {announcement ? `${announcement}${history.length % 2 ? '\u00a0' : ''}` : ''}
          </p>

          <form className="manual-form" onSubmit={submitManual}>
            <div className="manual-row">
              <label className="grow">
                <span className="sr-only">Pass link or code</span>
                <input
                  value={manual}
                  onChange={(e) => setManual(e.target.value)}
                  placeholder="Pass link or code"
                  aria-describedby="manual-help"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  enterKeyHint="go"
                />
              </label>
              <button
                className={`btn btn-primary${slow ? ' is-slow' : ''}`}
                disabled={!online || checking || !manual.trim()}
                aria-describedby={online ? undefined : 'scanner-offline'}
                title={online ? undefined : OFFLINE_MESSAGE}
              >
                {checking ? (slow ? SLOW_MESSAGE : 'Checking…') : 'Check'}
              </button>
            </div>
            <p id="manual-help" className="manual-help">
              Paste the pass link, or type the 8-character reference printed under the attendee’s QR code.
            </p>
          </form>

          <AttendeeFinder scannerKey={scannerKey} timeZone={timeZone} online={online} checking={checking} onAdmit={submit} onUnauthorized={onUnauthorized} />

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
                    <div className="history-detail">{[item.reason, item.explanation, item.replayed ? REPLAYED_NOTE : null].filter(Boolean).join(' · ')}</div>
                  </div>
                  <span className="history-verdict">{HISTORY_WORD[item.verdict]}</span>
                  <time className="history-time" dateTime={item.at}>
                    {formatEventTime(item.at, timeZone)}
                  </time>
                </li>
              ))}
              {history.length === 0 ? <li className="history-empty">No scans yet.</li> : null}
            </ul>
          </section>

          <footer className="scanner-footer">{decoderPath ? `Decoder: ${decoderPath}` : 'Decoder: starts with the camera'}</footer>
        </div>
      </div>

      {display ? <ResultOverlay display={display} onDismiss={dismiss} retry={retry} /> : null}
      {dialog}
    </main>
  );
}

/** How often the connection state is re-read, in case the browser did not deliver an online/offline event. */
const ONLINE_RECHECK_MS = 2_000;

/**
 * True while the browser reports a network connection; the server is still the only authority.
 * Events give the change at once; the periodic re-read and the re-read on returning to the tab
 * cover browsers that drop the event (a suspended tab, a slow network-state notifier).
 */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    document.addEventListener('visibilitychange', update);
    const timer = setInterval(update, ONLINE_RECHECK_MS);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      document.removeEventListener('visibilitychange', update);
      clearInterval(timer);
    };
  }, []);
  return online;
}
