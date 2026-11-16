import { test as base, expect, type BrowserContextOptions, type Page } from '@playwright/test';
import { CSRF, signUp } from './support';

// The door must fail closed: whenever the server's verdict does not arrive
// (aborted request, deadline, 5xx, offline), the scanner says "Not verified"
// and never "Admit". Failures are injected with page.route on the redeem
// endpoint; codes are entered by hand (no camera in CI).

const REDEEM = '**/api/scanner/redeem';

/**
 * One organizer per worker (UI sign-up), whose session every test's context
 * starts with: sign-up is rate-limited per address (20 a minute), and each
 * test only needs the session for setup and for reading the server's state.
 */
const test = base.extend<object, { organizer: BrowserContextOptions['storageState'] }>({
  organizer: [
    async ({ browser }, use, workerInfo) => {
      // A worker-scoped context does not inherit the project's `use` options.
      const context = await browser.newContext({ baseURL: workerInfo.project.use.baseURL });
      await signUp(await context.newPage());
      const state = await context.storageState();
      await context.close();
      await use(state);
    },
    { scope: 'worker' }
  ],
  storageState: ({ organizer }, use) => use(organizer)
});

interface Door {
  eventId: string;
  scannerId: string;
  /** The one-time setup link the page was opened with (now used). */
  setupUrl: string;
  passes: Array<{ id: string; passUrl: string; attendeeName: string | null }>;
}

/** An active event with passes and one device for the worker's organizer, set up through the API; the page then opens the device's setup link at phone size. */
async function openDoor(page: Page): Promise<Door> {
  const api = page.request;
  const now = Date.now();
  const event = await (
    await api.post('/api/events', {
      headers: CSRF,
      data: { name: 'E2E Fail-closed', status: 'active', startsAt: new Date(now - 3_600_000).toISOString(), endsAt: new Date(now + 3_600_000).toISOString() }
    })
  ).json();
  const passes = await (await api.post(`/api/events/${event.id}/passes`, { headers: CSRF, data: { attendees: [{ name: 'Ada Lovelace' }, { name: 'Grace Hopper' }] } })).json();
  const scanner = await (await api.post(`/api/events/${event.id}/scanners`, { headers: CSRF, data: { label: 'Door phone' } })).json();
  const setupUrl = `/scan${new URL(scanner.enrollment.url).hash}`;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(setupUrl);
  await expect(page.getByText('Door phone')).toBeVisible();
  return { eventId: event.id, scannerId: scanner.scanner.id, setupUrl, passes };
}

/** Every redeem request the page sends (including ones the route then aborts). */
function redeemRequests(page: Page): Array<{ code: string; requestId: string }> {
  const bodies: Array<{ code: string; requestId: string }> = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/scanner/redeem') bodies.push(request.postDataJSON());
  });
  return bodies;
}

async function scan(page: Page, code: string) {
  await page.getByPlaceholder('Pass link or code').fill(code);
  await page.getByRole('button', { name: 'Check' }).click();
}

/** The full-screen verdict overlay; its accessible name is the headline (Admit, Already used, Denied, Not verified). */
const verdict = (page: Page) => page.getByRole('alertdialog');

/** The pass as the server sees it, through the organizer's session (shared with the page's context). */
async function serverStatus(page: Page, door: Door, passId: string): Promise<string> {
  const passes: Array<{ id: string; status: string }> = await (await page.request.get(`/api/events/${door.eventId}/passes`)).json();
  return passes.find((pass) => pass.id === passId)!.status;
}

test('an aborted request is Not verified, never Admit; Retry verification reuses the requestId and admits once', async ({ page }) => {
  const door = await openDoor(page);
  const sent = redeemRequests(page);
  await page.route(REDEEM, (route) => route.abort('failed'));

  await scan(page, door.passes[0].passUrl);
  await expect(verdict(page)).toHaveAccessibleName('Not verified');
  await expect(verdict(page)).toContainText('No connection to the server. Do not admit.');
  await expect(page.getByRole('alertdialog', { name: 'Admit' })).toHaveCount(0);
  expect(await serverStatus(page, door, door.passes[0].id)).toBe('active');

  await page.unroute(REDEEM);
  await verdict(page).getByRole('button', { name: 'Retry verification' }).click();
  await expect(verdict(page)).toHaveAccessibleName('Admit');
  await expect(verdict(page)).toContainText('Ada Lovelace');
  // The first attempt never reached the server, so this is a first judgement, not a replay.
  await expect(verdict(page)).not.toContainText('Confirmed after reconnect');
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(await serverStatus(page, door, door.passes[0].id)).toBe('redeemed');
});

