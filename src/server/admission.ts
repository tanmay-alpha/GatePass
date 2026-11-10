import type { EventStatus, PassStatus, ScanResult, StoredScanOutcome } from '../shared/types';

/** Everything the admission decision depends on, loaded inside the redeem transaction. */
export interface AdmissionInput {
  now: string;
  scanner: { eventId: string; gateId: string | null };
  event: { startsAt: string; endsAt: string; status: EventStatus; capacity: number | null; admittedCount: number };
  pass: { eventId: string; status: PassStatus } | null;
  policy: {
    name: string;
    opensAt: string | null;
    closesAt: string | null;
    capacity: number | null;
    admittedCount: number;
    gates: Array<{ id: string; name: string }>;
  } | null;
}

export type AdmissionDecision =
  | { admit: true }
  | { admit: false; outcome: Exclude<StoredScanOutcome, 'admitted'>; detail?: ScanResult['detail'] };

/**
 * Pure admission rules (docs/decisions/0004-admission-policy-engine.md).
 * Order matters: identity first, then pass state, then time, gate and capacity.
 * The capacity check here is advisory; the conditional UPDATE in the redeem
 * transaction is the authority.
 */
export function evaluateAdmission({ now, scanner, event, pass, policy }: AdmissionInput): AdmissionDecision {
  if (!pass) return { admit: false, outcome: 'invalid' };
  if (pass.eventId !== scanner.eventId) return { admit: false, outcome: 'wrong_event' };
  if (event.status !== 'active') return { admit: false, outcome: 'event_closed' };
  if (pass.status === 'redeemed') return { admit: false, outcome: 'already_redeemed' };
  if (pass.status === 'revoked') return { admit: false, outcome: 'revoked' };
  if (pass.status === 'expired') return { admit: false, outcome: 'expired' };

  const opensAt = policy?.opensAt ?? event.startsAt;
  const closesAt = policy?.closesAt ?? event.endsAt;
  const policyName = policy ? { policyName: policy.name } : {};
  if (now < opensAt) return { admit: false, outcome: 'too_early', detail: { ...policyName, opensAt } };
  if (now >= closesAt) return { admit: false, outcome: 'too_late', detail: { ...policyName, closesAt } };

  // An unrestricted scanner may admit anywhere; a policy without gates allows every gate.
  if (policy && scanner.gateId && policy.gates.length > 0 && !policy.gates.some((gate) => gate.id === scanner.gateId)) {
    return { admit: false, outcome: 'wrong_gate', detail: { ...policyName, allowedGates: policy.gates.map((gate) => gate.name) } };
  }
  if (policy?.capacity != null && policy.admittedCount >= policy.capacity) {
    return { admit: false, outcome: 'capacity_full', detail: { ...policyName, capacity: policy.capacity } };
  }
  if (event.capacity !== null && event.admittedCount >= event.capacity) {
    return { admit: false, outcome: 'capacity_full', detail: { capacity: event.capacity, eventCapacity: true } };
  }
  return { admit: true };
}
