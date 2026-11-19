import { describe, expect, it } from 'vitest';
import type { AdmissionPolicy, EventSummary, Gate, Scanner } from '../src/shared/types';
import { closingNow, deviceStop, doorsOpen, eventNarrowing, gateBlockers, policyNarrowing, type PolicyDraft } from '../src/client/admin/live-impact';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const format = (iso: string) => iso.slice(11, 16);

const event = {
  id: 'e1',
  name: 'Harbour Lights',
  status: 'active',
  startsAt: at(-60),
  endsAt: at(300),
  capacity: 500,
  admittedCount: 3,
  passCount: 10,
  redeemedCount: 3,
  revokedCount: 1,
  readyScannerCount: 2
} as EventSummary;

const gate = (id: string, name: string, admittedCount = 0): Gate => ({ id, eventId: 'e1', name, createdAt: at(-600), admittedCount });
const north = gate('g1', 'North', 4);
const south = gate('g2', 'South');

function scanner(id: string, label: string, gateId: string | null, overrides: Partial<Scanner> = {}): Scanner {
  return {
    id,
    eventId: 'e1',
    label,
    gateId,
    gateName: gateId === 'g1' ? 'North' : gateId === 'g2' ? 'South' : null,
    createdAt: at(-600),
    revokedAt: null,
    lastUsedAt: at(-5),
    enrolledAt: at(-500),
    setup: 'enrolled',
    setupExpiresAt: null,
    ...overrides
  };
}

const policy = (overrides: Partial<AdmissionPolicy> = {}): AdmissionPolicy => ({
  id: 'p1',
  eventId: 'e1',
  name: 'Crew',
  opensAt: null,
  closesAt: null,
  capacity: 10,
  admittedCount: 2,
  gateIds: [],
  passCount: 5,
  createdAt: at(-600),
  updatedAt: at(-600),
  ...overrides
});

describe('doorsOpen', () => {
  it('is true only for an active event inside its window', () => {
    expect(doorsOpen(event, [], NOW)).toBe(true);
    expect(doorsOpen({ ...event, status: 'draft' }, [], NOW)).toBe(false);
    expect(doorsOpen({ ...event, startsAt: at(10) }, [], NOW)).toBe(false);
    expect(doorsOpen({ ...event, endsAt: at(0) }, [], NOW)).toBe(false);
  });

  it('counts a policy window that opens before the event (early entry) as open doors', () => {
    expect(doorsOpen({ ...event, startsAt: at(30) }, [{ opensAt: at(-15), closesAt: null }], NOW)).toBe(true);
  });
});

describe('gateBlockers', () => {
  it('names the devices, policies and admissions that keep a gate', () => {
    const scanners = [scanner('s1', 'Front door phone', 'g1'), scanner('s2', 'Old phone', 'g1', { revokedAt: at(-30) }), scanner('s3', 'Tablet', 'g2')];
    expect(gateBlockers(north, scanners, [policy({ gateIds: ['g1'] })])).toEqual([
      '1 active scanner is bound to it (Front door phone).',
      '1 other device (revoked or not set up) is bound to it.',
      'The policy “Crew” allows entry through it.',
      '4 people were admitted through it; those check-ins stay attached to this gate.'
    ]);
  });

  it('is empty for an unused gate', () => {
    expect(gateBlockers(south, [scanner('s1', 'Front door phone', 'g1')], [policy({ gateIds: ['g1'] })])).toEqual([]);
  });
});

