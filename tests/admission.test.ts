import { describe, expect, it } from 'vitest';
import { evaluateAdmission, type AdmissionInput } from '../src/server/admission';

const base: AdmissionInput = {
  now: '2030-06-01T18:30:00.000Z',
  scanner: { eventId: 'e1', gateId: 'north' },
  event: { startsAt: '2030-06-01T18:00:00.000Z', endsAt: '2030-06-01T23:00:00.000Z', status: 'active' },
  pass: { eventId: 'e1', status: 'active' },
  policy: null
};
const policy = (overrides: Partial<NonNullable<AdmissionInput['policy']>> = {}): AdmissionInput['policy'] => ({
  name: 'VIP',
  opensAt: null,
  closesAt: null,
  capacity: null,
  admittedCount: 0,
  gates: [],
  ...overrides
});
const decide = (overrides: Partial<AdmissionInput>) => evaluateAdmission({ ...base, ...overrides });

describe('evaluateAdmission', () => {
  it('admits a default-policy pass at any gate inside the event window', () => {
    expect(decide({})).toEqual({ admit: true });
    expect(decide({ scanner: { eventId: 'e1', gateId: null } })).toEqual({ admit: true });
  });

  it('applies identity and pass-state rules before time, gate and capacity', () => {
    const late = { now: '2030-06-02T00:00:00.000Z', policy: policy({ capacity: 1, admittedCount: 1 }) };
    expect(decide({ ...late, pass: null })).toMatchObject({ outcome: 'invalid' });
    expect(decide({ ...late, pass: { eventId: 'e2', status: 'active' } })).toMatchObject({ outcome: 'wrong_event' });
    expect(decide({ ...late, event: { ...base.event, status: 'archived' } })).toMatchObject({ outcome: 'event_closed' });
    expect(decide({ ...late, pass: { eventId: 'e1', status: 'redeemed' } })).toMatchObject({ outcome: 'already_redeemed' });
    expect(decide({ ...late, pass: { eventId: 'e1', status: 'revoked' } })).toMatchObject({ outcome: 'revoked' });
    expect(decide({ ...late, pass: { eventId: 'e1', status: 'expired' } })).toMatchObject({ outcome: 'expired' });
  });

  it('enforces the event window when the pass has no policy (start inclusive, end exclusive)', () => {
    expect(decide({ now: '2030-06-01T17:59:59.999Z' })).toEqual({ admit: false, outcome: 'too_early', detail: { opensAt: base.event.startsAt } });
    expect(decide({ now: '2030-06-01T18:00:00.000Z' })).toEqual({ admit: true });
    expect(decide({ now: '2030-06-01T23:00:00.000Z' })).toEqual({ admit: false, outcome: 'too_late', detail: { closesAt: base.event.endsAt } });
  });

  it('uses the policy window when set, and falls back to the event for an open side', () => {
    const wave = policy({ opensAt: '2030-06-01T19:00:00.000Z', closesAt: '2030-06-01T19:30:00.000Z' });
    expect(decide({ policy: wave })).toMatchObject({ outcome: 'too_early', detail: { policyName: 'VIP', opensAt: '2030-06-01T19:00:00.000Z' } });
    expect(decide({ policy: wave, now: '2030-06-01T19:10:00.000Z' })).toEqual({ admit: true });
    expect(decide({ policy: wave, now: '2030-06-01T19:30:00.000Z' })).toMatchObject({ outcome: 'too_late' });
    // Early-entry policy that opens before the event itself.
    expect(decide({ policy: policy({ opensAt: '2030-06-01T17:00:00.000Z' }), now: '2030-06-01T17:30:00.000Z' })).toEqual({ admit: true });
  });

  it('restricts gates only when both the scanner and the policy specify them', () => {
    const gates = [{ id: 'south', name: 'South' }, { id: 'east', name: 'East' }];
    expect(decide({ policy: policy({ gates }) })).toEqual({
      admit: false,
      outcome: 'wrong_gate',
      detail: { policyName: 'VIP', allowedGates: ['South', 'East'] }
    });
    expect(decide({ policy: policy({ gates }), scanner: { eventId: 'e1', gateId: 'south' } })).toEqual({ admit: true });
    expect(decide({ policy: policy({ gates }), scanner: { eventId: 'e1', gateId: null } })).toEqual({ admit: true });
    expect(decide({ policy: policy({ gates: [] }) })).toEqual({ admit: true });
  });

  it('reports a full policy with its capacity', () => {
    expect(decide({ policy: policy({ capacity: 2, admittedCount: 1 }) })).toEqual({ admit: true });
    expect(decide({ policy: policy({ capacity: 2, admittedCount: 2 }) })).toEqual({ admit: false, outcome: 'capacity_full', detail: { policyName: 'VIP', capacity: 2 } });
  });
});
