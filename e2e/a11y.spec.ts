import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { REVIEW_SCREENS, SCHEMES, openContext, seedReview, showAt, type ReviewSeed } from './review-fixtures';

/**
 * Automated accessibility check (axe-core, WCAG 2.0/2.1 A and AA rules) of every main screen, open menu
 * and dialog, in light and dark, at desktop and phone width. Automated rules catch a subset of problems
 * (contrast, names, roles, landmarks); keyboard behaviour is covered by the behavioural specs.
 */
const WIDTHS = [1280, 375];

test.skip(({ browserName }) => browserName !== 'chromium' || Boolean(process.env.E2E_BASE_URL), 'Seeds through the local operator token; axe runs once, in Chromium.');

let seed: ReviewSeed;
test.beforeAll(async ({}, testInfo) => {
  seed = await seedReview(testInfo);
});

for (const screen of REVIEW_SCREENS) {
  for (const scheme of SCHEMES) {
    test(`${screen.name} (${scheme}) has no WCAG A/AA violations`, async ({ browser }, testInfo) => {
      test.setTimeout(60_000);
      const context = await openContext(browser, testInfo, seed, screen, scheme);
      const page = await context.newPage();
      const found: string[] = [];
      for (const width of screen.widths ?? WIDTHS) {
        await showAt(page, seed, screen, width);
        const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
        for (const violation of violations) {
          const nodes = violation.nodes.map((node) => `    ${node.target.join(' ')}: ${node.failureSummary?.split('\n').slice(1).join(' ') ?? ''}`);
          found.push(`${width}px ${violation.id} (${violation.impact}): ${violation.help}\n${nodes.join('\n')}`);
        }
      }
      await context.close();
      expect(found, found.join('\n')).toEqual([]);
    });
  }
}
