import { randomBytes, randomUUID, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { AccountUser, EventMember, EventRole, Invitation, InvitationPreview, InvitationRole, PlatformRole } from '../shared/types';
import { recordAudit } from './audit';
import { transaction, type Database } from './db';
import { httpError } from './http';
import { generateToken, hashToken } from './tokens';

/** OWASP Password Storage Cheat Sheet scrypt alternative (N=2^15, r=8, p=3): 32 MiB per hash. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 3, keyLength: 32 } as const;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60_000;
export const SESSION_IDLE_MS = 24 * 60 * 60_000;
/** last_seen_at is written at most this often per session, keeping reads read-only. */
const SESSION_TOUCH_MS = 5 * 60_000;
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60_000;
export const RESET_TTL_MS = 60 * 60_000;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

function deriveKey(password: string, salt: Buffer, params: { N: number; r: number; p: number; keyLength: number }): Promise<Buffer> {
  const options: ScryptOptions = { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM };
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  scrypt(password.normalize('NFKC'), salt, params.keyLength, options, (error, key) => (error ? reject(error) : resolve(key)));
  return promise;
}

/** `scrypt$N$r$p$salt$hash` (base64url). Parameters are stored so they can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await deriveKey(password, Buffer.from(salt, 'base64url'), { N: Number(n), r: Number(r), p: Number(p), keyLength: expected.length });
  return timingSafeEqual(actual, expected);
}

/** Verified against when the email is unknown, so response time does not reveal which accounts exist. */
const DUMMY_HASH = hashPassword(generateToken());

/** Common choices a length rule alone lets through (ASVS 5.0 6.2.4 asks for a breached-password check; this is a minimal local list). */
const COMMON_PASSWORDS = new Set([
  '1234567890', '12345678910', '0123456789', 'qwertyuiop', 'password12', 'password123', 'password1234', 'iloveyou12',
  'abcdefghij', 'qwerty1234', '1q2w3e4r5t', 'gatepass123', 'letmein123', 'welcome123', 'adminadmin', 'administrator'
]);

export function passwordProblem(password: string, email: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower) || lower === email.toLowerCase() || /^(.)\1+$/.test(password)) return 'That password is too easy to guess. Choose another.';
  return null;
}

type Row = Record<string, unknown>;

export interface SessionUser {
  user: AccountUser;
  expiresAt: string;
}

export interface AccountsOptions {
  now: () => Date;
  /** Base URL for invitation and reset links, without trailing slash. */
  publicUrl: string;
  generateToken?: () => string;
}

/**
 * Accounts, cookie sessions, invitations and password resets. Every secret
 * (session id, invitation and reset token) is 256-bit random and stored only
 * as its SHA-256. One-time tokens are consumed with a conditional UPDATE, so
 * two concurrent uses cannot both succeed.
 */
export class Accounts {
  private readonly now: () => Date;
  private readonly newToken: () => string;
  private readonly publicUrl: string;

  constructor(
    private readonly db: Database,
    options: AccountsOptions
  ) {
    this.now = options.now;
    this.newToken = options.generateToken ?? generateToken;
    this.publicUrl = options.publicUrl.replace(/\/+$/, '');
  }

  // ---------------------------------------------------------------- users

  async register(input: { email: string; name: string; password: string }, actor: string | null): Promise<AccountUser> {
    const problem = passwordProblem(input.password, input.email);
    if (problem) throw httpError(400, problem);
    const passwordHash = await hashPassword(input.password);
    return transaction(this.db, () => this.insertUser(input.email, input.name, passwordHash, 'organizer', actor));
  }

  getUser(id: string): AccountUser {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw httpError(404, 'Account not found');
    return toUser(row);
  }

  listUsers(): Array<AccountUser & { eventCount: number }> {
    const rows = this.db
      .prepare('SELECT u.*, (SELECT COUNT(*) FROM event_members m WHERE m.user_id = u.id) AS event_count FROM users u ORDER BY u.created_at DESC')
      .all() as Row[];
    return rows.map((row) => ({ ...toUser(row), eventCount: Number(row.event_count) }));
  }

