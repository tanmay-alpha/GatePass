import { describe, expect, it } from 'vitest';
import { defaultDesignConfig, logoGallery, templates } from '../src/qr/design';
import { getLogoIcon } from '../src/qr/logo-icons';
import { renderQr } from '../src/qr/renderer';

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
