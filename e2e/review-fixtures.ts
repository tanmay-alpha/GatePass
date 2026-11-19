import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, request as playwrightRequest, type APIRequestContext, type APIResponse, type Browser, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import { CSRF, PASSWORD, uniqueEmail } from './support';

/** Matches `ADMIN_TOKEN` of the local web server in playwright.config.ts. */
const OPERATOR_TOKEN = 'e2e-admin-token-0123456789abcdef';

/** Signed-in browser states and links for the UI review specs (visual review and accessibility). */
export interface ReviewSeed {
  /** Organizer with two events, gates, a capacity-limited policy, passes, scans, devices, a saved template and a pending invitation. */
  organizer: string;
  /** Organizer with no events (first-run overview). */
  newcomer: string;
  /** Platform administrator. */
  platformAdmin: string;
  /** Organizer whose only event receives the passes issued by the issuance and badge screens, so they change no other screen. */
  issuer: string;
  eventId: string;
  issuerEventId: string;
  /** Attendee pass page path (`/p/<token>`). */
  passPath: string;
  /** Pending manager invitation (`/#/invite/<token>`). */
  invitePath: string;
}

export interface Screen {
  name: string;
  path: (seed: ReviewSeed) => string;
  /** Storage state key; omitted = signed out. */
  as?: 'organizer' | 'newcomer' | 'platformAdmin' | 'issuer';
  /** Visible once the screen has loaded. */
  ready: (page: Page) => Locator;
  /** Brings the screen into the state under review (an open menu or dialog). */
  prepare?: (page: Page) => Promise<void>;
  /** Viewport widths for this screen when not every width applies (print media lays out on paper, not the viewport). */
  widths?: number[];
  /** Screenshot the viewport only: a modal sits where the page was scrolled to, which a full-page capture misplaces. */
  viewportShot?: boolean;
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
  const crew = await ok<Created>(org.post(`/api/events/${event.id}/policies`, { data: { name: 'Crew & suppliers', capacity: 10 } }));
  const crewPasses = await ok<Array<{ passUrl: string }>>(
    org.post(`/api/events/${event.id}/passes`, {
      data: { policyId: crew.id, attendees: ['Stage crew: Jordan Lee', 'Catering: Priya Raman', 'Sound: Tomasz Wiśniewski'].map((name) => ({ name, email: '' })) }
    })
  );
  const device = await ok<{ enrollment: { url: string } }>(org.post(`/api/events/${event.id}/scanners`, { data: { label: 'Front door phone', gateId: gate.id } }));
  await ok(org.post(`/api/events/${event.id}/scanners`, { data: { label: 'Spare tablet' } }));
  const door = await playwrightRequest.newContext({ baseURL, extraHTTPHeaders: headers });
  const { key } = await ok<{ key: string }>(door.post('/api/scanner/enroll', { data: { code: new URL(device.enrollment.url).hash.replace('#enroll=', '') } }));
  const scan = (code: string) => ok(door.post('/api/scanner/redeem', { headers: { Authorization: `Bearer ${key}` }, data: { code } }));
  for (const pass of passes.slice(0, 3)) await scan(pass.passUrl);
  for (const pass of crewPasses.slice(0, 2)) await scan(pass.passUrl);
  await scan(passes[0].passUrl); // duplicate
  await scan('not-a-gatepass-code'); // unknown
  await door.dispose();
  await ok(org.post(`/api/events/${event.id}/passes/revoke`, { data: { passIds: [passes[7].id] } }));
  const invite = await ok<{ url: string }>(org.post(`/api/events/${event.id}/invitations`, { data: { email: uniqueEmail('manager') } }));
  await ok(org.post(`/api/events/${event.id}/save-template`, { data: { name: 'Waterfront festival', description: 'Two gates, crew policy with a capacity of 10, five-hour doors' } }));

