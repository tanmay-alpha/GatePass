import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DesignError, normalizeDesignConfig, templates as designPresets } from '../qr/design';
import type { DesignConfig, EventSummary, EventTemplate, EventTemplateConfig } from '../shared/types';
import type { Accounts } from './accounts';
import { recordAudit } from './audit';
import { transaction, type Database } from './db';
import { httpError } from './http';
import type { AccessControl } from './policies';
import { assertTimeZone, assertWindow, isConstraintError, isoDate } from './values';

/** Serialized `config_json` limit, checked on write and on read. */
export const TEMPLATE_CONFIG_MAX_BYTES = 16 * 1024;
/** Saved templates per account. */
export const MAX_TEMPLATES_PER_ACCOUNT = 50;

const DAY_MINUTES = 24 * 60;
const offset = z.number().int().min(-30 * DAY_MINUTES).max(366 * DAY_MINUTES);
const gateName = z.string().trim().min(1).max(100);
const PRESET_NAMES: readonly string[] = designPresets.map((preset) => preset.name);

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The only shape a template may have, on write and on read. Strict objects:
 * an unknown key (a token, an attendee list, a scanner) is a validation error,
 * not something silently stored.
 */
export const templateConfigSchema = z
  .strictObject({
    version: z.literal(1),
    durationMinutes: z.number().int().min(5).max(366 * DAY_MINUTES),
    timeZone: z.string().trim().min(1).max(64).refine(isTimeZone, 'Unknown time zone').nullable(),
    venue: z.string().trim().max(200).nullable(),
    capacity: z.number().int().min(1).max(1_000_000).nullable(),
    designPreset: z
      .string()
      .refine((name) => PRESET_NAMES.includes(name), 'Unknown design preset')
      .nullable(),
    design: z.record(z.string(), z.unknown()).nullable(),
    gates: z.array(gateName).max(50),
    policies: z
      .array(
        z.strictObject({
          name: z.string().trim().min(1).max(100),
          opensOffsetMinutes: offset.nullable(),
          closesOffsetMinutes: offset.nullable(),
          capacity: z.number().int().min(1).max(1_000_000).nullable(),
          gates: z.array(gateName).max(50)
        })
      )
      .max(50)
  })
  .superRefine((config, ctx) => {
    const issue = (message: string, path: PropertyKey[]) => ctx.addIssue({ code: 'custom', message, path });
    if (new Set(config.gates).size !== config.gates.length) issue('Gate names must be unique', ['gates']);
    if (new Set(config.policies.map((policy) => policy.name)).size !== config.policies.length) issue('Policy names must be unique', ['policies']);
    const gates = new Set(config.gates);
    config.policies.forEach((policy, index) => {
      if (policy.gates.some((gate) => !gates.has(gate))) issue('Policy gates must be listed in gates', ['policies', index, 'gates']);
      if (policy.opensOffsetMinutes !== null && policy.closesOffsetMinutes !== null && policy.closesOffsetMinutes <= policy.opensOffsetMinutes) {
        issue('Entry must close after it opens', ['policies', index]);
      }
    });
    if (config.design) {
      try {
        normalizeDesignConfig(config.design as Partial<DesignConfig>);
      } catch (error) {
        if (!(error instanceof DesignError)) throw error;
        issue(error.message, ['design']);
      }
    }
  });

/** Validates and canonicalizes untrusted template config (design normalized); throws ZodError or a 400. */
export function parseTemplateConfig(input: unknown): EventTemplateConfig {
  const parsed = templateConfigSchema.parse(input);
  const config: EventTemplateConfig = { ...parsed, design: parsed.design ? normalizeDesignConfig(parsed.design as Partial<DesignConfig>) : null };
  if (Buffer.byteLength(JSON.stringify(config)) > TEMPLATE_CONFIG_MAX_BYTES) throw httpError(400, 'This template is too large.');
  return config;
}

/** A stored row that no longer validates (manual edit, older build) is treated as unusable, never trusted. */
function readStoredConfig(json: string): EventTemplateConfig | null {
  if (json.length > TEMPLATE_CONFIG_MAX_BYTES) return null;
  try {
    return parseTemplateConfig(JSON.parse(json));
  } catch {
    return null;
  }
}

