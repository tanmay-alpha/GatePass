import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import { renderQr } from '../qr/renderer';
import type { AccountUser, DesignConfig, EventPermission, SessionInfo } from '../shared/types';
import { SESSION_ABSOLUTE_MS } from './accounts';
import type { AuthenticatedScanner, GatePass } from './gatepass';
import { bearerToken, errorHandler, FailureThrottle, httpError, type Middleware, rateLimit } from './http';
import { renderPassPage } from './pass-page';
import { actorOf, type Principal } from './permissions';
import { safeEqual } from './tokens';

export interface AppOptions {
  service: GatePass;
  /** Break-glass operator credential (API only, never offered in the UI). */
  adminToken: string;
  /** Public origin of the app; decides whether the session cookie is `Secure`/`__Host-`. */
  publicUrl?: string;
  /** Allow anyone to create an organizer account. */
  allowSignup?: boolean;
  trustProxy?: number | string | boolean;
  /** Built SPA directory; served only when it contains index.html. */
  clientDir?: string;
  /**
   * When set, every request except /api/health must carry `X-Origin-Secret`
   * with this value. Used when a CDN (e.g. Vercel rewrites) fronts the API, so
   * clients cannot bypass it and spoof forwarding headers.
   */
  originSecret?: string;
  /**
   * Header the fronting CDN sets to the visitor IP. Requires `originSecret`.
   * Replaces `req.ip` for rate limiting and failure throttling.
   */
  clientIpHeader?: string;
  /** Disable rate limiting (benchmarks only). */
  rateLimits?: boolean;
  /** Deployment has no durable storage; reported by /api/health so the UI can warn. */
  demoMode?: boolean;
}

const isoDateTime = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'must be an ISO 8601 date-time');
const id = z.string().min(1).max(64);
const designInput = z.record(z.string(), z.unknown());
const optionalEmail = z.union([z.email().max(254), z.literal('')]).nullish();
const email = z.email('Enter a valid email address.').max(254);
const password = z.string().min(1).max(256);
const personName = z.string().trim().min(1, 'Enter your name.').max(100);
const timeZone = z.string().trim().min(1).max(64);
const capacity = z.number().int().min(1).max(1_000_000).nullable();

const eventFields = {
  name: z.string().trim().min(1).max(200),
  venue: z.string().trim().max(200).nullish(),
  timeZone: timeZone.optional(),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  capacity: capacity.optional(),
  design: designInput.optional()
};
const createEventSchema = z.strictObject({ ...eventFields, status: z.enum(['draft', 'active']).optional() });
const updateEventSchema = z.strictObject({
  name: eventFields.name.optional(),
  venue: eventFields.venue,
  timeZone: timeZone.optional(),
  startsAt: isoDateTime.optional(),
  endsAt: isoDateTime.optional(),
  capacity: capacity.optional(),
  design: designInput.optional(),
  status: z.enum(['draft', 'active', 'ended', 'archived']).optional()
});
const cloneSchema = z.strictObject({ name: eventFields.name, startsAt: isoDateTime, endsAt: isoDateTime });
const attendee = z.strictObject({ name: z.string().trim().max(200).nullish(), email: optionalEmail });
const issueSchema = z
  .strictObject({
    attendees: z.array(attendee).min(1).max(500).optional(),
    count: z.number().int().min(1).max(500).optional(),
    expiresAt: isoDateTime.optional(),
    policyId: id.optional()
  })
  .refine((value) => !(value.attendees && value.count), 'Provide attendees or count, not both');
