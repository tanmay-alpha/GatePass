import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { REVIEW_SCREENS, SCHEMES, openContext, seedReview, showAt, type ReviewSeed } from './review-fixtures';

/**
 * UI review: every main screen at phone, tablet and desktop widths, in light and dark, must not scroll
 * sideways. `REVIEW_SHOTS=<folder>` also saves full-page screenshots to `docs/screenshots/<folder>/`
 * (e.g. `review-2026-11-pass3/after`, the evidence in docs/ui-review-2026-11.md).
 */
const WIDTHS = [320, 375, 390, 768, 1024, 1280, 1440];
const shots = process.env.REVIEW_SHOTS ? path.resolve('docs/screenshots', process.env.REVIEW_SHOTS) : null;

test.skip(({ browserName }) => browserName !== 'chromium' || Boolean(process.env.E2E_BASE_URL), 'Seeds through the local operator token; layout is checked once, in Chromium.');

let seed: ReviewSeed;
test.beforeAll(async ({}, testInfo) => {
  seed = await seedReview(testInfo);
  if (shots) mkdirSync(shots, { recursive: true });
});

for (const screen of REVIEW_SCREENS) {
  for (const scheme of SCHEMES) {
    test(`${screen.name} (${scheme}) fits every width without sideways scrolling`, async ({ browser }, testInfo) => {
      test.setTimeout(90_000);
      const context = await openContext(browser, testInfo, seed, screen, scheme);
      const page = await context.newPage();
      const overflowing: string[] = [];
      for (const width of screen.widths ?? WIDTHS) {
        await showAt(page, seed, screen, width);
        const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
        if (scrollWidth > innerWidth) overflowing.push(`${width}px: document is ${scrollWidth}px wide`);
        if (shots) await page.screenshot({ path: path.join(shots, `${screen.name}-${scheme}-${width}.png`), fullPage: !screen.viewportShot, animations: 'disabled', caret: 'hide' });
      }
      await context.close();
      expect(overflowing).toEqual([]);
    });
  }
}