function builtin(slug: string, name: string, description: string, config: Omit<EventTemplateConfig, 'version' | 'timeZone' | 'venue' | 'design'>): EventTemplate {
  return {
    id: `builtin:${slug}`,
    kind: 'builtin',
    name,
    description,
    // Built-ins never fix a zone or venue: the form fills in the organizer's own browser zone.
    config: parseTemplateConfig({ version: 1, timeZone: null, venue: null, design: null, ...config }),
    createdAt: null,
    updatedAt: null
  };
}

/** Starting points offered to every organizer. Offsets are minutes from the event start. */
export const BUILTIN_TEMPLATES: readonly EventTemplate[] = [
  builtin('college-seminar', 'College seminar', 'Two-hour talk in a lecture hall. Speakers can enter an hour before the doors open for everyone else.', {
    durationMinutes: 120,
    capacity: 150,
    designPreset: 'Classic',
    gates: ['Main entrance'],
    policies: [
      { name: 'General', opensOffsetMinutes: -30, closesOffsetMinutes: null, capacity: null, gates: [] },
      { name: 'Speakers/VIP', opensOffsetMinutes: -90, closesOffsetMinutes: null, capacity: null, gates: [] }
    ]
  }),
  builtin('workshop', 'Workshop', 'Half-day hands-on session for a small group, checked in at a registration desk.', {
    durationMinutes: 180,
    capacity: 30,
    designPreset: 'Easy',
    gates: ['Registration desk'],
    policies: [
      { name: 'Participants', opensOffsetMinutes: -15, closesOffsetMinutes: 60, capacity: null, gates: [] },
      { name: 'Facilitators', opensOffsetMinutes: -60, closesOffsetMinutes: null, capacity: null, gates: [] }
    ]
  }),
  builtin('conference', 'Conference', 'Full-day conference: general admission at the main entrance and registration desk, a separate VIP entrance for speakers.', {
    durationMinutes: 8 * 60,
    capacity: 500,
    designPreset: 'CompleteTech',
    gates: ['Main entrance', 'Registration desk', 'VIP entrance'],
    policies: [
      { name: 'General', opensOffsetMinutes: -60, closesOffsetMinutes: null, capacity: null, gates: ['Main entrance', 'Registration desk'] },
      { name: 'Speakers/VIP', opensOffsetMinutes: -120, closesOffsetMinutes: null, capacity: null, gates: ['Main entrance', 'VIP entrance'] },
      { name: 'Exhibitors', opensOffsetMinutes: -180, closesOffsetMinutes: null, capacity: null, gates: ['Main entrance'] }
    ]
  }),
  builtin('campus-event', 'Campus event', 'Open-air campus event with two gates; guests use the main gate.', {
    durationMinutes: 4 * 60,
    capacity: 300,
    designPreset: 'Dot',
    gates: ['Main gate', 'Side gate'],
    policies: [
      { name: 'Students', opensOffsetMinutes: -30, closesOffsetMinutes: null, capacity: null, gates: [] },
      { name: 'Guests', opensOffsetMinutes: -30, closesOffsetMinutes: null, capacity: null, gates: ['Main gate'] }
    ]
  }),
  builtin('private-gathering', 'Private gathering', 'Small invitation-only evening at one door; hosts arrive early.', {
    durationMinutes: 4 * 60,
    capacity: 50,
    designPreset: 'Classic',
    gates: ['Front door'],
    policies: [
      { name: 'Guests', opensOffsetMinutes: -15, closesOffsetMinutes: null, capacity: null, gates: [] },
      { name: 'Hosts', opensOffsetMinutes: -60, closesOffsetMinutes: null, capacity: null, gates: [] }
    ]
  })
];

export interface TemplateEventInput {
  name: string;
  venue?: string | null;
  timeZone?: string;
  startsAt: string;
  /** Default: start + the template's duration. */
  endsAt?: string;
  capacity?: number | null;
  /** Default draft, like a cloned event. */
  status?: 'draft' | 'active';
}

interface Dependencies {
  access: AccessControl;
  accounts: Accounts;
  now: () => Date;
  getEvent: (id: string) => EventSummary;
}

type Row = Record<string, unknown>;

/**
 * Event templates (docs/decisions/0011-event-templates.md). Saved templates
 * are private to the account that saved them: another account's template
 * answers 404, exactly like a missing one.
 */
export class EventTemplates {
  constructor(
    private readonly db: Database,
    private readonly deps: Dependencies
  ) {}

