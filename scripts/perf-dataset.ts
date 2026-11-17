/**
 * Synthetic event data for the phase 5 performance scripts
 * (scripts/perf-queries.ts, scripts/perf-phase5.ts). Rows are inserted
 * directly, in one transaction, with the same columns, constraints and
 * triggers the service writes through; `verifyDatabase` passes on the result.
 *
 * Shape of one event with N passes (seeded PRNG, so every run is identical):
 *   6 gates; policies General (gates 1-4), VIP (gates 5-6), Staff (any gate);
 *   12 enrolled scanners (gates 1-6, 1-4, one roaming, one more on gate 5)
 *   plus one revoked scanner;
 *   passes: 80% General, 10% VIP, 10% Staff, issued over the last 30 days in
 *   import-sized batches; 2% revoked, 1% expired; 1% of names start with '='
 *   (formula-injection path of the CSV exports), 5% contain a comma or quote;
 *   history ≈ 1.3 N scans in the two hours before `now`, mixed outcomes and
 *   methods: ~60% of passes admitted (one redemption + one admitted scan each),
 *   duplicates, wrong gate, invalid, revoked, expired, too early, capacity
 *   full, wrong event; ~N/10 audit rows; pass_deliveries for 20% of passes.
 * The remaining active passes are returned with their tokens for live traffic.
 */
import type { Database } from '../src/server/db';
import { hashToken } from '../src/server/tokens';

export interface SeededEvent {
  eventId: string;
  gateIds: string[];
  policyIds: { general: string; vip: string; staff: string };
  /** Index-aligned with SCANNER_GATES; the revoked device is not included. */
  scanners: Array<{ id: string; key: string; gateIndex: number | null }>;
  /** Active, never admitted passes and their raw tokens, in seeded random order. */
  live: Array<{ token: string; passId: string; policy: 'general' | 'vip' | 'staff' }>;
  counts: { passes: number; scans: number; redemptions: number; audit: number; deliveries: number };
}

/** Gate index (0-based) per scanner; null = roaming device that may admit at any gate. */
export const SCANNER_GATES: Array<number | null> = [0, 1, 2, 3, 4, 5, 0, 1, 2, 3, null, 4];

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

const MINUTE = 60_000;

