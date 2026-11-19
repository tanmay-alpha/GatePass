/**
 * Geometry of printable A4 badge sheets: 1, 2, 4 or 8 passes per page.
 *
 * Everything is in millimetres (font sizes in points) so the CSS in `badges.css`
 * and the scannability checks in `tests/badge-layout.test.ts` use one source.
 */

export type BadgesPerPage = 1 | 2 | 4 | 8;
export const BADGES_PER_PAGE: readonly BadgesPerPage[] = [1, 2, 4, 8];

/** A4 with the `@page` margin in `badges.css`. */
export const PAGE_MM = { width: 210, height: 297, margin: 10 } as const;
/**
 * Printable box of one sheet. One millimetre of slack in height keeps rounding in
 * the browser's print layout from pushing a sheet onto a second, blank page.
 */
export const SHEET_MM = { width: PAGE_MM.width - 2 * PAGE_MM.margin, height: PAGE_MM.height - 2 * PAGE_MM.margin - 1 } as const;

/** Light modules around the code in the server-rendered QR (`src/qr/renderer.ts`). */
export const QR_RENDER_MARGIN_MODULES = 2;
/** Smallest name size printed; long names wrap, then shrink to this, then are clamped with an ellipsis. */
export const MIN_NAME_PT = 10;

const MM_PER_PT = 25.4 / 72;
/** Average advance of a semibold Latin character, in em; slightly generous so the estimate errs towards smaller text. */
const CHAR_EM = 0.6;

export interface BadgeLayout {
  perPage: BadgesPerPage;
  columns: number;
  rows: number;
  cellWidthMm: number;
  cellHeightMm: number;
  /** Inner padding of a badge; also part of the QR's quiet zone. */
  paddingMm: number;
  /** Space between the QR and the text. */
  gapMm: number;
  qrMm: number;
  /** `column`: QR above the text; `row`: QR beside it. */
  direction: 'column' | 'row';
  /** Width available to the attendee name. */
  textWidthMm: number;
  nameMaxPt: number;
  nameLines: number;
}

interface Spec {
  columns: number;
  rows: number;
  paddingMm: number;
  gapMm: number;
  qrMm: number;
  direction: 'column' | 'row';
  nameMaxPt: number;
  nameLines: number;
}

const SPECS: Record<BadgesPerPage, Spec> = {
  1: { columns: 1, rows: 1, paddingMm: 12, gapMm: 8, qrMm: 90, direction: 'column', nameMaxPt: 32, nameLines: 2 },
  2: { columns: 1, rows: 2, paddingMm: 8, gapMm: 8, qrMm: 70, direction: 'row', nameMaxPt: 24, nameLines: 3 },
  4: { columns: 2, rows: 2, paddingMm: 6, gapMm: 5, qrMm: 52, direction: 'column', nameMaxPt: 18, nameLines: 3 },
  8: { columns: 2, rows: 4, paddingMm: 4, gapMm: 4, qrMm: 38, direction: 'row', nameMaxPt: 14, nameLines: 3 }
};

export function badgeLayout(perPage: BadgesPerPage): BadgeLayout {
  const spec = SPECS[perPage];
  const cellWidthMm = SHEET_MM.width / spec.columns;
  const cellHeightMm = SHEET_MM.height / spec.rows;
  const inner = cellWidthMm - 2 * spec.paddingMm;
  return {
    perPage,
    ...spec,
    cellWidthMm,
    cellHeightMm,
    textWidthMm: spec.direction === 'row' ? inner - spec.qrMm - spec.gapMm : inner
  };
}

export function pageCount(passes: number, perPage: BadgesPerPage): number {
  return Math.ceil(passes / perPage);
}

/** Splits passes into sheets of `perPage`. */
export function paginate<T>(items: readonly T[], perPage: BadgesPerPage): T[][] {
  const pages: T[][] = [];
  for (let start = 0; start < items.length; start += perPage) pages.push(items.slice(start, start + perPage));
  return pages;
}

/** Printed size of one QR module for a code `moduleCount` modules wide (QR version 8 is 49). */
export function qrModuleMm(layout: BadgeLayout, moduleCount: number): number {
  return layout.qrMm / (moduleCount + 2 * QR_RENDER_MARGIN_MODULES);
}

/**
 * Light space around the code, in modules: the renderer's own margin plus the badge's
 * white padding or gap, whichever is narrower. Scanners expect at least 4.
 */
export function quietZoneModules(layout: BadgeLayout, moduleCount: number): number {
  return QR_RENDER_MARGIN_MODULES + Math.min(layout.paddingMm, layout.gapMm) / qrModuleMm(layout, moduleCount);
}

/**
 * Lines `text` wraps to at `pt` in `widthMm`: breaks at spaces and after hyphens, and inside
 * words that do not fit a line (CSS `overflow-wrap: anywhere`).
 */
export function estimateLines(text: string, widthMm: number, pt: number): number {
  const perLine = Math.max(1, Math.floor(widthMm / (pt * MM_PER_PT * CHAR_EM)));
  let lines = 1;
  let used = 0;
  for (const word of text.trim().split(/\s+/)) {
    for (const [index, part] of (word.match(/[^-]+-*|-+/g) ?? [word]).entries()) {
      const space = index === 0 && used > 0 ? 1 : 0;
      let length = part.length;
      if (used > 0 && used + space + length <= perLine) {
        used += space + length;
        continue;
      }
      if (used > 0) lines += 1;
      while (length > perLine) {
        lines += 1;
        length -= perLine;
      }
      used = length;
    }
  }
  return lines;
}

/** Largest name size (half-point steps, at least {@link MIN_NAME_PT}) at which `name` fits the layout's name lines. */
export function nameFontPt(name: string, layout: BadgeLayout): number {
  for (let pt = layout.nameMaxPt; pt > MIN_NAME_PT; pt -= 0.5) {
    if (estimateLines(name, layout.textWidthMm, pt) <= layout.nameLines) return pt;
  }
  return MIN_NAME_PT;
}
