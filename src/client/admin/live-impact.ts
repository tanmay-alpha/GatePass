import type { AdmissionPolicy, EventSummary, Gate, Scanner } from '../../shared/types';

/**
 * What an organizer change does to admission at the door, worked out in the browser from data the
 * Access and Settings tabs already load, so a confirmation can state the consequence before it happens.
 * The server rules are unchanged and stay the authority; this only explains them in advance.
 */

/** Holds a key and can scan: enrolled, or issued before one-time setup links. */
export function canScan(scanner: Scanner): boolean {
  return !scanner.revokedAt && (scanner.setup === 'enrolled' || scanner.setup === 'legacy');
}

/**
 * Scanners admit right now: the event is Active and `now` is inside its entry window, which policies with
 * their own window widen (a pass with a policy window is checked against that window, not the event's;
 * see `evaluateAdmission` in src/server/admission.ts).
 */
export function doorsOpen(event: Pick<EventSummary, 'status' | 'startsAt' | 'endsAt'>, policies: Array<Pick<AdmissionPolicy, 'opensAt' | 'closesAt'>> = [], now = Date.now()): boolean {
  if (event.status !== 'active') return false;
  let opens = Date.parse(event.startsAt);
  let closes = Date.parse(event.endsAt);
  for (const policy of policies) {
    opens = Math.min(opens, Date.parse(policy.opensAt ?? event.startsAt));
    closes = Math.max(closes, Date.parse(policy.closesAt ?? event.endsAt));
  }
  return opens <= now && now < closes;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const list = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/**
 * Why a gate cannot be deleted, from what the page knows: bound devices (revoked ones too, they keep their
 * history), policies and admissions. Empty when nothing known refers to it; the server still refuses a gate
 * that only has denied scans, and its message is shown then.
 */
export function gateBlockers(gate: Gate, scanners: Scanner[], policies: AdmissionPolicy[]): string[] {
  const blockers: string[] = [];
  const bound = scanners.filter((scanner) => scanner.gateId === gate.id);
  const active = bound.filter(canScan);
  if (active.length) blockers.push(`${plural(active.length, 'active scanner')} ${active.length === 1 ? 'is' : 'are'} bound to it (${list(active.map((scanner) => scanner.label))}).`);
  const other = bound.length - active.length;
  if (other) blockers.push(`${plural(other, 'other device')} (revoked or not set up) ${other === 1 ? 'is' : 'are'} bound to it.`);
  const using = policies.filter((policy) => policy.gateIds.includes(gate.id));
  if (using.length) blockers.push(`${using.length === 1 ? 'The policy' : 'The policies'} ${list(using.map((policy) => `“${policy.name}”`))} ${using.length === 1 ? 'allows' : 'allow'} entry through it.`);
  if (gate.admittedCount) blockers.push(`${plural(gate.admittedCount, 'person was', 'people were')} admitted through it; those check-ins stay attached to this gate.`);
  return blockers;
}

export interface PolicyDraft {
  opensAt: string | null;
  closesAt: string | null;
  capacity: number | null;
  gateIds: string[];
}

/**
 * How an edit narrows who a policy admits from now on: capacity, window and gates. Widening changes return
 * nothing. `format` renders an instant in the event's zone.
 */
export function policyNarrowing(
  event: Pick<EventSummary, 'startsAt' | 'endsAt'>,
  policy: AdmissionPolicy,
  next: PolicyDraft,
  gates: Gate[],
  scanners: Scanner[],
  format: (iso: string) => string,
  now = Date.now()
): string[] {
  const lines: string[] = [];
  const waiting = Math.max(policy.passCount - policy.admittedCount, 0);
  /** "its 3 passes not yet admitted are refused" / "its 1 pass not yet admitted is refused". */
  const refused = waiting ? `its ${plural(waiting, 'pass', 'passes')} not yet admitted ${waiting === 1 ? 'is' : 'are'} refused` : 'its passes are refused';

  if (next.capacity !== null && (policy.capacity === null || next.capacity < policy.capacity)) {
    const left = next.capacity - policy.admittedCount;
    if (left <= 0) lines.push(`The policy is full as soon as you save: ${refused} as Capacity full.`);
    else if (left < waiting) lines.push(`Only ${left} more can enter; the rest of its ${plural(waiting, 'pass', 'passes')} not yet admitted are refused as Capacity full.`);
  }

  const closesBefore = Date.parse(policy.closesAt ?? event.endsAt);
  const closesAfter = Date.parse(next.closesAt ?? event.endsAt);
  if (closesAfter < closesBefore) {
    lines.push(closesAfter <= now ? `Entry closes now: ${refused} as Too late.` : `Entry closes earlier, at ${format(new Date(closesAfter).toISOString())}; after that ${refused} as Too late.`);
  }
  const opensBefore = Date.parse(policy.opensAt ?? event.startsAt);
  const opensAfter = Date.parse(next.opensAt ?? event.startsAt);
  if (opensAfter > opensBefore && opensAfter > now && opensBefore <= now) {
    lines.push(`Entry pauses until ${format(new Date(opensAfter).toISOString())}: until then ${refused} as Too early.`);
  }

  // An empty list allows every gate, so only a non-empty new list can shut a gate.
  if (next.gateIds.length) {
    const closed = gates.filter((gate) => !next.gateIds.includes(gate.id) && (policy.gateIds.length === 0 || policy.gateIds.includes(gate.id)));
    for (const gate of closed) {
      const active = scanners.filter((scanner) => scanner.gateId === gate.id && canScan(scanner)).length;
      lines.push(`${gate.name} stops accepting these passes${active ? ` (${plural(active, 'active scanner')} there ${active === 1 ? 'refuses' : 'refuse'} them as Wrong gate)` : ''}.`);
    }
  }
  return lines;
}

/** What revoking or re-keying a device means for its door while the doors are open. Empty for a device that cannot scan. */
export function deviceStop(scanner: Scanner, scanners: Scanner[], format: (iso: string) => string): string[] {
  if (!canScan(scanner)) return [];
  const door = scanner.gateName ?? 'any gate';
  const lines = [`“${scanner.label}” (${door}) stops admitting on its next scan${scanner.lastUsedAt ? `; it was last used at ${format(scanner.lastUsedAt)}` : ''}.`];
  // A device without a gate covers every door; one bound to a gate is covered by the others at that gate and by unbound ones.
  const others = scanners.filter((other) => other.id !== scanner.id && canScan(other) && (scanner.gateId === null || other.gateId === null || other.gateId === scanner.gateId));
  lines.push(
    others.length
      ? `${plural(others.length, 'other active device')} can still admit ${scanner.gateId ? `at ${door}` : 'people'}: ${list(others.map((other) => other.label))}.`
      : scanner.gateId
        ? `No other active device can admit at ${door}: nobody can be checked in there until another device is set up.`
        : 'No other active device is left: nobody can be checked in until another device is set up.'
  );
  return lines;
}

/** Ending or archiving while the doors are open. */
export function closingNow(event: EventSummary): string[] {
  const waiting = Math.max(event.passCount - event.redeemedCount - event.revokedCount, 0);
  const ready = event.readyScannerCount;
  return [
    `${ready ? `${plural(ready, 'active scanner')} ${ready === 1 ? 'stops admitting on its' : 'stop admitting on their'}` : 'Scanners stop admitting on their'} next scan; every pass is refused as Event closed.`,
    `${plural(waiting, 'pass', 'passes')} not used yet can no longer enter.`,
    `The ${plural(event.redeemedCount, 'admission')} so far ${event.redeemedCount === 1 ? 'stays' : 'stay'} recorded.`
  ];
}

export interface EventDraft {
  startsAt: string;
  endsAt: string;
  capacity: number | null;
}

/** Edits to an open event's window or capacity that refuse people from now on. */
export function eventNarrowing(event: EventSummary, next: EventDraft, format: (iso: string) => string, now = Date.now()): string[] {
  const lines: string[] = [];
  const waiting = Math.max(event.passCount - event.redeemedCount - event.revokedCount, 0);
  const ends = Date.parse(next.endsAt);
  if (ends < Date.parse(event.endsAt)) {
    lines.push(
      ends <= now
        ? 'The event window closes now: passes without a policy window of their own are refused as Too late.'
        : `The event window closes earlier, at ${format(next.endsAt)}; after that passes without a policy window of their own are refused as Too late.`
    );
  }
  const starts = Date.parse(next.startsAt);
  if (starts > Date.parse(event.startsAt) && starts > now) {
    lines.push(`Entry pauses until ${format(next.startsAt)}: passes without a policy window of their own are refused as Too early until then.`);
  }
  if (next.capacity !== null && (event.capacity === null || next.capacity < event.capacity)) {
    const left = next.capacity - event.admittedCount;
    if (left <= 0) lines.push(`The event is full as soon as you save: every further pass is refused as Capacity full (${plural(waiting, 'pass', 'passes')} not used yet).`);
    else if (left < waiting) lines.push(`Only ${left} more can enter; ${waiting - left} of the ${plural(waiting, 'pass', 'passes')} not used yet would be refused as Capacity full.`);
  }
  return lines;
}
