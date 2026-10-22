import QRCode from 'qrcode';
import type { DesignConfig, OutputFormat } from '../shared/types';
import { normalizeDesignConfig } from './design';
import { getLogoIcon } from './logo-icons';

export { logoGallery } from './design';

export interface RenderRequest {
  data: string;
  size: number;
  file: OutputFormat;
  config?: Partial<DesignConfig>;
}

export class UnsupportedFormatError extends Error {
  readonly status = 400;
  constructor(format: string) {
    super(`${format.toUpperCase()} export is not supported (disabled in this MVP); use PNG or SVG.`);
    this.name = 'UnsupportedFormatError';
  }
}

export async function renderQr({ data, size, file, config }: RenderRequest): Promise<{ body: Buffer | string; contentType: string; filename: string }> {
  const design = normalizeDesignConfig(config);
  const width = clampSize(size);
  if (file === 'pdf' || file === 'eps') {
    throw new UnsupportedFormatError(file);
  }
  if (file === 'svg') {
    return { body: renderStyledSvg(data, width, design), contentType: 'image/svg+xml', filename: 'qr.svg' };
  }
  const body = await QRCode.toBuffer(data, {
    type: 'png',
    width,
    margin: 2,
    errorCorrectionLevel: 'H',
    color: { dark: design.bodyColor, light: design.bgColor }
  });
  return { body, contentType: 'image/png', filename: 'qr.png' };
}

export function clampSize(size: number): number {
  if (!Number.isFinite(size)) return 300;
  return Math.max(200, Math.min(2000, Math.round(size / 25) * 25));
}

function injectLogo(svg: string, design: DesignConfig): string {
  if (!design.logo) return svg;
  const viewBoxMatch = svg.match(/viewBox="0 0 ([0-9.]+) ([0-9.]+)"/);
  const box = viewBoxMatch ? Number(viewBoxMatch[1]) : 300;
  const logoSize = box * 0.2;
  const x = (box - logoSize) / 2;
  const y = (box - logoSize) / 2;
  const clean = design.logoMode === 'clean' ? `<rect x="${x - 6}" y="${y - 6}" width="${logoSize + 12}" height="${logoSize + 12}" rx="10" fill="${design.bgColor}"/>` : '';
  let logoMarkup: string;
  if (design.logo.startsWith('#')) {
    const presetName = design.logo.slice(1);
    const icon = getLogoIcon(presetName);
    if (icon) {
      const scale = logoSize / 100;
      logoMarkup =
        `<g aria-label="logo">${clean}` +
        `<circle cx="${box / 2}" cy="${box / 2}" r="${logoSize / 2}" fill="${icon.bg}"/>` +
        `<g transform="translate(${x},${y}) scale(${scale})" fill="${icon.fg}">${icon.body}</g>` +
        `</g>`;
    } else {
      const label = presetName.slice(0, 2).toUpperCase();
      logoMarkup = `<g aria-label="logo">${clean}<circle cx="${box / 2}" cy="${box / 2}" r="${logoSize / 2}" fill="${design.bodyColor}"/><text x="${box / 2}" y="${box / 2 + logoSize * 0.12}" text-anchor="middle" font-size="${logoSize * 0.36}" font-family="Arial, sans-serif" font-weight="700" fill="${design.bgColor}">${escapeXml(label)}</text></g>`;
    }
  } else {
    logoMarkup = `<g aria-label="logo">${clean}<image href="${escapeXml(design.logo)}" x="${x}" y="${y}" width="${logoSize}" height="${logoSize}" preserveAspectRatio="xMidYMid meet"/></g>`;
  }
  return svg.replace('</svg>', `${logoMarkup}</svg>`);
}