  /** Built-ins, then the caller's saved templates by name. The operator (no account) sees built-ins only. */
  list(ownerId: string | null): EventTemplate[] {
    if (!ownerId) return [...BUILTIN_TEMPLATES];
    const rows = this.db.prepare('SELECT * FROM event_templates WHERE owner_id = ? ORDER BY name COLLATE NOCASE, id').all(ownerId) as Row[];
    const saved: EventTemplate[] = [];
    for (const row of rows) {
      const template = toTemplate(row);
      if (template) saved.push(template);
      else console.warn(JSON.stringify({ level: 'warn', msg: 'invalid event template skipped', templateId: row.id }));
    }
    return [...BUILTIN_TEMPLATES, ...saved];
  }

  get(templateId: string, ownerId: string | null): EventTemplate {
    const found = BUILTIN_TEMPLATES.find((template) => template.id === templateId);
    if (found) return found;
    const row = ownerId ? (this.db.prepare('SELECT * FROM event_templates WHERE id = ? AND owner_id = ?').get(templateId, ownerId) as Row | undefined) : undefined;
    if (!row) throw httpError(404, 'Template not found');
    const template = toTemplate(row);
    if (!template) throw httpError(409, 'This saved template is no longer valid. Delete it and save it again from an event.');
    return template;
  }

  create(ownerId: string | null, input: { name: string; description?: string | null; config: unknown }, actor: string): EventTemplate {
    const owner = requireOwner(ownerId);
    const config = parseTemplateConfig(input.config);
    return transaction(this.db, () => this.insert(owner, input.name, input.description ?? null, config, actor, null));
  }

  /**
   * Stores an event's settings, gates and policy shapes (times as minutes from
   * its start) as a private template of `ownerId`. Nothing else is read:
   * passes, attendees, scanners, team and credentials never enter a template.
   */
  saveFromEvent(eventId: string, ownerId: string | null, input: { name: string; description?: string | null }, actor: string): EventTemplate {
    const owner = requireOwner(ownerId);
    return transaction(this.db, () => {
      const event = this.deps.getEvent(eventId);
      const start = Date.parse(event.startsAt);
      const minutesFromStart = (value: string | null) => (value === null ? null : Math.round((Date.parse(value) - start) / 60_000));
      const gates = this.deps.access.listGates(eventId);
      const gateNames = new Map(gates.map((gate) => [gate.id, gate.name]));
      const config = parseTemplateConfig({
        version: 1,
        durationMinutes: Math.max(5, Math.round((Date.parse(event.endsAt) - start) / 60_000)),
        timeZone: event.timeZone,
        venue: event.venue,
        capacity: event.capacity,
        designPreset: null,
        design: event.design,
        gates: gates.map((gate) => gate.name),
        policies: this.deps.access.listPolicies(eventId).map((policy) => ({
          name: policy.name,
          opensOffsetMinutes: minutesFromStart(policy.opensAt),
          closesOffsetMinutes: minutesFromStart(policy.closesAt),
          capacity: policy.capacity,
          gates: policy.gateIds.map((id) => gateNames.get(id)!)
        }))
      });
      return this.insert(owner, input.name, input.description ?? null, config, actor, eventId);
    });
  }

  remove(templateId: string, ownerId: string | null, actor: string): void {
    if (BUILTIN_TEMPLATES.some((template) => template.id === templateId)) throw httpError(400, 'Built-in templates cannot be deleted.');
    const owner = requireOwner(ownerId);
    transaction(this.db, () => {
      const row = this.db.prepare('SELECT name FROM event_templates WHERE id = ? AND owner_id = ?').get(templateId, owner) as Row | undefined;
      if (!row) throw httpError(404, 'Template not found');
      this.db.prepare('DELETE FROM event_templates WHERE id = ?').run(templateId);
      this.audit(actor, 'template.deleted', templateId, { name: row.name });
    });
  }

