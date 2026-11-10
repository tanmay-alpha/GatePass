import { describe, expect, it } from 'vitest';
import { renderPassPage, type PassView } from '../src/server/pass-page';
import type { Pass } from '../src/shared/types';

const design = {} as PassView['event']['design'];

function view(overrides: { pass?: Partial<Pass>; event?: Partial<PassView['event']> } = {}): PassView {
  return {
    pass: {
      id: 'ab12cd34-0000-4000-8000-000000000000',
      eventId: 'event-1',
      policyId: null,
      attendeeName: 'Ada Lovelace',
      attendeeEmail: null,
      expiresAt: '2026-11-15T18:30:00.000Z',
      createdAt: '2026-11-01T00:00:00.000Z',
      revokedAt: null,
      redeemedAt: null,
      redeemedBy: null,
      status: 'active',
      ...overrides.pass
    },
    event: {
      name: 'Launch night',
      venue: 'Hall A',
      timeZone: 'Asia/Kolkata',
      startsAt: '2026-11-15T13:30:00.000Z',
      endsAt: '2026-11-15T17:30:00.000Z',
      status: 'active',
      design,
      ...overrides.event
    },
    admission: { policyName: null, gates: [] },
    qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
  };
}

describe('pass page', () => {
  it('formats event times in the event time zone with a zone label', () => {
    const html = renderPassPage(view());
    // 13:30Z–17:30Z is 19:00–23:00 in Kolkata (UTC+5:30).
    expect(html).toContain('Sun, 15 Nov 2026 · 19:00–23:00');
    expect(html).toContain('Times in Asia/Kolkata (GMT+5:30)');
    expect(html).toContain('Valid until Mon, 16 Nov 2026 · 00:00 GMT+5:30.');
  });

  it('shows both days when the event crosses midnight in its zone, and DST-aware abbreviations', () => {
    const html = renderPassPage(
      view({ event: { timeZone: 'Europe/London', startsAt: '2026-07-01T20:00:00.000Z', endsAt: '2026-07-02T01:00:00.000Z' } })
    );
    expect(html).toContain('Wed, 1 Jul 2026 · 21:00 – Thu, 2 Jul 2026 · 02:00');
    expect(html).toContain('Times in Europe/London (BST)');
  });

  it('falls back to UTC for an unknown zone', () => {
    const html = renderPassPage(view({ event: { timeZone: 'Not/AZone' } }));
    expect(html).toContain('Sun, 15 Nov 2026 · 13:30–17:30');
    expect(html).toContain('Times in UTC');
  });

  it('formats the check-in time in the event zone', () => {
    const html = renderPassPage(view({ pass: { status: 'redeemed', redeemedAt: '2026-11-15T14:05:00.000Z' } }));
    expect(html).toContain('Already used. Checked in Sun, 15 Nov 2026 · 19:35 GMT+5:30.');
  });

  it('labels the reference code for manual entry, also on inactive passes', () => {
    for (const status of ['active', 'revoked'] as const) {
      const html = renderPassPage(view({ pass: { status } }));
      expect(html).toContain('Reference (for manual entry at the door)');
      expect(html).toContain('>AB12CD34</p>');
    }
    expect(renderPassPage(view({ pass: { status: 'revoked' } }))).not.toContain('<svg');
  });

  it('escapes organiser- and attendee-controlled text', () => {
    const html = renderPassPage(
      view({
        pass: { attendeeName: '<script>alert(1)</script>' },
        event: { name: '<script>alert("name")</script>', venue: '<img src=x onerror=alert(1)>' }
      })
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<title>&lt;script&gt;alert(&quot;name&quot;)&lt;/script&gt; · GatePass</title>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('meets AA contrast for the light-mode warning colour and ships a print stylesheet', () => {
    const html = renderPassPage(view());
    const light = /@media \(prefers-color-scheme:light\)\{([\s\S]*?)\n\}/.exec(html)?.[1] ?? '';
    const color = (name: string) => new RegExp(`--${name}:(#[0-9a-f]{6})`).exec(light)?.[1] ?? '';
    expect(contrast(color('warn'), color('bg'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(color('muted'), color('bg'))).toBeGreaterThanOrEqual(4.5);
    expect(html).toContain('@media print');
  });

  it('has no scripts and renders a not-found page', () => {
    expect(renderPassPage(view())).not.toMatch(/<script/i);
    expect(renderPassPage(null)).toContain('Pass not found');
  });
});

function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
