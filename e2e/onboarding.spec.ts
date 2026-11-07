import { expect, test } from '@playwright/test';

const ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN ?? 'e2e-admin-token-0123456789abcdef';

function localInput(minutes: number): string {
  const date = new Date(Date.now() + minutes * 60_000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

test('a first-time organiser is guided from a new event to "Ready for doors"', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('complementary', { name: 'Events' }).getByRole('button', { name: 'New event' }).click();

  // Inline validation before anything is sent to the server.
  await page.getByLabel('Name').fill('E2E Onboarding');
  await page.getByLabel('Starts').fill(localInput(60));
  await page.getByLabel('Ends').fill(localInput(30));
  await page.getByRole('button', { name: 'Create event' }).click();
  await expect(page.getByText('The event must end after it starts.')).toBeVisible();
  await page.getByLabel('Ends').fill(localInput(240));
  await page.getByRole('button', { name: 'Create event' }).click();

  const setup = page.getByRole('region', { name: 'Set up this event' });
  await expect(setup).toBeVisible();
  await expect(setup).toContainText('1 of 6');

  // Single-door event with general admission: skip the optional steps.
  await setup.getByRole('button', { name: 'Skip gates' }).click();
  await setup.getByRole('button', { name: 'Skip admission rules' }).click();
  await expect(setup).toContainText('3 of 6');

  await setup.getByRole('button', { name: 'Issue passes' }).click();
  await expect(page.getByLabel('Attendees')).toBeFocused();
  await page.getByLabel('Attendees').fill('Ada Lovelace\nGrace Hopper');
  await page.getByRole('button', { name: /^Issue \d+ passes?$/ }).click();
  await expect(page.getByText('2 passes ready')).toBeVisible();
  await expect(setup).toContainText('4 of 6');

  await setup.getByRole('button', { name: 'Set up a scanner' }).click();
  await expect(page.getByLabel('Device label')).toBeFocused();
  await page.getByLabel('Device label').fill('Front door phone');
  await page.getByRole('button', { name: 'Add device' }).click();
  await expect(page.getByRole('region', { name: 'Setup for Front door phone' })).toBeVisible();

  await expect(page.getByRole('region', { name: 'Ready for doors' })).toBeVisible();
});
