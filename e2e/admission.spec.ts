import { expect, test, type Page } from '@playwright/test';

const ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN ?? 'e2e-admin-token-0123456789abcdef';

/** `datetime-local` value (local time, minute precision) `minutes` from now. */
function localInput(minutes: number): string {
  const date = new Date(Date.now() + minutes * 60_000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible();
}

async function scan(page: Page, code: string) {
  await page.getByPlaceholder('Pass link or code').fill(code);
  await page.getByRole('button', { name: 'Check' }).click();
}

/** The full-screen verdict overlay (a button: tapping it dismisses the result). */
const verdict = (page: Page) => page.getByRole('button', { name: /Tap to dismiss/ });

test('organiser configures gates and a capped policy; door staff see admit, duplicate, wrong gate and full', async ({ page, browser }) => {
  await signIn(page);

  // Event whose window contains "now".
  await page.getByRole('complementary', { name: 'Events' }).getByRole('button', { name: 'New event' }).click();
  await page.getByLabel('Name').fill('E2E Launch');
  await page.getByLabel('Starts').fill(localInput(-60));
  await page.getByLabel('Ends').fill(localInput(300));
  await page.getByRole('button', { name: 'Create event' }).click();
  await expect(page.getByRole('heading', { name: 'E2E Launch', level: 1 })).toBeVisible();

  // Gates, a policy limited to North with capacity 1, and two scanner devices.
  await page.getByRole('tab', { name: 'Access' }).click();
  for (const gate of ['North', 'South']) {
    await page.getByPlaceholder('Gate name, e.g. North entrance').fill(gate);
    await page.getByRole('button', { name: 'Add gate' }).click();
    await expect(page.getByText(gate, { exact: true }).first()).toBeVisible();
  }
  await page.getByRole('button', { name: /New policy|Add policy/ }).click();
  const policyForm = page.locator('form').filter({ has: page.getByPlaceholder('e.g. VIP, Early entry') });
  await policyForm.getByLabel('Name').fill('VIP');
  await policyForm.getByLabel('Capacity').fill('1');
  await policyForm.getByLabel('North').check();
  await policyForm.getByRole('button', { name: /Create|Save/ }).click();
  await expect(page.getByText('VIP', { exact: true }).first()).toBeVisible();

  const setupLinks: Record<string, string> = {};
  for (const [label, gate] of [['North phone', 'North'], ['South phone', 'South']] as const) {
    await page.getByLabel('Device label').fill(label);
    await page.getByRole('combobox', { name: 'Gate' }).selectOption({ label: gate });
    await page.getByRole('button', { name: /Add scanner|Add device/ }).click();
    const setup = page.getByRole('region', { name: `Setup for ${label}` });
    setupLinks[label] = await setup.getByLabel('Setup link').inputValue();
    await setup.getByRole('button', { name: 'Done' }).click();
  }

  // Issue two VIP passes; tokens are only in this response.
  await page.getByRole('tab', { name: 'Passes' }).click();
  await page.getByLabel('Attendees').fill('Ada Lovelace, ada@example.com\nGrace Hopper');
  await page.getByLabel('Admission policy').selectOption({ label: 'VIP' });
  const issued = page.waitForResponse((response) => response.url().endsWith('/passes') && response.request().method() === 'POST');
  await page.getByRole('button', { name: /^Issue \d+ passes?$/ }).click();
  const passes = (await (await issued).json()) as Array<{ passUrl: string; attendeeName: string }>;
  expect(passes).toHaveLength(2);
  await expect(page.getByText('2 passes ready')).toBeVisible();

  // The attendee page shows the pass and does not redeem it.
  const attendee = await browser.newPage();
  await attendee.goto(passes[0].passUrl);
  await expect(attendee.getByRole('status')).toHaveText(/^Valid/);
  await attendee.close();

  // Door staff on phones.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const south = await phone.newPage();
  await south.goto(setupLinks['South phone']);
  await expect(south.getByText('South phone')).toBeVisible();
  expect(south.url()).not.toContain('key='); // key removed from the address bar
  await scan(south, passes[0].passUrl);
  await expect(verdict(south)).toContainText('Use gate: North');

  const north = await phone.newPage();
  await north.goto(setupLinks['North phone']);
  await expect(north.getByText('North phone')).toBeVisible();
  await scan(north, passes[0].passUrl);
  await expect(verdict(north)).toHaveAccessibleName('Admit. Tap to dismiss.');
  await expect(verdict(north)).toContainText('Ada Lovelace');

  await verdict(north).click();
  await scan(north, passes[0].passUrl);
  await expect(verdict(north)).toHaveAccessibleName('Already used. Tap to dismiss.');

  await verdict(north).click();
  await scan(north, passes[1].passUrl);
  await expect(verdict(north)).toHaveAccessibleName('Denied. Tap to dismiss.');
  await expect(verdict(north)).toContainText('VIP is full (1)');

  await verdict(north).click();
  await scan(north, 'https://elsewhere.example/p/' + 'Z'.repeat(43));
  await expect(verdict(north)).toContainText('Not a valid pass for this event.');
  await phone.close();

  // Operations dashboard reflects the scans.
  await page.getByRole('tab', { name: 'Operations' }).click();
  await expect(page.getByText('Possible shared screenshot', { exact: false }).or(page.getByText(/presented .* more times/))).toHaveCount(0);
  await expect(page.locator('main')).toContainText('North');
  await expect(page.locator('main')).toContainText('1 of 1');
});

test('revoked passes and revoked scanner devices are refused at the door', async ({ page, request }) => {
  const headers = { Authorization: `Bearer ${ADMIN_TOKEN}` };
  const now = Date.now();
  const event = await (
    await request.post('/api/events', { headers, data: { name: 'E2E Revocation', startsAt: new Date(now - 3_600_000).toISOString(), endsAt: new Date(now + 3_600_000).toISOString() } })
  ).json();
  const [pass] = await (await request.post(`/api/events/${event.id}/passes`, { headers, data: { count: 1 } })).json();
  const scanner = await (await request.post(`/api/events/${event.id}/scanners`, { headers, data: { label: 'Gate phone' } })).json();
  await request.post(`/api/passes/${pass.id}/revoke`, { headers });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/scan#key=${scanner.key}`);
  await expect(page.getByText('Gate phone')).toBeVisible();
  await scan(page, pass.passUrl);
  await expect(verdict(page)).toContainText('This pass was revoked by the organiser.');

  await request.post(`/api/scanners/${scanner.scanner.id}/revoke`, { headers });
  await verdict(page).click();
  await scan(page, pass.passUrl);
  await expect(page.getByLabel('Scanner key')).toBeVisible();
  await expect(page.getByText(/revoked/i).first()).toBeVisible();
});

test('expired passes are refused once their expiry passes, and the pass page says so', async ({ page, request }) => {
  test.setTimeout(150_000);
  const headers = { Authorization: `Bearer ${ADMIN_TOKEN}` };
  const now = Date.now();
  const created = await request.post('/api/events', { headers, data: { name: 'E2E Expiry', startsAt: new Date(now - 3_600_000).toISOString(), endsAt: new Date(now + 3_600_000).toISOString() } });
  const event = await created.json();
  // The server decides expiry, so use its clock (Date header) rather than this machine's.
  const skew = new Date(created.headers()['date']).getTime() - Date.now();
  const expiresAt = Date.now() + skew + 20_000;
  const [pass] = await (await request.post(`/api/events/${event.id}/passes`, { headers, data: { count: 1, expiresAt: new Date(expiresAt).toISOString() } })).json();
  const scanner = await (await request.post(`/api/events/${event.id}/scanners`, { headers, data: { label: 'Expiry phone' } })).json();

  await page.goto(pass.passUrl);
  await expect(page.getByRole('status')).toHaveText(/^Valid/);
  await page.waitForTimeout(Math.max(0, expiresAt - skew + 2_000 - Date.now())); // Date header has 1 s resolution
  await page.reload();
  await expect(page.getByRole('status')).toHaveText(/expired/);

  const result = await request.post('/api/scanner/redeem', { headers: { Authorization: `Bearer ${scanner.key}` }, data: { code: pass.passUrl } });
  expect((await result.json()).outcome).toBe('expired');
});
