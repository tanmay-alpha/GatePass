import { expect, test } from '@playwright/test';
import { localInput, signUp } from './support';

test('a first-time organiser is guided from a new event to "Ready for doors"', async ({ page }) => {
  await signUp(page);
  await page.getByRole('complementary', { name: 'Events' }).getByRole('button', { name: 'New event' }).click();

  // Inline validation before anything is sent to the server.
  await page.getByLabel('Name', { exact: true }).fill('E2E Onboarding');
  await page.getByLabel('Starts').fill(localInput(60));
  await page.getByLabel('Ends').fill(localInput(30));
  await page.getByRole('button', { name: 'Create event' }).click();
  await expect(page.getByText('The event must end after it starts.')).toBeVisible();
  await page.getByLabel('Ends').fill(localInput(240));
  await page.getByRole('button', { name: 'Create event' }).click();

  // New events start as drafts: scanners refuse every pass until the event is opened.
  await expect(page.getByRole('heading', { name: 'E2E Onboarding', level: 1 })).toBeVisible();
  const setup = page.getByRole('region', { name: 'Set up this event' });
  await expect(setup).toBeVisible();
  await expect(setup).toContainText('1 of 7');

  // Single-door event with general admission: skip the optional steps.
  await setup.getByRole('button', { name: 'Skip gates' }).click();
  await setup.getByRole('button', { name: 'Skip admission rules' }).click();
  await expect(setup).toContainText('3 of 7');

  await setup.getByRole('button', { name: 'Issue passes' }).click();
  await expect(page.getByLabel('Attendees')).toBeFocused();
  await page.getByLabel('Attendees').fill('Ada Lovelace\nGrace Hopper');
  await page.getByRole('button', { name: /^Issue \d+ passes?$/ }).click();
  await expect(page.getByText('2 passes ready')).toBeVisible();
  await expect(setup).toContainText('4 of 7');

  await setup.getByRole('button', { name: 'Set up a scanner' }).click();
  await expect(page.getByLabel('Device label')).toBeFocused();
  await page.getByLabel('Device label').fill('Front door phone');
  await page.getByRole('button', { name: 'Add device' }).click();
  await expect(page.getByRole('region', { name: 'Setup for Front door phone' })).toBeVisible();
  await expect(setup).toContainText('5 of 7');

  // Passes and a scanner are not enough while the event is a draft: open it.
  await setup.getByRole('button', { name: 'Open the event' }).click();
  const open = page.locator('#status-to-active');
  await expect(open).toBeFocused();
  await open.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Open the event' }).click();

  await expect(page.getByRole('region', { name: 'Ready for doors' })).toBeVisible();
});
