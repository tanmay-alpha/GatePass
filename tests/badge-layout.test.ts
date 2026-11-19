import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import {
  BADGES_PER_PAGE,
  MIN_NAME_PT,
  PAGE_MM,
  SHEET_MM,
  badgeLayout,
  estimateLines,
  nameFontPt,
  pageCount,
  paginate,
  qrModuleMm,
  quietZoneModules
} from '../src/client/admin/BadgeSheetLayout';

/** A long but realistic pass link: https origin + `/p/` + 43-character token. */
const PASS_URL = `https://tickets.gatepass-events.example.org/p/${'A'.repeat(43)}`;
/** Modules across the code the renderer draws (error correction H, as in `src/qr/renderer.ts`). */
const MODULES = QRCode.create(PASS_URL, { errorCorrectionLevel: 'H' }).modules.size;

describe('badge sheet layout', () => {
  it('fits every layout on the printable A4 area', () => {
    expect(SHEET_MM.width).toBe(PAGE_MM.width - 2 * PAGE_MM.margin);
    for (const perPage of BADGES_PER_PAGE) {
      const layout = badgeLayout(perPage);
      expect(layout.columns * layout.rows).toBe(perPage);
      expect(layout.columns * layout.cellWidthMm).toBeCloseTo(SHEET_MM.width);
      expect(layout.rows * layout.cellHeightMm).toBeCloseTo(SHEET_MM.height);
      // The QR plus padding fits the cell in both directions.
      expect(layout.qrMm + 2 * layout.paddingMm).toBeLessThanOrEqual(layout.cellWidthMm);
      expect(layout.qrMm + 2 * layout.paddingMm).toBeLessThanOrEqual(layout.cellHeightMm);
      expect(layout.textWidthMm).toBeGreaterThanOrEqual(40);
    }
  });

  it('8-up cells are about 95 x 69 mm (A4 in a 2 x 4 grid inside 10 mm margins)', () => {
    const layout = badgeLayout(8);
    expect(layout.cellWidthMm).toBeCloseTo(95);
    expect(layout.cellHeightMm).toBeCloseTo(69);
    expect(layout.direction).toBe('row');
  });

  it('prints QR codes large enough to scan: at least 30 mm, modules of at least 0.6 mm, quiet zone of 4+ modules', () => {
    expect(MODULES).toBeGreaterThanOrEqual(45); // a long URL at level H is version 8 or more
    for (const perPage of BADGES_PER_PAGE) {
      const layout = badgeLayout(perPage);
      expect(layout.qrMm).toBeGreaterThanOrEqual(30);
      expect(qrModuleMm(layout, MODULES)).toBeGreaterThanOrEqual(0.6);
      expect(quietZoneModules(layout, MODULES)).toBeGreaterThanOrEqual(4);
    }
  });

  it('counts pages as ceil(passes / perPage) and paginates in order', () => {
    expect(pageCount(10, 8)).toBe(2);
    expect(pageCount(10, 4)).toBe(3);
    expect(pageCount(10, 2)).toBe(5);
    expect(pageCount(10, 1)).toBe(10);
    expect(pageCount(8, 8)).toBe(1);
    const pages = paginate([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4);
    expect(pages).toEqual([[1, 2, 3, 4], [5, 6, 7, 8], [9, 10]]);
    expect(paginate([], 8)).toEqual([]);
  });
});

describe('attendee name sizing', () => {
  it('keeps short names at the layout maximum', () => {
    for (const perPage of BADGES_PER_PAGE) {
      const layout = badgeLayout(perPage);
      expect(nameFontPt('Ada Lovelace', layout)).toBe(layout.nameMaxPt);
    }
  });

  it('shrinks long names until they fit the name lines, never below 10 pt', () => {
    const name = 'Maximiliana Bartholomew-Featherstonehaugh';
    for (const perPage of BADGES_PER_PAGE) {
      const layout = badgeLayout(perPage);
      const pt = nameFontPt(name, layout);
      expect(pt).toBeGreaterThanOrEqual(MIN_NAME_PT);
      expect(pt).toBeLessThanOrEqual(layout.nameMaxPt);
      expect(estimateLines(name, layout.textWidthMm, pt)).toBeLessThanOrEqual(layout.nameLines);
    }
    expect(nameFontPt(name, badgeLayout(8))).toBeLessThan(badgeLayout(8).nameMaxPt);
  });

  it('floors at 10 pt for names longer than the lines can hold (CSS clamps those with an ellipsis)', () => {
    expect(nameFontPt('x'.repeat(100), badgeLayout(8))).toBe(MIN_NAME_PT);
    expect(nameFontPt('Maximiliana Alexandrina Bartholomew-Featherstonehaugh von Hohenzollern-Sigmaringen', badgeLayout(8))).toBe(MIN_NAME_PT);
  });

  it('wraps at spaces and breaks words longer than a line', () => {
    // 10 pt at 0.6 em is ~2.1 mm per character: 21 characters in 45 mm.
    expect(estimateLines('Ada Lovelace', 45, 10)).toBe(1);
    expect(estimateLines('Ada Lovelace Grace Hopper Alan Turing', 45, 10)).toBe(2);
    expect(estimateLines('y'.repeat(50), 45, 10)).toBe(3);
    expect(estimateLines('Bartholomew-Featherstonehaugh', 45, 10)).toBe(2);
  });
});