  /**
   * Disabling ends every session of the account, cancels its open reset
   * links, and revokes the pending invitations it created (so access it
   * prepared beforehand cannot be used later). An account cannot disable itself.
   */
  setDisabled(userId: string, disabled: boolean, actor: string): AccountUser {
    transaction(this.db, () => {
      const user = this.getUser(userId);
      if (actor === `user:${userId}`) throw httpError(409, 'You cannot disable your own account.');
      if (Boolean(user.disabledAt) === disabled) return;
      const at = this.timestamp();
      this.db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(disabled ? at : null, userId);
      let invitationsRevoked = 0;
      if (disabled) {
        this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(at, userId);
        this.db.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(at, userId);
        invitationsRevoked = Number(
          this.db.prepare('UPDATE invitations SET revoked_at = ? WHERE created_by = ? AND accepted_at IS NULL AND revoked_at IS NULL').run(at, `user:${userId}`).changes
        );
      }
      this.audit(null, actor, disabled ? 'user.disabled' : 'user.enabled', userId, { email: user.email, ...(disabled ? { invitationsRevoked } : {}) });
    });
    return this.getUser(userId);
  }

  // ---------------------------------------------------------------- sessions

  /**
   * Returns a new session token, or null for any failure (unknown email,
   * wrong password, disabled account) so callers cannot tell them apart.
   */
  async login(email: string, password: string, context: { ip: string }): Promise<{ user: AccountUser; token: string; expiresAt: string } | null> {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim()) as Row | undefined;
    const valid = await verifyPassword(password, (row?.password_hash as string | undefined) ?? (await DUMMY_HASH));
    if (!row || !valid || row.disabled_at) {
      transaction(this.db, () => this.audit(null, 'anonymous', 'user.login_failed', (row?.id as string | undefined) ?? null, { email: email.trim().slice(0, 254), ip: context.ip }));
      return null;
    }
    const user = toUser(row);
    return transaction(this.db, () => {
      const session = this.createSession(user.id);
      this.audit(null, `user:${user.id}`, 'user.login', user.id, { ip: context.ip });
      return { user, ...session };
    });
  }

  /** Resolves a session cookie. Expired, idle, revoked and disabled-account sessions are refused. */
  authenticate(token: string): SessionUser | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const idHash = hashToken(token);
    const row = this.db
      .prepare(
        `SELECT u.*, s.expires_at AS session_expires_at, s.last_seen_at AS session_last_seen_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id_hash = ? AND s.revoked_at IS NULL AND u.disabled_at IS NULL`
      )
      .get(idHash) as Row | undefined;
    if (!row) return null;
    const now = this.now();
    const nowIso = now.toISOString();
    const lastSeen = Date.parse(row.session_last_seen_at as string);
    if ((row.session_expires_at as string) <= nowIso || now.getTime() - lastSeen >= SESSION_IDLE_MS) return null;
    if (now.getTime() - lastSeen >= SESSION_TOUCH_MS) {
      this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(nowIso, idHash);
    }
    return { user: toUser(row), expiresAt: row.session_expires_at as string };
  }

  logout(token: string): void {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    transaction(this.db, () => {
      const row = this.db.prepare('SELECT user_id FROM sessions WHERE id_hash = ? AND revoked_at IS NULL').get(hashToken(token)) as Row | undefined;
      if (!row) return;
      this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE id_hash = ?').run(this.timestamp(), hashToken(token));
      this.audit(null, `user:${row.user_id as string}`, 'user.logout', row.user_id as string, {});
    });
  }

  /** Changing the password ends every other session; the caller receives a fresh one. */
  async changePassword(userId: string, current: string, next: string): Promise<{ token: string; expiresAt: string }> {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Row | undefined;
    if (!row || !(await verifyPassword(current, row.password_hash as string))) {
      transaction(this.db, () => this.audit(null, `user:${userId}`, 'user.password_change_failed', userId, {}));
      throw httpError(400, 'The current password is not correct.');
    }
    const problem = passwordProblem(next, row.email as string);
    if (problem) throw httpError(400, problem);
    const passwordHash = await hashPassword(next);
    return transaction(this.db, () => {
      const at = this.timestamp();
      this.db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?').run(passwordHash, at, userId);
      this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(at, userId);
      // A reset link issued before the change must not undo it.
      this.db.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(at, userId);
      this.audit(null, `user:${userId}`, 'user.password_changed', userId, {});
      return this.createSession(userId);
    });
  }

  // ---------------------------------------------------------------- invitations

  /** Returns the one-time link; only its hash is stored. Manager invitations need `eventId`. */
  createInvitation(input: { role: InvitationRole; email: string; eventId?: string | null }, actor: string): { invitation: Invitation; url: string } {
    const token = this.newToken();
    const id = randomUUID();
    const eventId = input.role === 'manager' ? (input.eventId ?? null) : null;
    if (input.role === 'manager' && !eventId) throw httpError(400, 'A manager invitation needs an event.');
    transaction(this.db, () => {
      if (eventId) {
        const existing = this.db
          .prepare('SELECT 1 FROM event_members m JOIN users u ON u.id = m.user_id WHERE m.event_id = ? AND u.email = ?')
          .get(eventId, input.email);
        if (existing) throw httpError(409, 'That person is already on the event team.');
      } else if (this.db.prepare('SELECT 1 FROM users WHERE email = ?').get(input.email)) {
        throw httpError(409, 'An account with that email already exists.');
      }
      const now = this.now();
      this.db
        .prepare('INSERT INTO invitations (id, token_hash, role, email, event_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, hashToken(token), input.role, input.email, eventId, actor, now.toISOString(), new Date(now.getTime() + INVITATION_TTL_MS).toISOString());
      this.audit(eventId, actor, 'invitation.created', id, { role: input.role, email: input.email });
    });
    return { invitation: this.getInvitation(id), url: `${this.publicUrl}/#/invite/${token}` };
  }

  getInvitation(id: string): Invitation {
    const row = this.db.prepare('SELECT * FROM invitations WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw httpError(404, 'Invitation not found');
    return this.toInvitation(row);
  }

  listInvitations(eventId: string | null): Invitation[] {
    const rows = (
      eventId
        ? this.db.prepare('SELECT * FROM invitations WHERE event_id = ? ORDER BY created_at DESC').all(eventId)
        : this.db.prepare('SELECT * FROM invitations WHERE event_id IS NULL ORDER BY created_at DESC').all()
    ) as Row[];
    return rows.map((row) => this.toInvitation(row));
  }

  revokeInvitation(id: string, actor: string): Invitation {
    transaction(this.db, () => {
      const invitation = this.getInvitation(id);
      if (invitation.status !== 'pending') throw httpError(409, `This invitation is already ${invitation.status}.`);
      this.db.prepare('UPDATE invitations SET revoked_at = ? WHERE id = ?').run(this.timestamp(), id);
      this.audit(invitation.eventId, actor, 'invitation.revoked', id, { email: invitation.email });
    });
    return this.getInvitation(id);
  }

  /** Public preview of a pending invitation. Unusable tokens all return null. */
  previewInvitation(token: string): InvitationPreview | null {
    const row = this.pendingInvitation(token);
    if (!row) return null;
    const event = row.event_id ? (this.db.prepare('SELECT name FROM events WHERE id = ?').get(row.event_id as string) as Row | undefined) : undefined;
    return {
      role: row.role as InvitationRole,
      email: row.email as string,
      eventName: (event?.name as string | undefined) ?? null,
      expiresAt: row.expires_at as string,
      accountExists: Boolean(this.db.prepare('SELECT 1 FROM users WHERE email = ?').get(row.email as string))
    };
  }

  /**
   * Consumes an invitation exactly once. A signed-in account accepts a manager
   * invitation only if its email matches; otherwise a new account is created
   * with the invited email and the given password (and a session is returned).
   */
  async acceptInvitation(
    token: string,
    input: { currentUser: AccountUser | null; name?: string; password?: string }
  ): Promise<{ user: AccountUser; session: { token: string; expiresAt: string } | null; eventId: string | null }> {
    const pending = this.pendingInvitation(token);
    if (!pending) throw httpError(410, 'This invitation link is invalid, expired or already used.');
    const email = pending.email as string;
    const existing = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as Row | undefined;
    let passwordHash: string | null = null;
    if (existing) {
      if (!input.currentUser || input.currentUser.id !== existing.id) throw httpError(409, `Sign in as ${email} to accept this invitation.`);
    } else {
      if (!input.name || !input.password) throw httpError(400, 'Enter your name and a password to create your account.');
      const problem = passwordProblem(input.password, email);
      if (problem) throw httpError(400, problem);
      passwordHash = await hashPassword(input.password);
    }
    return transaction(this.db, () => {
      // A concurrent acceptance may have committed while this request was hashing the password.
      if (!this.pendingInvitation(token)) throw httpError(410, 'This invitation link is invalid, expired or already used.');
      const at = this.timestamp();
      const user = existing ? toUser(existing) : this.insertUser(email, input.name!, passwordHash!, pending.role === 'platform_admin' ? 'platform_admin' : 'organizer', null);
      const claimed = this.db
        .prepare('UPDATE invitations SET accepted_at = ?, accepted_by = ? WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?')
        .run(at, user.id, hashToken(token), at);
      if (claimed.changes !== 1) throw httpError(410, 'This invitation link is invalid, expired or already used.');
      const eventId = (pending.event_id as string | null) ?? null;
      if (eventId) {
        this.db
          .prepare("INSERT INTO event_members (event_id, user_id, role, created_at) VALUES (?, ?, 'manager', ?) ON CONFLICT (event_id, user_id) DO NOTHING")
          .run(eventId, user.id, at);
      }
      this.audit(eventId, `user:${user.id}`, 'invitation.accepted', pending.id as string, { role: pending.role });
      return { user, session: existing ? null : this.createSession(user.id), eventId };
    });
  }

  // ---------------------------------------------------------------- password reset

  /**
   * Platform-admin generated one-time reset link (no email provider is
   * configured). Resetting a platform administrator needs the operator, so
   * one admin cannot take over another. The requesting admin is recorded on
   * both the creation and the use of the link.
   */
  createPasswordReset(userId: string, actor: string): { url: string; expiresAt: string } {
    const token = this.newToken();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + RESET_TTL_MS).toISOString();
    transaction(this.db, () => {
      const user = this.getUser(userId);
      if (user.platformRole === 'platform_admin' && actor !== 'operator') throw httpError(403, 'Only the operator can reset a platform administrator.');
      // Only the newest link works.
      this.db.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(now.toISOString(), userId);
      this.db
        .prepare('INSERT INTO password_resets (token_hash, user_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(hashToken(token), userId, actor, now.toISOString(), expiresAt);
      this.audit(null, actor, 'user.password_reset_created', userId, { email: user.email });
    });
    return { url: `${this.publicUrl}/#/reset/${token}`, expiresAt };
  }

  /** Consumes the reset token once, sets the password and ends every session of the account. */
  async resetPassword(token: string, password: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw httpError(410, 'This reset link is invalid, expired or already used.');
    const row = this.db
      .prepare('SELECT r.user_id, r.created_by, u.email FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > ?')
      .get(hashToken(token), this.timestamp()) as Row | undefined;
    if (!row) throw httpError(410, 'This reset link is invalid, expired or already used.');
    const problem = passwordProblem(password, row.email as string);
    if (problem) throw httpError(400, problem);
    const passwordHash = await hashPassword(password);
    transaction(this.db, () => {
      const at = this.timestamp();
      const claimed = this.db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').run(at, hashToken(token), at);
      if (claimed.changes !== 1) throw httpError(410, 'This reset link is invalid, expired or already used.');
      this.db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?').run(passwordHash, at, row.user_id as string);
      this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(at, row.user_id as string);
      this.audit(null, `user:${row.user_id as string}`, 'user.password_reset_used', row.user_id as string, { requestedBy: row.created_by as string });
    });
  }

  // ---------------------------------------------------------------- event membership

  eventRole(userId: string, eventId: string): EventRole | null {
    const row = this.db.prepare('SELECT role FROM event_members WHERE event_id = ? AND user_id = ?').get(eventId, userId) as Row | undefined;
    return (row?.role as EventRole | undefined) ?? null;
  }

  listMembers(eventId: string): EventMember[] {
    const rows = this.db
      .prepare(
        `SELECT m.user_id, u.email, u.name, m.role, m.created_at FROM event_members m JOIN users u ON u.id = m.user_id
         WHERE m.event_id = ? ORDER BY m.role DESC, u.name`
      )
      .all(eventId) as Row[];
    return rows.map((row) => ({
      userId: row.user_id as string,
      email: row.email as string,
      name: row.name as string,
      role: row.role as EventRole,
      createdAt: row.created_at as string
    }));
  }

  /**
   * Owners cannot be removed here; ownership moves with `setOwner`. Scanner
   * keys the removed person issued (created or rotated) for this event are
   * revoked in the same transaction: they may still hold them.
   */
  removeMember(eventId: string, userId: string, actor: string): void {
    transaction(this.db, () => {
      const role = this.eventRole(userId, eventId);
      if (!role) throw httpError(404, 'That person is not on the event team.');
      if (role === 'owner') throw httpError(409, 'The owner cannot be removed. Transfer ownership first.');
      this.db.prepare('DELETE FROM event_members WHERE event_id = ? AND user_id = ?').run(eventId, userId);
      const at = this.timestamp();
      const keys = this.db
        .prepare('SELECT id FROM scanners WHERE event_id = ? AND key_issued_by = ? AND revoked_at IS NULL')
        .all(eventId, `user:${userId}`) as Array<{ id: string }>;
      for (const { id } of keys) {
        this.db.prepare('UPDATE scanners SET revoked_at = ? WHERE id = ?').run(at, id);
        this.audit(eventId, actor, 'scanner.revoked', id, { reason: 'issuer removed from team' });
      }
      this.audit(eventId, actor, 'member.removed', userId, { scannersRevoked: keys.length });
    });
  }

  /** Makes `userId` the owner; a previous owner stays on the team as a manager. Must run inside a transaction. */
  setOwnerInTransaction(eventId: string, userId: string, actor: string): void {
    const user = this.getUser(userId);
    const at = this.timestamp();
    const previous = this.db.prepare("SELECT user_id FROM event_members WHERE event_id = ? AND role = 'owner'").get(eventId) as Row | undefined;
    if (previous?.user_id === userId) return;
    if (previous) this.db.prepare("UPDATE event_members SET role = 'manager' WHERE event_id = ? AND user_id = ?").run(eventId, previous.user_id as string);
    this.db
      .prepare("INSERT INTO event_members (event_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?) ON CONFLICT (event_id, user_id) DO UPDATE SET role = 'owner'")
      .run(eventId, userId, at);
    this.audit(eventId, actor, 'member.owner_set', userId, { email: user.email, previousOwner: (previous?.user_id as string | undefined) ?? null });
  }

  // ---------------------------------------------------------------- internals

  private insertUser(email: string, name: string, passwordHash: string, role: PlatformRole, actor: string | null): AccountUser {
    const id = randomUUID();
    const at = this.timestamp();
    if (this.db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw httpError(409, 'An account with that email already exists. Sign in instead.');
    this.db
      .prepare('INSERT INTO users (id, email, name, password_hash, platform_role, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, email.trim(), name.trim(), passwordHash, role, at, at);
    this.audit(null, actor ?? `user:${id}`, 'user.registered', id, { email: email.trim(), platformRole: role });
    return this.getUser(id);
  }

  private createSession(userId: string): { token: string; expiresAt: string } {
    const token = this.newToken();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MS).toISOString();
    this.db
      .prepare('INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
      .run(hashToken(token), userId, now.toISOString(), expiresAt, now.toISOString());
    return { token, expiresAt };
  }

  private pendingInvitation(token: string): Row | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    return this.db
      .prepare('SELECT * FROM invitations WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?')
      .get(hashToken(token), this.timestamp()) as Row | undefined;
  }

  private toInvitation(row: Row): Invitation {
    const acceptedAt = (row.accepted_at as string | null) ?? null;
    const revokedAt = (row.revoked_at as string | null) ?? null;
    const expiresAt = row.expires_at as string;
    return {
      id: row.id as string,
      role: row.role as InvitationRole,
      email: row.email as string,
      eventId: (row.event_id as string | null) ?? null,
      createdBy: row.created_by as string,
      createdAt: row.created_at as string,
      expiresAt,
      acceptedAt,
      revokedAt,
      status: acceptedAt ? 'accepted' : revokedAt ? 'revoked' : expiresAt <= this.timestamp() ? 'expired' : 'pending'
    };
  }

  private audit(eventId: string | null, actor: string, action: string, entityId: string | null, details: Record<string, unknown>): void {
    recordAudit(this.db, { eventId, actor, action, entityId, details, at: this.timestamp() });
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function toUser(row: Row): AccountUser {
  return {
    id: row.id as string,
    email: row.email as string,
    name: row.name as string,
    platformRole: row.platform_role as PlatformRole,
    createdAt: row.created_at as string,
    disabledAt: (row.disabled_at as string | null) ?? null
  };
}
