import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { localInput, signUp } from './support';

/**
 * Printable A4 badge sheets: real PDFs from Chromium's print pipeline, page breaks per
 * sheet, and every QR decoded from a print-media rasterisation at 150 dpi.
 * `UPDATE_BADGE_SAMPLES=1` also copies the sample PDFs and PNGs to docs/screenshots/badges/.
 */

const DPI = 150;
const PT_PX = 96 / 72;
const MM_PX = 96 / 25.4;
// One CSS pixel = 1/96 inch, so this device scale rasterises print-size content at DPI.
test.use({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: DPI / 96 });

const LONG_NAME = 'Maximiliana Bartholomew-Featherstonehaugh';
/** Longer than three lines can hold at 8-up even at 10 pt: clamped, never overflowing. */
const CLAMPED_NAME = 'Maximiliana Alexandrina Bartholomew-Featherstonehaugh von Hohenzollern-Sigmaringen';
const NAMES = ['Ada Lovelace', 'Grace Hopper', LONG_NAME, 'Alan Turing', 'Katherine Johnson', 'Edsger Dijkstra', 'Barbara Liskov', 'Donald Knuth', 'Margaret Hamilton', CLAMPED_NAME];

const SAMPLES_DIR = path.resolve('docs/screenshots/badges');

test.beforeAll(async () => {
  const bytes = readFileSync(createRequire(import.meta.url).resolve('zxing-wasm/reader/zxing_reader.wasm'));
  await prepareZXingModule({
    overrides: { wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
    fireImmediately: true
  });
});

async function decodeQrs(png: Buffer): Promise<string[]> {
  const results = await readBarcodes(new Uint8Array(png), { formats: ['QRCode'], maxNumberOfSymbols: 16, tryHarder: true });
  return results.filter((result) => result.isValid).map((result) => result.text);
}

function pdfPages(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
}

/** Print-media geometry of every badge: name size, clamping and containment. */
async function badgeMetrics(page: Page) {
  return page.locator('.sheet-print .sheet-badge').evaluateAll((badges) =>
    badges.map((badge) => {
      const box = badge.getBoundingClientRect();
      // Parts of the badge drawn outside its cell, with their rectangles, for a readable failure.
      const outside = [...badge.querySelectorAll('.sheet-qr, .sheet-text, .sheet-text > *')].flatMap((element) => {
        const rect = element.getBoundingClientRect();
        const fits = rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5 && rect.top >= box.top - 0.5 && rect.bottom <= box.bottom + 0.5;
        return fits ? [] : [`${element.className} ${JSON.stringify(rect)} in ${JSON.stringify(box)}`];
      });
      const name = badge.querySelector<HTMLElement>('.sheet-name')!;
      const text = badge.querySelector<HTMLElement>('.sheet-text')!;
      const qr = badge.querySelector<HTMLImageElement>('img.sheet-qr');
      return {
        name: name.textContent ?? '',
        namePx: parseFloat(getComputedStyle(name).fontSize),
        nameTruncated: name.scrollHeight > name.clientHeight + 1,
        textOverflows: text.scrollHeight > text.clientHeight + 1 || text.scrollWidth > text.clientWidth + 1,
        outside,
        qrPx: qr?.getBoundingClientRect().width ?? 0,
        qrLoaded: Boolean(qr?.complete && qr.naturalWidth > 0)
      };
    })
  );
}

test('issued passes print as 1/2/4/8-up A4 sheets whose QR codes all decode', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'page.pdf() is Chromium-only');
  test.setTimeout(120_000);

  await signUp(page);
  await page.getByRole('complementary', { name: 'Events' }).getByRole('button', { name: 'New event' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Badge Night 2026');
  await page.getByLabel('Venue (optional)').fill('Main Hall, 1 Example Street');
  await page.getByLabel('Starts').fill(localInput(60));
  await page.getByLabel('Ends').fill(localInput(300));
  await page.getByRole('button', { name: 'Create event' }).click();
  await expect(page.getByRole('heading', { name: 'Badge Night 2026', level: 1 })).toBeVisible();

  await page.getByRole('tab', { name: 'Access' }).click();
  await page.getByRole('button', { name: 'New policy' }).click();
  const policyForm = page.locator('form').filter({ has: page.getByPlaceholder('e.g. VIP, Early entry') });
  await policyForm.getByLabel('Name').fill('VIP');
  await policyForm.getByRole('button', { name: 'Create policy' }).click();
  await expect(page.getByText('VIP', { exact: true }).first()).toBeVisible();

  // Tokens exist only in this issuance response and the page's memory.
  await page.getByRole('tab', { name: 'Passes' }).click();
  await page.getByLabel('Attendees').fill(NAMES.join('\n'));
  await page.getByLabel('Admission policy').selectOption({ label: 'VIP' });
  const response = page.waitForResponse((res) => res.url().endsWith('/passes') && res.request().method() === 'POST');
  await page.getByRole('button', { name: /^Issue \d+ passes?$/ }).click();
  const passes = (await (await response).json()) as Array<{ passUrl: string; attendeeName: string }>;
  expect(passes).toHaveLength(NAMES.length);
  const passUrls = passes.map((pass) => pass.passUrl).sort();

  await page.getByRole('button', { name: 'Print passes' }).click();
  const preview = page.getByRole('region', { name: 'Print preview' });
  await expect(preview.getByRole('button', { name: 'Print', exact: true })).toBeEnabled({ timeout: 20_000 });

  const samples = new Map<string, Buffer>();

  for (const perPage of [8, 4, 2, 1] as const) {
    const pages = Math.ceil(passes.length / perPage);
    await page.emulateMedia({ media: 'screen' });
    await preview.getByRole('radio', { name: `${perPage} per page` }).click();
    await expect(preview.getByRole('status')).toContainText(`${pages} A4 page${pages === 1 ? '' : 's'}, ${perPage} per page`);
    await expect(preview.getByText(`Page 1 of ${pages}`)).toBeVisible();
    if (perPage === 8) samples.set('preview-8up.png', await preview.screenshot());

    await page.emulateMedia({ media: 'print' });
    const sheets = page.locator('.sheet-print .sheet-page');
    await expect(sheets).toHaveCount(pages);
    await expect(page.locator('#root')).toBeHidden();

    const metrics = await badgeMetrics(page);
    expect(metrics.map((badge) => badge.name)).toEqual(NAMES);
    for (const badge of metrics) {
      expect(badge.qrLoaded, badge.name).toBe(true);
      expect(badge.qrPx / MM_PX, `QR size for ${badge.name}`).toBeGreaterThanOrEqual(30);
      expect(badge.namePx, `name size for ${badge.name}`).toBeGreaterThanOrEqual(10 * PT_PX - 0.01);
      expect(badge.outside, `${badge.name} stays inside its badge`).toEqual([]);
      expect(badge.textOverflows, `${badge.name} text column overflow`).toBe(false);
      if (badge.name !== CLAMPED_NAME) expect(badge.nameTruncated, `${badge.name} shown in full`).toBe(false);
    }

    // The real print pipeline: one PDF page per sheet.
    const pdf = await page.pdf({ format: 'A4', preferCSSPageSize: true, printBackground: true });
    expect(pdfPages(pdf), `${perPage}-up PDF pages`).toBe(pages);
    if (perPage !== 1) samples.set(`badges-${perPage}up.pdf`, pdf);

    // Every sheet rasterised at 150 dpi; every QR on it must decode to an issued pass link.
    const decoded: string[] = [];
    for (let index = 0; index < pages; index++) {
      const png = await sheets.nth(index).screenshot();
      if (index === 0) samples.set(`badges-${perPage}up-page1.png`, png);
      const codes = await decodeQrs(png);
      expect(codes, `${perPage}-up sheet ${index + 1}`).toHaveLength(Math.min(perPage, passes.length - index * perPage));
      decoded.push(...codes);
    }
    expect(decoded.sort()).toEqual(passUrls);
  }

  if (process.env.UPDATE_BADGE_SAMPLES === '1') {
    mkdirSync(SAMPLES_DIR, { recursive: true });
    for (const [name, data] of samples) writeFileSync(path.join(SAMPLES_DIR, name), data);
  }
});
