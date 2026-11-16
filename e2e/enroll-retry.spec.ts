import { test as base, expect, type APIRequestContext, type BrowserContextOptions, type Page, type Route } from '@playwright/test';
import { CSRF, signUp } from './support';

// A setup link is one-time, so a lost enrollment answer must not strand the
// phone: the page keeps the code with a claim secret in localStorage and
// resends the same pair ("Try again", reload), which the server answers with
// a replacement key (ADR 0010). A definitive refusal clears the pending claim,
// and a failed new link never costs a working scanner its key. Lost answers
// are injected by forwarding the request to the server and then aborting it,
// so the server enrolls but the browser never sees the 201.

const ENROLL = '**/api/scanner/enroll';
const PENDING = 'gatepass.pendingEnrollment';
const KEY = 'gatepass.scannerKey';

/** One organizer per worker (sign-up is rate-limited per address); every test's context starts with its session. */
const test = base.extend<object, { organizer: BrowserContextOptions['storageState'] }>({
  organizer: [
    async ({ browser }, use, workerInfo) => {
      // A worker-scoped context does not inherit the project's `use` options.
      const context = await browser.newContext({ baseURL: workerInfo.project.use.baseURL, extraHTTPHeaders: workerInfo.project.use.extraHTTPHeaders });
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
  eventName: string;
  passes: Array<{ id: string; passUrl: string }>;
}

/** An active event with passes for the worker's organizer, through the API. */
async function createDoor(page: Page): Promise<Door> {
  const now = Date.now();
  const eventName = `E2E Enroll retry ${Math.random().toString(36).slice(2, 8)}`;
  const event = await (
    await page.request.post('/api/events', {
      headers: CSRF,
      data: { name: eventName, status: 'active', startsAt: new Date(now - 3_600_000).toISOString(), endsAt: new Date(now + 3_600_000).toISOString() }
    })
  ).json();
  const passes = await (await page.request.post(`/api/events/${event.id}/passes`, { headers: CSRF, data: { attendees: [{ name: 'Ada Lovelace' }, { name: 'Grace Hopper' }] } })).json();
  await page.setViewportSize({ width: 390, height: 844 });
  return { eventId: event.id, eventName, passes };
}

/** A new device for the event; returns its one-time setup link (`/scan#enroll=…`) and code. */
async function addScanner(page: Page, door: Door, label: string): Promise<{ setupUrl: string; code: string }> {
  const scanner = await (await page.request.post(`/api/events/${door.eventId}/scanners`, { headers: CSRF, data: { label } })).json();
  const hash = new URL(scanner.enrollment.url).hash;
  return { setupUrl: `/scan${hash}`, code: hash.replace('#enroll=', '') };
}

/** Every enroll request body the page sends, including ones a route then aborts. */
function enrollRequests(page: Page): Array<{ code: string; claim: string }> {
  const bodies: Array<{ code: string; claim: string }> = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/scanner/enroll') bodies.push(request.postDataJSON());
  });
  return bodies;
}

/** Forwards each enroll request to the server, records the key it issued, then aborts so the page never sees the answer. */
async function loseEnrollAnswers(page: Page): Promise<string[]> {
  const issued: string[] = [];
  await page.route(ENROLL, async (route: Route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    issued.push((await response.json()).key);
    await route.abort('failed');
  });
  return issued;
}

const pending = (page: Page) => page.evaluate((name) => localStorage.getItem(name), PENDING);
const storedKey = (page: Page) => page.evaluate((name) => localStorage.getItem(name), KEY);

/** HTTP status of the scanner session for a key, outside the page (no cookie, so only the bearer counts). */
async function keyStatus(request: APIRequestContext, key: string): Promise<number> {
  return (await request.get('/api/scanner/session', { headers: { Authorization: `Bearer ${key}`, Cookie: '' } })).status();
}

async function scanAdmits(page: Page, passUrl: string) {
  await page.getByPlaceholder('Pass link or code').fill(passUrl);
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByRole('alertdialog')).toHaveAccessibleName('Admit');
}

