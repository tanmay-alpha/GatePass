import { describe, expect, it } from 'vitest';
import { normalizeDesignConfig } from '../src/qr/design';

describe('design input validation', () => {
  it('rejects SVG attribute injection and unsafe logo references', () => {
    expect(() => normalizeDesignConfig({ bodyColor: '#000000" onload="alert(1)' })).toThrow();
    expect(() => normalizeDesignConfig({ logo: 'javascript:alert(1)' })).toThrow();
    expect(() => normalizeDesignConfig({ logo: '//evil.example/logo.svg' })).toThrow();
    // Uploads were removed; only built-in preset logos remain valid.
    expect(() => normalizeDesignConfig({ logo: '/uploads/abc.svg' })).toThrow();
    expect(normalizeDesignConfig({ logo: '#ctech' }).logo).toBe('#ctech');
  });

  it('drops unknown keys so arbitrary client data is never persisted', () => {
    const design = normalizeDesignConfig({ bodyColor: '#112233', injected: 'x'.repeat(10) } as never);
    expect(design.bodyColor).toBe('#112233');
    expect(design).not.toHaveProperty('injected');
  });
});