function renderStyledSvg(data: string, width: number, design: DesignConfig): string {
  const qr = QRCode.create(data, { errorCorrectionLevel: 'H' }) as any;
  const count = qr.modules.size as number;
  const margin = 2;
  const unit = width / (count + margin * 2);
  const gradientId = `bodyGradient-${hashString(`${data}:${design.gradientColor1}:${design.gradientColor2}:${design.gradientType}`)}`;
  const fill = design.gradientColor1 && design.gradientColor2 ? `url(#${gradientId})` : design.bodyColor;
  // userSpaceOnUse makes one gradient span the whole code instead of restarting inside every module.
  const defs = design.gradientColor1 && design.gradientColor2
    ? design.gradientType === 'radial'
      ? `<radialGradient id="${gradientId}" gradientUnits="userSpaceOnUse" cx="${width / 2}" cy="${width / 2}" r="${width / 2}"><stop offset="0%" stop-color="${design.gradientColor1}"/><stop offset="100%" stop-color="${design.gradientColor2}"/></radialGradient>`
      : `<linearGradient id="${gradientId}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${width}" y2="${width}"><stop offset="0%" stop-color="${design.gradientColor1}"/><stop offset="100%" stop-color="${design.gradientColor2}"/></linearGradient>`
    : '';
  const eyeFill = (color: string) => (defs && design.gradientOnEyes ? fill : color);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${width}" width="${width}" height="${width}" role="img" aria-label="QR code">`,
    defs ? `<defs>${defs}</defs>` : '',
    `<rect width="100%" height="100%" fill="${design.bgColor}"/>`
  ];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!qr.modules.get(row, col) || isFinder(col, row, count)) continue;
      parts.push(drawBodyModule((col + margin) * unit, (row + margin) * unit, unit, fill, design.body));
    }
  }
  parts.push(drawEye(margin * unit, margin * unit, unit, eyeFill(design.eye1Color), eyeFill(design.eyeBall1Color), design));
  parts.push(drawEye((count - 7 + margin) * unit, margin * unit, unit, eyeFill(design.eye2Color), eyeFill(design.eyeBall2Color), design));
  parts.push(drawEye(margin * unit, (count - 7 + margin) * unit, unit, eyeFill(design.eye3Color), eyeFill(design.eyeBall3Color), design));
  parts.push('</svg>');
  return injectLogo(parts.join(''), design);
}

function isFinder(col: number, row: number, count: number): boolean {
  const inTop = row < 7;
  const inLeft = col < 7;
  const inRight = col >= count - 7;
  const inBottom = row >= count - 7;
  return (inTop && inLeft) || (inTop && inRight) || (inBottom && inLeft);
}

function drawBodyModule(x: number, y: number, unit: number, fill: string, shape: string): string {
  const pad = unit * 0.08;
  const size = unit - pad * 2;
  const cx = x + unit / 2;
  const cy = y + unit / 2;
  if (['dot', 'circle', 'circular', 'circle-zebra', 'circle-zebra-vertical'].includes(shape)) {
    return `<circle cx="${cx}" cy="${cy}" r="${size / 2}" fill="${fill}"/>`;
  }
  if (['diamond', 'star', 'pointed', 'pointed-smooth', 'pointed-edge-cut'].includes(shape)) {
    return `<path d="M${cx} ${y + pad}L${x + unit - pad} ${cy}L${cx} ${y + unit - pad}L${x + pad} ${cy}Z" fill="${fill}"/>`;
  }
  const radius = ['round', 'rounded-in', 'rounded-in-smooth', 'rounded-pointed', 'mosaic', 'leaf'].includes(shape) ? unit * 0.26 : ['edge-cut', 'edge-cut-smooth', 'pointed-in', 'pointed-in-smooth'].includes(shape) ? unit * 0.12 : 0;
  return `<rect x="${x + pad}" y="${y + pad}" width="${size}" height="${size}" rx="${radius}" fill="${fill}"/>`;
}

function drawEye(x: number, y: number, unit: number, frameColor: string, ballColor: string, design: DesignConfig): string {
  const outer = unit * 7;
  const inner = unit * 3;
  const innerOffset = unit * 2;
  const frameRadius = ['frame5', 'frame6', 'frame7', 'frame8', 'frame13', 'frame14', 'frame16'].includes(design.eye) ? unit * 1.3 : ['frame1', 'frame2', 'frame3'].includes(design.eye) ? unit * 0.5 : 0;
  const ballRound = ['ball5', 'ball6', 'ball7', 'ball8', 'ball10', 'ball11', 'ball14', 'ball15', 'ball16', 'ball17', 'ball18', 'ball19'].includes(design.eyeBall);
  return [
    `<rect x="${x}" y="${y}" width="${outer}" height="${outer}" rx="${frameRadius}" fill="${frameColor}"/>`,
    `<rect x="${x + unit}" y="${y + unit}" width="${unit * 5}" height="${unit * 5}" rx="${frameRadius / 1.5}" fill="${design.bgColor}"/>`,
    ballRound
      ? `<circle cx="${x + outer / 2}" cy="${y + outer / 2}" r="${inner / 2}" fill="${ballColor}"/>`
      : `<rect x="${x + innerOffset}" y="${y + innerOffset}" width="${inner}" height="${inner}" rx="${unit * 0.25}" fill="${ballColor}"/>`
  ].join('');
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char] ?? char);
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
