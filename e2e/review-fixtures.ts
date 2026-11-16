import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, request as playwrightRequest, type APIRequestContext, type APIResponse, type Browser, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import { CSRF, PASSWORD, uniqueEmail } from './support';

/** Matches `ADMIN_TOKEN` of the local web server in playwright.config.ts. */
const OPERATOR_TOKEN = 'e2e-admin-token-0123456789abcdef';

/** Signed-in browser states and links for the UI review specs (visual review and accessibility). */
export interface ReviewSeed {
  /** Organizer with two events, gates, passes, scans, devices and a pending invitation. */
  organizer: string;
  /** Organizer with no events (first-run overview). */
  newcomer: string;
  /** Platform administrator. */
  platformAdmin: string;
  eventId: string;
  /** Attendee pass page path (`/p/<token>`). */
  passPath: string;
  /** Pending manager invitation (`/#/invite/<token>`). */
  invitePath: string;
}

export interface Screen {
  name: string;
  path: (seed: ReviewSeed) => string;
  /** Storage state key; omitted = signed out. */
  as?: 'organizer' | 'newcomer' | 'platformAdmin';
  /** Visible once the screen has loaded. */
  ready: (page: Page) => Locator;
  /** Brings the screen into the state under review (an open menu or dialog). */
  prepare?: (page: Page) => Promise<void>;
}

const hour = 3_600_000;
const iso = (offset: number) => new Date(Date.now() + offset).toISOString();

async function ok<T>(response: Promise<APIResponse>): Promise<T> {
  const result = await response;
  expect(result.ok(), `${result.url()} → ${result.status()} ${await result.text()}`).toBe(true);
  return (result.status() === 204 ? undefined : await result.json()) as T;
}

async function account(baseURL: string, headers: Record<string, string>, name: string): Promise<APIRequestContext> {
  const api = await playwrightRequest.newContext({ baseURL, extraHTTPHeaders: { ...headers, ...CSRF } });
  await ok(api.post('/api/auth/register', { data: { email: uniqueEmail('review'), name, password: PASSWORD } }));
  return api;
}

/**
 * Seeds realistic data through the API once per spec file and run, and stores one browser state per account
 * under `.local/e2e` (wiped by the runner at the start of each local run). A worker restarted after a failed
 * test reuses the seed instead of registering again into the per-address sign-up limit.
 */
