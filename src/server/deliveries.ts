import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DeliveryActionResult, DeliveryCounts, DeliveryList, DeliveryPause, DeliverySkipReason, DeliveryStatus, PassDelivery } from '../shared/types';
import { recordAudit } from './audit';
import { transaction, type Database } from './db';
import { httpError } from './http';
import { attemptSend, composeEmail, type MailAttempt, type Mailer, type MailMessage } from './mailer';
import { extractPassToken, generateToken, hashToken } from './tokens';

// Attendee pass email (docs/decisions/0012-pass-email-outbox.md).
//
// Issuing or importing with "email passes" inserts one `pass_deliveries` row
// per attendee with an address, inside the issuance transaction: no network
// call ever runs inside a database transaction. Passes store only token
// hashes, so the raw link the email needs is kept sealed (AES-256-GCM, key
// from PASS_DELIVERY_KEY, older keys from PASS_DELIVERY_PREVIOUS_KEYS) until
// the row reaches a final state.
//
// `DeliveryWorker` sends due rows one at a time at a fixed maximum rate,
// taking events in turn. A row moves queued → sending in a short transaction
// before the provider call and to accepted / failed / unconfirmed / queued
// (retry) after it. The delivery id is the provider idempotency key, so a
// retry after a timeout or a crash does not send a second message while the
// provider remembers the key (24 hours). Past that window an attempt that may
// have reached the provider is never repeated: the email ends `unconfirmed`
// and the organizer decides. Recipients and links are never logged.

type Row = Record<string, unknown>;

/** Audit actor for changes the worker makes on its own. */
const SYSTEM = 'system';
const MAX_ERROR = 300;
/** Pass emails one address may receive per 24 hours across the deployment (group bookings fit; bulk abuse does not). */
export const RECIPIENT_DAILY_LIMIT = 10;
const DAY_MS = 24 * 60 * 60_000;

/** How long the provider de-duplicates a repeated idempotency key (Resend: 24 hours, https://resend.com/docs/dashboard/emails/idempotency-keys). */
export const PROVIDER_DEDUP_WINDOW_MS = DAY_MS;
/**
 * An attempt that may have reached the provider is repeated automatically
 * only this long after it started: the provider's window minus one hour for
 * the request's own duration and clock drift between us and the provider.
 */
export const SAFE_RETRY_WINDOW_MS = PROVIDER_DEDUP_WINDOW_MS - 60 * 60_000;

const STATUSES = ['queued', 'sending', 'accepted', 'failed', 'cancelled', 'unconfirmed'] as const satisfies readonly DeliveryStatus[];

/** Why a queued email can no longer be sent, or NULL. Needs `d` (delivery), `p` (pass), `r` (redemption) and `:now`. */
const STALE_SQL = `CASE
  WHEN r.pass_id IS NOT NULL THEN 'redeemed'
  WHEN p.revoked_at IS NOT NULL THEN 'revoked'
  WHEN p.token_hash <> d.token_hash THEN 'reissued'
  WHEN d.link_expires_at <= :now THEN 'expired'
END`;

/** A later email exists for the same pass (rowid follows insertion order). Needs `d` (delivery). */
const SUPERSEDED_SQL = 'EXISTS (SELECT 1 FROM pass_deliveries n WHERE n.pass_id = d.pass_id AND n.rowid > d.rowid)';

const STALE_REASON: Record<string, string> = {
  redeemed: 'the pass was used at the door first.',
  revoked: 'the pass was revoked.',
  reissued: 'the pass was reissued, so this email carried a link that no longer works.',
  expired: 'the pass expired first.'
};

/** Why a waiting email was cancelled; it may still have been sent when an earlier attempt was ambiguous. */
function staleMessage(row: Row): string {
  const reason = STALE_REASON[row.stale as string];
  return row.uncertain_since ? `Not sent again: ${reason} An earlier attempt may still have reached the provider.` : `Not sent: ${reason}`;
}

const INTERRUPTED =
  'Sending was interrupted by a server restart; the provider may have accepted it. It is retried with the same request id, which the provider de-duplicates for 24 hours; after that it is not sent again.';
const UNREADABLE =
  'The stored link could not be decrypted with PASS_DELIVERY_KEY or PASS_DELIVERY_PREVIOUS_KEYS (was the key changed without keeping the old one?). Send a new link.';
/** Appended to an `unconfirmed` email's reason. */
const MAY_HAVE_SENT = 'The provider may already have sent it: check its log, or send a new link (the attendee may get two emails; only the newest link works).';
const WINDOW_PASSED = `Not retried: more than 23 hours passed since an attempt that may have reached the provider, which de-duplicates for 24 hours only. ${MAY_HAVE_SENT}`;

// ------------------------------------------------------------ request schemas

const passToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'token must be a pass token');
const id = z.string().min(1).max(64);

/** POST /api/events/:eventId/passes/:passId/deliveries: prove the current link (`token`) or replace it (`reissue`). */
export const singleDeliverySchema = z
  .strictObject({ token: passToken.optional(), reissue: z.boolean().optional() })
  .refine((value) => !(value.token && value.reissue), 'Provide token or reissue, not both');
