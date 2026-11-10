import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { parseCsv } from '../src/client/csv';
import { PASSWORD, createEvent, signUp, uniqueEmail } from './support';

test('owner invites a manager who can issue passes but not manage the team or export', async ({ page, browser }) => {
  const owner = await signUp(page, 'Olivia Owner');
  await createEvent(page, 'E2E Team Event', { active: true });

  // Invite: the link is shown once in a dialog; no email is sent.
  await page.getByRole('tab', { name: 'Team' }).click();
  const managerEmail = uniqueEmail('manager');
  await page.getByLabel('Manager email').fill(managerEmail);
  await page.getByRole('button', { name: 'Create invitation' }).click();
  const invite = page.getByRole('dialog', { name: `Invitation for ${managerEmail}` });
  const link = await invite.getByLabel('Invitation link').inputValue();
  expect(link).toContain('#/invite/');
  await invite.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('row', { name: new RegExp(managerEmail) })).toContainText('Pending');

  // The manager accepts in a separate browser (no shared cookies) by creating an account.
  const managerContext = await browser.newContext();
  const manager = await managerContext.newPage();
  await manager.goto(link);
  await expect(manager.getByRole('heading', { name: 'Join E2E Team Event' })).toBeVisible();
  await manager.getByLabel('Your name').fill('Max Manager');
  await manager.getByLabel('Choose a password').fill(PASSWORD);
  await manager.getByRole('button', { name: 'Create account and accept' }).click();
  await expect(manager.getByRole('heading', { name: 'E2E Team Event', level: 1 })).toBeVisible();
  await expect(manager.getByText('Your role:').first()).toContainText('Manager');

  // Managers issue passes…
  await manager.getByRole('tab', { name: 'Passes' }).click();
  await manager.getByLabel('Attendees').fill('Grace Hopper, grace@example.com');
  await manager.getByRole('button', { name: 'Issue 1 pass' }).click();
  await expect(manager.getByText('1 pass ready')).toBeVisible();
  // …but cannot export attendee data…
  await expect(manager.getByRole('button', { name: /Export attendance/ })).toHaveCount(0);
  await manager.getByRole('tab', { name: 'Operations' }).click();
  await expect(manager.getByRole('group', { name: 'Exports' })).toHaveCount(0);
  // …or manage the team, which they can still see.
  await manager.getByRole('tab', { name: 'Team' }).click();
  await expect(manager.getByRole('row', { name: new RegExp(owner.email) })).toContainText('Owner');
  await expect(manager.getByText('Only the owner can invite or remove managers.')).toBeVisible();
  await expect(manager.getByLabel('Manager email')).toHaveCount(0);
  await expect(manager.getByRole('button', { name: /Remove|Make .* the owner/ })).toHaveCount(0);

  // Sign out returns to the sign-in screen, and the session is gone on reload.
  await manager.getByRole('button', { name: 'Max Manager' }).click();
  await manager.getByRole('button', { name: 'Sign out' }).click();
  await expect(manager.getByRole('heading', { name: 'Sign in to GatePass' })).toBeVisible();
  await manager.reload();
  await expect(manager.getByRole('heading', { name: 'Sign in to GatePass' })).toBeVisible();
  await managerContext.close();

  // The owner sees the manager on the team.
  await page.reload();
  await expect(page.getByRole('row', { name: /Max Manager/ })).toContainText('Manager');
});

test('CSV import previews rejected duplicates, and the attendance export lists the admitted attendee', async ({ page, request }) => {
  await signUp(page);
  await createEvent(page, 'E2E Import Event', { active: true });

  // A door device, so a pass can be admitted.
  await page.getByRole('tab', { name: 'Access' }).click();
  await page.getByLabel('Device label').fill('Import door');
  await page.getByRole('button', { name: 'Add device' }).click();
  const setupLink = await page.getByRole('region', { name: 'Setup for Import door' }).getByLabel('Setup link').inputValue();
  const scannerKey = new URL(setupLink).hash.replace('#key=', '');

  await page.getByRole('tab', { name: 'Passes' }).click();
  await page.getByRole('button', { name: 'Import CSV' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Or paste rows').fill('Name,Email\r\n"Turing, Alan",alan@example.com\r\nAlan again,ALAN@example.com\r\nKatherine Johnson,katherine@example.com\r\n');
  await dialog.getByRole('button', { name: 'Preview import' }).click();
  await expect(dialog.getByText('2 to issue')).toBeVisible();
  const skipped = dialog.getByRole('table', { name: 'Skipped rows' });
  await expect(skipped).toContainText('Duplicate in file');
  await expect(skipped).toContainText('Alan again');

  const imported = page.waitForResponse((response) => response.url().endsWith('/passes/import') && response.request().method() === 'POST' && response.status() === 201);
  await dialog.getByRole('button', { name: 'Issue 2 passes' }).click();
  const report = (await (await imported).json()) as { issued: Array<{ attendeeName: string; passUrl: string }> };
  await expect(page.getByText('2 passes ready')).toBeVisible();
  const alan = report.issued.find((pass) => pass.attendeeName === 'Turing, Alan');
  expect(alan).toBeDefined();

  // Admit Alan at the door (a scanner device has no session cookie).
  const redeemed = await request.post('/api/scanner/redeem', { headers: { Authorization: `Bearer ${scannerKey}` }, data: { code: alan?.passUrl } });
  expect((await redeemed.json()).outcome).toBe('admitted');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export attendance CSV' }).click();
  const file = await (await download).path();
  const [header, ...rows] = parseCsv(await readFile(file, 'utf8'));
  const column = (name: string) => header.indexOf(name);
  const row = rows.find((cells) => cells[column('attendee_name')] === 'Turing, Alan');
  expect(row?.[column('status')]).toBe('redeemed');
  expect(row?.[column('admitted_at')]).toBeTruthy();
});