describe('policyNarrowing', () => {
  const draft = (overrides: Partial<PolicyDraft> = {}): PolicyDraft => ({
    opensAt: null,
    closesAt: null,
    capacity: 10,
    gateIds: [],
    ...overrides
  });
  const narrow = (next: PolicyDraft, current = policy(), scanners = [scanner('s1', 'Front door phone', 'g1')]) =>
    policyNarrowing(event, current, next, [north, south], scanners, format, NOW);

  it('says nothing for a change that only widens admission', () => {
    expect(narrow(draft({ capacity: 20, closesAt: at(400) }))).toEqual([]);
    expect(narrow(draft({ capacity: null }))).toEqual([]);
  });

  it('warns that lowering capacity to the admitted count fills the policy at once', () => {
    expect(narrow(draft({ capacity: 2 }))).toEqual(['The policy is full as soon as you save: its 3 passes not yet admitted are refused as Capacity full.']);
  });

  it('counts how many waiting passes a lower capacity leaves out', () => {
    expect(narrow(draft({ capacity: 4 }))).toEqual(['Only 2 more can enter; the rest of its 3 passes not yet admitted are refused as Capacity full.']);
  });

  it('distinguishes closing now from closing earlier', () => {
    expect(narrow(draft({ closesAt: at(-1) }))).toEqual(['Entry closes now: its 3 passes not yet admitted are refused as Too late.']);
    expect(narrow(draft({ closesAt: at(60) }))).toEqual([`Entry closes earlier, at ${format(at(60))}; after that its 3 passes not yet admitted are refused as Too late.`]);
  });

  it('warns when an open window is pushed later', () => {
    expect(narrow(draft({ opensAt: at(30) }))).toEqual([`Entry pauses until ${format(at(30))}: until then its 3 passes not yet admitted are refused as Too early.`]);
  });

  it('names the gates that stop accepting the passes and the active scanners there', () => {
    expect(narrow(draft({ gateIds: ['g2'] }))).toEqual(['North stops accepting these passes (1 active scanner there refuses them as Wrong gate).']);
    expect(narrow(draft({ gateIds: ['g2'] }), policy({ gateIds: ['g1', 'g2'] }), [])).toEqual(['North stops accepting these passes.']);
  });
});

describe('deviceStop', () => {
  const front = scanner('s1', 'Front door phone', 'g1');

  it('says when no other device can admit at the gate', () => {
    expect(deviceStop(front, [front, scanner('s2', 'Tablet', 'g2')], format)).toEqual([
      `“Front door phone” (North) stops admitting on its next scan; it was last used at ${format(at(-5))}.`,
      'No other active device can admit at North: nobody can be checked in there until another device is set up.'
    ]);
  });

  it('lists the devices that still cover the gate, including unbound ones', () => {
    expect(deviceStop(front, [front, scanner('s2', 'Spare', null), scanner('s3', 'Pending', 'g1', { setup: 'pending', enrolledAt: null })], format)[1]).toBe(
      '1 other active device can still admit at North: Spare.'
    );
  });

  it('is empty for a device that cannot scan', () => {
    expect(deviceStop(scanner('s3', 'Pending', 'g1', { setup: 'pending' }), [], format)).toEqual([]);
    expect(deviceStop(scanner('s4', 'Gone', 'g1', { revokedAt: at(-1) }), [], format)).toEqual([]);
  });
});

describe('closingNow and eventNarrowing', () => {
  it('states who is turned away and that admissions stay recorded', () => {
    expect(closingNow(event)).toEqual([
      '2 active scanners stop admitting on their next scan; every pass is refused as Event closed.',
      '6 passes not used yet can no longer enter.',
      'The 3 admissions so far stay recorded.'
    ]);
  });

  it('flags an earlier end, a later start and a capacity that fills the event', () => {
    expect(eventNarrowing(event, { startsAt: event.startsAt, endsAt: at(-1), capacity: 3 }, format, NOW)).toEqual([
      'The event window closes now: passes without a policy window of their own are refused as Too late.',
      'The event is full as soon as you save: every further pass is refused as Capacity full (6 passes not used yet).'
    ]);
    expect(eventNarrowing(event, { startsAt: at(30), endsAt: event.endsAt, capacity: 500 }, format, NOW)).toEqual([
      `Entry pauses until ${format(at(30))}: passes without a policy window of their own are refused as Too early until then.`
    ]);
    expect(eventNarrowing(event, { startsAt: event.startsAt, endsAt: at(400), capacity: null }, format, NOW)).toEqual([]);
  });
});
