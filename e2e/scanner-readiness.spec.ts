import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test as base, expect, type BrowserContext, type BrowserContextOptions, type Page } from '@playwright/test';
import QRCode from 'qrcode';
import { CSRF, signUp } from './support';

// Scanner readiness (checklist + camera test code) and door assistance (find
// attendee → admit through redeem). Browser emulation only: Chromium's fake
// camera plays a generated video of the test code. This is not verification
// on a physical phone or camera.

/** One organizer per worker; every test's context starts with that session (sign-up is rate-limited). */
const test = base.extend<object, { organizer: BrowserContextOptions['storageState'] }>({
  organizer: [
    async ({ browser }, use, workerInfo) => {
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

const TEST_CODE = 'gatepass:diagnostic:v1:e2e-camera-test-0001';

interface Door {
  eventId: string;
  passes: Array<{ id: string; attendeeName: string }>;
}

/** An open event with two named passes and one device, set up through the API; the page opens the device's setup link at phone size. */
async function openDoor(page: Page): Promise<Door> {
  const api = page.request;
  const now = Date.now();
  const event = await (
    await api.post('/api/events', {
      headers: CSRF,
      data: { name: 'E2E Readiness', status: 'active', startsAt: new Date(now - 3_600_000).toISOString(), endsAt: new Date(now + 3_600_000).toISOString() }
    })
  ).json();
  const passes = await (
    await api.post(`/api/events/${event.id}/passes`, {
      headers: CSRF,
      data: { attendees: [{ name: 'Ada Lovelace', email: 'ada@example.org' }, { name: 'Grace Hopper', email: 'grace@example.org' }] }
    })
  ).json();
  const scanner = await (await api.post(`/api/events/${event.id}/scanners`, { headers: CSRF, data: { label: 'Door phone' } })).json();
  if (!page.viewportSize() || page.viewportSize()!.width > 600) await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/scan${new URL(scanner.enrollment.url).hash}`);
  await expect(page.getByRole('heading', { name: 'Before you scan' })).toBeVisible();
  return { eventId: event.id, passes };
}

/** Every redeem body sent by any page or worker of the context. */
function redeemBodies(context: BrowserContext): Array<{ code: string; requestId: string }> {
  const bodies: Array<{ code: string; requestId: string }> = [];
  context.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/scanner/redeem') bodies.push(request.postDataJSON());
  });
  return bodies;
}

/** Every request whose URL or body carries the camera test code. */
function testCodeRequests(context: BrowserContext): string[] {
  const seen: string[] = [];
  context.on('request', (request) => {
    if (`${request.url()} ${request.postData() ?? ''}`.includes('gatepass:diagnostic')) seen.push(request.url());
  });
  return seen;
}

const check = (page: Page, id: string) => page.locator(`[data-check="${id}"]`);
const verdict = (page: Page) => page.getByRole('alertdialog');

async function scans(page: Page, eventId: string): Promise<Array<[string | null, string]>> {
  const rows: Array<{ passId: string | null; outcome: string }> = await (await page.request.get(`/api/events/${eventId}/scans`)).json();
  return rows.map((row) => [row.passId, row.outcome]);
}

/** A 640x480 Y4M clip of the test code (white quiet zone, 10 px modules) for Chromium's fake camera. */
function testCodeVideo(payload: string): string {
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
  const width = 640;
  const height = 480;
  const scale = 10;
  const quiet = 4;
  const side = (qr.modules.size + 2 * quiet) * scale;
  const left = Math.floor((width - side) / 2);
  const top = Math.floor((height - side) / 2);
  const luma = Buffer.alloc(width * height, 235);
  for (let row = 0; row < qr.modules.size; row++) {
    for (let col = 0; col < qr.modules.size; col++) {
      if (!qr.modules.get(row, col)) continue;
      for (let y = 0; y < scale; y++) luma.fill(16, (top + (row + quiet) * scale + y) * width + left + (col + quiet) * scale, (top + (row + quiet) * scale + y) * width + left + (col + quiet + 1) * scale);
    }
  }
  const chroma = Buffer.alloc((width / 2) * (height / 2) * 2, 128);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), luma, chroma]);
  const file = path.join(tmpdir(), `gatepass-e2e-test-code-${process.pid}.y4m`);
  writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420jpeg\n`), frame, frame]));
  return file;
}