// Import rows are validated row by row by the service (invalid rows are reported, not fatal).
const importSchema = z.strictObject({
  rows: z.array(z.strictObject({ name: z.string().max(1000).nullish(), email: z.string().max(1000).nullish() })).min(1).max(2000),
  policyId: id.optional(),
  expiresAt: isoDateTime.optional(),
  dryRun: z.boolean()
});
const bulkRevokeSchema = z.strictObject({ passIds: z.array(id).min(1).max(500) });
const passFilterSchema = z.object({
  status: z.enum(['active', 'redeemed', 'revoked', 'expired']).optional(),
  q: z.string().trim().max(200).optional(),
  policyId: id.optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
  offset: z.coerce.number().int().min(0).optional()
});
const passPatchSchema = z.strictObject({ policyId: id.nullable() });
const scansQuerySchema = z.object({
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
});
const auditQuerySchema = z.object({
  action: z.string().trim().max(64).optional(),
  q: z.string().trim().max(200).optional(),
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional()
});
const scannerSchema = z.strictObject({ label: z.string().trim().min(1).max(100), gateId: id.nullish() });
const gateSchema = z.strictObject({ name: z.string().trim().min(1).max(100) });
const policyFields = {
  name: z.string().trim().min(1).max(100),
  opensAt: isoDateTime.nullish(),
  closesAt: isoDateTime.nullish(),
  capacity: z.number().int().min(1).max(1_000_000).nullish(),
  gateIds: z.array(id).max(50).optional()
};
const createPolicySchema = z.strictObject(policyFields);
const updatePolicySchema = z.strictObject({ ...policyFields, name: policyFields.name.optional() });
const redeemSchema = z.strictObject({ code: z.string().min(1).max(2048), requestId: z.string().min(8).max(64).optional() });
const qrSchema = z.object({
  data: z.string().min(1).max(1024),
  size: z.coerce.number().optional().default(300),
  file: z.enum(['png', 'svg', 'pdf', 'eps']).optional().default('svg'),
  download: z.coerce.boolean().optional().default(false),
  config: designInput.optional().default({})
});
const registerSchema = z.strictObject({ email, name: personName, password });
const loginSchema = z.strictObject({ email: z.string().trim().min(1).max(254), password });
const passwordChangeSchema = z.strictObject({ currentPassword: password, newPassword: password });
const acceptSchema = z.strictObject({ token: z.string().min(1).max(100), name: personName.optional(), password: password.optional() });
const resetSchema = z.strictObject({ token: z.string().min(1).max(100), password });
const managerInviteSchema = z.strictObject({ email });
const platformInviteSchema = z.strictObject({ email, role: z.enum(['organizer', 'platform_admin']) });
const ownerSchema = z.strictObject({ userId: id });