  const issuer = await account(baseURL, headers, 'Morgan Issuer');
  const fair = await ok<Created>(
    issuer.post('/api/events', { data: { name: 'Riverside Book Fair 2026', venue: 'Exhibition Hall B, Riverside Convention Centre', startsAt: iso(-hour), endsAt: iso(8 * hour), status: 'active' } })
  );
  await ok(issuer.post(`/api/events/${fair.id}/policies`, { data: { name: 'Exhibitor' } }));

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
    issuer: await save(issuer, 'issuer'),
    eventId: event.id,
    issuerEventId: fair.id,
    passPath: new URL(passes[3].passUrl).pathname,
    invitePath: `/${new URL(invite.url).hash}`
  };
}

/** Pasted CSV with one row of each kind the import refuses: an existing attendee, a missing name, a bad email and a duplicate. */
const IMPORT_ROWS = [
  'Name,Email',
  'Chiamaka Okonkwo-Adebayo,chiamaka.okonkwo-adebayo@international-logistics-partners.example.org',
  'Ada Lovelace,ada@example.com',
  ',missing-name@example.com',
  'Rosalind Franklin,not-an-email',
  'Lin Wei,lin.wei@example.com',
  'Lin Wei,lin.wei@example.com'
].join('\n');

const ISSUE_NAMES = ['Ngozi Adichie', 'Maximiliana Bartholomew-Featherstonehaugh', 'Haruki Murakami', 'Zadie Smith', 'Jorge Luis Borges', 'Wisława Szymborska'];

/** Issues passes to the issuer's event; the response with the one-time links shows below the form. */
async function issue(page: Page) {
  await page.getByLabel('Attendees').fill(ISSUE_NAMES.join('\n'));
  await page.getByRole('button', { name: /^Issue \d+ passes?$/ }).click();
  await expect(page.getByRole('button', { name: 'Print passes' })).toBeVisible();
}

