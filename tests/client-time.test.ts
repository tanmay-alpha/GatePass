import { describe, expect, it } from 'vitest';
import { fromZoneInput, isValidTimeZone, listTimeZones, toZoneInput, zoneOffsetMs } from '../src/client/time';

describe('event time zone conversion', () => {
  it('reads a wall-clock input in the event zone, not the browser zone', () => {
    expect(fromZoneInput('2026-11-07T18:00', 'Asia/Kolkata')).toBe('2026-11-07T12:30:00.000Z');
    expect(fromZoneInput('2026-11-07T18:00', 'UTC')).toBe('2026-11-07T18:00:00.000Z');
    expect(fromZoneInput('2026-07-01T09:15', 'America/Los_Angeles')).toBe('2026-07-01T16:15:00.000Z');
  });

  it('formats an instant as the event zone wall clock', () => {
    expect(toZoneInput('2026-11-07T12:30:00.000Z', 'Asia/Kolkata')).toBe('2026-11-07T18:00');
    expect(toZoneInput('2026-01-01T00:00:00.000Z', 'Pacific/Auckland')).toBe('2026-01-01T13:00');
    expect(toZoneInput('2026-03-08T23:59:59.000Z', 'UTC')).toBe('2026-03-08T23:59');
  });

  it('round-trips every hour across a DST change in both directions', () => {
    for (const zone of ['America/New_York', 'Europe/Berlin', 'Australia/Sydney']) {
      for (let hour = 0; hour < 72; hour++) {
        const instant = new Date(Date.UTC(2026, 2, 7) + hour * 3_600_000).toISOString();
        expect(fromZoneInput(toZoneInput(instant, zone), zone), `${zone} ${instant}`).toBe(instant);
      }
    }
  });

  it('uses the right offset on each side of the US spring-forward boundary', () => {
    // Clocks in New York jump from 02:00 EST to 03:00 EDT on 8 March 2026.
    expect(fromZoneInput('2026-03-08T01:59', 'America/New_York')).toBe('2026-03-08T06:59:00.000Z');
    expect(fromZoneInput('2026-03-08T03:00', 'America/New_York')).toBe('2026-03-08T07:00:00.000Z');
    // 02:30 does not exist that night; it moves forward by the gap to 03:30 EDT.
    expect(fromZoneInput('2026-03-08T02:30', 'America/New_York')).toBe('2026-03-08T07:30:00.000Z');
    expect(zoneOffsetMs('America/New_York', Date.parse('2026-03-08T06:59:00Z'))).toBe(-5 * 3_600_000);
    expect(zoneOffsetMs('America/New_York', Date.parse('2026-03-08T07:00:00Z'))).toBe(-4 * 3_600_000);
  });

  it('picks the earlier instant for the repeated hour when clocks go back', () => {
    // 1 November 2026: 02:00 EDT becomes 01:00 EST, so 01:30 happens twice.
    expect(fromZoneInput('2026-11-01T01:30', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z');
    expect(fromZoneInput('2026-11-01T02:30', 'America/New_York')).toBe('2026-11-01T07:30:00.000Z');
    // Europe changes at 01:00 UTC on 25 October 2026.
    expect(fromZoneInput('2026-10-25T02:30', 'Europe/Berlin')).toBe('2026-10-25T00:30:00.000Z');
  });

  it('rejects malformed input and knows valid zones', () => {
    expect(fromZoneInput('', 'UTC')).toBeNull();
    expect(fromZoneInput('2026-11-07', 'UTC')).toBeNull();
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    const zones = listTimeZones('Etc/GMT+5');
    expect(zones).toContain('UTC');
    expect(zones).toContain('Etc/GMT+5');
    expect(zones).toContain('Europe/London');
  });
});