test('a request that outlasts the 12 s deadline shows the slow notice, then Not verified', async ({ page }) => {
  // Fake page timers (time still flows) so the 12 s client deadline can be crossed without waiting for it.
  await page.clock.install();
  const door = await openDoor(page);
  // Swallow the request: no answer ever comes back.
  await page.route(REDEEM, () => {});

  await scan(page, door.passes[0].passUrl);
  await expect(page.getByRole('button', { name: /^Checking…/ })).toBeDisabled();
  await page.clock.fastForward(2_000);
  await expect(page.getByRole('status').filter({ hasText: 'Checking… slow connection' })).toBeVisible();
  await expect(verdict(page)).toHaveCount(0);

  await page.clock.fastForward(10_500); // 12.5 s in total
  await expect(verdict(page)).toHaveAccessibleName('Not verified');
  await expect(verdict(page)).toContainText('No response from the server. Do not admit.');
  await expect(verdict(page).getByRole('button', { name: 'Retry verification' })).toBeVisible();
  await expect(page.getByRole('alertdialog', { name: 'Admit' })).toHaveCount(0);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  expect(await serverStatus(page, door, door.passes[0].id)).toBe('active');
});

test('a 503 from a busy server is Not verified and offers no retry of the stored verdict; the next scan is judged normally', async ({ page }) => {
  const door = await openDoor(page);
  await page.route(REDEEM, (route) =>
    route.fulfill({ status: 503, headers: { 'Retry-After': '1' }, contentType: 'application/json', body: JSON.stringify({ error: 'The server is busy. Try again.' }) })
  );

  await scan(page, door.passes[0].passUrl);
  await expect(verdict(page)).toHaveAccessibleName('Not verified');
  await expect(verdict(page)).toContainText('Server error. Do not admit; scan again.');
  // An answered failure is not a lost response: there is no stored verdict to retry.
  await expect(verdict(page).getByRole('button', { name: 'Retry verification' })).toHaveCount(0);
  await expect(page.getByRole('alertdialog', { name: 'Admit' })).toHaveCount(0);

  await page.unroute(REDEEM);
  await verdict(page).getByRole('button', { name: 'Scan next' }).click();
  await expect(verdict(page)).toHaveCount(0);
  await scan(page, door.passes[0].passUrl);
  await expect(verdict(page)).toHaveAccessibleName('Admit');
  expect(await serverStatus(page, door, door.passes[0].id)).toBe('redeemed');
});

test('after a lost response, entering the same code again replays the stored verdict: Admit, confirmed after reconnect', async ({ page }) => {
  const door = await openDoor(page);
  const sent = redeemRequests(page);
  let lose = true;
  await page.route(REDEEM, async (route) => {
    if (!lose) return route.continue();
    lose = false;
    const delivered = await route.fetch(); // the server receives the scan and admits…
    expect(delivered.status()).toBe(200);
    await route.abort('connectionreset'); // …but its answer never reaches the phone
  });

  await scan(page, door.passes[0].passUrl);
  await expect(verdict(page)).toHaveAccessibleName('Not verified');
  await expect(page.getByRole('alertdialog', { name: 'Admit' })).toHaveCount(0);
  expect(await serverStatus(page, door, door.passes[0].id)).toBe('redeemed');

  // Staff dismiss the overlay and type the same code again.
  await verdict(page).getByRole('button', { name: 'Scan next' }).click();
  await scan(page, door.passes[0].passUrl);
  await expect(verdict(page)).toHaveAccessibleName('Admit');
  await expect(verdict(page)).toContainText('Ada Lovelace');
  await expect(verdict(page)).toContainText('Confirmed after reconnect');
  expect(sent).toHaveLength(2);
  expect(sent[1].requestId).toBe(sent[0].requestId);

  // One judgement on the server: the retry was answered from the stored scan.
  const scans: Array<{ passId: string | null; outcome: string }> = await (await page.request.get(`/api/events/${door.eventId}/scans`)).json();
  expect(scans.map((row) => ({ passId: row.passId, outcome: row.outcome }))).toEqual([{ passId: door.passes[0].id, outcome: 'admitted' }]);
});

