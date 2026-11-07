import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import { renderQr } from '../qr/renderer';
import type { DesignConfig } from '../shared/types';
import type { AuthenticatedScanner, GatePass } from './gatepass';
import { bearerToken, errorHandler, FailureThrottle, httpError, type Middleware, rateLimit } from './http';
import { renderPassPage } from './pass-page';
import { safeEqual } from './tokens';

export interface AppOptions {
  service: GatePass;
  adminToken: string;
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
}

const isoDateTime = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'must be an ISO 8601 date-time');
const id = z.string().min(1).max(64);
const designInput = z.record(z.string(), z.unknown());
const optionalEmail = z.union([z.email().max(254), z.literal('')]).nullish();

const eventFields = {
  name: z.string().trim().min(1).max(200),
  venue: z.string().trim().max(200).nullish(),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  design: designInput.optional()
};
const createEventSchema = z.strictObject(eventFields);
const updateEventSchema = z.strictObject({
  name: eventFields.name.optional(),
  venue: eventFields.venue,
  startsAt: isoDateTime.optional(),
  endsAt: isoDateTime.optional(),
  design: designInput.optional(),
  status: z.enum(['active', 'archived']).optional()
});
const issueSchema = z
  .strictObject({
    attendees: z.array(z.strictObject({ name: z.string().trim().max(200).nullish(), email: optionalEmail })).min(1).max(500).optional(),
    count: z.number().int().min(1).max(500).optional(),
    expiresAt: isoDateTime.optional(),
    policyId: id.optional()
  })
  .refine((value) => !(value.attendees && value.count), 'Provide attendees or count, not both');