/** The lost first answer leaves the phone in the retry state with the code and claim stored; returns what was stored. */
async function expectRetryState(page: Page, code: string): Promise<{ code: string; claim: string }> {
  await expect(page.getByText('Trying again is safe.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  // A phone without a key has no current setup to keep.
  await expect(page.getByRole('button', { name: 'Keep the current setup' })).toHaveCount(0);
  const stored = JSON.parse((await pending(page))!);
  expect(stored.code).toBe(code);
  expect(stored.claim).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await storedKey(page)).toBeNull();
  return stored;
}

/** The station is running for the event, the pending claim is gone, the key in use is the replacement and the one lost in transit is dead. */
async function expectRecovered(page: Page, door: Door, label: string, lostKey: string) {
  await expect(page.getByText(label)).toBeVisible();
  await expect(page.getByRole('heading', { name: door.eventName })).toBeVisible();
  expect(await pending(page)).toBeNull();
  const key = (await storedKey(page))!;
  expect(key).toMatch(/^gps_/);
  expect(key).not.toBe(lostKey);
  expect(await keyStatus(page.request, key)).toBe(200);
  expect(await keyStatus(page.request, lostKey)).toBe(401);
  await scanAdmits(page, door.passes[0].passUrl);
}

test('a lost enrollment answer: the phone keeps the code and claim, Try again gets a replacement key that admits', async ({ page }) => {
  const door = await createDoor(page);
  const { setupUrl, code } = await addScanner(page, door, 'Door phone');
  const sent = enrollRequests(page);
  const issued = await loseEnrollAnswers(page);

  await page.goto(setupUrl);
  const stored = await expectRetryState(page, code);
  expect(issued).toHaveLength(1);
  expect(sent).toEqual([stored]);

  await page.unroute(ENROLL);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expectRecovered(page, door, 'Door phone', issued[0]);
  // The retry resent exactly the same code and claim.
  expect(sent).toEqual([stored, stored]);
});

test('a reload after a lost enrollment answer resumes the stored code and enrolls', async ({ page }) => {
  const door = await createDoor(page);
  const { setupUrl, code } = await addScanner(page, door, 'Gate phone');
  const sent = enrollRequests(page);
  const issued = await loseEnrollAnswers(page);

  await page.goto(setupUrl);
  const stored = await expectRetryState(page, code);
  expect(new URL(page.url()).hash).toBe('');

  await page.unroute(ENROLL);
  await page.goto('/scan');
  await expectRecovered(page, door, 'Gate phone', issued[0]);
  expect(sent).toEqual([stored, stored]);
});

test('a link already claimed by another phone is refused, the pending claim is cleared and a reload does not retry', async ({ page, browser }, testInfo) => {
  const door = await createDoor(page);
  const { setupUrl, code } = await addScanner(page, door, 'Contested phone');

  // Another phone opens the link first.
  const other = await browser.newContext({ baseURL: testInfo.project.use.baseURL, extraHTTPHeaders: testInfo.project.use.extraHTTPHeaders, serviceWorkers: 'block' });
  const otherPage = await other.newPage();
  await otherPage.goto(setupUrl);
  await expect(otherPage.getByText('Contested phone')).toBeVisible();
  await other.close();

  const sent = enrollRequests(page);
  await page.goto(setupUrl);
  await expect(page.getByText('This setup link is invalid, expired or already used.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set up this device' })).toBeVisible();
  expect(sent).toHaveLength(1);
  expect(sent[0].code).toBe(code);
  expect(await pending(page)).toBeNull();
  expect(await storedKey(page)).toBeNull();

  await page.goto('/scan');
  await expect(page.getByRole('button', { name: 'Set up this device' })).toBeVisible();
  expect(sent).toHaveLength(1);
  expect(await pending(page)).toBeNull();
});

test('a working scanner whose new setup link loses its answer keeps its current key and still admits', async ({ page }) => {
  const door = await createDoor(page);
  const first = await addScanner(page, door, 'Door phone');
  await page.goto(first.setupUrl);
  await expect(page.getByText('Door phone')).toBeVisible();
  const key = (await storedKey(page))!;
  expect(key).toMatch(/^gps_/);

  // A second link (another device record): the server enrolls it, but the phone never hears back.
  const second = await addScanner(page, door, 'Spare phone');
  const issued = await loseEnrollAnswers(page);
  await page.goto('about:blank');
  await page.goto(second.setupUrl);
  await page.getByRole('alertdialog', { name: "Replace this scanner's setup?" }).getByRole('button', { name: 'Use the new setup' }).click();
  await expect(page.getByText('Trying again is safe.')).toBeVisible();
  expect(issued).toHaveLength(1);
  expect(JSON.parse((await pending(page))!).code).toBe(second.code);
  // The old key stays in place until a new one actually arrives.
  expect(await storedKey(page)).toBe(key);

  await page.unroute(ENROLL);
  await page.getByRole('button', { name: 'Keep the current setup' }).click();
  await expect(page.getByText('Door phone')).toBeVisible();
  expect(await pending(page)).toBeNull();
  expect(await storedKey(page)).toBe(key);
  expect(await keyStatus(page.request, key)).toBe(200);
  await scanAdmits(page, door.passes[0].passUrl);

  // Nothing is resumed after a reload: the discarded claim is gone.
  const sent = enrollRequests(page);
  await page.reload();
  await expect(page.getByText('Door phone')).toBeVisible();
  expect(sent).toHaveLength(0);
});
