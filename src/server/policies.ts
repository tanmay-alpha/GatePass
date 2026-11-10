import { randomUUID } from 'node:crypto';
import type { AdmissionPolicy, Gate } from '../shared/types';
import type { AdmissionInput } from './admission';
import { recordAudit } from './audit';
import { transaction, type Database } from './db';
import { httpError } from './http';
import { isConstraintError, isoDate } from './values';

export interface PolicyInput {
  name: string;
  opensAt?: string | null;
  closesAt?: string | null;
  capacity?: number | null;
  gateIds?: string[];
}

type Row = Record<string, unknown>;

/** Gates and admission policies of an event (docs/decisions/0004-admission-policy-engine.md). */
export class AccessControl {
  constructor(
    private readonly db: Database,
    private readonly now: () => string
  ) {}

  // ---------------------------------------------------------------- gates

  listGates(eventId: string): Gate[] {
    const rows = this.db
      .prepare(
        `SELECT g.*, (SELECT COUNT(*) FROM redemptions r WHERE r.gate_id = g.id) AS admitted_count
         FROM gates g WHERE g.event_id = ? ORDER BY g.name`
      )
      .all(eventId) as Row[];
    return rows.map(toGate);
  }

  createGate(eventId: string, name: string, actor: string): Gate {
    const id = randomUUID();
    transaction(this.db, () => {
      try {
        this.db.prepare('INSERT INTO gates (id, event_id, name, created_at) VALUES (?, ?, ?, ?)').run(id, eventId, name, this.now());
      } catch (error) {
        if (isConstraintError(error, 'UNIQUE')) throw httpError(409, 'A gate with that name already exists');
        throw error;
      }
      recordAudit(this.db, { eventId, actor, action: 'gate.created', entityId: id, details: { name }, at: this.now() });
    });
    return this.listGates(eventId).find((gate) => gate.id === id)!;
  }

  /** Throws 400 unless `gateId` is a gate of `eventId`; prevents cross-event references. */
  assertGate(eventId: string, gateId: string): { id: string; name: string } {
    const row = this.db.prepare('SELECT id, name FROM gates WHERE id = ? AND event_id = ?').get(gateId, eventId) as Row | undefined;
    if (!row) throw httpError(400, 'Unknown gate for this event');
    return { id: row.id as string, name: row.name as string };
  }

  /** Event of a gate, or 404. Used to authorize gate routes. */
  gateEventId(gateId: string): string {
    const row = this.db.prepare('SELECT event_id FROM gates WHERE id = ?').get(gateId) as Row | undefined;
    if (!row) throw httpError(404, 'Gate not found');
    return row.event_id as string;
  }

  renameGate(gateId: string, name: string, actor: string): Gate {
    const eventId = this.gateEventId(gateId);
    transaction(this.db, () => {
      try {
        this.db.prepare('UPDATE gates SET name = ? WHERE id = ?').run(name, gateId);
      } catch (error) {
        if (isConstraintError(error, 'UNIQUE')) throw httpError(409, 'A gate with that name already exists');
        throw error;
      }
      recordAudit(this.db, { eventId, actor, action: 'gate.renamed', entityId: gateId, details: { name }, at: this.now() });
    });
    return this.listGates(eventId).find((gate) => gate.id === gateId)!;
  }