const passFilterSchema = z.object({
  status: z.enum(['active', 'redeemed', 'revoked', 'expired']).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional()
});
const passPatchSchema = z.strictObject({ policyId: id.nullable() });
const scansQuerySchema = z.object({
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
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
const redeemSchema = z.strictObject({ code: z.string().min(1).max(2048) });
const qrSchema = z.object({
  data: z.string().min(1).max(1024),
  size: z.coerce.number().optional().default(300),
  file: z.enum(['png', 'svg', 'pdf', 'eps']).optional().default('svg'),
  download: z.coerce.boolean().optional().default(false),
  config: designInput.optional().default({})
});

const ADMIN = 'admin';
const passThrough: Middleware = (_req, _res, next) => next();

export function createApp({ service, adminToken, trustProxy = false, clientDir, originSecret, clientIpHeader, rateLimits = true }: AppOptions): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  const limit = (perMinute: number, key?: Parameters<typeof rateLimit>[1]) => (rateLimits ? rateLimit(perMinute, key) : passThrough);

  if (originSecret) {
    app.use((req, res, next) => {
      if (req.path === '/api/health' || safeEqual(req.header('x-origin-secret') ?? '', originSecret)) return next();
      res.status(403).json({ error: 'Forbidden' });
    });
    if (clientIpHeader) {
      app.use((req, _res, next) => {
        const ip = req.header(clientIpHeader)?.split(',')[0].trim();
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
  app.use(express.json({ limit: '100kb' }));

  // Only requests with invalid credentials are throttled; valid ones always pass.
  const failures = new FailureThrottle(60, 5 * 60_000);
  const refuse = (req: express.Request<unknown>, res: express.Response, message: string) => {
    const wait = rateLimits ? failures.fail(req.ip ?? 'unknown') : 0;
    if (wait > 0) {
      res.setHeader('Retry-After', String(wait));
      res.status(429).json({ error: 'Too many failed authentication attempts' });
      return;
    }
    res.status(401).json({ error: message });
  };

  const requireAdmin: Middleware = (req, res, next) => {
    const token = bearerToken(req.header('authorization'));
    if (token && safeEqual(token, adminToken)) return next();
    refuse(req, res, 'Admin authentication required');
  };

  const requireScanner: Middleware = (req, res, next) => {
    const key = bearerToken(req.header('authorization'));
    const scanner = key ? service.authenticateScanner(key) : null;
    if (!scanner) return refuse(req, res, 'Scanner authentication required');
    res.locals.scanner = scanner;
    next();
  };

  const scannerOf = (res: express.Response): AuthenticatedScanner => res.locals.scanner as AuthenticatedScanner;

  // ------------------------------------------------------------ public

  app.get('/api/health', (_req, res) => {
    try {
      service.ping();
      res.json({ ok: true, service: 'gatepass' });
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
    const qr = await renderQr({ data: service.passUrl(req.params.token), size: 320, file: 'svg', config: found.event.design });
    res.type('html').send(renderPassPage({ ...found, qrSvg: String(qr.body) }));
  });

  // ------------------------------------------------------------ admin

  // QR rendering is CPU-bound; only the admin UI needs it, so it is not public.
  const qrLimiter = limit(120);
  app.get('/api/qr/custom', requireAdmin, qrLimiter, async (req, res) => {
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
  app.post('/api/qr/custom', requireAdmin, qrLimiter, async (req, res) => {
    await sendQr(res, qrSchema.parse(req.body));
  });

  app.get('/api/admin/session', requireAdmin, (_req, res) => {
    res.json({ role: ADMIN });
  });

  app.get('/api/events', requireAdmin, (_req, res) => {
    res.json(service.listEvents());
  });

  app.post('/api/events', requireAdmin, (req, res) => {
    const input = createEventSchema.parse(req.body);
    res.status(201).json(service.createEvent({ ...input, design: input.design as Partial<DesignConfig> | undefined }, ADMIN));
  });

  app.get('/api/events/:eventId', requireAdmin, (req, res) => {
    res.json(service.getEvent(req.params.eventId));
  });

  app.patch('/api/events/:eventId', requireAdmin, (req, res) => {
    const patch = updateEventSchema.parse(req.body);
    res.json(service.updateEvent(req.params.eventId, { ...patch, design: patch.design as Partial<DesignConfig> | undefined }, ADMIN));
  });

  app.get('/api/events/:eventId/operations', requireAdmin, (req, res) => {
    res.json(service.operations(req.params.eventId));
  });

  app.get('/api/events/:eventId/gates', requireAdmin, (req, res) => {
    service.getEvent(req.params.eventId);
    res.json(service.access.listGates(req.params.eventId));
  });

  app.post('/api/events/:eventId/gates', requireAdmin, (req, res) => {
    const { name } = gateSchema.parse(req.body);
    service.getEvent(req.params.eventId);
    res.status(201).json(service.access.createGate(req.params.eventId, name, ADMIN));
  });

  app.get('/api/events/:eventId/policies', requireAdmin, (req, res) => {
    service.getEvent(req.params.eventId);
    res.json(service.access.listPolicies(req.params.eventId));
  });

  app.post('/api/events/:eventId/policies', requireAdmin, (req, res) => {
    const input = createPolicySchema.parse(req.body);
    service.getEvent(req.params.eventId);
    res.status(201).json(service.access.createPolicy(req.params.eventId, input, ADMIN));
  });

  app.patch('/api/policies/:policyId', requireAdmin, (req, res) => {
    res.json(service.access.updatePolicy(req.params.policyId, updatePolicySchema.parse(req.body), ADMIN));
  });

  app.get('/api/events/:eventId/passes', requireAdmin, (req, res) => {
    res.json(service.listPasses(req.params.eventId, passFilterSchema.parse(req.query)));
  });

  app.post('/api/events/:eventId/passes', requireAdmin, (req, res) => {
    res.status(201).json(service.issuePasses(req.params.eventId, issueSchema.parse(req.body), ADMIN));
  });

  app.patch('/api/passes/:passId', requireAdmin, (req, res) => {
    res.json(service.setPassPolicy(req.params.passId, passPatchSchema.parse(req.body).policyId, ADMIN));
  });

  app.post('/api/passes/:passId/revoke', requireAdmin, (req, res) => {
    res.json(service.revokePass(req.params.passId, ADMIN));
  });

  app.post('/api/passes/:passId/reissue', requireAdmin, (req, res) => {
    res.json(service.reissuePass(req.params.passId, ADMIN));
  });

  app.get('/api/events/:eventId/scanners', requireAdmin, (req, res) => {
    res.json(service.listScanners(req.params.eventId));
  });

  app.post('/api/events/:eventId/scanners', requireAdmin, (req, res) => {
    const input = scannerSchema.parse(req.body);
    res.status(201).json(service.createScanner(req.params.eventId, input.label, input.gateId ?? null, ADMIN));
  });

  app.post('/api/scanners/:scannerId/revoke', requireAdmin, (req, res) => {
    res.json(service.revokeScanner(req.params.scannerId, ADMIN));
  });

  app.get('/api/events/:eventId/scans', requireAdmin, (req, res) => {
    res.json(service.listScans(req.params.eventId, scansQuerySchema.parse(req.query)));
  });

  app.get('/api/events/:eventId/audit', requireAdmin, (req, res) => {
    res.json(service.listAudit(req.params.eventId));
  });

  // ------------------------------------------------------------ scanner

  app.get('/api/scanner/session', requireScanner, limit(60, (_req, res) => `scanner-session:${scannerOf(res).id}`), (_req, res) => {
    res.json(service.scannerSession(scannerOf(res)));
  });

  // Limited per device, not per IP: every gate at a venue often shares one NAT address.
  app.post('/api/scanner/redeem', requireScanner, limit(240, (_req, res) => `scanner:${scannerOf(res).id}`), (req, res) => {
    res.json(service.redeem(scannerOf(res), redeemSchema.parse(req.body).code));
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