const passThrough: Middleware = (_req, _res, next) => next();
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function createApp({
  service,
  adminToken,
  publicUrl = 'http://localhost:3000',
  allowSignup = false,
  trustProxy = false,
  clientDir,
  originSecret,
  clientIpHeader,
  rateLimits = true,
  demoMode = false
}: AppOptions): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  const limit = (perMinute: number, key?: Parameters<typeof rateLimit>[1]) => (rateLimits ? rateLimit(perMinute, key) : passThrough);
  const secureCookie = publicUrl.startsWith('https://');
  // `__Host-` cookies must be Secure, Path=/ and carry no Domain: the browser refuses anything else.
  const SESSION_COOKIE = secureCookie ? '__Host-gatepass_session' : 'gatepass_session';

  if (originSecret) {
    app.use((req, res, next) => {
      if (req.path === '/api/health' || safeEqual(req.header('x-origin-secret') ?? '', originSecret)) return next();
      res.status(403).json({ error: 'Forbidden' });
    });
    if (clientIpHeader) {
      app.use((req, _res, next) => {
        // The last entry is the one the CDN itself appended; anything before it may come from the client.
        const ip = req.header(clientIpHeader)?.split(',').at(-1)?.trim();
        if (ip) Object.defineProperty(req, 'ip', { value: ip, configurable: true });
        next();
      });
    }
  }

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // 'wasm-unsafe-eval' lets the scanner compile the self-hosted ZXing WebAssembly decoder.
          scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'blob:', 'data:'],
          mediaSrc: ["'self'", 'blob:'],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'self'"],
          objectSrc: ["'none'"],
          // TLS is terminated by the reverse proxy; upgrading would break plain-HTTP local use.
          upgradeInsecureRequests: null
        }
      },
      frameguard: { action: 'deny' },
      referrerPolicy: { policy: 'no-referrer' }
    })
  );
  app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    next();
  });
  app.use(['/api', '/p'], (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // Per-IP limit for admin and public API traffic. Scanner routes are limited
  // per device instead (below): every gate at a venue often shares one NAT address.
  const apiLimit = limit(600);
  app.use('/api', (req, res, next) => (req.path.startsWith('/scanner/') ? next() : apiLimit(req, res, next)));
  app.use(express.json({ limit: '512kb' }));

  // CSRF: browser requests that change state with the session cookie (and
  // the cookie-issuing sign-in, sign-up, invitation and reset endpoints) must
  // carry a custom header. Cross-site forms cannot set it, and a cross-site
  // fetch that sets it needs a CORS preflight this server never approves.
  // Cross-site fetch metadata is refused outright. Bearer requests (scanner
  // devices, operator) carry no ambient credential and are exempt.
  app.use('/api', (req, res, next) => {
    if (!UNSAFE_METHODS.has(req.method) || req.header('authorization')) return next();
    const cookieAuth = (req.header('cookie') ?? '').includes(`${SESSION_COOKIE}=`);
    const route = req.path.toLowerCase(); // Express routing is case-insensitive
    const issuesSession = route.startsWith('/auth/') || route.startsWith('/invitations/');
    if (!cookieAuth && !issuesSession) return next();
    if (req.header('x-gatepass-csrf') !== '1' || req.header('sec-fetch-site') === 'cross-site') {
      res.status(403).json({ error: 'Request blocked: missing CSRF header' });
      return;
    }
    next();
  });

  // Only requests with invalid credentials are throttled; valid ones always pass.
  const failures = new FailureThrottle(60, 5 * 60_000);
  // Per-account login failures, so one address cannot be guessed at from many IPs.
  const accountFailures = new FailureThrottle(10, 15 * 60_000);
  const refuse = (req: express.Request<unknown>, res: express.Response, message: string) => {
    const wait = rateLimits ? failures.fail(req.ip ?? 'unknown') : 0;
    if (wait > 0) {
      res.setHeader('Retry-After', String(wait));
      res.status(429).json({ error: 'Too many failed authentication attempts' });
      return;
    }
    res.status(401).json({ error: message });
  };

  const sessionToken = (req: express.Request<unknown>): string | null => {
    for (const part of (req.header('cookie') ?? '').split(';')) {
      const [name, ...value] = part.trim().split('=');
      if (name === SESSION_COOKIE) return value.join('=');
    }
    return null;
  };
  const setSessionCookie = (res: express.Response, token: string) => {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_ABSOLUTE_MS / 1000}${secureCookie ? '; Secure' : ''}`);
  };
  const clearSessionCookie = (res: express.Response) => {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie ? '; Secure' : ''}`);
  };

  /** Operator bearer token or account session cookie. Scanner keys are never accepted here. */
  const requireAccount: Middleware = (req, res, next) => {
    const bearer = bearerToken(req.header('authorization'));
    if (req.header('authorization')) {
      if (bearer && safeEqual(bearer, adminToken)) {
        res.locals.principal = { kind: 'operator' } satisfies Principal;
        return next();
      }
      return refuse(req, res, 'Sign in required');
    }
    const token = sessionToken(req);
    const session = token ? service.accounts.authenticate(token) : null;
    if (session) {
      res.locals.principal = { kind: 'user', user: session.user } satisfies Principal;
      res.locals.session = session;
      return next();
    }
    if (token) {
      clearSessionCookie(res);
      return refuse(req, res, 'Your session has ended. Sign in again.');
    }
    res.status(401).json({ error: 'Sign in required' });
  };

  const principalOf = (res: express.Response): Principal => res.locals.principal as Principal;
  const actor = (res: express.Response): string => actorOf(principalOf(res));
  const ownerIdOf = (res: express.Response): string | null => {
    const principal = principalOf(res);
    return principal.kind === 'user' ? principal.user.id : null;
  };

  const requirePlatformAdmin: Middleware = (_req, res, next) => {
    const principal = principalOf(res);
    if (principal.kind === 'operator' || principal.user.platformRole === 'platform_admin') return next();
    next(httpError(403, 'Platform administrators only.'));
  };

  /**
   * Authorizes the event named by the route (`:eventId`, or the event that
   * owns `:passId` / `:policyId` / `:gateId` / `:scannerId` / `:invitationId`)
   * against the caller's role, and stores it in `res.locals.eventId`.
   */
  const requireEvent =
    (permission: EventPermission): Middleware =>
    (req, res, next) => {
      const params = req.params as Record<string, string | undefined>;
      try {
        const eventId = params.eventId
          ? params.eventId
          : params.passId
            ? service.passEventId(params.passId)
            : params.policyId
              ? service.access.policyEventId(params.policyId)
              : params.gateId
                ? service.access.gateEventId(params.gateId)
                : params.scannerId
                  ? service.scannerEventId(params.scannerId)
                  : null;
        if (!eventId) throw httpError(404, 'Not found');
        service.authorize(principalOf(res), eventId, permission);
        res.locals.eventId = eventId;
        next();
      } catch (error) {
        next(error);
      }
    };
  const eventOf = (res: express.Response): string => res.locals.eventId as string;

  const requireScanner: Middleware = (req, res, next) => {
    const key = bearerToken(req.header('authorization'));
    const scanner = key ? service.authenticateScanner(key) : null;
    if (!scanner) return refuse(req, res, 'Scanner authentication required');
    res.locals.scanner = scanner;
    next();
  };
  const scannerOf = (res: express.Response): AuthenticatedScanner => res.locals.scanner as AuthenticatedScanner;

  const sessionInfo = (user: AccountUser, expiresAt: string): SessionInfo => ({ user, expiresAt });
  const sendCsv = (res: express.Response, filename: string, body: string) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(body);
  };
  const authLimit = limit(20);

  // ------------------------------------------------------------ public

  app.get('/api/health', (_req, res) => {
    try {
      service.ping();
      res.json({ ok: true, service: 'gatepass', signup: allowSignup, ...(demoMode ? { demo: true } : {}) });
    } catch (error) {
      console.error(error);
      res.status(503).json({ ok: false });
    }
  });

  // Attendee-facing pass page. Read-only: opening or previewing the link never redeems.
  app.get('/p/:token', limit(60), async (req, res) => {
    const found = service.viewPass(req.params.token);
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    if (!found) {
      res.status(404).type('html').send(renderPassPage(null));
      return;
    }
    const policy = service.access.admissionPolicy(found.pass.policyId);
    const admission = {
      policyName: policy ? policy.name : null,
      gates: policy ? policy.gates.map((g) => g.name) : []
    };
    const qr = await renderQr({ data: service.passUrl(req.params.token), size: 320, file: 'svg', config: found.event.design });
    res.type('html').send(renderPassPage({ ...found, admission, qrSvg: String(qr.body) }));
  });

  // ------------------------------------------------------------ accounts

  app.post('/api/auth/register', authLimit, async (req, res) => {
    if (!allowSignup) throw httpError(403, 'Self-registration is closed. Ask a platform administrator for an invitation.');
    const input = registerSchema.parse(req.body);
    const user = await service.accounts.register(input, null);
    const login = await service.accounts.login(input.email, input.password, { ip: req.ip ?? 'unknown' });
    setSessionCookie(res, login!.token);
    res.status(201).json(sessionInfo(user, login!.expiresAt));
  });

  app.post('/api/auth/login', authLimit, async (req, res) => {
    const input = loginSchema.parse(req.body);
    const account = input.email.trim().toLowerCase();
    const tooMany = (wait: number) => {
      res.setHeader('Retry-After', String(wait));
      res.status(429).json({ error: 'Too many failed sign-in attempts. Try again later.' });
    };
    // An account over its failure limit is refused BEFORE the password is
    // checked, so guessing from many addresses gains nothing during the lock.
    // Trade-off (documented): an attacker can keep a known account locked.
    const locked = rateLimits ? accountFailures.blocked(account) : 0;
    if (locked > 0) return tooMany(locked);
    const login = await service.accounts.login(input.email, input.password, { ip: req.ip ?? 'unknown' });
    if (!login) {
      const wait = rateLimits ? Math.max(failures.fail(req.ip ?? 'unknown'), accountFailures.fail(account)) : 0;
      if (wait > 0) return tooMany(wait);
      res.status(401).json({ error: 'Email or password is incorrect.' });
      return;
    }
    setSessionCookie(res, login.token);
    res.json(sessionInfo(login.user, login.expiresAt));
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = sessionToken(req);
    if (token) service.accounts.logout(token);
    clearSessionCookie(res);
    res.status(204).end();
  });

  app.get('/api/auth/session', requireAccount, (_req, res) => {
    const principal = principalOf(res);
    if (principal.kind === 'operator') throw httpError(400, 'The operator token has no account session.');
    res.json(sessionInfo(principal.user, (res.locals.session as { expiresAt: string }).expiresAt));
  });

  app.post('/api/auth/password', requireAccount, authLimit, async (req, res) => {
    const principal = principalOf(res);
    if (principal.kind === 'operator') throw httpError(400, 'The operator token has no password.');
    const input = passwordChangeSchema.parse(req.body);
    const session = await service.accounts.changePassword(principal.user.id, input.currentPassword, input.newPassword);
    setSessionCookie(res, session.token);
    res.json(sessionInfo(principal.user, session.expiresAt));
  });

  app.post('/api/auth/reset', authLimit, async (req, res) => {
    const input = resetSchema.parse(req.body);
    await service.accounts.resetPassword(input.token, input.password);
    clearSessionCookie(res);
    res.status(204).end();
  });

  // POST with the token in the body: a GET path would put the one-time token into proxy request logs.
  app.post('/api/invitations/preview', authLimit, (req, res) => {
    const preview = service.accounts.previewInvitation(z.strictObject({ token: z.string().min(1).max(100) }).parse(req.body).token);
    if (!preview) throw httpError(410, 'This invitation link is invalid, expired or already used.');
    res.json(preview);
  });

  app.post('/api/invitations/accept', authLimit, async (req, res) => {
    const input = acceptSchema.parse(req.body);
    const token = sessionToken(req);
    const current = token ? service.accounts.authenticate(token) : null;
    const result = await service.accounts.acceptInvitation(input.token, { currentUser: current?.user ?? null, name: input.name, password: input.password });
    if (result.session) setSessionCookie(res, result.session.token);
    res.json({ user: result.user, eventId: result.eventId });
  });

  // ------------------------------------------------------------ platform

  app.get('/api/platform/users', requireAccount, requirePlatformAdmin, (_req, res) => {
    res.json(service.accounts.listUsers());
  });
  app.post('/api/platform/users/:userId/disable', requireAccount, requirePlatformAdmin, (req, res) => {
    res.json(service.accounts.setDisabled(req.params.userId, true, actor(res)));
  });
  app.post('/api/platform/users/:userId/enable', requireAccount, requirePlatformAdmin, (req, res) => {
    res.json(service.accounts.setDisabled(req.params.userId, false, actor(res)));
  });
  app.post('/api/platform/users/:userId/reset-link', requireAccount, requirePlatformAdmin, (req, res) => {
    res.json(service.accounts.createPasswordReset(req.params.userId, actor(res)));
  });
  app.get('/api/platform/invitations', requireAccount, requirePlatformAdmin, (_req, res) => {
    res.json(service.accounts.listInvitations(null));
  });
  app.post('/api/platform/invitations', requireAccount, requirePlatformAdmin, (req, res) => {
    const input = platformInviteSchema.parse(req.body);
    res.status(201).json(service.accounts.createInvitation(input, actor(res)));
  });

  // Platform invitations need a platform admin; manager invitations need `team` on their event.
  app.post('/api/invitations/:invitationId/revoke', requireAccount, (req, res) => {
    const invitation = service.accounts.getInvitation(req.params.invitationId);
    const principal = principalOf(res);
    if (invitation.eventId) service.authorize(principal, invitation.eventId, 'team');
    else if (principal.kind === 'user' && principal.user.platformRole !== 'platform_admin') throw httpError(404, 'Invitation not found');
    res.json(service.accounts.revokeInvitation(invitation.id, actor(res)));
  });

  // ------------------------------------------------------------ admin

  // QR rendering is CPU-bound; only the admin UI needs it, so it is not public.
  const qrLimiter = limit(120);
  app.get('/api/qr/custom', requireAccount, qrLimiter, async (req, res) => {
    let config: unknown = {};
    if (typeof req.query.config === 'string') {
      try {
        config = JSON.parse(req.query.config);
      } catch {
        throw httpError(400, 'config must be valid JSON');
      }
    }
    await sendQr(res, qrSchema.parse({ ...req.query, config }));
  });
  app.post('/api/qr/custom', requireAccount, qrLimiter, async (req, res) => {
    await sendQr(res, qrSchema.parse(req.body));
  });

  app.get('/api/events', requireAccount, (_req, res) => {
    res.json(service.listEvents(principalOf(res)));
  });

  app.post('/api/events', requireAccount, (req, res) => {
    const input = createEventSchema.parse(req.body);
    const event = service.createEvent({ ...input, design: input.design as Partial<DesignConfig> | undefined }, actor(res), ownerIdOf(res));
    res.status(201).json(service.getEvent(event.id, principalOf(res)));
  });

  app.get('/api/events/:eventId', requireAccount, requireEvent('view'), (req, res) => {
    res.json(service.getEvent(req.params.eventId, principalOf(res)));
  });

  app.patch('/api/events/:eventId', requireAccount, requireEvent('edit'), (req, res) => {
    const patch = updateEventSchema.parse(req.body);
    if (patch.status !== undefined) service.authorize(principalOf(res), req.params.eventId, 'lifecycle');
    service.updateEvent(req.params.eventId, { ...patch, design: patch.design as Partial<DesignConfig> | undefined }, actor(res));
    res.json(service.getEvent(req.params.eventId, principalOf(res)));
  });

  app.post('/api/events/:eventId/clone', requireAccount, requireEvent('edit'), (req, res) => {
    const event = service.cloneEvent(req.params.eventId, cloneSchema.parse(req.body), actor(res), ownerIdOf(res));
    res.status(201).json(service.getEvent(event.id, principalOf(res)));
  });

  // Team
  app.get('/api/events/:eventId/members', requireAccount, requireEvent('view'), (req, res) => {
    res.json(service.accounts.listMembers(req.params.eventId));
  });
  app.delete('/api/events/:eventId/members/:userId', requireAccount, requireEvent('team'), (req, res) => {
    service.accounts.removeMember(req.params.eventId, req.params.userId, actor(res));
    res.status(204).end();
  });
  app.post('/api/events/:eventId/owner', requireAccount, requireEvent('team'), (req, res) => {
    const { userId } = ownerSchema.parse(req.body);
    service.setOwner(req.params.eventId, userId, actor(res), principalOf(res).kind !== 'operator');
    res.json(service.accounts.listMembers(req.params.eventId));
  });
  app.get('/api/events/:eventId/invitations', requireAccount, requireEvent('team'), (req, res) => {
    res.json(service.accounts.listInvitations(req.params.eventId));
  });
  app.post('/api/events/:eventId/invitations', requireAccount, requireEvent('team'), (req, res) => {
    const input = managerInviteSchema.parse(req.body);
    res.status(201).json(service.accounts.createInvitation({ role: 'manager', email: input.email, eventId: req.params.eventId }, actor(res)));
  });

  app.get('/api/events/:eventId/operations', requireAccount, requireEvent('view'), (req, res) => {
    res.json(service.operations(req.params.eventId));
  });

  // Gates and policies
  app.get('/api/events/:eventId/gates', requireAccount, requireEvent('view'), (req, res) => {
    res.json(service.access.listGates(req.params.eventId));
  });
  app.post('/api/events/:eventId/gates', requireAccount, requireEvent('access'), (req, res) => {
    const { name } = gateSchema.parse(req.body);
    res.status(201).json(service.access.createGate(req.params.eventId, name, actor(res)));
  });
  app.patch('/api/gates/:gateId', requireAccount, requireEvent('access'), (req, res) => {
    res.json(service.access.renameGate(req.params.gateId, gateSchema.parse(req.body).name, actor(res)));
  });
  app.delete('/api/gates/:gateId', requireAccount, requireEvent('access'), (req, res) => {
    service.access.deleteGate(req.params.gateId, actor(res));
    res.status(204).end();
  });
  app.get('/api/events/:eventId/policies', requireAccount, requireEvent('view'), (req, res) => {
    res.json(service.access.listPolicies(req.params.eventId));
  });
  app.post('/api/events/:eventId/policies', requireAccount, requireEvent('access'), (req, res) => {
    res.status(201).json(service.access.createPolicy(req.params.eventId, createPolicySchema.parse(req.body), actor(res)));
  });
  app.patch('/api/policies/:policyId', requireAccount, requireEvent('access'), (req, res) => {
    res.json(service.access.updatePolicy(req.params.policyId, updatePolicySchema.parse(req.body), actor(res)));
  });
  app.delete('/api/policies/:policyId', requireAccount, requireEvent('access'), (req, res) => {
    service.access.deletePolicy(req.params.policyId, actor(res));
    res.status(204).end();
  });

  // Passes
  app.get('/api/events/:eventId/passes', requireAccount, requireEvent('view'), (req, res) => {
    const { passes, total } = service.listPasses(req.params.eventId, passFilterSchema.parse(req.query));
    res.setHeader('X-Total-Count', String(total));
    res.json(passes);
  });
  app.post('/api/events/:eventId/passes', requireAccount, requireEvent('passes'), (req, res) => {
    res.status(201).json(service.issuePasses(req.params.eventId, issueSchema.parse(req.body), actor(res)));
  });
  app.post('/api/events/:eventId/passes/import', requireAccount, requireEvent('passes'), (req, res) => {
    const input = importSchema.parse(req.body);
    res.status(input.dryRun ? 200 : 201).json(service.importPasses(req.params.eventId, input, actor(res)));
  });
  app.post('/api/events/:eventId/passes/revoke', requireAccount, requireEvent('passes'), (req, res) => {
    res.json(service.revokePasses(req.params.eventId, bulkRevokeSchema.parse(req.body).passIds, actor(res)));
  });
  app.patch('/api/passes/:passId', requireAccount, requireEvent('passes'), (req, res) => {
    res.json(service.setPassPolicy(req.params.passId, passPatchSchema.parse(req.body).policyId, actor(res)));
  });
  app.post('/api/passes/:passId/revoke', requireAccount, requireEvent('passes'), (req, res) => {
    res.json(service.revokePass(req.params.passId, actor(res)));
  });
  app.post('/api/passes/:passId/reissue', requireAccount, requireEvent('passes'), (req, res) => {
    res.json(service.reissuePass(req.params.passId, actor(res)));
  });

  // Scanner devices
  app.get('/api/events/:eventId/scanners', requireAccount, requireEvent('view'), (req, res) => {
    res.json(service.listScanners(req.params.eventId));
  });
  app.post('/api/events/:eventId/scanners', requireAccount, requireEvent('scanners'), (req, res) => {
    const input = scannerSchema.parse(req.body);
    res.status(201).json(service.createScanner(req.params.eventId, input.label, input.gateId ?? null, actor(res)));
  });
  app.post('/api/scanners/:scannerId/revoke', requireAccount, requireEvent('scanners'), (req, res) => {
    res.json(service.revokeScanner(req.params.scannerId, actor(res)));
  });
  app.post('/api/scanners/:scannerId/rotate', requireAccount, requireEvent('scanners'), (req, res) => {
    res.json(service.rotateScanner(req.params.scannerId, actor(res)));
  });

  app.get('/api/events/:eventId/scans', requireAccount, requireEvent('view'), (req, res) => {
    res.json(service.listScans(req.params.eventId, scansQuerySchema.parse(req.query)));
  });

  app.get('/api/events/:eventId/audit', requireAccount, requireEvent('audit'), (req, res) => {
    res.json(service.listAudit(req.params.eventId, auditQuerySchema.parse(req.query)));
  });

  // Exports: attendee personal data, owners only, each download audited.
  app.get('/api/events/:eventId/exports/attendance.csv', requireAccount, requireEvent('export'), (req, res) => {
    sendCsv(res, `gatepass-${req.params.eventId.slice(0, 8)}-attendance.csv`, service.attendanceCsv(eventOf(res), actor(res)));
  });
  app.get('/api/events/:eventId/exports/scans.csv', requireAccount, requireEvent('export'), (req, res) => {
    sendCsv(res, `gatepass-${req.params.eventId.slice(0, 8)}-scans.csv`, service.scansCsv(eventOf(res), actor(res)));
  });
  app.get('/api/events/:eventId/exports/audit.csv', requireAccount, requireEvent('export'), (req, res) => {
    sendCsv(res, `gatepass-${req.params.eventId.slice(0, 8)}-audit.csv`, service.auditCsv(eventOf(res), actor(res)));
  });

  // ------------------------------------------------------------ scanner

  app.get('/api/scanner/session', requireScanner, limit(60, (_req, res) => `scanner-session:${scannerOf(res).id}`), (_req, res) => {
    res.json(service.scannerSession(scannerOf(res)));
  });

  // Limited per device, not per IP: every gate at a venue often shares one NAT address.
  app.post('/api/scanner/redeem', requireScanner, limit(240, (_req, res) => `scanner:${scannerOf(res).id}`), (req, res) => {
    const input = redeemSchema.parse(req.body);
    res.json(service.redeem(scannerOf(res), input.code, input.requestId));
  });

  app.use('/api', (_req, _res, next) => next(httpError(404, 'Not found')));

  // ------------------------------------------------------------ SPA

  if (clientDir && existsSync(path.join(clientDir, 'index.html'))) {
    const root = path.resolve(clientDir);
    app.use(express.static(root, { index: false }));
    app.get('/{*path}', (_req, res) => res.sendFile(path.join(root, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}

async function sendQr(res: express.Response, input: z.infer<typeof qrSchema>): Promise<void> {
  const rendered = await renderQr({ data: input.data, size: input.size, file: input.file, config: input.config as Partial<DesignConfig> });
  res.setHeader('Content-Type', rendered.contentType);
  if (input.download) res.setHeader('Content-Disposition', `attachment; filename="${rendered.filename}"`);
  res.send(rendered.body);
}