/** Seeds one event with `passes` passes. Call inside no transaction; it opens its own. */
export function seedEvent(db: Database, options: { passes: number; now: Date; seed?: number; name?: string; timeZone?: string }): SeededEvent {
  const random = mulberry32(options.seed ?? 1);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
  const now = options.now.getTime();
  const iso = (ms: number) => new Date(ms).toISOString();
  const token = () => {
    const bytes = Buffer.alloc(32);
    for (let i = 0; i < 32; i += 1) bytes[i] = Math.floor(random() * 256);
    return bytes.toString('base64url');
  };
  const uuid = () => {
    // Seeded v4-shaped ids keep runs comparable (pass references are the first 8 hex digits).
    const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16)).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };

  const eventId = uuid();
  const startsAt = iso(now - 120 * MINUTE);
  const endsAt = iso(now + 6 * 60 * MINUTE);
  const created = iso(now - 30 * 24 * 60 * MINUTE);
  const counts = { passes: 0, scans: 0, redemptions: 0, audit: 0, deliveries: 0 };
  const audit = db.prepare('INSERT INTO audit_log (event_id, actor, action, entity_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const addAudit = (action: string, entityId: string | null, details: object, at: string) => {
    audit.run(eventId, 'operator', action, entityId, JSON.stringify(details), at);
    counts.audit += 1;
  };

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      "INSERT INTO events (id, name, venue, time_zone, starts_at, ends_at, status, capacity, design_json, created_at, updated_at) VALUES (?, ?, 'Hall A', ?, ?, ?, 'active', NULL, '{}', ?, ?)"
    ).run(eventId, options.name ?? `Perf event ${options.passes}`, options.timeZone ?? 'Europe/London', startsAt, endsAt, created, created);
    addAudit('event.created', eventId, { name: options.name ?? 'Perf event' }, created);

    const gateIds = Array.from({ length: 6 }, (_, index) => {
      const id = uuid();
      db.prepare('INSERT INTO gates (id, event_id, name, created_at) VALUES (?, ?, ?, ?)').run(id, eventId, `Gate ${index + 1}`, created);
      addAudit('gate.created', id, { name: `Gate ${index + 1}` }, created);
      return id;
    });
    const policy = (name: string, gates: number[]) => {
      const id = uuid();
      db.prepare('INSERT INTO admission_policies (id, event_id, name, opens_at, closes_at, capacity, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?)').run(
        id,
        eventId,
        name,
        created,
        created
      );
      for (const gate of gates) db.prepare('INSERT INTO policy_gates (policy_id, gate_id) VALUES (?, ?)').run(id, gateIds[gate]);
      addAudit('policy.created', id, { name }, created);
      return id;
    };
    const policyIds = { general: policy('General', [0, 1, 2, 3]), vip: policy('VIP', [4, 5]), staff: policy('Staff', []) };
    const policyGates: Record<keyof typeof policyIds, number[] | null> = { general: [0, 1, 2, 3], vip: [4, 5], staff: null };

    const insertScanner = db.prepare(
      'INSERT INTO scanners (id, event_id, gate_id, label, key_hash, created_at, revoked_at, last_used_at, last_seen_at, key_issued_by, enrolled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const scanners = SCANNER_GATES.map((gateIndex, index) => {
      const id = uuid();
      const key = token();
      const label = gateIndex === null ? `Roaming ${index + 1}` : `Door ${index + 1} (Gate ${gateIndex + 1})`;
      insertScanner.run(id, eventId, gateIndex === null ? null : gateIds[gateIndex], label, hashToken(key), created, null, null, null, 'operator', created);
      addAudit('scanner.created', id, { label }, created);
      return { id, key, gateIndex };
    });
    const revokedScanner = uuid();
    insertScanner.run(revokedScanner, eventId, gateIds[0], 'Lost phone', hashToken(token()), created, iso(now - 90 * MINUTE), iso(now - 95 * MINUTE), iso(now - 95 * MINUTE), 'operator', created);
    addAudit('scanner.revoked', revokedScanner, {}, iso(now - 90 * MINUTE));

    // ---- passes
    const insertPass = db.prepare(
      'INSERT INTO passes (id, event_id, token_hash, attendee_name, attendee_email, expires_at, created_at, revoked_at, policy_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    type Seeded = { id: string; token: string; tokenHash: string; email: string | null; policy: keyof typeof policyIds; state: 'active' | 'revoked' | 'expired' };
    const passes: Seeded[] = [];
    const batch = 500;
    for (let start = 0; start < options.passes; start += batch) {
      const issuedAt = now - 30 * 24 * 60 * MINUTE + Math.floor((start / options.passes) * 29 * 24 * 60) * MINUTE;
      const size = Math.min(batch, options.passes - start);
      for (let offset = 0; offset < size; offset += 1) {
        const n = start + offset;
        const roll = random();
        const policyName: keyof typeof policyIds = roll < 0.8 ? 'general' : roll < 0.9 ? 'vip' : 'staff';
        const stateRoll = random();
        const state = stateRoll < 0.02 ? 'revoked' : stateRoll < 0.03 ? 'expired' : 'active';
        const nameRoll = random();
        const name =
          nameRoll < 0.01 ? `=HYPERLINK("x",${n})` : nameRoll < 0.06 ? `Doe, "J" ${n}` : nameRoll < 0.1 ? null : `Attendee ${String(n).padStart(6, '0')}`;
        const email = random() < 0.85 ? `attendee${n}@example.test` : null;
        const raw = token();
        const pass: Seeded = { id: uuid(), token: raw, tokenHash: hashToken(raw), email, policy: policyName, state };
        insertPass.run(
          pass.id,
          eventId,
          pass.tokenHash,
          name,
          email,
          state === 'expired' ? iso(now - 60 * MINUTE) : endsAt,
          iso(issuedAt + offset),
          state === 'revoked' ? iso(now - 180 * MINUTE) : null,
          policyIds[policyName]
        );
        passes.push(pass);
        if (state === 'revoked') addAudit('pass.revoked', pass.id, {}, iso(now - 180 * MINUTE));
      }
      addAudit('passes.issued', null, { count: size }, iso(issuedAt));
    }
    counts.passes = passes.length;

    // ---- pass emails for 20% of passes with an address (accepted by the provider long ago)
    const insertDelivery = db.prepare(
      "INSERT INTO pass_deliveries (id, event_id, pass_id, recipient, token_hash, status, attempts, created_by, created_at, updated_at, accepted_at) VALUES (?, ?, ?, ?, ?, 'accepted', 1, 'operator', ?, ?, ?)"
    );
    for (const pass of passes) {
      if (!pass.email || random() >= 0.2) continue;
      const at = iso(now - 20 * 24 * 60 * MINUTE);
      insertDelivery.run(uuid(), eventId, pass.id, pass.email, pass.tokenHash, at, at, at);
      counts.deliveries += 1;
    }

    // ---- scan history in the two hours before `now`, arrivals peaking ~1 h ago
    const insertScan = db.prepare(
      'INSERT INTO scans (event_id, scanner_id, gate_id, pass_id, outcome, created_at, request_id, method) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const insertRedemption = db.prepare('INSERT INTO redemptions (pass_id, scanner_id, gate_id, policy_id, redeemed_at) VALUES (?, ?, ?, ?, ?)');
    const arrival = () => now - Math.round(((random() + random()) / 2) * 115 * MINUTE + MINUTE);
    const method = () => {
      const roll = random();
      return roll < 0.85 ? 'camera' : roll < 0.95 ? 'manual' : 'lookup';
    };
    let requestSeq = 0;
    type Row = { at: number; scanner: number; passId: string | null; outcome: string; method: string };
    const history: Row[] = [];
    const scannerFor = (policyName: keyof typeof policyIds) => {
      const gates = policyGates[policyName];
      const allowed = SCANNER_GATES.map((gate, index) => ({ gate, index })).filter(({ gate }) => gate === null || !gates || gates.includes(gate));
      return pick(allowed).index;
    };
    const admittedPasses: Seeded[] = [];
    const policyAdmitted: Record<keyof typeof policyIds, number> = { general: 0, vip: 0, staff: 0 };
    const live: SeededEvent['live'] = [];
    for (const pass of passes) {
      if (pass.state === 'active' && random() < 0.62) {
        const scanner = scannerFor(pass.policy);
        const at = arrival();
        history.push({ at, scanner, passId: pass.id, outcome: 'admitted', method: method() });
        insertRedemption.run(pass.id, scanners[scanner].id, SCANNER_GATES[scanner] === null ? null : gateIds[SCANNER_GATES[scanner]!], policyIds[pass.policy], iso(at));
        policyAdmitted[pass.policy] += 1;
        admittedPasses.push(pass);
      } else if (pass.state === 'active') {
        live.push({ token: pass.token, passId: pass.id, policy: pass.policy });
      }
    }
    counts.redemptions = admittedPasses.length;
    const extra = (count: number, make: () => Omit<Row, 'at' | 'method'> & { at?: number }) => {
      for (let i = 0; i < count; i += 1) {
        const row = make();
        history.push({ at: row.at ?? arrival(), method: method(), ...row });
      }
    };
    const n = passes.length;
    const revoked = passes.filter((pass) => pass.state === 'revoked');
    const expired = passes.filter((pass) => pass.state === 'expired');
    const vipPasses = live.filter((pass) => pass.policy === 'vip');
    const generalLive = live.filter((pass) => pass.policy === 'general');
    // Re-scans of admitted passes, some minutes after their admission.
    extra(Math.round(0.3 * n), () => ({ scanner: Math.floor(random() * SCANNER_GATES.length), passId: pick(admittedPasses).id, outcome: 'already_redeemed' }));
    // General passes shown at a VIP gate.
    extra(Math.round(0.15 * n), () => ({ scanner: pick([4, 5, 11]), passId: pick(generalLive).passId, outcome: 'wrong_gate' }));
    extra(Math.round(0.12 * n), () => ({ scanner: Math.floor(random() * SCANNER_GATES.length), passId: null, outcome: 'invalid' }));
    extra(Math.round(0.03 * n), () => ({ scanner: Math.floor(random() * SCANNER_GATES.length), passId: null, outcome: 'wrong_event' }));
    if (revoked.length) extra(Math.round(0.02 * n), () => ({ scanner: Math.floor(random() * SCANNER_GATES.length), passId: pick(revoked).id, outcome: 'revoked' }));
    if (expired.length) extra(Math.round(0.01 * n), () => ({ scanner: Math.floor(random() * SCANNER_GATES.length), passId: pick(expired).id, outcome: 'expired' }));
    // Early arrivals before the doors opened.
    extra(Math.round(0.05 * n), () => ({ scanner: Math.floor(random() * SCANNER_GATES.length), passId: pick(live).passId, outcome: 'too_early', at: now - 125 * MINUTE - Math.floor(random() * 20 * MINUTE) }));
    if (vipPasses.length) extra(Math.round(0.02 * n), () => ({ scanner: pick([4, 5]), passId: pick(vipPasses).passId, outcome: 'capacity_full' }));
    history.sort((a, b) => a.at - b.at);
    for (const row of history) {
      const scanner = scanners[row.scanner];
      requestSeq += 1;
      insertScan.run(
        eventId,
        scanner.id,
        scanner.gateIndex === null ? null : gateIds[scanner.gateIndex],
        row.passId,
        row.outcome,
        iso(row.at),
        `seed-${eventId.slice(0, 8)}-${requestSeq}`,
        row.method
      );
    }
    counts.scans = history.length;
    const lastAt = new Map<number, number>();
    for (const row of history) lastAt.set(row.scanner, row.at);
    for (const [index, at] of lastAt) db.prepare('UPDATE scanners SET last_used_at = ?, last_seen_at = ? WHERE id = ?').run(iso(at), iso(at), scanners[index].id);
    for (const [name, admitted] of Object.entries(policyAdmitted)) {
      db.prepare('UPDATE admission_policies SET admitted_count = ? WHERE id = ?').run(admitted, policyIds[name as keyof typeof policyIds]);
    }
    db.prepare('UPDATE events SET admitted_count = ? WHERE id = ?').run(admittedPasses.length, eventId);
    // A trail of earlier downloads and lookups, as an organizer leaves during an event.
    for (let i = 0; counts.audit < Math.round(n / 10); i += 1) {
      addAudit(i % 3 ? 'export.downloaded' : 'pass.reissued', i % 3 ? null : pick(passes).id, i % 3 ? { kind: 'attendance', rows: n } : {}, iso(now - Math.floor(random() * 100) * MINUTE));
    }
    db.exec('COMMIT');
    // Seeded shuffle so live traffic does not walk passes in issue order.
    for (let i = live.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [live[i], live[j]] = [live[j], live[i]];
    }
    return { eventId, gateIds, policyIds, scanners, live, counts };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
