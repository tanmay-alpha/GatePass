import { expect, type Page } from '@playwright/test';

export const PASSWORD = 'correct horse battery staple';

/** Unique per call, so tests and browser projects never collide on the shared database. */
export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

/** `datetime-local` value (browser-local time, minute precision) `minutes` from now. New events default to the browser's zone. */
export function localInput(minutes: number): string {
  const date = new Date(Date.now() + minutes * 60_000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** Creates a fresh organizer account through the UI (the server runs with ALLOW_SIGNUP=true) and lands on the dashboard. */
export async function signUp(page: Page, name = 'E2E Organizer'): Promise<{ email: string; name: string }> {
  const email = uniqueEmail('organizer');
  await page.goto('/');
  await page.getByRole('link', { name: 'Create an account' }).click();
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible();
  return { email, name };
}

/** New event through the form; `active` opens it immediately so scanners admit. */
export async function createEvent(page: Page, name: string, options: { startMinutes?: number; endMinutes?: number; active?: boolean } = {}): Promise<void> {
  await page.getByRole('complementary', { name: 'Events' }).getByRole('button', { name: 'New event' }).click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Starts').fill(localInput(options.startMinutes ?? -60));
  await page.getByLabel('Ends').fill(localInput(options.endMinutes ?? 300));
  if (options.active) await page.getByRole('radio', { name: 'Active' }).click();
  await page.getByRole('button', { name: 'Create event' }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
}

/** Headers for state-changing API calls made with the page's session cookie. */
export const CSRF = { 'X-GatePass-CSRF': '1' };
