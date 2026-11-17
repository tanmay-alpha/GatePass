import { expect, test, type Page } from '@playwright/test';
import { CSRF, signUp } from './support';

// Organizer changes while the doors are open: deleting a gate that is in use is explained instead of
// attempted; narrowing a policy, revoking a working device and ending the event state who will be turned
// away and need an explicit acknowledgement. Server rules are unchanged; past admissions stay recorded.

interface LiveEvent {
  id: string;
  name: string;
}

/** An open event with gate North, an enrolled phone bound to it, and policy VIP (capacity 5, two passes, one admitted). */
async function openEvent(page: Page): Promise<LiveEvent> {
  const api = page.request;
  const now = Date.now();
  const name = 'E2E Live Changes';
  const event = await (
    await api.post('/api/events', { headers: CSRF, data: { name, status: 'active', startsAt: new Date(now - 3_600_000).toISOString(), endsAt: new Date(now + 3_600_000).toISOString() } })
  ).json();
  const gate = await (await api.post(`/api/events/${event.id}/gates`, { headers: CSRF, data: { name: 'North' } })).json();
  const policy = await (await api.post(`/api/events/${event.id}/policies`, { headers: CSRF, data: { name: 'VIP', capacity: 5 } })).json();
  const passes: Array<{ passUrl: string }> = await (
    await api.post(`/api/events/${event.id}/passes`, {
      headers: CSRF,
      data: { policyId: policy.id, attendees: [{ name: 'Ada Lovelace', email: '' }, { name: 'Grace Hopper', email: '' }] }
    })
  ).json();
  const scanner = await (await api.post(`/api/events/${event.id}/scanners`, { headers: CSRF, data: { label: 'North phone', gateId: gate.id } })).json();
  // The session cookie rides along on this request context, so the CSRF header is needed here too.
  const enroll = await api.post('/api/scanner/enroll', { headers: CSRF, data: { code: new URL(scanner.enrollment.url).hash.replace('#enroll=', '') } });
  expect(enroll.ok()).toBe(true);
  const { key } = await enroll.json();
  const admitted = await (await api.post('/api/scanner/redeem', { headers: { ...CSRF, Authorization: `Bearer ${key}` }, data: { code: passes[0].passUrl } })).json();
  expect(admitted.outcome).toBe('admitted');
  return { id: event.id, name };
}

/** Every state-changing admin request the page sends. */
function writes(page: Page): string[] {
  const sent: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/') && !request.url().includes('/api/scanner/')) sent.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  return sent;
}

test('changes that turn people away while the doors are open are explained and acknowledged', async ({ page }) => {
  await signUp(page);
  const event = await openEvent(page);
  await page.goto(`/#/events/${event.id}/access`);
  await expect(page.getByRole('tab', { name: 'Access', selected: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'North phone', exact: true })).toBeVisible();
  const sent = writes(page);

  // A gate in use: the reason, and no delete button to press.
  await page.getByRole('button', { name: 'Delete gate North' }).click();
  const blocked = page.getByRole('dialog', { name: '“North” cannot be deleted' });
  await expect(blocked).toContainText('1 active scanner is bound to it (North phone).');
  await expect(blocked).toContainText('1 person was admitted through it');
  await expect(blocked.getByRole('button', { name: /Delete/ })).toHaveCount(0);
  await blocked.getByRole('button', { name: 'OK' }).click();
  await expect(blocked).toHaveCount(0);

  // Capacity down to the one already admitted: the policy is full at once.
  await page.getByRole('button', { name: 'Edit policy VIP' }).click();
  const form = page.getByRole('dialog', { name: 'Edit “VIP”' });
  await form.getByLabel('Capacity').fill('1');
  await form.getByRole('button', { name: 'Save policy' }).click();
  const narrowing = page.getByRole('dialog', { name: 'Change “VIP” while the doors are open?' });
  await expect(narrowing).toContainText('The policy is full as soon as you save: its 1 pass not yet admitted is refused as Capacity full.');
  const apply = narrowing.getByRole('button', { name: 'Save and apply now' });
  await expect(apply).toBeDisabled();
  await narrowing.getByRole('button', { name: 'Cancel' }).click();
  await expect(narrowing).toHaveCount(0);
  await expect(form).toBeVisible();
  expect(sent).toEqual([]);
  await form.getByRole('button', { name: 'Save policy' }).click();
  await narrowing.getByLabel('I understand door staff will start refusing these passes.').check();
  await apply.click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('row', { name: /VIP/ })).toContainText('1/1');
  expect(sent).toEqual([`PATCH /api/policies/${await policyId(page, event.id)}`]);

  // The only working device at North: revoking it leaves the door without a scanner.
  await page.getByRole('button', { name: 'Revoke North phone' }).click();
  const revoke = page.getByRole('dialog', { name: 'Revoke “North phone” while the doors are open?' });
  await expect(revoke).toContainText('No other active device can admit at North');
  await expect(revoke.getByRole('button', { name: 'Revoke device' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(revoke).toHaveCount(0);
  expect(sent).toHaveLength(1);

  // Ending the event: who stops, and that the admission so far stays.
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'End the event' }).click();
  const end = page.getByRole('dialog', { name: `End “${event.name}” while the doors are open?` });
  await expect(end).toContainText('1 active scanner stops admitting on its next scan');
  await expect(end).toContainText('The 1 admission so far stays recorded.');
  await expect(end.getByRole('button', { name: 'End the event' })).toBeDisabled();
  await end.getByLabel('I understand the doors close now.').check();
  await end.getByRole('button', { name: 'End the event' }).click();
  await expect(page.getByText('Event ended: scanners refuse every pass')).toBeVisible();

  const scans: Array<{ outcome: string }> = await (await page.request.get(`/api/events/${event.id}/scans`)).json();
  expect(scans.map((scan) => scan.outcome)).toEqual(['admitted']);
});

test('outside opening hours the same changes keep the plain confirmation', async ({ page }) => {
  await signUp(page);
  const api = page.request;
  const later = Date.now() + 48 * 3_600_000;
  const event = await (
    await api.post('/api/events', { headers: CSRF, data: { name: 'E2E Next Week', status: 'active', startsAt: new Date(later).toISOString(), endsAt: new Date(later + 3_600_000).toISOString() } })
  ).json();
  const scanner = await (await api.post(`/api/events/${event.id}/scanners`, { headers: CSRF, data: { label: 'Spare phone' } })).json();
  const enroll = await api.post('/api/scanner/enroll', { headers: CSRF, data: { code: new URL(scanner.enrollment.url).hash.replace('#enroll=', '') } });
  expect(enroll.ok()).toBe(true);

  await page.goto(`/#/events/${event.id}/access`);
  await page.getByRole('button', { name: 'Revoke Spare phone' }).click();
  const revoke = page.getByRole('dialog', { name: 'Revoke “Spare phone”?' });
  await expect(revoke.getByRole('checkbox')).toHaveCount(0);
  await expect(revoke.getByRole('button', { name: 'Revoke device' })).toBeEnabled();
});

async function policyId(page: Page, eventId: string): Promise<string> {
  const policies: Array<{ id: string; name: string }> = await (await page.request.get(`/api/events/${eventId}/policies`)).json();
  return policies.find((policy) => policy.name === 'VIP')!.id;
}
