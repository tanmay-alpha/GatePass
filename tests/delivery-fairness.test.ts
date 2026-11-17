import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { DeliveryWorker } from '../src/server/deliveries';
import { FakeProvider } from './mail-fakes';
import { createHarness, type Harness } from './helpers';

// MAIL-03: one event's large import must not hold back every other event's
// pass emails. The worker serves events with due emails in turn (the event
// served longest ago first), within the one global provider rate.

let h: Harness;
const workers: DeliveryWorker[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  h?.close();
});

function setup(): FakeProvider {
  h = createHarness({ mailer: new FakeProvider(() => h.clock.current.getTime()), passDeliveryKey: randomBytes(32) });
  return h.service.accounts.mailer as FakeProvider;
}

/** An event with `count` queued emails, issued one second after the previous call. */
function eventWith(name: string, count: number): string {
  h.clock.advance(1_000);
  const event = h.service.createEvent({ name, startsAt: '2030-06-01T18:00:00.000Z', endsAt: '2030-06-02T23:00:00.000Z' }, 'operator');
  h.service.issuePasses(event.id, { attendees: Array.from({ length: count }, (_, i) => ({ email: `${name.toLowerCase()}-${i}@example.com` })), emailPasses: true }, 'operator');
  return event.id;
}

/** Claims and records `n` emails the way the worker does, returning the event of each. */
function serve(n: number, names: Record<string, string>): string[] {
  const order: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const job = h.service.deliveries.claim();
    if (!job) break;
    h.service.deliveries.markAccepted(job, `msg_${i}`);
    order.push(names[job.eventId]);
  }
  return order;
}

describe('fair scheduling across events (MAIL-03)', () => {
  it('does not make a small event wait behind another event’s 2,000-email import', () => {
    setup();
    const a = eventWith('A', 2_000);
    const b = eventWith('B', 5);
    expect(serve(12, { [a]: 'A', [b]: 'B' })).toEqual(['A', 'B', 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'A']);
  });

  it('takes three events in turn, starting with the one whose email is due first, and keeps the queue order within each event', () => {
    setup();
    const a = eventWith('A', 4);
    const b = eventWith('B', 2);
    const c = eventWith('C', 3);
    const names = { [a]: 'A', [b]: 'B', [c]: 'C' };
    const recipients: string[] = [];
    for (let job = h.service.deliveries.claim(); job; job = h.service.deliveries.claim()) {
      recipients.push(job.message.to);
      h.service.deliveries.markAccepted(job, 'msg');
    }
    expect(recipients.map((to) => to.split('-')[0].toUpperCase())).toEqual(['A', 'B', 'C', 'A', 'B', 'C', 'A', 'C', 'A']);
    expect(recipients.filter((to) => to.startsWith('a-'))).toEqual(['a-0@example.com', 'a-1@example.com', 'a-2@example.com', 'a-3@example.com']);
    // A new event joining later goes ahead of events already served.
    const d = eventWith('D', 2);
    const later = eventWith('A2', 3);
    expect(serve(5, { ...names, [d]: 'D', [later]: 'A2' })).toEqual(['D', 'A2', 'D', 'A2', 'A2']);
  });

  it('serves events in turn through the worker, within the global rate', async () => {
    const provider = setup();
    eventWith('A', 6);
    eventWith('B', 2);
    eventWith('C', 2);
    const worker = new DeliveryWorker(h.service.deliveries, provider, { perSecond: 25, maxAttempts: 3, log: () => {} });
    workers.push(worker);
    worker.start();
    await provider.callsReached(10);
    await worker.stop();
    expect(provider.calls.map((call) => call.message.to[0].toUpperCase())).toEqual(['A', 'B', 'C', 'A', 'B', 'C', 'A', 'A', 'A', 'A']);
    const gaps = provider.calls.slice(1).map((call, i) => call.at - provider.calls[i].at);
    expect(gaps.every((gap) => gap >= 38)).toBe(true); // 25 a second = one every 40 ms (timers may fire a millisecond early)
  });
});
