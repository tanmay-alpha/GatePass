import type { EventStatus, ScannerSession } from '../../shared/types';
import { formatEventTime } from './outcome';

/**
 * Pre-shift readiness checklist for a door device. Pure: the station gathers
 * the facts (session, a server round trip, camera state, the local test-code
 * decode) and this module turns them into items with plain-language guidance.
 * The checklist is advisory: the server still judges every pass, and scanning
 * stays paused offline whatever the checklist says.
 */
export type ItemState = 'ok' | 'warn' | 'fail' | 'pending' | 'info';

export interface ReadinessItem {
  id: 'enrolled' | 'assignment' | 'server' | 'camera' | 'window' | 'diagnostic';
  label: string;
  state: ItemState;
  detail: string;
  /** What staff should do about it; absent when nothing is needed. */
  guidance?: string;
}

/** A timed `GET /api/scanner/session` made by the checklist. */
export type Probe =
  | { state: 'checking' }
  | { state: 'ok'; latencyMs: number; serverTime: string; receivedAt: number }
  | { state: 'failed'; message: string };

export type CameraPermission = 'granted' | 'denied' | 'prompt' | 'unknown';

export interface CameraFacts {
  /** Secure context with `getUserMedia`. */
  supported: boolean;
  permission: CameraPermission;
  /** A frame source is live in the viewfinder. */
  live: boolean;
  /** Why the camera could not start, if it failed. */
  error: string;
}

export type DiagnosticState = 'idle' | 'running' | 'passed';

export interface ReadinessFacts {
  session: ScannerSession;
  online: boolean;
  probe: Probe;
  camera: CameraFacts;
  diagnostic: DiagnosticState;
  /** Device clock, ms since the epoch. */
  nowMs: number;
}

/** Above this a round trip is reported as slow (same threshold as a scan). */
export const SLOW_PROBE_MS = 1500;
/** A device clock further off than this is worth a warning. */
export const CLOCK_SKEW_WARN_MS = 2 * 60_000;

export const DIAGNOSTIC_WHERE =
  'Open the camera test code on a second screen or on paper (organiser: event page → Scanners → Camera test code) and hold it in front of this camera.';

const STATUS_PROBLEM: Record<Exclude<EventStatus, 'active'>, string> = {
  draft: 'The event is still a draft: every pass is refused.',
  ended: 'The event has ended: every pass is refused.',
  archived: 'The event is archived: every pass is refused.'
};

/** Server clock minus device clock, from the probe; 0 until the server has answered. */
export function clockOffsetMs(probe: Probe): number {
  if (probe.state !== 'ok') return 0;
  const serverMs = Date.parse(probe.serverTime);
  // The server read its clock somewhere in the round trip: assume the middle. An older server sends no time.
  return Number.isFinite(serverMs) ? serverMs - (probe.receivedAt - probe.latencyMs / 2) : 0;
}

export type EntryWindow = { state: 'closed'; status: Exclude<EventStatus, 'active'> } | { state: 'early'; opensAt: string } | { state: 'late'; closedAt: string } | { state: 'open'; closesAt: string };

/** The event-wide entry window at server time `nowMs`. Ticket-type windows can be narrower; the server applies them per pass. */
export function entryWindow(event: ScannerSession['event'], nowMs: number): EntryWindow {
  if (event.status !== 'active') return { state: 'closed', status: event.status };
  if (nowMs < Date.parse(event.startsAt)) return { state: 'early', opensAt: event.startsAt };
  if (nowMs >= Date.parse(event.endsAt)) return { state: 'late', closedAt: event.endsAt };
  return { state: 'open', closesAt: event.endsAt };
}

function minutes(ms: number): string {
  const value = Math.round(Math.abs(ms) / 60_000);
  return `${value} minute${value === 1 ? '' : 's'}`;
}

