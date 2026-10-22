import { describe, expect, it } from 'vitest';
import { defaultDesignConfig, templates } from '../src/qr/design';
import { logoGallery } from '../src/qr/design';
import { getLogoIcon } from '../src/qr/logo-icons';
import { buildPayload } from '../src/qr/payloads';
import { renderQr } from '../src/qr/renderer';
import type { ContentType } from '../src/shared/types';

describe('QR payload builders', () => {
  it.each<[ContentType, Record<string, unknown>, string]>([
    ['url', { url: 'https://example.com' }, 'https://example.com'],
    ['text', { text: 'hello' }, 'hello'],
    ['email', { email: 'hello@example.com', subject: 'Hi there', message: 'Body text' }, 'mailto:hello@example.com?subject=Hi+there&body=Body+text'],
    ['phone', { phone: '+15555550100' }, 'tel:+15555550100'],
    ['sms', { phone: '+15555550100', message: 'Hi' }, 'SMSTO:+15555550100:Hi'],
    ['maps', { latitude: 40, longitude: -73 }, 'https://maps.google.com/local?q=40,-73'],
    ['facebook', { mode: 'share', url: 'https://example.com' }, 'https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fexample.com'],
    ['twitter', { mode: 'tweet', tweet: 'hello world' }, 'https://twitter.com/intent/tweet?text=hello%20world'],
    ['youtube', { url: 'https://youtube.com/watch?v=abc' }, 'https://youtube.com/watch?v=abc'],
    ['wifi', { ssid: 'example;guest', password: 'p:a,s', encryption: 'WPA' }, 'WIFI:S:example\\;guest;T:WPA;P:p\\:a\\,s;;'],
    ['crypto', { currency: 'bitcoin', address: 'abc', amount: 1.5 }, 'bitcoin:abc?amount=1.5']
  ])('builds %s payload', (type, input, expected) => {
    expect(buildPayload(type, input)).toBe(expected);
  });

  it('builds vCard and MeCard payloads', () => {
    expect(buildPayload('vcard', { firstName: 'Ada', lastName: 'Lovelace', version: '3.0', email: 'ada@example.com' })).toContain('BEGIN:VCARD');
    expect(buildPayload('mecard', { firstName: 'Ada', lastName: 'Lovelace', birthday: '1815-12-10', notes: 'math;engine' })).toContain('BDAY:18151210');
    expect(buildPayload('mecard', { notes: 'math;engine' })).toContain('NOTE:math,engine');
  });

  it('builds event payload with normalized dates', () => {
    const payload = buildPayload('event', { title: 'Launch', location: 'Online', start: '2026-05-07T12:30:00', end: '2026-05-07T13:30:00' });
    expect(payload).toContain('BEGIN:VEVENT');
    expect(payload).toContain('DTSTART:20260507T123000');
  });
});

describe('design and renderer', () => {
  it('ships all scoped templates', () => {
    expect(templates.map((template) => template.name)).toEqual(['Classic', 'CompleteTech', 'Easy', 'Facebook', 'Twitter', 'Youtube', 'Monkey', 'Rain', 'Jungle', 'Mosaic', 'Dot', 'Coffee', 'Ninja', 'Bitcoin']);
  });

  it('resolves every logo gallery preset to an SVG icon', () => {
    expect(logoGallery.map((name) => [name, Boolean(getLogoIcon(name))])).toEqual(
      logoGallery.map((name) => [name, true])
    );
  });

  it('renders SVG and PNG', async () => {
    const svg = await renderQr({ data: 'https://example.com', size: 300, file: 'svg', config: { ...defaultDesignConfig, logo: '#ctech-mark', logoMode: 'clean' } });
    expect(svg.contentType).toBe('image/svg+xml');
    expect(String(svg.body)).toContain('<svg');
    expect(String(svg.body)).toContain('aria-label="logo"');

    const png = await renderQr({ data: 'https://example.com', size: 300, file: 'png', config: defaultDesignConfig });
    expect(png.contentType).toBe('image/png');
    expect(Buffer.isBuffer(png.body)).toBe(true);
  });

  it('explicitly disables PDF and EPS in the MVP', async () => {
    await expect(renderQr({ data: 'https://example.com', size: 300, file: 'pdf', config: defaultDesignConfig })).rejects.toThrow('disabled');
    await expect(renderQr({ data: 'https://example.com', size: 300, file: 'eps', config: defaultDesignConfig })).rejects.toThrow('disabled');
  });
});

describe('gradient on eyes', () => {
  const base = { ...defaultDesignConfig, gradientColor1: '#ff0000', gradientColor2: '#0000ff', eye1Color: '#123456', eyeBall1Color: '#abcdef' };

  it('keeps eye colors when gradientOnEyes is off', async () => {
    const svg = String((await renderQr({ data: 'https://example.com', size: 300, file: 'svg', config: { ...base, gradientOnEyes: false } })).body);
    expect(svg).toContain('fill="#123456"');
    expect(svg).toContain('fill="#abcdef"');
  });

  it('paints eye frames and balls with the body gradient when gradientOnEyes is on', async () => {
    const render = async (gradientOnEyes: boolean) => String((await renderQr({ data: 'https://example.com', size: 300, file: 'svg', config: { ...base, gradientOnEyes } })).body);
    const off = await render(false);
    const on = await render(true);
    expect(on).not.toContain('fill="#123456"');
    expect(on).not.toContain('fill="#abcdef"');
    expect(on).toContain('gradientUnits="userSpaceOnUse"');
    const gradientFills = (svg: string) => svg.split('fill="url(#').length - 1;
    // 3 eyes x (frame + ball) switch to the gradient.
    expect(gradientFills(on)).toBe(gradientFills(off) + 6);
  });
});