async function openBadges(page: Page) {
  await issue(page);
  await page.getByRole('button', { name: 'Print passes' }).click();
  await expect(page.getByRole('region', { name: 'Print preview' }).getByRole('button', { name: 'Print', exact: true })).toBeEnabled({ timeout: 20_000 });
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
    viewportShot: true,
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
    viewportShot: true,
    path: (seed) => `/#/events/${seed.eventId}/settings`,
    as: 'organizer',
    ready: (page) => page.getByRole('tab', { name: 'Settings', selected: true }),
    prepare: async (page) => {
      await page.getByRole('button', { name: 'End the event' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
    }
  },
  {
    name: 'skip-link',
    viewportShot: true,
    path: (seed) => `/#/events/${seed.eventId}`,
    as: 'organizer',
    ready: (page) => page.getByRole('tab', { name: 'Operations', selected: true }),
    prepare: async (page) => {
      await page.keyboard.press('Tab');
    }
  },
  {
    name: 'new-event',
    path: () => '/',
    as: 'organizer',
    ready: (page) => page.getByRole('link', { name: /Harbour Lights/ }).first(),
    prepare: async (page) => {
      await page.getByRole('main').getByRole('button', { name: 'New event' }).click();
      await expect(page.getByRole('heading', { name: 'New event', level: 1 })).toBeVisible();
      await page.getByRole('combobox', { name: 'Start from' }).selectOption({ label: 'Waterfront festival' });
      await expect(page.getByText('Two gates, crew policy with a capacity of 10, five-hour doors')).toBeVisible();
    }
  },
  {
    name: 'import-preview',
    viewportShot: true,
    path: (seed) => `/#/events/${seed.eventId}/passes`,
    as: 'organizer',
    ready: (page) => page.getByRole('tab', { name: 'Passes', selected: true }),
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Import CSV' }).click();
      await page.getByRole('dialog', { name: 'Import attendees from CSV' }).getByLabel('Or paste rows').fill(IMPORT_ROWS);
      await page.getByRole('dialog').getByRole('button', { name: 'Preview import' }).click();
      await expect(page.getByRole('dialog', { name: 'Check the import' })).toBeVisible();
    }
  },
  { name: 'issued-passes', path: (seed) => `/#/events/${seed.issuerEventId}/passes`, as: 'issuer', ready: (page) => page.getByRole('tab', { name: 'Passes', selected: true }), prepare: issue },
  {
    name: 'badges-preview',
    path: (seed) => `/#/events/${seed.issuerEventId}/passes`,
    as: 'issuer',
    ready: (page) => page.getByRole('tab', { name: 'Passes', selected: true }),
    prepare: openBadges
  },
  {
    name: 'badges-print',
    path: (seed) => `/#/events/${seed.issuerEventId}/passes`,
    as: 'issuer',
    ready: (page) => page.getByRole('tab', { name: 'Passes', selected: true }),
    prepare: async (page) => {
      await openBadges(page);
      await page.emulateMedia({ media: 'print' });
    },
    widths: [1280]
  },
  {
    name: 'scanner-setup',
    path: (seed) => `/#/events/${seed.eventId}/access`,
    as: 'organizer',
    ready: (page) => page.getByRole('tab', { name: 'Access', selected: true }),
    prepare: async (page) => {
      await page.getByText('Camera test code', { exact: true }).click();
      await expect(page.getByRole('img', { name: 'Camera test QR code' })).toBeVisible();
      await page.getByRole('button', { name: 'New setup link for Spare tablet' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Create link' }).click();
      await expect(page.getByRole('img', { name: 'Setup QR code for Spare tablet' })).toBeVisible();
    }
  },
  {
    name: 'revoke-scanner-dialog',
    viewportShot: true,
    path: (seed) => `/#/events/${seed.eventId}/access`,
    as: 'organizer',
    ready: (page) => page.getByRole('tab', { name: 'Access', selected: true }),
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Revoke Front door phone' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
    }
  },
  {
    name: 'delete-gate-dialog',
    viewportShot: true,
    path: (seed) => `/#/events/${seed.eventId}/access`,
    as: 'organizer',
    ready: (page) => page.getByRole('tab', { name: 'Access', selected: true }),
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Delete gate Main entrance' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
    }
  },
  {
    name: 'delete-policy-dialog',
    viewportShot: true,
    path: (seed) => `/#/events/${seed.eventId}/access`,
    as: 'organizer',
    ready: (page) => page.getByRole('tab', { name: 'Access', selected: true }),
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Delete policy Crew & suppliers' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
    }
  },
  {
    name: 'policy-capacity-error',
    viewportShot: true,
    path: (seed) => `/#/events/${seed.eventId}/access`,
    as: 'organizer',
    ready: (page) => page.getByRole('tab', { name: 'Access', selected: true }),
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Edit policy Crew & suppliers' }).click();
      const dialog = page.getByRole('dialog', { name: /Edit/ });
      await dialog.getByLabel('Capacity').fill('1');
      await dialog.getByRole('button', { name: 'Save policy' }).click();
      await expect(dialog.getByText('2 people are already admitted, so capacity cannot be lower than 2.')).toBeVisible();
    }
  },
  {
    name: 'policy-change-confirm',
    viewportShot: true,
    path: (seed) => `/#/events/${seed.eventId}/access`,
    as: 'organizer',
    ready: (page) => page.getByRole('tab', { name: 'Access', selected: true }),
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Edit policy Crew & suppliers' }).click();
      await page.getByRole('dialog', { name: /Edit/ }).getByLabel('Capacity').fill('2');
      await page.getByRole('dialog', { name: /Edit/ }).getByRole('button', { name: 'Save policy' }).click();
      await expect(page.getByRole('dialog', { name: 'Change “Crew & suppliers” while the doors are open?' })).toBeVisible();
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
  await page.emulateMedia({ media: null });
  await page.goto('about:blank');
  await page.goto(screen.path(seed));
  await expect(screen.ready(page)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  await screen.prepare?.(page);
}
