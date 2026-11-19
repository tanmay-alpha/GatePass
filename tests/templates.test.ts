import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeDesignConfig, templates as designPresets } from '../src/qr/design';
import { hashToken } from '../src/server/tokens';
import { BUILTIN_TEMPLATES, TEMPLATE_CONFIG_MAX_BYTES } from '../src/server/templates';
import type { EventTemplate, EventTemplateConfig } from '../src/shared/types';
import { createHarness, enroll, EVENT_INPUT, type Harness } from './helpers';

let h: Harness;
beforeEach(() => {
  h = createHarness();
});
afterEach(() => h.close());

const PASSWORD = 'correct horse battery';
type Method = 'get' | 'post' | 'patch' | 'delete';

/** Cookie session by hand (the harness URL is https, so supertest's jar would not send the Secure cookie). */
class Account {
  cookie = '';
  id = '';
  constructor(readonly email: string) {}

  send(method: Method, path: string, body?: object, csrf = true) {
    const req = request(h.app)[method](path);
    if (this.cookie) req.set('Cookie', this.cookie);
    if (csrf && method !== 'get') req.set('X-GatePass-CSRF', '1');
    return body === undefined ? req : req.send(body);
  }

  async signUp() {
    const response = await this.send('post', '/api/auth/register', { email: this.email, name: this.email.split('@')[0], password: PASSWORD }).expect(201);
    this.cookie = (response.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    this.id = response.body.user.id;
    return this;
  }
}

const signUp = (email: string) => new Account(email).signUp();
const operator = (method: Method, path: string) => h.admin(request(h.app)[method](path));

const CONFIG: EventTemplateConfig = {
  version: 1,
  durationMinutes: 90,
  timeZone: 'Europe/Berlin',
  venue: 'Aula',
  capacity: 80,
  designPreset: null,
  design: null,
  gates: ['North', 'South'],
  policies: [{ name: 'Early', opensOffsetMinutes: -45, closesOffsetMinutes: 30, capacity: 10, gates: ['North'] }]
};

/** An event with everything a template must NOT carry: passes with attendee data, a scanner with a key, a team member. */
async function richEvent(owner: Account) {
  const event = (await owner.send('post', '/api/events', { ...EVENT_INPUT, timeZone: 'Asia/Kolkata', capacity: 200, design: { bodyColor: '#123456' } }).expect(201)).body;
  const vipGate = (await owner.send('post', `/api/events/${event.id}/gates`, { name: 'VIP door' }).expect(201)).body;
  await owner.send('post', `/api/events/${event.id}/gates`, { name: 'Main door' }).expect(201);
  const vip = (
    await owner
      .send('post', `/api/events/${event.id}/policies`, {
        name: 'VIP',
        opensAt: '2030-06-01T17:00:00.000Z',
        closesAt: '2030-06-01T19:00:00.000Z',
        capacity: 25,
        gateIds: [vipGate.id]
      })
      .expect(201)
  ).body;
  await owner.send('post', `/api/events/${event.id}/policies`, { name: 'General' }).expect(201);
  const passes = (
    await owner.send('post', `/api/events/${event.id}/passes`, { attendees: [{ name: 'Secret Attendee', email: 'secret.attendee@example.com' }], policyId: vip.id }).expect(201)
  ).body;
  const scanner = (await owner.send('post', `/api/events/${event.id}/scanners`, { label: 'Hidden scanner label' }).expect(201)).body;
  const scannerKey = await enroll(h.app, scanner);
  const invite = (await owner.send('post', `/api/events/${event.id}/invitations`, { email: 'teammate@example.com' }).expect(201)).body;
  return { event, passes, scannerKey, invite };
}

describe('built-in templates', () => {
  it('offers five valid built-ins to every account and to the operator', async () => {
    const alice = await signUp('alice@example.com');
    const listed = (await alice.send('get', '/api/templates').expect(200)).body as EventTemplate[];
    expect(listed.map((t) => t.name)).toEqual(['College seminar', 'Workshop', 'Conference', 'Campus event', 'Private gathering']);
    for (const template of listed) {
      expect(template).toMatchObject({ kind: 'builtin', createdAt: null, config: { version: 1, timeZone: null, venue: null, design: null } });
      expect(designPresets.map((p) => p.name)).toContain(template.config.designPreset);
      expect(template.config.gates.length).toBeGreaterThan(0);
      expect(template.config.policies.length).toBeGreaterThan(0);
    }
    expect(listed.find((t) => t.name === 'Conference')!.config.policies.map((p) => p.name)).toContain('Speakers/VIP');
    expect((await operator('get', '/api/templates').expect(200)).body).toEqual(listed);
  });

  it('creates an event from a built-in: defaults from the template, form values override, design preset applied', async () => {
    const alice = await signUp('alice@example.com');
    const created = (
      await alice.send('post', '/api/templates/builtin:conference/events', { name: 'DevConf', startsAt: '2030-09-10T08:00:00.000Z', timeZone: 'America/New_York' }).expect(201)
    ).body;
    expect(created).toMatchObject({
      name: 'DevConf',
      status: 'draft',
      timeZone: 'America/New_York',
      capacity: 500,
      startsAt: '2030-09-10T08:00:00.000Z',
      endsAt: '2030-09-10T16:00:00.000Z',
      myRole: 'owner',
      gateCount: 3,
      policyCount: 3,
      passCount: 0,
      scannerCount: 0
    });
    expect(created.design).toEqual(normalizeDesignConfig(designPresets.find((p) => p.name === 'CompleteTech')!.config));
    const gates = (await alice.send('get', `/api/events/${created.id}/gates`).expect(200)).body as Array<{ id: string; name: string }>;
    const policies = (await alice.send('get', `/api/events/${created.id}/policies`).expect(200)).body as Array<{ name: string; opensAt: string; closesAt: string | null; gateIds: string[] }>;
    const vip = policies.find((p) => p.name === 'Speakers/VIP')!;
    expect(vip.opensAt).toBe('2030-09-10T06:00:00.000Z');
    expect(vip.closesAt).toBeNull();
    expect(vip.gateIds.map((id) => gates.find((g) => g.id === id)!.name).sort()).toEqual(['Main entrance', 'VIP entrance']);

    const overridden = (
      await alice
        .send('post', '/api/templates/builtin:workshop/events', {
          name: 'Clay',
          venue: 'Studio 3',
          startsAt: '2030-09-10T08:00:00.000Z',
          endsAt: '2030-09-10T12:00:00.000Z',
          capacity: null,
          status: 'active'
        })
        .expect(201)
    ).body;
    expect(overridden).toMatchObject({ venue: 'Studio 3', capacity: null, status: 'active', timeZone: 'UTC', endsAt: '2030-09-10T12:00:00.000Z' });

    const audit = (await alice.send('get', `/api/events/${created.id}/audit?action=event.created`).expect(200)).body;
    expect(audit[0].details).toMatchObject({ templateId: 'builtin:conference', templateName: 'Conference', status: 'draft' });
  });

  it('refuses a template the event window cannot hold, unknown templates and a design in the body', async () => {
    const alice = await signUp('alice@example.com');
    await alice.send('post', '/api/templates/builtin:nope/events', { name: 'X', startsAt: '2030-09-10T08:00:00.000Z' }).expect(404);
    await alice.send('post', '/api/templates/builtin:workshop/events', { name: 'X', startsAt: '2030-09-10T08:00:00.000Z', design: {} }).expect(400);
    await alice.send('post', '/api/templates/builtin:workshop/events', { name: 'X', startsAt: '2030-09-10T08:00:00.000Z', endsAt: '2030-09-10T07:00:00.000Z' }).expect(400);
    const template = (
      await alice
        .send('post', '/api/templates', {
          name: 'Late wave',
          config: { ...CONFIG, policies: [{ name: 'Late', opensOffsetMinutes: 120, closesOffsetMinutes: null, capacity: null, gates: [] }] }
        })
        .expect(201)
    ).body;
    const refused = await alice.send('post', `/api/templates/${template.id}/events`, { name: 'Short', startsAt: '2030-09-10T08:00:00.000Z' }).expect(400);
    expect(refused.body.error).toContain('Late');
    expect((await operator('get', '/api/events').expect(200)).body).toHaveLength(0);
  });
});

describe('saved templates', () => {
  it('saves an event as a template with settings, gates and policy offsets only: no passes, attendees, scanners, team or credentials', async () => {
    const alice = await signUp('alice@example.com');
    const { event, passes, scannerKey, invite } = await richEvent(alice);
    const saved = (await alice.send('post', `/api/events/${event.id}/save-template`, { name: 'Gala', description: 'Yearly gala' }).expect(201)).body as EventTemplate;
    expect(saved).toMatchObject({ kind: 'saved', name: 'Gala', description: 'Yearly gala' });
    expect(saved.config).toEqual({
      version: 1,
      durationMinutes: 300,
      timeZone: 'Asia/Kolkata',
      venue: 'Hall A',
      capacity: 200,
      designPreset: null,
      design: normalizeDesignConfig({ bodyColor: '#123456' }),
      gates: ['Main door', 'VIP door'],
      policies: [
        { name: 'General', opensOffsetMinutes: null, closesOffsetMinutes: null, capacity: null, gates: [] },
        { name: 'VIP', opensOffsetMinutes: -60, closesOffsetMinutes: 60, capacity: 25, gates: ['VIP door'] }
      ]
    });

    const row = h.db.prepare('SELECT * FROM event_templates WHERE id = ?').get(saved.id) as Record<string, string>;
    expect(row.owner_id).toBe(alice.id);
    const stored = JSON.stringify(row);
    const token = passes[0].token as string;
    for (const secret of [token, hashToken(token), passes[0].id, scannerKey, hashToken(scannerKey), 'Hidden scanner label', 'Secret Attendee', 'secret.attendee@example.com', 'teammate@example.com', invite.url, alice.email]) {
      expect(stored).not.toContain(secret);
    }
    expect(stored).not.toMatch(/token|passes|scanner|attendee|member|key/i);

    const audit = h.db.prepare("SELECT * FROM audit_log WHERE action = 'template.created'").all();
    expect(audit).toEqual([expect.objectContaining({ event_id: null, actor: `user:${alice.id}`, entity_id: saved.id })]);
    expect(JSON.parse((audit[0] as { details_json: string }).details_json)).toEqual({ name: 'Gala', sourceEventId: event.id, gates: 2, policies: 2 });
  });

  it('creates a new event from a saved template in one transaction, with windows moved to the new start', async () => {
    const alice = await signUp('alice@example.com');
    const { event } = await richEvent(alice);
    const saved = (await alice.send('post', `/api/events/${event.id}/save-template`, { name: 'Gala' }).expect(201)).body as EventTemplate;
    const created = (await alice.send('post', `/api/templates/${saved.id}/events`, { name: 'Gala 2031', startsAt: '2031-06-01T18:00:00.000Z' }).expect(201)).body;
    expect(created).toMatchObject({
      name: 'Gala 2031',
      venue: 'Hall A',
      timeZone: 'Asia/Kolkata',
      capacity: 200,
      status: 'draft',
      startsAt: '2031-06-01T18:00:00.000Z',
      endsAt: '2031-06-01T23:00:00.000Z',
      passCount: 0,
      scannerCount: 0,
      scanCount: 0,
      design: event.design
    });
    const policies = (await alice.send('get', `/api/events/${created.id}/policies`).expect(200)).body;
    const gates = (await alice.send('get', `/api/events/${created.id}/gates`).expect(200)).body as Array<{ id: string; name: string }>;
    const vip = policies.find((p: { name: string }) => p.name === 'VIP');
    expect(vip).toMatchObject({ opensAt: '2031-06-01T17:00:00.000Z', closesAt: '2031-06-01T19:00:00.000Z', capacity: 25, admittedCount: 0 });
    expect(vip.gateIds).toEqual([gates.find((g) => g.name === 'VIP door')!.id]);
    // The team is the creator alone; no invitation or member is copied.
    expect((await alice.send('get', `/api/events/${created.id}/members`).expect(200)).body).toEqual([expect.objectContaining({ userId: alice.id, role: 'owner' })]);
    expect((await alice.send('get', `/api/events/${created.id}/invitations`).expect(200)).body).toEqual([]);
  });

  it('keeps templates private: another account cannot list, use or delete them, nor save from an event it is not on', async () => {
    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');
    const { event } = await richEvent(alice);
    const saved = (await alice.send('post', `/api/events/${event.id}/save-template`, { name: 'Gala' }).expect(201)).body as EventTemplate;

    const bobList = (await bob.send('get', '/api/templates').expect(200)).body as EventTemplate[];
    expect(bobList.every((t) => t.kind === 'builtin')).toBe(true);
    expect((await operator('get', '/api/templates').expect(200)).body.some((t: EventTemplate) => t.id === saved.id)).toBe(false);
    await bob.send('post', `/api/templates/${saved.id}/events`, { name: 'Stolen', startsAt: '2031-06-01T18:00:00.000Z' }).expect(404);
    await operator('post', `/api/templates/${saved.id}/events`).send({ name: 'Stolen', startsAt: '2031-06-01T18:00:00.000Z' }).expect(404);
    await bob.send('delete', `/api/templates/${saved.id}`).expect(404);
    await bob.send('post', `/api/events/${event.id}/save-template`, { name: 'Copy' }).expect(404);
    // Same name in another account is fine: names are unique per owner.
    const bobEvent = (await bob.send('post', '/api/events', EVENT_INPUT).expect(201)).body;
    await bob.send('post', `/api/events/${bobEvent.id}/save-template`, { name: 'Gala' }).expect(201);

    expect((await alice.send('get', '/api/templates').expect(200)).body.filter((t: EventTemplate) => t.kind === 'saved').map((t: EventTemplate) => t.id)).toEqual([saved.id]);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM events WHERE name = 'Stolen'").get()).toEqual({ n: 0 });
  });

  it('lets a manager with edit rights save a template of their own, and refuses members without the event', async () => {
    const owner = await signUp('owner@example.com');
    const { event, invite } = await richEvent(owner);
    const manager = new Account('teammate@example.com');
    const accepted = await manager.send('post', '/api/invitations/accept', { token: invite.url.split('/').at(-1), name: 'Mate', password: PASSWORD }).expect(200);
    manager.cookie = (accepted.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    manager.id = accepted.body.user.id;
    const saved = (await manager.send('post', `/api/events/${event.id}/save-template`, { name: 'Managed' }).expect(201)).body;
    expect(h.db.prepare('SELECT owner_id FROM event_templates WHERE id = ?').get(saved.id)).toEqual({ owner_id: manager.id });
    expect((await owner.send('get', '/api/templates').expect(200)).body.some((t: EventTemplate) => t.id === saved.id)).toBe(false);
  });

  it('refuses event creation from any template when the account cannot create events (403), but still lists them', async () => {
    const alice = await signUp('alice@example.com');
    const template = (await alice.send('post', '/api/templates', { name: 'Mine', config: CONFIG }).expect(201)).body;
    await operator('post', `/api/platform/users/${alice.id}/event-creation`).send({ allowed: false }).expect(200);
    for (const id of [template.id, 'builtin:workshop']) {
      const refused = await alice.send('post', `/api/templates/${id}/events`, { name: 'Nope', startsAt: '2031-06-01T18:00:00.000Z' }).expect(403);
      expect(refused.body.error).toContain('cannot create new ones');
    }
    expect((await alice.send('get', '/api/templates').expect(200)).body.some((t: EventTemplate) => t.id === template.id)).toBe(true);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 });
  });

  it('validates template config strictly on write: unknown keys, broken references, bad windows, bad design, oversize', async () => {
    const alice = await signUp('alice@example.com');
    const post = (body: object) => alice.send('post', '/api/templates', body);
    await post({ name: 'Leaky', config: { ...CONFIG, passes: [{ token: 'abc' }] } }).expect(400);
    await post({ name: 'Leaky', config: { ...CONFIG, policies: [{ ...CONFIG.policies[0], scannerKey: 'x' }] } }).expect(400);
    await post({ name: 'Leaky', config: CONFIG, attendees: [] }).expect(400);
    await post({ name: 'Bad gate', config: { ...CONFIG, policies: [{ ...CONFIG.policies[0], gates: ['West'] }] } }).expect(400);
    await post({ name: 'Dup gate', config: { ...CONFIG, gates: ['North', 'North'] } }).expect(400);
    await post({ name: 'Window', config: { ...CONFIG, policies: [{ ...CONFIG.policies[0], opensOffsetMinutes: 30, closesOffsetMinutes: 30 }] } }).expect(400);
    await post({ name: 'Zone', config: { ...CONFIG, timeZone: 'Mars/Olympus' } }).expect(400);
    await post({ name: 'Design', config: { ...CONFIG, design: { bodyColor: 'red' } } }).expect(400);
    await post({ name: 'Preset', config: { ...CONFIG, designPreset: 'Nope' } }).expect(400);
    await post({ name: 'Version', config: { ...CONFIG, version: 2 } }).expect(400);
    const gates = Array.from({ length: 50 }, (_, i) => `${'g'.repeat(96)}${String(i).padStart(4, '0')}`);
    const huge = { ...CONFIG, gates, policies: Array.from({ length: 50 }, (_, i) => ({ name: `P${i}`, opensOffsetMinutes: null, closesOffsetMinutes: null, capacity: null, gates })) };
    expect(Buffer.byteLength(JSON.stringify(huge))).toBeGreaterThan(TEMPLATE_CONFIG_MAX_BYTES);
    expect((await post({ name: 'Huge', config: huge }).expect(400)).body.error).toContain('too large');
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM event_templates').get()).toEqual({ n: 0 });

    const created = (await post({ name: 'Good', config: { ...CONFIG, design: { bodyColor: '#00ff00', unknownKey: 1 } } }).expect(201)).body;
    expect(created.config.design).toEqual(normalizeDesignConfig({ bodyColor: '#00ff00' }));
    expect((await post({ name: 'Good', config: CONFIG }).expect(409)).body.error).toContain('already have a template');
  });

  it('re-validates stored config on read: a tampered row is skipped in the list and refused on use', async () => {
    const alice = await signUp('alice@example.com');
    const template = (await alice.send('post', '/api/templates', { name: 'Mine', config: CONFIG }).expect(201)).body;
    h.db.prepare('UPDATE event_templates SET config_json = ? WHERE id = ?').run(JSON.stringify({ ...CONFIG, tokens: ['leak'] }), template.id);
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (line: string) => warnings.push(line);
    try {
      expect((await alice.send('get', '/api/templates').expect(200)).body.some((t: EventTemplate) => t.id === template.id)).toBe(false);
    } finally {
      console.warn = warn;
    }
    expect(JSON.parse(warnings[0])).toEqual({ level: 'warn', msg: 'invalid event template skipped', templateId: template.id });
    await alice.send('post', `/api/templates/${template.id}/events`, { name: 'X', startsAt: '2031-06-01T18:00:00.000Z' }).expect(409);
    await alice.send('delete', `/api/templates/${template.id}`).expect(204);
  });

  it('deletes own templates with an audit entry; built-ins cannot be deleted; the operator has no templates of its own', async () => {
    const alice = await signUp('alice@example.com');
    const template = (await alice.send('post', '/api/templates', { name: 'Mine', config: CONFIG }).expect(201)).body;
    await alice.send('delete', '/api/templates/builtin:workshop').expect(400);
    await alice.send('delete', `/api/templates/${template.id}`).expect(204);
    await alice.send('delete', `/api/templates/${template.id}`).expect(404);
    expect(h.db.prepare("SELECT action, entity_id, event_id FROM audit_log WHERE action LIKE 'template.%' ORDER BY id").all()).toEqual([
      { action: 'template.created', entity_id: template.id, event_id: null },
      { action: 'template.deleted', entity_id: template.id, event_id: null }
    ]);
    await operator('post', '/api/templates').send({ name: 'Op', config: CONFIG }).expect(400);
    const event = (await operator('post', '/api/events').send(EVENT_INPUT).expect(201)).body;
    await operator('post', `/api/events/${event.id}/save-template`).send({ name: 'Op' }).expect(400);
    // The operator may still start an event from a built-in (it has no owner, like operator-created events).
    await operator('post', '/api/templates/builtin:workshop/events').send({ name: 'Op event', startsAt: '2031-06-01T18:00:00.000Z' }).expect(201);
  });

  it('requires sign-in and the CSRF header on cookie writes', async () => {
    await request(h.app).get('/api/templates').expect(401);
    await request(h.app).post('/api/templates/builtin:workshop/events').send({ name: 'X', startsAt: '2031-06-01T18:00:00.000Z' }).expect(401);
    const alice = await signUp('alice@example.com');
    await alice.send('post', '/api/templates', { name: 'Mine', config: CONFIG }, false).expect(403);
    await alice.send('post', '/api/templates/builtin:workshop/events', { name: 'X', startsAt: '2031-06-01T18:00:00.000Z' }, false).expect(403);
  });

  it('creates a working event from every built-in at its default duration', async () => {
    const alice = await signUp('alice@example.com');
    for (const template of BUILTIN_TEMPLATES) {
      const created = (await alice.send('post', `/api/templates/${template.id}/events`, { name: template.name, startsAt: '2031-06-01T18:00:00.000Z' }).expect(201)).body;
      expect(Date.parse(created.endsAt) - Date.parse(created.startsAt)).toBe(template.config.durationMinutes * 60_000);
      expect(created).toMatchObject({ gateCount: template.config.gates.length, policyCount: template.config.policies.length, capacity: template.config.capacity });
    }
  });
});