  /** Only gates nothing refers to: no scanner, policy, redemption or scan history. */
  deleteGate(gateId: string, actor: string): void {
    const eventId = this.gateEventId(gateId);
    transaction(this.db, () => {
      const used = this.db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM scanners WHERE gate_id = :id) + (SELECT COUNT(*) FROM policy_gates WHERE gate_id = :id)
                + (SELECT COUNT(*) FROM redemptions WHERE gate_id = :id) + (SELECT COUNT(*) FROM scans WHERE gate_id = :id) AS n`
        )
        .get({ id: gateId }) as Row;
      if (Number(used.n) > 0) throw httpError(409, 'This gate is used by scanners, policies or scan history and cannot be deleted. Rename it instead.');
      this.db.prepare('DELETE FROM gates WHERE id = ?').run(gateId);
      recordAudit(this.db, { eventId, actor, action: 'gate.deleted', entityId: gateId, details: {}, at: this.now() });
    });
  }

  /** Event of a policy, or 404. Used to authorize policy routes. */
  policyEventId(policyId: string): string {
    const row = this.db.prepare('SELECT event_id FROM admission_policies WHERE id = ?').get(policyId) as Row | undefined;
    if (!row) throw httpError(404, 'Admission policy not found');
    return row.event_id as string;
  }

  /** Only policies with no passes and no admissions. */
  deletePolicy(policyId: string, actor: string): void {
    const eventId = this.policyEventId(policyId);
    transaction(this.db, () => {
      const used = this.db
        .prepare('SELECT (SELECT COUNT(*) FROM passes WHERE policy_id = :id) + (SELECT COUNT(*) FROM redemptions WHERE policy_id = :id) AS n')
        .get({ id: policyId }) as Row;
      if (Number(used.n) > 0) throw httpError(409, 'Passes use this policy, so it cannot be deleted. Move them to another policy first.');
      this.db.prepare('DELETE FROM admission_policies WHERE id = ?').run(policyId);
      recordAudit(this.db, { eventId, actor, action: 'policy.deleted', entityId: policyId, details: {}, at: this.now() });
    });
  }

  // ---------------------------------------------------------------- policies

  listPolicies(eventId: string): AdmissionPolicy[] {
    const rows = this.db
      .prepare(
        `SELECT ap.*, (SELECT COUNT(*) FROM passes p WHERE p.policy_id = ap.id) AS pass_count
         FROM admission_policies ap WHERE ap.event_id = ? ORDER BY COALESCE(ap.opens_at, ''), ap.name`
      )
      .all(eventId) as Row[];
    return rows.map((row) => this.toPolicy(row));
  }

  getPolicy(policyId: string): AdmissionPolicy {
    const row = this.db
      .prepare('SELECT ap.*, (SELECT COUNT(*) FROM passes p WHERE p.policy_id = ap.id) AS pass_count FROM admission_policies ap WHERE ap.id = ?')
      .get(policyId) as Row | undefined;
    if (!row) throw httpError(404, 'Admission policy not found');
    return this.toPolicy(row);
  }

  /** Throws 400 unless `policyId` belongs to `eventId`. */
  assertPolicy(eventId: string, policyId: string): void {
    if (!this.db.prepare('SELECT 1 FROM admission_policies WHERE id = ? AND event_id = ?').get(policyId, eventId)) {
      throw httpError(400, 'Unknown admission policy for this event');
    }
  }

  createPolicy(eventId: string, input: PolicyInput, actor: string): AdmissionPolicy {
    const id = randomUUID();
    const now = this.now();
    transaction(this.db, () => {
      const opensAt = input.opensAt ? isoDate(input.opensAt) : null;
      const closesAt = input.closesAt ? isoDate(input.closesAt) : null;
      assertWindow(opensAt, closesAt);
      this.write(() =>
        this.db
          .prepare('INSERT INTO admission_policies (id, event_id, name, opens_at, closes_at, capacity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, eventId, input.name, opensAt, closesAt, input.capacity ?? null, now, now)
      );
      this.setGates(eventId, id, input.gateIds ?? []);
      recordAudit(this.db, { eventId, actor, action: 'policy.created', entityId: id, details: { name: input.name, capacity: input.capacity ?? null }, at: now });
    });
    return this.getPolicy(id);
  }

  updatePolicy(policyId: string, patch: Partial<PolicyInput>, actor: string): AdmissionPolicy {
    transaction(this.db, () => {
      const current = this.getPolicy(policyId);
      const opensAt = patch.opensAt === undefined ? current.opensAt : patch.opensAt ? isoDate(patch.opensAt) : null;
      const closesAt = patch.closesAt === undefined ? current.closesAt : patch.closesAt ? isoDate(patch.closesAt) : null;
      assertWindow(opensAt, closesAt);
      const capacity = patch.capacity === undefined ? current.capacity : patch.capacity;
      if (capacity !== null && capacity < current.admittedCount) {
        throw httpError(409, `Capacity cannot be lower than the ${current.admittedCount} people already admitted`);
      }
      this.write(() =>
        this.db
          .prepare('UPDATE admission_policies SET name = ?, opens_at = ?, closes_at = ?, capacity = ?, updated_at = ? WHERE id = ?')
          .run(patch.name ?? current.name, opensAt, closesAt, capacity, this.now(), policyId)
      );
      if (patch.gateIds) {
        this.db.prepare('DELETE FROM policy_gates WHERE policy_id = ?').run(policyId);
        this.setGates(current.eventId, policyId, patch.gateIds);
      }
      const details: Record<string, unknown> = { fields: Object.keys(patch) };
      if (capacity !== current.capacity) details.capacity = { from: current.capacity, to: capacity };
      if (opensAt !== current.opensAt || closesAt !== current.closesAt) details.window = { from: [current.opensAt, current.closesAt], to: [opensAt, closesAt] };
      if (patch.gateIds) details.gateIds = { from: current.gateIds, to: [...new Set(patch.gateIds)] };
      recordAudit(this.db, { eventId: current.eventId, actor, action: 'policy.updated', entityId: policyId, details, at: this.now() });
    });
    return this.getPolicy(policyId);
  }

  /** Policy as seen by the admission evaluator, or null for the default policy. Hot path: indexed lookups only, no aggregates. */
  admissionPolicy(policyId: string | null): (NonNullable<AdmissionInput['policy']> & { id: string }) | null {
    if (!policyId) return null;
    const row = this.db
      .prepare('SELECT id, name, opens_at, closes_at, capacity, admitted_count FROM admission_policies WHERE id = ?')
      .get(policyId) as Row | undefined;
    if (!row) throw new Error(`Pass references missing policy ${policyId}`); // prevented by the foreign key
    const gates = this.db
      .prepare('SELECT g.id, g.name FROM policy_gates pg JOIN gates g ON g.id = pg.gate_id WHERE pg.policy_id = ? ORDER BY g.name')
      .all(policyId) as Array<{ id: string; name: string }>;
    return {
      id: row.id as string,
      name: row.name as string,
      opensAt: (row.opens_at as string | null) ?? null,
      closesAt: (row.closes_at as string | null) ?? null,
      capacity: row.capacity === null ? null : Number(row.capacity),
      admittedCount: Number(row.admitted_count),
      gates
    };
  }

  /**
   * Atomically takes one admission from the policy's capacity. Returns false
   * when the policy is full. Must run inside the redeem transaction.
   */
  claimCapacity(policyId: string): boolean {
    const result = this.db
      .prepare('UPDATE admission_policies SET admitted_count = admitted_count + 1 WHERE id = ? AND (capacity IS NULL OR admitted_count < capacity)')
      .run(policyId);
    return result.changes === 1;
  }

  private setGates(eventId: string, policyId: string, gateIds: string[]): void {
    const insert = this.db.prepare('INSERT INTO policy_gates (policy_id, gate_id) VALUES (?, ?)');
    for (const gateId of new Set(gateIds)) {
      this.assertGate(eventId, gateId);
      insert.run(policyId, gateId);
    }
  }

  private write(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      if (isConstraintError(error, 'UNIQUE')) throw httpError(409, 'A policy with that name already exists');
      if (isConstraintError(error, 'CHECK')) throw httpError(409, 'Policy values are inconsistent (window or capacity)');
      throw error;
    }
  }

  private toPolicy(row: Row): AdmissionPolicy {
    const gateIds = (this.db.prepare('SELECT gate_id FROM policy_gates WHERE policy_id = ?').all(row.id as string) as Array<{ gate_id: string }>).map(
      (gate) => gate.gate_id
    );
    return {
      id: row.id as string,
      eventId: row.event_id as string,
      name: row.name as string,
      opensAt: (row.opens_at as string | null) ?? null,
      closesAt: (row.closes_at as string | null) ?? null,
      capacity: row.capacity === null ? null : Number(row.capacity),
      admittedCount: Number(row.admitted_count),
      gateIds,
      passCount: Number(row.pass_count ?? 0),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string
    };
  }
}

function toGate(row: Row): Gate {
  return {
    id: row.id as string,
    eventId: row.event_id as string,
    name: row.name as string,
    createdAt: row.created_at as string,
    admittedCount: Number(row.admitted_count ?? 0)
  };
}

function assertWindow(opensAt: string | null, closesAt: string | null): void {
  if (opensAt && closesAt && closesAt <= opensAt) throw httpError(400, 'Entry must close after it opens.');
}
