/**
 * Event times are stored as UTC instants and entered and shown as wall-clock
 * time in the event's IANA zone, whatever zone the organiser's browser is in.
 * Offsets come from Intl, so daylight-saving rules follow the browser's tz data.
 */

const DAY_MS = 86_400_000;

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function partFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = partFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    partFormatters.set(zone, formatter);
  }
  return formatter;
}

function wallClock(ms: number, zone: string): WallClock {
  const values: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const part of partFormatter(zone).formatToParts(ms)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? 1970,
    month: values.month ?? 1,
    day: values.day ?? 1,
    // Some engines still render midnight as 24 even with h23.
    hour: (values.hour ?? 0) % 24,
    minute: values.minute ?? 0,
    second: values.second ?? 0
  };
}

/** Milliseconds to add to UTC to get the zone's wall clock at `ms`, e.g. +19 800 000 for Asia/Kolkata. */
export function zoneOffsetMs(zone: string, ms: number): number {
  const whole = Math.floor(ms / 1000) * 1000;
  const wall = wallClock(whole, zone);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - whole;
}

/** True when `zone` is an IANA zone this browser knows. */
export function isValidTimeZone(zone: string): boolean {
  try {
    partFormatter(zone);
    return true;
  } catch {
    return false;
  }
}

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

/** `datetime-local` value (minute precision) for the instant `iso` as seen on a clock in `zone`. */
export function toZoneInput(iso: string, zone: string): string {
  const wall = wallClock(new Date(iso).getTime(), zone);
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

const INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * UTC ISO string for a `datetime-local` value read as wall-clock time in `zone`.
 * Ambiguous times (the repeated hour when clocks go back) resolve to the
 * earlier instant; times skipped when clocks go forward move forward by the
 * gap (02:30 on a spring-forward night becomes 03:30), like Temporal's
 * "compatible" disambiguation. Returns null for an unparseable value.
 */
export function fromZoneInput(value: string, zone: string): string | null {
  const match = INPUT_PATTERN.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second = '0'] = match.slice(1).map((part) => part ?? '0');
  const wallMs = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  if (Number.isNaN(wallMs)) return null;
  const before = zoneOffsetMs(zone, wallMs - DAY_MS);
  const after = zoneOffsetMs(zone, wallMs + DAY_MS);
  const candidates = [...new Set([wallMs - before, wallMs - after])].filter((instant) => zoneOffsetMs(zone, instant) === wallMs - instant);
  const instant = candidates.length ? Math.min(...candidates) : wallMs - before;
  return new Date(instant).toISOString();
}

/** The browser's zone, used as the default for new events. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Every IANA zone the browser knows, sorted, always including UTC and `include`. */
export function listTimeZones(include?: string): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [];
  }
  const set = new Set(zones);
  set.add('UTC');
  if (include) set.add(include);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Short zone label at that instant, e.g. "GMT+5:30", "CET" or "EDT" depending on locale. */
export function zoneLabel(zone: string, iso: string): string {
  try {
    const part = new Intl.DateTimeFormat(undefined, { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(new Date(iso))
      .find((item) => item.type === 'timeZoneName');
    return part?.value ?? zone;
  } catch {
    return zone;
  }
}

function dayKey(ms: number, zone: string): string {
  const wall = wallClock(ms, zone);
  return `${wall.year}-${wall.month}-${wall.day}`;
}

function timeOf(date: Date, zone: string): string {
  return date.toLocaleTimeString(undefined, { timeZone: zone, hour: '2-digit', minute: '2-digit' });
}

function shortDayOf(date: Date, zone: string): string {
  return date.toLocaleDateString(undefined, { timeZone: zone, month: 'short', day: 'numeric' });
}

/** "Nov 7, 2026" in the zone. */
export function formatDateInZone(iso: string, zone: string): string {
  return new Date(iso).toLocaleDateString(undefined, { timeZone: zone, dateStyle: 'medium' });
}

/** "Nov 7, 2026, 18:00 GMT+1" (with zone label) or "—". */
export function formatDateTimeInZone(iso: string | null, zone: string, withZone = true): string {
  if (!iso) return '—';
  const text = new Date(iso).toLocaleString(undefined, { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' });
  return withZone ? `${text} ${zoneLabel(zone, iso)}` : text;
}

/** "Nov 7, 18:00": compact date and time in the zone for dense tables; "—" for null. */
export function formatShortInZone(iso: string | null, zone: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return `${shortDayOf(date, zone)}, ${timeOf(date, zone)}`;
}

/** "18:00" when the instant is today in the zone, else "Nov 7 18:00". */
export function formatTimeInZone(iso: string, zone: string, now = Date.now()): string {
  const date = new Date(iso);
  const time = timeOf(date, zone);
  return dayKey(date.getTime(), zone) === dayKey(now, zone) ? time : `${shortDayOf(date, zone)} ${time}`;
}

/** "Nov 7, 18:00 – 23:30 GMT+1", or both dates when the range spans days in the zone. */
export function formatRangeInZone(startIso: string, endIso: string, zone: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const sameDay = dayKey(start.getTime(), zone) === dayKey(end.getTime(), zone);
  const endText = sameDay ? timeOf(end, zone) : formatShortInZone(endIso, zone);
  return `${formatShortInZone(startIso, zone)} – ${endText} ${zoneLabel(zone, startIso)}`;
}