export function readinessItems({ session, online, probe, camera, diagnostic, nowMs }: ReadinessFacts): ReadinessItem[] {
  const zone = session.event.timeZone;
  const serverNow = nowMs + clockOffsetMs(probe);
  const items: ReadinessItem[] = [];

  // The device label and "Gate: …" are already in the header; repeating them verbatim here would only add noise.
  items.push({ id: 'enrolled', label: 'Device set up', state: 'ok', detail: 'This device’s scanner key was accepted by the server.' });

  items.push({
    id: 'assignment',
    label: 'Event and gate',
    state: 'info',
    detail: `${session.event.name}${session.event.venue ? `, ${session.event.venue}` : ''} — ${session.gate ? `admits at the ${session.gate.name} gate` : 'admits at every gate'}.`,
    guidance: 'Check this is your event and door. If not, ask the organiser for the setup link of the right device.'
  });

  if (!online) {
    items.push({
      id: 'server',
      label: 'Server verification',
      state: 'fail',
      detail: 'No network connection.',
      guidance: 'Connect to Wi-Fi or mobile data. Scanning stays paused and nobody can be admitted until the server answers.'
    });
  } else if (probe.state === 'checking') {
    items.push({ id: 'server', label: 'Server verification', state: 'pending', detail: 'Checking the server…' });
  } else if (probe.state === 'failed') {
    items.push({
      id: 'server',
      label: 'Server verification',
      state: 'fail',
      detail: probe.message,
      guidance: 'Check Wi-Fi or mobile data, then tap Test connection. Nobody can be admitted until the server answers.'
    });
  } else {
    const skew = clockOffsetMs(probe);
    const slow = probe.latencyMs > SLOW_PROBE_MS;
    const skewed = Math.abs(skew) > CLOCK_SKEW_WARN_MS;
    const notes = [
      slow ? 'The connection is slow: each check takes a moment. Move closer to the Wi-Fi access point or switch networks if you can.' : null,
      skewed
        ? `This phone’s clock is ${minutes(skew)} ${skew > 0 ? 'behind' : 'ahead of'} the server. Admission uses the server’s clock; set the phone to automatic time.`
        : null
    ].filter((note): note is string => note !== null);
    items.push({
      id: 'server',
      label: 'Server verification',
      state: slow || skewed ? 'warn' : 'ok',
      detail: `Reachable, ${probe.latencyMs} ms round trip.`,
      ...(notes.length ? { guidance: notes.join(' ') } : {})
    });
  }

  if (!camera.supported) {
    items.push({
      id: 'camera',
      label: 'Camera',
      state: 'fail',
      detail: 'This browser cannot use the camera on this page.',
      guidance: 'Open the scanner over HTTPS in Chrome or Safari. Until then, type the reference or use Find attendee.'
    });
  } else if (camera.error) {
    items.push({
      id: 'camera',
      label: 'Camera',
      state: 'fail',
      detail: camera.error,
      guidance: 'Close other apps that use the camera, then tap Test camera again. Until then, type the reference or use Find attendee.'
    });
  } else if (camera.permission === 'denied') {
    items.push({
      id: 'camera',
      label: 'Camera',
      state: 'fail',
      detail: 'Camera access is blocked for this site.',
      guidance: 'Allow the camera in the browser’s site settings (the icon next to the address), then reload this page.'
    });
  } else if (camera.live || camera.permission === 'granted') {
    items.push({ id: 'camera', label: 'Camera', state: 'ok', detail: camera.live ? 'Camera on.' : 'Camera access allowed.' });
  } else {
    items.push({ id: 'camera', label: 'Camera', state: 'pending', detail: 'Not allowed yet.', guidance: 'Tap Test camera and allow camera access when the browser asks.' });
  }

  const entry = entryWindow(session.event, serverNow);
  if (entry.state === 'closed') {
    items.push({ id: 'window', label: 'Entry open', state: 'fail', detail: STATUS_PROBLEM[entry.status], guidance: 'Ask the organiser to open check-in for this event.' });
  } else if (entry.state === 'early') {
    items.push({
      id: 'window',
      label: 'Entry open',
      state: 'warn',
      detail: `Entry opens at ${formatEventTime(entry.opensAt, zone, new Date(serverNow))} event time (${zone}).`,
      guidance: 'Passes scanned before then are refused as too early. You can finish setting up now.'
    });
  } else if (entry.state === 'late') {
    items.push({
      id: 'window',
      label: 'Entry open',
      state: 'fail',
      detail: `Entry closed at ${formatEventTime(entry.closedAt, zone, new Date(serverNow))}.`,
      guidance: 'Every pass is refused as too late. Ask the organiser to extend the event if entry should still be open.'
    });
  } else {
    items.push({
      id: 'window',
      label: 'Entry open',
      state: 'ok',
      detail: `Accepting entry until ${formatEventTime(entry.closesAt, zone, new Date(serverNow))}. Ticket types can have their own entry times.`
    });
  }

  items.push(
    diagnostic === 'passed'
      ? { id: 'diagnostic', label: 'Camera test code', state: 'ok', detail: 'Read on this device. Nothing was sent to the server.' }
      : diagnostic === 'running'
        ? { id: 'diagnostic', label: 'Camera test code', state: 'pending', detail: 'Looking for the camera test code…', guidance: DIAGNOSTIC_WHERE }
        : { id: 'diagnostic', label: 'Camera test code', state: 'pending', detail: 'Not tested yet.', guidance: `Tap Test camera. ${DIAGNOSTIC_WHERE}` }
  );
  return items;
}

/** Every item passed (informational items need no action). */
export function isReady(items: ReadinessItem[]): boolean {
  return items.every((item) => item.state === 'ok' || item.state === 'info');
}
