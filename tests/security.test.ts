import { describe, expect, it } from 'vitest';
import { buildPayload } from '../src/qr/payloads';
import { normalizeDesignConfig } from '../src/qr/design';

describe('security constraints', () => {
  it('rejects SVG attribute injection and unsafe logo references', () => {
    expect(() => normalizeDesignConfig({ bodyColor: '#000000" onload="alert(1)' })).toThrow();
    expect(() => normalizeDesignConfig({ logo: 'javascript:alert(1)' })).toThrow();
    expect(() => normalizeDesignConfig({ logo: '//evil.example/logo.svg' })).toThrow();
  });
  it('rejects unsafe URL protocols in URL-backed payloads', () => {
    expect(() => buildPayload('url', { url: 'javascript:alert(1)' })).toThrow();
    expect(() => buildPayload('youtube', { url: 'file:///etc/passwd' })).toThrow();
  });

  it('does not require server-side fetches for URL payload validation', () => {
    const payload = buildPayload('url', { url: 'https://127.0.0.1/private' });
    expect(payload).toBe('https://127.0.0.1/private');
  });
});