test('a gateway error after the server admitted is Not verified; the next scan of that code confirms the admission instead of "Already used"', async ({ page }) => {
  const door = await openDoor(page);
  const sent = redeemRequests(page);
  let fail = true;
  await page.route(REDEEM, async (route) => {
    if (!fail) return route.continue();
    fail = false;
    const delivered = await route.fetch(); // the server receives the scan and admits…
    expect(delivered.status()).toBe(200);
    // …but the proxy in front of it answers 504 with its own error page.
    await route.fulfill({ status: 504, contentType: 'text/html', body: '<html><body>Gateway Timeout</body></html>' });
  });

  await scan(page, door.passes[0].passUrl);
  await expect(verdict(page)).toHaveAccessibleName('Not verified');
  await expect(page.getByRole('alertdialog', { name: 'Admit' })).toHaveCount(0);
  expect(await serverStatus(page, door, door.passes[0].id)).toBe('redeemed');

  await verdict(page).getByRole('button', { name: 'Scan next' }).click();
  await scan(page, door.passes[0].passUrl);
  await expect(verdict(page)).toHaveAccessibleName('Admit');
  await expect(verdict(page)).toContainText('Confirmed after reconnect');
  expect(sent[1].requestId).toBe(sent[0].requestId);
});

test('re-opening a used setup link on a working scanner keeps its key: the phone can still scan', async ({ page }) => {
  const door = await openDoor(page);
  await page.goto('about:blank');
  await page.goto(door.setupUrl);

  await page.getByRole('alertdialog', { name: "Replace this scanner's setup?" }).getByRole('button', { name: 'Use the new setup' }).click();
  await expect(page.getByText('this phone keeps its current setup')).toBeVisible();
  await page.getByRole('button', { name: 'Continue with the current setup' }).click();

  await scan(page, door.passes[0].passUrl);
  await expect(verdict(page)).toHaveAccessibleName('Admit');
});

test('a device revoked mid-session is signed out at its next server answer (401), without admitting', async ({ page }) => {
  const door = await openDoor(page);
  await page.route(REDEEM, (route) => route.abort('failed'));
  await scan(page, door.passes[0].passUrl);
  await expect(verdict(page)).toHaveAccessibleName('Not verified');

  // The organizer revokes the device while it waits to retry.
  expect((await page.request.post(`/api/scanners/${door.scannerId}/revoke`, { headers: CSRF })).ok()).toBe(true);
  await page.unroute(REDEEM);
  await verdict(page).getByRole('button', { name: 'Retry verification' }).click();

  await expect(page.getByRole('heading', { name: 'GatePass scanner' })).toBeVisible();
  await expect(page.getByLabel('Setup link or code')).toBeVisible();
  await expect(page.getByText('This device was revoked by the organiser. Ask for a new setup link.')).toBeVisible();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('gatepass.scannerKey'))).toBeNull();
  expect(await serverStatus(page, door, door.passes[0].id)).toBe('active');
  // The key is gone for good: a reload stays on the setup screen.
  await page.reload();
  await expect(page.getByLabel('Setup link or code')).toBeVisible();
});

test('offline, scanning pauses: manual entry cannot submit and nothing is sent; back online the same code is checked', async ({ page }) => {
  const door = await openDoor(page);
  const sent = redeemRequests(page);
  const input = page.getByPlaceholder('Pass link or code');
  const check = page.getByRole('button', { name: 'Check' });

  await page.context().setOffline(true);
  await expect(page.getByRole('alert').filter({ hasText: 'Scanning paused — offline. Do not admit anyone until the connection returns.' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /^Offline$/ })).toBeVisible();
  await input.fill(door.passes[0].passUrl);
  await expect(check).toBeDisabled();
  await input.press('Enter');
  await expect(verdict(page)).toHaveCount(0);
  expect(sent).toEqual([]);

  await page.context().setOffline(false);
  await expect(page.getByRole('alert').filter({ hasText: 'Scanning paused' })).toHaveCount(0);
  await expect(input).toHaveValue(door.passes[0].passUrl);
  await check.click();
  await expect(verdict(page)).toHaveAccessibleName('Admit');
  expect(sent).toHaveLength(1);
});
