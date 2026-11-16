import { expect, test } from '@playwright/test';
import { createEvent, signUp } from './support';

// One organiser path through the UI end to end: a gate and a capped policy,
// a pass, a device set up from its link on a phone, an admission typed from
// the printed reference, then the dashboard and the attendee's pass page.

test('organiser sets up an event in the UI; a phone admits by the printed reference; dashboard and pass page agree', async ({ page, browser }) => {
  await signUp(page);
  await createEvent(page, 'E2E Journey', { active: true });

  await page.getByRole('tab', { name: 'Access' }).click();
  await page.getByPlaceholder('Gate name, e.g. North entrance').fill('Main');
  await page.getByRole('button', { name: 'Add gate' }).click();
  await expect(page.getByRole('list', { name: 'Gates' })).toContainText('Main');
  await page.getByRole('button', { name: 'New policy' }).click();
  const policyForm = page.locator('form').filter({ has: page.getByPlaceholder('e.g. VIP, Early entry') });
  await policyForm.getByLabel('Name').fill('Members');
  await policyForm.getByLabel('Capacity').fill('5');
  await policyForm.getByLabel('Main').check();
  await policyForm.getByRole('button', { name: 'Create policy' }).click();
  await expect(page.getByRole('region', { name: 'Admission policies' }).getByRole('cell', { name: 'Members', exact: true })).toBeVisible();

  const deviceLabel = page.getByLabel('Device label');
  await page.getByRole('combobox', { name: 'Gate' }).selectOption({ label: 'Main' });
  await deviceLabel.fill('Main door phone');
  await expect(deviceLabel).toHaveValue('Main door phone');
  await page.getByRole('button', { name: 'Add device' }).click();
  const setup = page.getByRole('region', { name: 'Setup for Main door phone' });
  const setupLink = await setup.getByLabel('Setup link').inputValue();
  await setup.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('tab', { name: 'Passes' }).click();
  await page.getByLabel('Attendees').fill('Katherine Johnson, katherine@example.com');
  await page.getByLabel('Admission policy').selectOption({ label: 'Members' });
  const issued = page.waitForResponse((response) => response.url().endsWith('/passes') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Issue 1 pass' }).click();
  const [pass] = (await (await issued).json()) as Array<{ id: string; passUrl: string }>;
  await expect(page.getByText('1 pass ready')).toBeVisible();
  // The 8-character reference printed under the QR code, for manual entry at the door.
  const reference = pass.id.slice(0, 8).toUpperCase();
  await expect(page.getByText(reference, { exact: true }).first()).toBeVisible();

  // Door staff open the setup link on a phone and type the reference in lower case.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const door = await phone.newPage();
  await door.goto(setupLink);
  await expect(door.getByText('Main door phone')).toBeVisible();
  await expect(door.getByText('Gate: Main')).toBeVisible();
  await door.getByPlaceholder('Pass link or code').fill(reference.toLowerCase());
  await door.getByRole('button', { name: 'Check' }).click();
  const result = door.getByRole('alertdialog');
  await expect(result).toHaveAccessibleName('Admit');
  await expect(result).toContainText('Katherine Johnson');

  // The attendee's own pass page now shows the pass as used, with the check-in time.
  const attendee = await phone.newPage();
  await attendee.goto(pass.passUrl);
  await expect(attendee.getByRole('status')).toHaveText(/^Already used\. Checked in /);
  await phone.close();

  // The organiser's operations dashboard counts the admission.
  await page.getByRole('tab', { name: 'Operations' }).click();
  await expect(page.getByText('Admitted / issued', { exact: true }).locator('..')).toContainText('1 / 1');
  await expect(page.getByRole('region', { name: 'Policy capacity' })).toContainText('1/5');
});