  /**
   * Creates an event with the template's settings, gates and policies in one
   * transaction, following the clone pattern (`GatePass.cloneEvent`): policy
   * windows are placed relative to the new start. Form values override the
   * template's suggestions. `caller.ownerId` becomes the owner.
   */
  createEvent(templateId: string, input: TemplateEventInput, caller: { ownerId: string | null; actor: string }): EventSummary {
    const template = this.get(templateId, caller.ownerId);
    const { config } = template;
    const startsAt = isoDate(input.startsAt);
    const endsAt = input.endsAt ? isoDate(input.endsAt) : new Date(Date.parse(startsAt) + config.durationMinutes * 60_000).toISOString();
    assertWindow(startsAt, endsAt);
    const timeZone = assertTimeZone(input.timeZone ?? config.timeZone ?? 'UTC');
    const venue = input.venue === undefined ? config.venue : input.venue || null;
    const capacity = input.capacity === undefined ? config.capacity : input.capacity;
    const design = normalizeDesignConfig(config.design ?? designPresets.find((preset) => preset.name === config.designPreset)?.config ?? {});
    const status = input.status ?? 'draft';
    const at = (minutes: number | null) => (minutes === null ? null : new Date(Date.parse(startsAt) + minutes * 60_000).toISOString());
    const policies = config.policies.map((policy) => {
      const opensAt = at(policy.opensOffsetMinutes);
      const closesAt = at(policy.closesOffsetMinutes);
      if ((closesAt ?? endsAt) <= (opensAt ?? startsAt)) throw httpError(400, `Policy “${policy.name}” would close before it opens with this event window.`);
      return { ...policy, opensAt, closesAt };
    });
    const id = randomUUID();
    const now = this.timestamp();
    transaction(this.db, () => {
      this.db
        .prepare(
          'INSERT INTO events (id, name, venue, time_zone, starts_at, ends_at, status, capacity, design_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(id, input.name, venue, timeZone, startsAt, endsAt, status, capacity, JSON.stringify(design), now, now);
      const gateIds = new Map<string, string>();
      for (const name of config.gates) {
        const gateId = randomUUID();
        gateIds.set(name, gateId);
        this.db.prepare('INSERT INTO gates (id, event_id, name, created_at) VALUES (?, ?, ?, ?)').run(gateId, id, name, now);
      }
      for (const policy of policies) {
        const policyId = randomUUID();
        this.db
          .prepare('INSERT INTO admission_policies (id, event_id, name, opens_at, closes_at, capacity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(policyId, id, policy.name, policy.opensAt, policy.closesAt, policy.capacity, now, now);
        for (const gate of policy.gates) this.db.prepare('INSERT INTO policy_gates (policy_id, gate_id) VALUES (?, ?)').run(policyId, gateIds.get(gate)!);
      }
      recordAudit(this.db, {
        eventId: id,
        actor: caller.actor,
        action: 'event.created',
        entityId: id,
        details: { name: input.name, startsAt, endsAt, timeZone, status, templateId: template.id, templateName: template.name },
        at: now
      });
      if (caller.ownerId) this.deps.accounts.setOwnerInTransaction(id, caller.ownerId, caller.actor);
    });
    return this.deps.getEvent(id);
  }

  private insert(ownerId: string, name: string, description: string | null, config: EventTemplateConfig, actor: string, sourceEventId: string | null): EventTemplate {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM event_templates WHERE owner_id = ?').get(ownerId) as Row;
    if (Number(count.n) >= MAX_TEMPLATES_PER_ACCOUNT) throw httpError(409, `You can keep up to ${MAX_TEMPLATES_PER_ACCOUNT} templates. Delete one first.`);
    const id = randomUUID();
    const now = this.timestamp();
    try {
      this.db
        .prepare('INSERT INTO event_templates (id, owner_id, name, description, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, ownerId, name, description || null, JSON.stringify(config), now, now);
    } catch (error) {
      if (isConstraintError(error, 'UNIQUE')) throw httpError(409, 'You already have a template with that name.');
      throw error;
    }
    this.audit(actor, 'template.created', id, { name, sourceEventId, gates: config.gates.length, policies: config.policies.length });
    return { id, kind: 'saved', name, description: description || null, config, createdAt: now, updatedAt: now };
  }

  /** Templates are account-level, so their audit rows are platform-level (no event). */
  private audit(actor: string, action: string, entityId: string, details: Record<string, unknown>): void {
    recordAudit(this.db, { eventId: null, actor, action, entityId, details, at: this.timestamp() });
  }

  private timestamp(): string {
    return this.deps.now().toISOString();
  }
}

function requireOwner(ownerId: string | null): string {
  if (!ownerId) throw httpError(400, 'Templates belong to an account; the operator token has none.');
  return ownerId;
}

function toTemplate(row: Row): EventTemplate | null {
  const config = readStoredConfig(row.config_json as string);
  if (!config) return null;
  return {
    id: row.id as string,
    kind: 'saved',
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    config,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  };
}