export async function seedReview(testInfo: TestInfo): Promise<ReviewSeed> {
  const dir = path.resolve('.local/e2e', `review-${testInfo.project.name}-${path.basename(testInfo.file, '.spec.ts')}`);
  const cache = path.join(dir, 'seed.json');
  try {
    return JSON.parse(readFileSync(cache, 'utf8')) as ReviewSeed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  mkdirSync(dir, { recursive: true });
  const seed = await createSeed(testInfo, dir);
  writeFileSync(cache, JSON.stringify(seed));
  return seed;
}

async function createSeed(testInfo: TestInfo, dir: string): Promise<ReviewSeed> {
  const baseURL = testInfo.project.use.baseURL!;
  const headers = (testInfo.project.use.extraHTTPHeaders ?? {}) as Record<string, string>;
  const save = async (api: APIRequestContext, name: string) => {
    const file = path.join(dir, `${name}.json`);
    await api.storageState({ path: file });
    await api.dispose();
    return file;
  };

  const org = await account(baseURL, headers, 'Riley Organizer');
  type Created = { id: string };
  const event = await ok<Created>(
    org.post('/api/events', {
      data: { name: 'Harbour Lights Festival 2026', venue: 'Pier 4 Warehouse, Long Harbour Road', startsAt: iso(-hour), endsAt: iso(5 * hour), capacity: 500, status: 'active' }
    })
  );
  await ok(org.post('/api/events', { data: { name: 'Board Retreat', venue: 'Lakeside Lodge', startsAt: iso(240 * hour), endsAt: iso(250 * hour) } }));
  const gate = await ok<Created>(org.post(`/api/events/${event.id}/gates`, { data: { name: 'Main entrance' } }));
  await ok(org.post(`/api/events/${event.id}/gates`, { data: { name: 'VIP side door' } }));
  const attendees = [
    ['Ada Lovelace', 'ada@example.com'],
    ['Grace Hopper', 'grace@example.com'],
    ['Maximilian Alexander Featherstonehaugh-Worthington', 'maximilian.featherstonehaugh-worthington@very-long-company-domain.example.com'],
    ['Katherine Johnson', 'katherine@example.com'],
    ['Alan Turing', ''],
    ['Dorothy Vaughan', 'dorothy@example.com'],
    ['Edsger Dijkstra', 'edsger@example.com'],
    ['Barbara Liskov', 'barbara@example.com']
  ].map(([name, email]) => ({ name, email }));
  const passes = await ok<Array<{ id: string; passUrl: string }>>(org.post(`/api/events/${event.id}/passes`, { data: { attendees } }));
  const device = await ok<{ enrollment: { url: string } }>(org.post(`/api/events/${event.id}/scanners`, { data: { label: 'Front door phone', gateId: gate.id } }));
  await ok(org.post(`/api/events/${event.id}/scanners`, { data: { label: 'Spare tablet' } }));
  const door = await playwrightRequest.newContext({ baseURL, extraHTTPHeaders: headers });
  const { key } = await ok<{ key: string }>(door.post('/api/scanner/enroll', { data: { code: new URL(device.enrollment.url).hash.replace('#enroll=', '') } }));
  const scan = (code: string) => ok(door.post('/api/scanner/redeem', { headers: { Authorization: `Bearer ${key}` }, data: { code } }));
  for (const pass of passes.slice(0, 3)) await scan(pass.passUrl);
  await scan(passes[0].passUrl); // duplicate
  await scan('not-a-gatepass-code'); // unknown
  await door.dispose();
  await ok(org.post(`/api/events/${event.id}/passes/revoke`, { data: { passIds: [passes[7].id] } }));
  const invite = await ok<{ url: string }>(org.post(`/api/events/${event.id}/invitations`, { data: { email: uniqueEmail('manager') } }));

  const newcomer = await account(baseURL, headers, 'Nova Newcomer');

  const operator = await playwrightRequest.newContext({ baseURL, extraHTTPHeaders: { ...headers, Authorization: `Bearer ${OPERATOR_TOKEN}` } });
  const adminInvite = await ok<{ url: string }>(operator.post('/api/platform/invitations', { data: { email: uniqueEmail('platform'), role: 'platform_admin' } }));
  await operator.dispose();
  const admin = await playwrightRequest.newContext({ baseURL, extraHTTPHeaders: { ...headers, ...CSRF } });
  await ok(admin.post('/api/invitations/accept', { data: { token: new URL(adminInvite.url).hash.replace('#/invite/', ''), name: 'Pat Platform', password: PASSWORD } }));

  return {
    organizer: await save(org, 'organizer'),
    newcomer: await save(newcomer, 'newcomer'),
    platformAdmin: await save(admin, 'platform-admin'),
    eventId: event.id,
    passPath: new URL(passes[3].passUrl).pathname,
    invitePath: `/${new URL(invite.url).hash}`
  };
}

const eventTab = (id: string, label: string): Screen => ({
  name: `event-${id}`,
  path: (seed) => `/#/events/${seed.eventId}${id === 'operations' ? '' : `/${id}`}`,
  as: 'organizer',
  ready: (page) => page.getByRole('tab', { name: label, selected: true })
});

/** Every screen the review covers. */
export const REVIEW_SCREENS: Screen[] = [
  { name: 'sign-in', path: () => '/', ready: (page) => page.getByRole('heading', { name: 'Sign in to GatePass' }) },
  { name: 'register', path: () => '/#/signup', ready: (page) => page.getByRole('button', { name: 'Create account' }) },
  { name: 'forgot', path: () => '/#/forgot', ready: (page) => page.getByRole('heading', { level: 1 }) },
  { name: 'reset', path: () => '/#/reset/review-not-a-real-token', ready: (page) => page.getByRole('heading', { level: 1 }) },
  { name: 'invite', path: (seed) => seed.invitePath, ready: (page) => page.getByRole('heading', { name: /Join/ }) },
  { name: 'events-first-run', path: () => '/', as: 'newcomer', ready: (page) => page.getByRole('heading', { name: 'Welcome to GatePass', level: 1 }) },
  { name: 'events-overview', path: () => '/', as: 'organizer', ready: (page) => page.getByRole('link', { name: /Harbour Lights/ }).first() },
  eventTab('operations', 'Operations'),
  eventTab('passes', 'Passes'),
  eventTab('access', 'Access'),
  eventTab('team', 'Team'),
  eventTab('design', 'Pass design'),
  eventTab('settings', 'Settings'),
  eventTab('audit', 'Audit log'),
  { name: 'event-not-found', path: () => '/#/events/no-such-event', as: 'organizer', ready: (page) => page.getByText('Event not found') },
  { name: 'platform', path: () => '/#/platform', as: 'platformAdmin', ready: (page) => page.getByRole('heading', { level: 1 }) },
  {
    name: 'account-menu',
    path: () => '/',
    as: 'organizer',
    ready: (page) => page.getByRole('link', { name: /Harbour Lights/ }).first(),
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Riley Organizer' }).click();
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    }
  },
  {
    name: 'change-password-dialog',
    path: () => '/',
    as: 'organizer',
    ready: (page) => page.getByRole('link', { name: /Harbour Lights/ }).first(),
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Riley Organizer' }).click();
      await page.getByRole('button', { name: 'Change password' }).click();
      await page.getByRole('dialog', { name: 'Change password' }).getByRole('button', { name: 'Change password' }).click();
      await expect(page.getByText('Enter your current password.')).toBeVisible();
    }
  },
  {
    name: 'confirm-dialog',
    path: (seed) => `/#/events/${seed.eventId}/settings`,
    as: 'organizer',
    ready: (page) => page.getByRole('tab', { name: 'Settings', selected: true }),
    prepare: async (page) => {
      await page.getByRole('button', { name: 'End the event' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
    }
  },
  { name: 'pass-page', path: (seed) => seed.passPath, ready: (page) => page.getByRole('img', { name: 'QR code' }) },
  { name: 'scanner-landing', path: () => '/scan', ready: (page) => page.locator('#root > *').first() }
];

export const SCHEMES = ['light', 'dark'] as const;

/**
 * A browser context for one screen: the project's base URL, the screen's account, the scheme. Each test
 * presents its own client address (the local server trusts loopback as a proxy, see playwright.config.ts):
 * a screen reloads once per width, and the invitation and sign-in screens call rate-limited endpoints
 * (20 a minute per address), which a whole review run would exceed from one address.
 */
export async function openContext(browser: Browser, testInfo: TestInfo, seed: ReviewSeed, screen: Screen, colorScheme: (typeof SCHEMES)[number]): Promise<BrowserContext> {
  let hash = 0;
  for (const char of `${testInfo.file}|${testInfo.title}`) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    extraHTTPHeaders: { ...testInfo.project.use.extraHTTPHeaders, 'X-Forwarded-For': `10.66.${(hash >>> 8) & 255}.${hash & 255}` },
    storageState: screen.as ? seed[screen.as] : undefined,
    colorScheme
  });
}

/** Loads the screen fresh at `width` and waits until its content, fonts and data requests have settled. */
export async function showAt(page: Page, seed: ReviewSeed, screen: Screen, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('about:blank');
  await page.goto(screen.path(seed));
  await expect(screen.ready(page)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  await screen.prepare?.(page);
}
