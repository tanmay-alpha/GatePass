import { expect, test } from '@playwright/test';
import { CSRF, signUp } from './support';

// Operations tab on event day: the "Assisted admissions" tile counts admissions made through
// "Find attendee" on a door device (and nothing else), and the event-day strip summarises the door.

test('a lookup admission counts as assisted on the dashboard; a typed code does not', async ({ page, context }) => {
  await signUp(page);
  const api = page.request;
  const now = Date.now();
  const event = await (
    await api.post('/api/events', {
      headers: CSRF,
      data: { name: 'E2E Ops Day', status: 'active', startsAt: new Date(now - 3_600_000).toISOString(), endsAt: new Date(now + 3_600_000).toISOString() }
    })
  ).json();
  const passes: Array<{ attendeeName: string; passUrl: string }> = await (
    await api.post(`/api/events/${event.id}/passes`, {
      headers: CSRF,
      data: { attendees: [{ name: 'Ada Lovelace', email: 'ada@example.org' }, { name: 'Grace Hopper', email: 'grace@example.org' }] }
    })
  ).json();
  const scanner = await (await api.post(`/api/events/${event.id}/scanners`, { headers: CSRF, data: { label: 'Door phone' } })).json();

  const door = await context.newPage();
  await door.setViewportSize({ width: 390, height: 844 });
  await door.goto(`/scan${new URL(scanner.enrollment.url).hash}`);
  await expect(door.getByRole('heading', { name: 'Before you scan' })).toBeVisible();

  // Assisted: found by name, admitted after the confirmation.
  await door.getByPlaceholder('Name, reference or email').fill('Grace');
  await door.getByRole('button', { name: 'Search' }).click();
  await door.getByRole('button', { name: 'Admit Grace Hopper' }).click();
  await door.getByRole('dialog', { name: 'Admit Grace Hopper?' }).getByRole('button', { name: 'Yes, admit' }).click();
  await expect(door.getByRole('alertdialog')).toHaveAccessibleName('Admit');
  await expect(door.getByRole('alertdialog')).toHaveCount(0);

  // Not assisted: the pass link typed in.
  await door.getByPlaceholder('Pass link or code').fill(passes.find((pass) => pass.attendeeName === 'Ada Lovelace')!.passUrl);
  await door.getByRole('button', { name: 'Check' }).click();
  await expect(door.getByRole('alertdialog')).toHaveAccessibleName('Admit');
  await door.close();

  await page.goto(`/#/events/${event.id}`);
  const tile = (label: string) => page.locator('.stat').filter({ has: page.locator('.stat-label', { hasText: label }) }).locator('.stat-value');
  await expect(tile('Admitted / issued')).toHaveText('2 / 2');
  await expect(tile('Assisted admissions')).toHaveText('1');

  const strip = page.getByRole('region', { name: 'Event day' });
  const cell = (label: string) => strip.getByRole('listitem').filter({ has: page.locator('.event-day-label', { hasText: label }) });
  // Times follow the browser's locale (12- or 24-hour clock).
  await expect(cell('Doors')).toContainText(/Open until \d{1,2}:\d{2}/);
  await expect(cell('Scanners')).toContainText('1 in use');
  await expect(cell('Last admission')).toContainText(/\d{1,2}:\d{2}( [AP]M)?–\d{1,2}:\d{2}/);
  await expect(cell('Capacity')).toContainText('No event limit');
  // No pass emails were queued, so the strip has no email cell.
  await expect(cell('Pass emails')).toHaveCount(0);
  // The refresh bar says when the figures were taken.
  await expect(page.getByText(/^Updated \d{2}:\d{2}:\d{2}/)).toBeVisible();
});

test('when a refresh fails the last figures stay on screen, marked stale, until a retry succeeds', async ({ page }) => {
  await signUp(page);
  const now = Date.now();
  const event = await (
    await page.request.post('/api/events', {
      headers: CSRF,
      data: { name: 'E2E Ops Stale', status: 'active', startsAt: new Date(now - 3_600_000).toISOString(), endsAt: new Date(now + 3_600_000).toISOString() }
    })
  ).json();
  await page.goto(`/#/events/${event.id}`);
  const strip = page.getByRole('region', { name: 'Event day' });
  await expect(strip).toContainText('None set up');
  await expect(page.getByText(/^Updated /)).toBeVisible();

  await page.route('**/api/events/*/operations', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Service unavailable.' }) }));
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Could not refresh' })).toContainText('Showing data from');
  await expect(page.getByText('Stale', { exact: true })).toBeVisible();
  await expect(strip).toContainText('None set up');

  await page.unroute('**/api/events/*/operations');
  await page.getByRole('button', { name: 'Retry now' }).click();
  await expect(page.getByText('Stale', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
});