test('the checklist shows the device state with guidance and reopens from the header; a typed test code is never sent', async ({ page, context }) => {
  const sent = redeemBodies(context);
  const leaked = testCodeRequests(context);
  const door = await openDoor(page);

  await expect(check(page, 'enrolled')).toContainText('Passed');
  await expect(check(page, 'assignment')).toContainText('E2E Readiness — admits at every gate.');
  await expect(check(page, 'server')).toContainText(/Reachable, \d+ ms round trip\./);
  await expect(check(page, 'window')).toContainText('Accepting entry until');
  await expect(check(page, 'diagnostic')).toContainText('To do');
  await expect(check(page, 'diagnostic')).toContainText('Camera test code');
  await expect(page.locator('.readiness-shell')).toContainText('Server verificationAvailable');

  // Typed or pasted, a test code stays on the device too.
  await page.getByPlaceholder('Pass link or code').fill(TEST_CODE);
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Camera test code read' })).toBeVisible();
  await expect(verdict(page)).toHaveCount(0);

  await page.getByRole('button', { name: 'Start scanning anyway' }).click();
  await expect(page.getByRole('heading', { name: 'Before you scan' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Before you scan' }).click();
  await expect(page.getByRole('heading', { name: 'Before you scan' })).toBeVisible();
  await expect(check(page, 'server')).toContainText('Reachable');

  expect(sent).toEqual([]);
  expect(leaked).toEqual([]);
  expect(await scans(page, door.eventId)).toEqual([]);
});

test('find attendee: admit by reference goes through redeem once; a second admit from a stale list is Already used', async ({ page, context }) => {
  const sent = redeemBodies(context);
  const door = await openDoor(page);
  const grace = door.passes.find((pass) => pass.attendeeName === 'Grace Hopper')!;
  const reference = grace.id.slice(0, 8).toUpperCase();
  // A second door phone with the same key (same storage), whose list was loaded before the admission.
  const other = await context.newPage();
  await other.goto('/scan');
  await expect(other.getByRole('heading', { name: 'Before you scan' })).toBeVisible();

  const match = (p: Page) => p.getByRole('list', { name: 'Matches for Grace' }).getByRole('listitem').filter({ hasText: 'Grace Hopper' });
  for (const p of [page, other]) {
    const input = p.getByPlaceholder('Name, reference or email');
    await input.fill('Gr');
    await expect(p.getByRole('button', { name: 'Search' })).toBeDisabled();
    await input.fill('Grace');
    await p.getByRole('button', { name: 'Search' }).click();
    await expect(match(p)).toContainText('Valid');
    await expect(match(p)).toContainText(reference);
    await expect(match(p)).toContainText('g***@e***.org');
    await expect(match(p)).not.toContainText('grace@example.org');
  }

  await match(page).getByRole('button', { name: 'Admit Grace Hopper' }).click();
  await page.getByRole('dialog', { name: 'Admit Grace Hopper?' }).getByRole('button', { name: 'Yes, admit' }).click();
  await expect(verdict(page)).toHaveAccessibleName('Admit');
  await expect(verdict(page)).toContainText('Grace Hopper');
  expect(sent).toEqual([{ code: reference, requestId: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/) }]);
  // The list refreshes from the server: used, and no way to admit again.
  await expect(verdict(page)).toHaveCount(0);
  await expect(match(page)).toContainText('Used');
  await expect(match(page)).toContainText('Do not admit again');
  await expect(match(page).getByRole('button', { name: /^Admit/ })).toHaveCount(0);

  await other.bringToFront();
  await match(other).getByRole('button', { name: 'Admit Grace Hopper' }).click();
  await other.getByRole('dialog', { name: 'Admit Grace Hopper?' }).getByRole('button', { name: 'Yes, admit' }).click();
  await expect(verdict(other)).toHaveAccessibleName('Already used');
  expect(sent).toHaveLength(2);
  expect(sent[1].code).toBe(reference);
  expect(sent[1].requestId).not.toBe(sent[0].requestId);

  // Both attempts are ordinary scans in the event's feed: one admission, one refusal.
  expect(await scans(page, door.eventId)).toEqual([
    [grace.id, 'already_redeemed'],
    [grace.id, 'admitted']
  ]);
});

test('camera test: the fake camera shows the test code, the device reads it locally and sends nothing to redeem', async ({ playwright, browserName, organizer }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Fake camera capture from a file is a Chromium feature');
  const video = testCodeVideo(TEST_CODE);
  const browser = await playwright.chromium.launch({
    headless: testInfo.project.use.headless ?? true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`]
  });
  try {
    const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, extraHTTPHeaders, baseURL } = testInfo.project.use;
    const context = await browser.newContext({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, extraHTTPHeaders, baseURL, storageState: organizer, permissions: ['camera'] });
    const sent = redeemBodies(context);
    const leaked = testCodeRequests(context);
    const page = await context.newPage();
    const door = await openDoor(page);

    await page.getByRole('button', { name: 'Test camera' }).click();
    await expect(page.getByLabel('Camera view')).toBeVisible();
    await expect(check(page, 'diagnostic')).toContainText('Passed', { timeout: 20_000 });
    await expect(check(page, 'diagnostic')).toContainText('Nothing was sent to the server');
    await expect(check(page, 'camera')).toContainText('Passed');
    await expect(page.getByRole('button', { name: 'Start scanning' })).toBeVisible();

    // Scanning: the same code in front of the camera is still only a test code.
    await page.getByRole('button', { name: 'Start scanning' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Camera test code read' })).toBeVisible({ timeout: 10_000 });
    await expect(verdict(page)).toHaveCount(0);

    expect(sent).toEqual([]);
    expect(leaked).toEqual([]);
    expect(await scans(page, door.eventId)).toEqual([]);
    await context.close();
  } finally {
    await browser.close();
    rmSync(video, { force: true });
  }
});

test.describe('installable scanner (service worker allowed)', () => {
  test.use({ serviceWorkers: 'allow' });

  test('caches the app shell only; offline, the app opens and says server verification is unavailable', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'Offline start from the service worker is checked in Chromium');
    const sent = redeemBodies(context);
    await openDoor(page);
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
    expect(await (await page.request.get('/manifest.webmanifest')).json()).toMatchObject({ start_url: '/scan', scope: '/scan' });

    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? '')).toMatch(/\/sw\.js$/);
    await expect(page.locator('.readiness-shell')).toContainText('Loaded · opens offline');
    const cachedPaths = () =>
      page.evaluate(async () => {
        const paths: string[] = [];
        for (const name of await caches.keys()) for (const entry of await (await caches.open(name)).keys()) paths.push(new URL(entry.url).pathname);
        return paths;
      });
    await expect.poll(cachedPaths).toContain('/scan');
    const cached = await cachedPaths();
    expect(cached.some((p) => /^\/assets\/.+\.js$/.test(p))).toBe(true);
    expect(cached.filter((p) => p.startsWith('/api') || p.startsWith('/p/'))).toEqual([]);

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByText('App loaded (offline copy). Server verification unavailable')).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(sent).toEqual([]);
    await context.setOffline(false);
  });
});