/** POST /api/events/:eventId/deliveries */
export const bulkDeliverySchema = z.strictObject({
  passes: z.array(z.strictObject({ passId: id, token: passToken.optional() })).min(1).max(500),
  reissue: z.boolean().optional()
});
/** POST /api/events/:eventId/deliveries/retry and /cancel */
export const deliveryIdsSchema = z.strictObject({ deliveryIds: z.array(id).min(1).max(500), reissue: z.boolean().optional() });
export const deliveryFilterSchema = z.object({
  status: z.enum(STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional()
});

// ------------------------------------------------------------ sealing

/** Schema-5 links: version ‖ IV ‖ tag ‖ ciphertext, sealed with the one key there was. Still opened. */
const SEAL_V1 = 1;
/** version ‖ key id ‖ IV ‖ tag ‖ ciphertext: the key id says which configured key opens it. */
const SEAL_V2 = 2;
const KEY_ID_BYTES = 8;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Names a key without revealing it: the first 8 bytes of SHA-256 over a domain-separation prefix and the key. */
function keyId(key: Buffer): Buffer {
  return createHash('sha256').update('gatepass:pass-delivery-key-id\0').update(key).digest().subarray(0, KEY_ID_BYTES);
}

/** Binds a ciphertext to its row and, from version 2, to its version and key id: a sealed link copied into another delivery or pass does not open. */
function additionalData(version: number, id: Buffer | null, deliveryId: string, passId: string): Buffer {
  return Buffer.from(`gatepass:pass-delivery:v${version}:${id ? `${id.toString('hex')}:` : ''}${deliveryId}:${passId}`, 'utf8');
}

/** `body` is IV ‖ tag ‖ ciphertext; null when the key, the additional data or any byte does not match. */
function decrypt(key: Buffer, body: Buffer, aad: Buffer): string | null {
  if (body.length <= IV_BYTES + TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, body.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(body.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(body.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * AES-256-GCM with a random 96-bit IV per link, sealed under the active key
 * (PASS_DELIVERY_KEY). Layout: version 2 (1) ‖ key id (8) ‖ IV (12) ‖ tag (16)
 * ‖ ciphertext. Opens version 2 with the configured key its id names, and
 * version 1 with the active key, then each previous key
 * (PASS_DELIVERY_PREVIOUS_KEYS).
 */
export class LinkSealer {
  private readonly keys: Array<{ id: Buffer; key: Buffer }>;
  /** What every link sealed now starts with: the version and the active key id. */
  readonly header: Buffer;

  constructor(active: Buffer, previous: readonly Buffer[] = []) {
    if ([active, ...previous].some((key) => key.length !== 32)) throw new Error('Pass delivery keys must be 32 bytes');
    this.keys = [active, ...previous].map((key) => ({ id: keyId(key), key }));
    this.header = Buffer.concat([Buffer.from([SEAL_V2]), this.keys[0].id]);
  }

  seal(link: string, deliveryId: string, passId: string): Buffer {
    const { id, key } = this.keys[0];
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(additionalData(SEAL_V2, id, deliveryId, passId));
    const body = Buffer.concat([cipher.update(link, 'utf8'), cipher.final()]);
    return Buffer.concat([this.header, iv, cipher.getAuthTag(), body]);
  }

  /** The link, or null when no configured key sealed it, it was sealed for another row, or it was altered. */
  open(blob: Uint8Array, deliveryId: string, passId: string): string | null {
    const data = Buffer.from(blob);
    if (data[0] === SEAL_V2) {
      const entry = this.keys.find(({ id }) => id.equals(data.subarray(1, 1 + KEY_ID_BYTES)));
      return entry ? decrypt(entry.key, data.subarray(1 + KEY_ID_BYTES), additionalData(SEAL_V2, entry.id, deliveryId, passId)) : null;
    }
    if (data[0] !== SEAL_V1) return null;
    for (const { key } of this.keys) {
      const link = decrypt(key, data.subarray(1), additionalData(SEAL_V1, null, deliveryId, passId));
      if (link !== null) return link;
    }
    return null;
  }
}

// ------------------------------------------------------------ outbox

export interface PassDeliveriesOptions {
  now: () => Date;
  /** Base URL of pass links, without trailing slash. */
  publicUrl: string;
  generateToken?: () => string;
  /** PASS_DELIVERY_KEY. Without it passes cannot be emailed (links are never stored in clear). */
  key?: Buffer | null;
  /** PASS_DELIVERY_PREVIOUS_KEYS: open links sealed before a key rotation. */
  previousKeys?: readonly Buffer[];
  /** A mail provider is configured. */
  emailEnabled: boolean;
}

/** A claimed email: the row is `sending` until `markAccepted`, `markFailed` or `reschedule`. */
export interface DeliveryJob {
  id: string;
  eventId: string;
  passId: string;
  /** Attempts including this one. */
  attempts: number;
  message: MailMessage;
}

type QueueOutcome = { deliveryId: string; reissued: boolean } | DeliverySkipReason;

const SKIP_ERROR: Record<DeliverySkipReason, [number, string]> = {
  not_found: [404, 'Pass not found'],
  no_email: [400, 'This pass has no attendee email address.'],
  redeemed: [409, 'This pass was already used at the door.'],
  revoked: [409, 'This pass is revoked.'],
  expired: [409, 'This pass has expired.'],
  already_queued: [409, 'An email for this pass is already waiting to be sent.'],
  needs_reissue: [
    409,
    'Pass links are stored only as hashes, so emailing this pass needs a new link. Confirm “reissue”: the current QR code and link stop working.'
  ],
  link_changed: [409, 'This pass was reissued since that link was created. Email it with a new link instead.'],
  recipient_limit: [429, `This address already received ${RECIPIENT_DAILY_LIMIT} pass emails in the last 24 hours. Try again later.`],
  in_progress: [409, 'This email is being handed to the provider right now.'],
  not_queued: [409, 'Only emails that are still waiting can be cancelled.'],
  superseded: [409, 'This pass was already emailed again since; act on the newest email instead.']
};

/**
 * The `pass_deliveries` outbox: queueing (inside the caller's or its own
 * transaction), organizer actions, and the claim/record steps the worker
 * runs. Every query is scoped to the event the route authorized; ids of other
 * events answer like missing ones.
 */
export class PassDeliveries {
  private readonly sealer: LinkSealer | null;
  private readonly newToken: () => string;
  private listener: () => void = () => {};
  /** Fair claims: when each event was last served (a running count); reset on restart, which is harmless. */
  private readonly served = new Map<string, number>();
  private serves = 0;

  constructor(
    private readonly db: Database,
    private readonly options: PassDeliveriesOptions
  ) {
    this.sealer = options.key ? new LinkSealer(options.key, options.previousKeys) : null;
    this.newToken = options.generateToken ?? generateToken;
  }

  /** A mail provider and PASS_DELIVERY_KEY are both configured. */
  get available(): boolean {
    return this.options.emailEnabled && this.sealer !== null;
  }

  /** 409 with what the operator has to configure, before anything is written. */
  assertAvailable(): void {
    if (!this.options.emailEnabled) throw httpError(409, 'Email is not configured on this server, so passes cannot be emailed. Share the pass links instead.');
    if (!this.sealer) {
      throw httpError(
        409,
        'Emailing passes needs PASS_DELIVERY_KEY on the server: it encrypts pass links while they wait to be sent. Ask the operator to set it, or share the links yourself.'
      );
    }
  }

  /** The worker subscribes; called after every commit that made an email due. */
  onQueued(listener: () => void): void {
    this.listener = listener;
  }

  notify(): void {
    this.listener();
  }

  now(): Date {
    return this.options.now();
  }

  // ---------------------------------------------------------------- queueing

  /**
   * Must run inside the issuance transaction, after the passes were
   * inserted: one delivery per pass with an email address. Refuses the whole
   * issuance (rolled back by the caller) when an address is over its daily
   * limit, so the response never claims emails that were not queued.
   */
  queueIssuedInTransaction(eventId: string, passes: Array<{ id: string; token: string; attendeeEmail: string | null; expiresAt: string }>, actor: string): number {
    this.assertAvailable();
    const sealer = this.sealer!;
    const withEmail = passes.filter((pass): pass is typeof pass & { attendeeEmail: string } => Boolean(pass.attendeeEmail));
    if (withEmail.length === 0) return 0;
    const over = this.overRecipientLimit(withEmail.map((pass) => pass.attendeeEmail));
    if (over.size) {
      throw httpError(
        429,
        `${over.size} address${over.size === 1 ? '' : 'es'} already received ${RECIPIENT_DAILY_LIMIT} pass emails in the last 24 hours. Issue without email, or try again later.`
      );
    }
    const now = this.timestamp();
    for (const pass of withEmail) this.insertDelivery(sealer, eventId, pass.id, pass.attendeeEmail, pass.token, pass.expiresAt, actor, now);
    this.audit(eventId, actor, 'pass.email_queued', null, { count: withEmail.length, passIds: withEmail.map((pass) => pass.id) });
    return withEmail.length;
  }

  /**
   * Queues emails for existing passes. Each pass needs its current link:
   * either the caller proves it with the token (passes just issued, still on
   * screen) or asks to `reissue` (new token; the old QR code stops working).
   */
  queue(eventId: string, items: Array<{ passId: string; token?: string }>, reissue: boolean, actor: string): DeliveryActionResult {
    this.assertAvailable();
    const result = transaction(this.db, (): DeliveryActionResult => {
      this.assertEventOpen(eventId);
      const unique = [...new Map(items.map((item) => [item.passId, item])).values()];
      const over = this.overRecipientLimit(this.recipientsOf(eventId, unique.map((item) => item.passId)));
      const queued: string[] = [];
      const skipped: DeliveryActionResult['skipped'] = [];
      let reissued = 0;
      for (const item of unique) {
        const outcome = this.queueOne(eventId, item.passId, item.token, reissue, actor, over);
        if (typeof outcome === 'string') skipped.push({ id: item.passId, reason: outcome });
        else {
          queued.push(item.passId);
          if (outcome.reissued) reissued += 1;
        }
      }
      if (queued.length) this.audit(eventId, actor, 'pass.email_queued', null, { count: queued.length, passIds: queued, reissued });
      return { done: queued.length, reissued, skipped };
    });
    if (result.done) this.notify();
    return result;
  }

  /** One pass; errors instead of a skip list. */
  queuePass(eventId: string, passId: string, input: { token?: string; reissue?: boolean }, actor: string): PassDelivery {
    const result = this.queue(eventId, [{ passId, token: input.token }], input.reissue === true, actor);
    const skip = result.skipped[0];
    if (skip) throw httpError(...SKIP_ERROR[skip.reason]);
    return this.latestFor(passId);
  }

  /**
   * Waiting emails (including ones backing off after a failure) become due
   * now with the same link and idempotency key. Final ones (accepted, failed,
   * cancelled) no longer hold a link: they are sent again only with
   * `reissue`, which replaces the pass link.
   */
  retry(eventId: string, deliveryIds: string[], reissue: boolean, actor: string): DeliveryActionResult {
    this.assertAvailable();
    const result = transaction(this.db, (): DeliveryActionResult => {
      const now = this.timestamp();
      const rows = this.rowsOf(eventId, deliveryIds);
      if (reissue && rows.some(({ row }) => row && row.status !== 'queued' && row.status !== 'sending')) this.assertEventOpen(eventId);
      const over = reissue ? this.overRecipientLimit(this.recipientsOf(eventId, rows.flatMap(({ row }) => (row ? [row.pass_id as string] : [])))) : new Set<string>();
      const retried: string[] = [];
      const requeued: string[] = [];
      const skipped: DeliveryActionResult['skipped'] = [];
      for (const { id, row } of rows) {
        if (!row) skipped.push({ id, reason: 'not_found' });
        else if (row.status === 'queued') {
          this.db.prepare("UPDATE pass_deliveries SET next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(now, now, id);
          retried.push(id);
        } else if (row.status === 'sending') skipped.push({ id, reason: 'in_progress' });
        else if (row.superseded) skipped.push({ id, reason: 'superseded' });
        else if (!reissue) skipped.push({ id, reason: 'needs_reissue' });
        else {
          const outcome = this.queueOne(eventId, row.pass_id as string, undefined, true, actor, over);
          if (typeof outcome === 'string') skipped.push({ id, reason: outcome });
          else requeued.push(row.pass_id as string);
        }
      }
      if (retried.length) this.audit(eventId, actor, 'pass.email_retried', null, { deliveryIds: retried });
      if (requeued.length) this.audit(eventId, actor, 'pass.email_queued', null, { count: requeued.length, passIds: requeued, reissued: requeued.length });
      return { done: retried.length + requeued.length, reissued: requeued.length, skipped };
    });
    if (result.done) this.notify();
    return result;
  }

  /** Cancels emails that are still waiting; the sealed link is erased. One being sent right now cannot be cancelled. */
  cancel(eventId: string, deliveryIds: string[], actor: string): DeliveryActionResult {
    return transaction(this.db, (): DeliveryActionResult => {
      const skipped: DeliveryActionResult['skipped'] = [];
      let done = 0;
      for (const { id, row } of this.rowsOf(eventId, deliveryIds)) {
        if (!row) skipped.push({ id, reason: 'not_found' });
        else if (row.status === 'sending') skipped.push({ id, reason: 'in_progress' });
        else if (row.status !== 'queued') skipped.push({ id, reason: 'not_queued' });
        else {
          this.close(row, 'cancelled', 'Cancelled by an organizer.', actor, 'organizer');
          done += 1;
        }
      }
      return { done, reissued: 0, skipped };
    });
  }

  // ---------------------------------------------------------------- reading

  list(eventId: string, filter: z.infer<typeof deliveryFilterSchema> = {}): DeliveryList {
    const where = 'WHERE d.event_id = :eventId AND (:status IS NULL OR d.status = :status)';
    const params = { eventId, status: filter.status ?? null };
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM pass_deliveries d ${where}`).get(params) as Row).n);
    const rows = this.db
      .prepare(
        `SELECT d.*, p.attendee_name, ${SUPERSEDED_SQL} AS superseded FROM pass_deliveries d JOIN passes p ON p.id = d.pass_id ${where}
         ORDER BY d.created_at DESC, d.rowid DESC LIMIT :limit OFFSET :offset`
      )
      .all({ ...params, limit: filter.limit ?? 50, offset: filter.offset ?? 0 }) as Row[];
    const counts: DeliveryCounts = { queued: 0, sending: 0, accepted: 0, failed: 0, cancelled: 0, unconfirmed: 0, retrying: 0 };
    for (const row of this.db
      .prepare(
        `SELECT d.status, COUNT(*) AS n, SUM(d.status = 'queued' AND d.last_error IS NOT NULL) AS retrying, SUM(${SUPERSEDED_SQL}) AS superseded
         FROM pass_deliveries d WHERE d.event_id = ? GROUP BY d.status`
      )
      .all(eventId) as Row[]) {
      // A failed or unconfirmed email that was sent again since no longer needs attention.
      counts[row.status as DeliveryStatus] = Number(row.n) - (row.status === 'failed' || row.status === 'unconfirmed' ? Number(row.superseded) : 0);
      if (row.status === 'queued') counts.retrying = Number(row.retrying);
    }
    return { deliveries: rows.map(toDelivery), total, counts, paused: counts.queued + counts.sending > 0 ? this.pausedBy() : null };
  }

  // ---------------------------------------------------------------- worker steps

  /**
   * Rows a crash left in `sending` go back to the queue, keeping their id
   * (the idempotency key). The interrupted attempt may have reached the
   * provider, so the row is uncertain since that attempt started.
   */
  recoverInterrupted(): number {
    const now = this.timestamp();
    return transaction(this.db, () =>
      Number(
        this.db
          .prepare(
            `UPDATE pass_deliveries SET status = 'queued', next_attempt_at = ?, updated_at = ?, last_error = ?, uncertain_since = COALESCE(uncertain_since, last_attempt_at, updated_at)
             WHERE status = 'sending'`
          )
          .run(now, now, INTERRUPTED).changes
      )
    );
  }

  /**
   * After a key rotation: re-seals every waiting link that is not sealed
   * under the active key yet (older seal version or a previous key), in one
   * transaction. Links no configured key opens stay as they are and are
   * failed when claimed. Returns counts only.
   */
  resealWaiting(): { resealed: number; unreadable: number } {
    const sealer = this.sealer;
    if (!sealer) return { resealed: 0, unreadable: 0 };
    return transaction(this.db, () => {
      const rows = this.db
        .prepare("SELECT id, pass_id, sealed_link FROM pass_deliveries WHERE status = 'queued' AND sealed_link IS NOT NULL AND substr(sealed_link, 1, ?) <> ?")
        .all(sealer.header.length, sealer.header) as Row[];
      const update = this.db.prepare('UPDATE pass_deliveries SET sealed_link = ? WHERE id = ?');
      let resealed = 0;
      for (const row of rows) {
        const link = sealer.open(row.sealed_link as Uint8Array, row.id as string, row.pass_id as string);
        if (link === null) continue;
        update.run(sealer.seal(link, row.id as string, row.pass_id as string), row.id as string);
        resealed += 1;
      }
      return { resealed, unreadable: rows.length - resealed };
    });
  }

  /** Cancels waiting emails whose link can no longer be used (pass used, revoked, reissued or expired) and erases their sealed links. */
  sweep(): number {
    return transaction(this.db, () => {
      const rows = this.db
        .prepare(
          `SELECT * FROM (SELECT d.id, d.event_id, d.pass_id, d.uncertain_since, ${STALE_SQL} AS stale FROM pass_deliveries d JOIN passes p ON p.id = d.pass_id
           LEFT JOIN redemptions r ON r.pass_id = d.pass_id WHERE d.status = 'queued') WHERE stale IS NOT NULL`
        )
        .all({ now: this.timestamp() }) as Row[];
      for (const row of rows) this.close(row, 'cancelled', staleMessage(row), SYSTEM, row.stale as string);
      return rows.length;
    });
  }

  /** When the next waiting email is due, or null when none waits. */
  nextDueAt(): string | null {
    return ((this.db.prepare("SELECT MIN(next_attempt_at) AS due FROM pass_deliveries WHERE status = 'queued'").get() as Row).due as string | null) ?? null;
  }

  /**
   * Moves the next due email to `sending` and returns it with its unsealed
   * message. Events with due emails take turns (the one served longest ago
   * first, then the earliest due), so one large import does not hold back
   * other events; within an event, emails go in queue order. Stale or
   * unreadable rows, and rows that can no longer be repeated safely, are
   * closed on the way without contacting the provider.
   */
  claim(): DeliveryJob | null {
    const sealer = this.sealer;
    if (!sealer) return null;
    return transaction(this.db, () => {
      const now = this.timestamp();
      const unsafeBefore = new Date(this.options.now().getTime() - SAFE_RETRY_WINDOW_MS).toISOString();
      for (;;) {
        const eventId = this.nextEvent(now);
        if (!eventId) return null;
        const row = this.db
          .prepare(
            `SELECT d.*, ${STALE_SQL} AS stale, p.attendee_name, e.name AS event_name, e.venue, e.time_zone, e.starts_at
             FROM pass_deliveries d JOIN passes p ON p.id = d.pass_id JOIN events e ON e.id = d.event_id LEFT JOIN redemptions r ON r.pass_id = d.pass_id
             WHERE d.status = 'queued' AND d.event_id = :eventId AND d.next_attempt_at <= :now ORDER BY d.next_attempt_at, d.rowid LIMIT 1`
          )
          .get({ eventId, now }) as Row;
        if (row.stale) {
          this.close(row, 'cancelled', staleMessage(row), SYSTEM, row.stale as string);
          continue;
        }
        // The provider forgets the request id after 24 hours: repeating an attempt that may have reached it could send a second email.
        if (row.uncertain_since && (row.uncertain_since as string) <= unsafeBefore) {
          this.close(row, 'unconfirmed', WINDOW_PASSED, SYSTEM);
          continue;
        }
        const link = row.sealed_link ? sealer.open(row.sealed_link as Uint8Array, row.id as string, row.pass_id as string) : null;
        const token = link ? extractPassToken(link) : null;
        let message: MailMessage | null = null;
        let failure = UNREADABLE;
        if (link && token && hashToken(token) === row.token_hash) {
          try {
            message = passEmail(row, link);
          } catch (error) {
            failure = `The email could not be composed: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        if (!message) {
          // Cannot be sent again; an earlier attempt that may have reached the provider still may have been sent.
          if (row.uncertain_since) this.close(row, 'unconfirmed', `${failure} ${MAY_HAVE_SENT}`, SYSTEM);
          else this.close(row, 'failed', failure, SYSTEM);
          continue;
        }
        this.db.prepare("UPDATE pass_deliveries SET status = 'sending', attempts = attempts + 1, last_attempt_at = ?, updated_at = ? WHERE id = ?").run(now, now, row.id as string);
        this.serves += 1;
        this.served.set(eventId, this.serves);
        return { id: row.id as string, eventId, passId: row.pass_id as string, attempts: Number(row.attempts) + 1, message };
      }
    });
  }

  markAccepted(job: DeliveryJob, providerId: string): void {
    transaction(this.db, () => {
      const now = this.timestamp();
      const changed = this.db
        .prepare(
          `UPDATE pass_deliveries SET status = 'accepted', provider_id = ?, accepted_at = ?, sealed_link = NULL, next_attempt_at = NULL, last_error = NULL, updated_at = ?
           WHERE id = ? AND status = 'sending'`
        )
        .run(providerId, now, now, job.id).changes;
      if (changed) this.audit(job.eventId, SYSTEM, 'pass.email_accepted', job.passId, { deliveryId: job.id, providerId, attempts: job.attempts });
    });
  }

  /**
   * Final failure (refused, or out of attempts). `unconfirmed` when this
   * attempt (`ambiguous`) or an earlier one may have reached the provider,
   * `failed` when none can have. Returns the status recorded.
   */
  markFailed(job: DeliveryJob, error: string, ambiguous: boolean): 'failed' | 'unconfirmed' | null {
    return transaction(this.db, () => {
      const row = this.db
        .prepare(
          `UPDATE pass_deliveries SET uncertain_since = CASE WHEN ? THEN COALESCE(uncertain_since, last_attempt_at) ELSE uncertain_since END
           WHERE id = ? AND status = 'sending' RETURNING id, event_id, pass_id, uncertain_since`
        )
        .get(ambiguous ? 1 : 0, job.id) as Row | undefined;
      if (!row) return null;
      if (!row.uncertain_since) {
        this.close(row, 'failed', error, SYSTEM);
        return 'failed';
      }
      this.close(row, 'unconfirmed', `${error} ${MAY_HAVE_SENT}`, SYSTEM);
      return 'unconfirmed';
    });
  }

  /**
   * Back to the queue with the same id, due after `delayMs`. A throttled
   * attempt (rate limit) is not counted. An `ambiguous` attempt makes the row
   * uncertain since that attempt started (unless it already was).
   */
  reschedule(job: DeliveryJob, error: string, delayMs: number, attempt: { counted: boolean; ambiguous: boolean }): void {
    transaction(this.db, () => {
      const now = this.now();
      this.db
        .prepare(
          `UPDATE pass_deliveries SET status = 'queued', attempts = attempts - ?, next_attempt_at = ?, last_error = ?, updated_at = ?,
             uncertain_since = CASE WHEN ? THEN COALESCE(uncertain_since, last_attempt_at) ELSE uncertain_since END
           WHERE id = ? AND status = 'sending'`
        )
        .run(attempt.counted ? 0 : 1, new Date(now.getTime() + delayMs).toISOString(), truncate(error), now.toISOString(), attempt.ambiguous ? 1 : 0, job.id);
    });
  }

  // ---------------------------------------------------------------- internals

  private assertEventOpen(eventId: string): void {
    const event = this.db.prepare('SELECT status FROM events WHERE id = ?').get(eventId) as Row | undefined;
    if (!event) throw httpError(404, 'Event not found');
    if (event.status === 'ended' || event.status === 'archived') throw httpError(409, `Passes of an ${event.status as string} event cannot be emailed.`);
  }

  /** Of the events with a due email, the one served longest ago (never served first), then the earliest due. */
  private nextEvent(now: string): string | null {
    const due = this.db
      .prepare("SELECT event_id, MIN(next_attempt_at) AS due FROM pass_deliveries WHERE status = 'queued' GROUP BY event_id HAVING due <= ?")
      .all(now) as Row[];
    let best: { eventId: string; served: number; due: string } | null = null;
    for (const row of due) {
      const candidate = { eventId: row.event_id as string, served: this.served.get(row.event_id as string) ?? 0, due: row.due as string };
      if (!best || candidate.served < best.served || (candidate.served === best.served && candidate.due < best.due)) best = candidate;
    }
    return best?.eventId ?? null;
  }

  /** Why this server cannot send waiting emails, or null. */
  private pausedBy(): DeliveryPause | null {
    if (!this.options.emailEnabled) return 'no_provider';
    return this.sealer ? null : 'no_key';
  }

  /** Must run inside a transaction. */
  private queueOne(eventId: string, passId: string, token: string | undefined, reissue: boolean, actor: string, over: Set<string>): QueueOutcome {
    const now = this.timestamp();
    const pass = this.db
      .prepare('SELECT p.id, p.token_hash, p.attendee_email, p.expires_at, p.revoked_at, r.redeemed_at FROM passes p LEFT JOIN redemptions r ON r.pass_id = p.id WHERE p.id = ? AND p.event_id = ?')
      .get(passId, eventId) as Row | undefined;
    if (!pass) return 'not_found';
    if (pass.redeemed_at) return 'redeemed';
    if (pass.revoked_at) return 'revoked';
    if ((pass.expires_at as string) <= now) return 'expired';
    const recipient = pass.attendee_email as string | null;
    if (!recipient) return 'no_email';
    if (this.db.prepare("SELECT 1 FROM pass_deliveries WHERE pass_id = ? AND status IN ('queued', 'sending')").get(passId)) return 'already_queued';
    if (over.has(foldCase(recipient))) return 'recipient_limit';
    let link: string;
    if (token !== undefined) {
      if (hashToken(token) !== pass.token_hash) return 'link_changed';
      link = token;
    } else if (reissue) {
      link = this.newToken();
      this.db.prepare('UPDATE passes SET token_hash = ? WHERE id = ?').run(hashToken(link), passId);
      this.audit(eventId, actor, 'pass.reissued', passId, { via: 'email' });
    } else return 'needs_reissue';
    const deliveryId = this.insertDelivery(this.sealer!, eventId, passId, recipient, link, pass.expires_at as string, actor, now);
    return { deliveryId, reissued: token === undefined };
  }

  private insertDelivery(sealer: LinkSealer, eventId: string, passId: string, recipient: string, token: string, expiresAt: string, actor: string, now: string): string {
    const deliveryId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO pass_deliveries (id, event_id, pass_id, recipient, token_hash, status, attempts, next_attempt_at, sealed_link, link_expires_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?)`
      )
      .run(deliveryId, eventId, passId, recipient, hashToken(token), now, sealer.seal(`${this.options.publicUrl}/p/${token}`, deliveryId, passId), expiresAt, actor, now, now);
    return deliveryId;
  }

  /** Addresses (case-folded) whose pass emails in the last 24 hours plus `recipients` would exceed the daily limit. */
  private overRecipientLimit(recipients: string[]): Set<string> {
    const wanted = new Map<string, number>();
    for (const recipient of recipients) wanted.set(foldCase(recipient), (wanted.get(foldCase(recipient)) ?? 0) + 1);
    if (wanted.size === 0) return new Set();
    const since = new Date(this.now().getTime() - DAY_MS).toISOString();
    // Only the addresses asked about, through pass_deliveries_recipient_idx: this runs inside the issuance transaction.
    const sent = new Map(
      (
        this.db
          .prepare(
            'SELECT lower(recipient) AS recipient, COUNT(*) AS n FROM pass_deliveries WHERE lower(recipient) IN (SELECT value FROM json_each(?)) AND created_at > ? GROUP BY lower(recipient)'
          )
          .all(JSON.stringify([...wanted.keys()]), since) as Row[]
      ).map((row) => [row.recipient as string, Number(row.n)])
    );
    return new Set([...wanted].filter(([recipient, count]) => (sent.get(recipient) ?? 0) + count > RECIPIENT_DAILY_LIMIT).map(([recipient]) => recipient));
  }

  private recipientsOf(eventId: string, passIds: string[]): string[] {
    const find = this.db.prepare('SELECT attendee_email FROM passes WHERE id = ? AND event_id = ?');
    return passIds.flatMap((passId) => {
      const email = (find.get(passId, eventId) as Row | undefined)?.attendee_email;
      return typeof email === 'string' ? [email] : [];
    });
  }

  private rowsOf(eventId: string, deliveryIds: string[]): Array<{ id: string; row: Row | undefined }> {
    const find = this.db.prepare(`SELECT d.id, d.event_id, d.pass_id, d.status, ${SUPERSEDED_SQL} AS superseded FROM pass_deliveries d WHERE d.id = ? AND d.event_id = ?`);
    return [...new Set(deliveryIds)].map((id) => ({ id, row: find.get(id, eventId) as Row | undefined }));
  }

  /** Final state: the sealed link is erased in the same statement. */
  private close(row: Row, status: 'failed' | 'cancelled' | 'unconfirmed', message: string, actor: string, reason?: string): void {
    const closed = this.db
      .prepare('UPDATE pass_deliveries SET status = ?, sealed_link = NULL, next_attempt_at = NULL, last_error = ?, updated_at = ? WHERE id = ? RETURNING attempts, uncertain_since')
      .get(status, truncate(message), this.timestamp(), row.id as string) as Row;
    this.audit(row.event_id as string, actor, `pass.email_${status}`, row.pass_id as string, {
      deliveryId: row.id,
      attempts: Number(closed.attempts),
      ...(status === 'cancelled' ? { reason } : { error: truncate(message) }),
      ...(status === 'unconfirmed' ? { uncertainSince: closed.uncertain_since } : {})
    });
  }

  private latestFor(passId: string): PassDelivery {
    const row = this.db
      .prepare('SELECT d.*, p.attendee_name, 0 AS superseded FROM pass_deliveries d JOIN passes p ON p.id = d.pass_id WHERE d.pass_id = ? ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1')
      .get(passId) as Row;
    return toDelivery(row);
  }

  private audit(eventId: string, actor: string, action: string, entityId: string | null, details: Record<string, unknown>): void {
    recordAudit(this.db, { eventId, actor, action, entityId, details, at: this.timestamp() });
  }

  private timestamp(): string {
    return this.options.now().toISOString();
  }
}

function truncate(message: string): string {
  return message.length > MAX_ERROR ? `${message.slice(0, MAX_ERROR - 1)}…` : message;
}

/** Addresses are counted case-insensitively the way SQLite's lower() folds them: ASCII letters only. */
function foldCase(address: string): string {
  return address.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

function toDelivery(row: Row): PassDelivery {
  return {
    id: row.id as string,
    passId: row.pass_id as string,
    attendeeName: (row.attendee_name as string | null) ?? null,
    recipient: row.recipient as string,
    status: row.status as DeliveryStatus,
    attempts: Number(row.attempts),
    nextAttemptAt: (row.next_attempt_at as string | null) ?? null,
    lastAttemptAt: (row.last_attempt_at as string | null) ?? null,
    uncertainSince: (row.uncertain_since as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    providerId: (row.provider_id as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    acceptedAt: (row.accepted_at as string | null) ?? null,
    superseded: Boolean(row.superseded)
  };
}

/** Fixed subject: the event name is organizer-controlled text and stays in the (escaped) body. */
function passEmail(row: Row, link: string): MailMessage {
  const zone = row.time_zone as string;
  const starts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, dateStyle: 'full', timeStyle: 'short' }).format(new Date(row.starts_at as string));
  const name = row.attendee_name as string | null;
  const venue = row.venue as string | null;
  return composeEmail({
    to: row.recipient as string,
    subject: 'Your entry pass',
    lines: [
      name ? `Hello ${name},` : 'Hello,',
      `Here is your pass for “${row.event_name as string}”${venue ? ` at ${venue}` : ''}, starting ${starts} (${zone}).`,
      'Open the link on your phone and show the QR code at the entrance. The pass admits one person once; keep the link to yourself.'
    ],
    action: { label: 'Open your pass', url: link },
    footer: 'You received this because an event organizer issued you a pass with GatePass. If you were not expecting it, you can ignore this email.',
    idempotencyKey: row.id as string
  });
}

// ------------------------------------------------------------ worker

export interface DeliveryWorkerOptions {
  /** Provider requests per second at most. */
  perSecond: number;
  /** Counted attempts before an email is closed (`failed`, or `unconfirmed` when an attempt may have reached the provider). */
  maxAttempts: number;
  /** Longest wait between checks when nothing is due (stale rows are also swept this often). */
  idleMs?: number;
  log?: (entry: Record<string, unknown>) => void;
}

const SWEEP_EVERY_MS = 30_000;

/** 30 s, 1 min, 2 min … capped at one hour. */
export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);
}

/**
 * Worker-wide pause after `consecutive` rate-limit answers in a row: 1 s,
 * 2 s, 4 s … capped at 10 minutes, or longer when the provider asks. An
 * exhausted daily or monthly quota answers 429 to every request until it
 * resets; this keeps the worker from asking once a second meanwhile.
 */
function throttleWaitMs(consecutive: number, retryAfterMs: number | undefined): number {
  return Math.max(retryAfterMs ?? 0, Math.min(1_000 * 2 ** (consecutive - 1), 600_000));
}

/**
 * Server start-up: the worker when this server can send pass emails (start
 * it once listening). Without one, emails a crash left in `sending` are
 * queued again anyway, so they read as waiting while sending is paused
 * (`DeliveryList.paused`) and organizers can cancel them.
 */
export function deliveryWorkerFor(outbox: PassDeliveries, mailer: Mailer, options: DeliveryWorkerOptions): DeliveryWorker | null {
  if (outbox.available) return new DeliveryWorker(outbox, mailer, options);
  outbox.recoverInterrupted();
  return null;
}

/**
 * Sends due pass emails one at a time, at most `perSecond` provider requests
 * a second, taking events in turn. `stop()` stops claiming and resolves once
 * the email in flight has been recorded; `abort()` cancels that request
 * (recorded as an ambiguous attempt, retried with the same idempotency key
 * within the provider's window) so shutdown stays bounded.
 */
export class DeliveryWorker {
  private stopping = false;
  private loop: Promise<void> | null = null;
  private inFlight: AbortController | null = null;
  private idleWake: (() => void) | null = null;
  private stopWake: (() => void) | null = null;
  private nextStartAt = 0;
  private lastSweepAt = Number.NEGATIVE_INFINITY;
  /** Rate-limit answers in a row; any other answer resets it. */
  private throttled = 0;
  private readonly log: (entry: Record<string, unknown>) => void;

  constructor(
    private readonly outbox: PassDeliveries,
    private readonly mailer: Mailer,
    private readonly options: DeliveryWorkerOptions
  ) {
    this.log = options.log ?? ((entry) => console.log(JSON.stringify(entry)));
  }

  /** Re-queues rows a crash left in `sending`, re-seals waiting links after a key rotation, then runs until `stop()`. */
  start(): void {
    if (this.loop || this.stopping) return;
    const recovered = this.outbox.recoverInterrupted();
    if (recovered) this.log({ level: 'warn', msg: 'pass emails interrupted by a restart were queued again', count: recovered });
    const { resealed, unreadable } = this.outbox.resealWaiting();
    if (resealed || unreadable) {
      // Counts only: once a deploy logs nothing here, PASS_DELIVERY_PREVIOUS_KEYS can be removed.
      this.log({ level: unreadable ? 'warn' : 'info', msg: 'pass email links re-sealed under the active key', resealed, unreadable });
    }
    this.outbox.onQueued(() => this.notify());
    this.loop = this.run();
  }

  /** Wakes an idle worker (new emails are due). Never shortens the rate-limit gap. */
  notify(): void {
    this.idleWake?.();
  }

  /** Stops claiming; resolves once the email in flight (if any) is recorded. */
  stop(): Promise<void> {
    this.stopping = true;
    this.stopWake?.();
    return this.loop ?? Promise.resolve();
  }

  /** Cancels the provider request in flight. */
  abort(): void {
    this.inFlight?.abort();
  }

  /** Sends at most one due email after the rate-limit gap; false when none was due. Public for tests. */
  async runOnce(): Promise<boolean> {
    const gap = this.nextStartAt - performance.now();
    if (gap > 0) await this.pause(gap, false);
    if (this.stopping) return false;
    if (performance.now() - this.lastSweepAt >= SWEEP_EVERY_MS) {
      this.outbox.sweep();
      this.lastSweepAt = performance.now();
    }
    const job = this.outbox.claim();
    if (!job) return false;
    this.nextStartAt = performance.now() + 1000 / this.options.perSecond;
    const controller = new AbortController();
    this.inFlight = controller;
    let result: MailAttempt;
    try {
      result = await attemptSend(this.mailer, job.message, controller.signal);
    } catch (error) {
      this.log({ level: 'error', msg: 'pass email send threw', deliveryId: job.id, error: error instanceof Error ? error.name : 'unknown' });
      result = { status: 'retry', error: 'The email provider could not be reached.', ambiguous: true };
    } finally {
      this.inFlight = null;
    }
    this.settle(job, result, controller.signal.aborted);
    return true;
  }

  private settle(job: DeliveryJob, result: MailAttempt, interrupted: boolean): void {
    if (result.status === 'accepted') {
      this.throttled = 0;
      this.outbox.markAccepted(job, result.providerId);
      return;
    }
    let outcome: string;
    if (result.status === 'retry' && result.throttled) {
      this.throttled += 1;
      const wait = throttleWaitMs(this.throttled, result.retryAfterMs);
      this.outbox.reschedule(job, result.error, wait, { counted: false, ambiguous: false });
      this.nextStartAt = Math.max(this.nextStartAt, performance.now() + wait);
      outcome = 'throttled';
    } else {
      this.throttled = 0;
      const ambiguous = result.status === 'retry' && result.ambiguous;
      if (result.status === 'refused') outcome = this.outbox.markFailed(job, result.error, false) ?? 'gone';
      else if (job.attempts >= this.options.maxAttempts) outcome = this.outbox.markFailed(job, `${result.error} Gave up after ${job.attempts} attempts.`, ambiguous) ?? 'gone';
      else {
        this.outbox.reschedule(job, result.error, interrupted ? 0 : backoffMs(job.attempts), { counted: true, ambiguous });
        outcome = 'retry';
      }
    }
    this.log({ level: 'warn', msg: 'pass email not accepted', deliveryId: job.id, attempt: job.attempts, outcome });
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        if (await this.runOnce()) continue;
        if (!this.stopping) await this.pause(this.idleDelay(), true);
      } catch (error) {
        // The database was busy or closed underneath: report and try again later.
        this.log({ level: 'error', msg: 'pass email worker error', error: error instanceof Error ? error.message : String(error) });
        if (!this.stopping) await this.pause(5_000, true);
      }
    }
  }

  private idleDelay(): number {
    const idle = this.options.idleMs ?? SWEEP_EVERY_MS;
    const due = this.outbox.nextDueAt();
    if (!due) return idle;
    return Math.min(idle, Math.max(100, Date.parse(due) - this.outbox.now().getTime()));
  }

  /** `idle` pauses end early on `notify()`; every pause ends early on `stop()`. */
  private pause(ms: number, idle: boolean): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const done = () => {
      clearTimeout(timer);
      if (this.idleWake === done) this.idleWake = null;
      if (this.stopWake === done) this.stopWake = null;
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref();
    this.stopWake = done;
    if (idle) this.idleWake = done;
    return promise;
  }
}
