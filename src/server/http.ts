import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { rateLimit as expressRateLimit } from 'express-rate-limit';
import { z } from 'zod';

/** Generic over route params so it composes with typed route handlers. */
export type Middleware = <P>(req: Request<P>, res: Response, next: NextFunction) => void;

export type HttpError = Error & { status: number };

export function httpError(status: number, message: string): HttpError {
  return Object.assign(new Error(message), { status });
}

/**
 * Client errors (4xx) return their message; everything else is logged and
 * answered with a generic message so SQL, file paths and stack details never
 * reach the client.
 */
export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    res.status(400).json({ error: `${where}${issue?.message ?? 'Invalid request'}` });
    return;
  }
  // Write-lock contention beyond busy_timeout (e.g. a CLI backup holding the lock): transient, retryable.
  if (error instanceof Error && /database is locked|SQLITE_BUSY/.test(error.message)) {
    console.error(error);
    res.setHeader('Retry-After', '1');
    res.status(503).json({ error: 'The server is busy. Try again.' });
    return;
  }
  const status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 500;
  if (status >= 400 && status < 500) {
    // body-parser errors (malformed JSON, oversized bodies) carry `expose`.
    res.status(status).json({ error: error instanceof Error ? error.message : 'Bad request' });
    return;
  }
  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
};

/**
 * Fixed-window limiter backed by express-rate-limit's in-memory store. Keyed by
 * client IP unless `key` is given. Correct for the single-process deployment
 * GatePass targets; put a proxy limit in front for anything larger.
 */
export function rateLimit(maxPerMinute: number, key?: (req: Request, res: Response) => string): Middleware {
  const limiter = expressRateLimit({
    windowMs: 60_000,
    limit: maxPerMinute,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many requests' },
    ...(key ? { keyGenerator: key } : {})
  });
  return (req, res, next) => void limiter(req as Request, res, next);
}

/**
 * Counts failed authentications per client IP in a fixed window. Only
 * requests with invalid credentials are refused once the limit is reached, so
 * someone guessing tokens on a shared venue network cannot lock out scanners
 * or admins that present valid credentials from the same address.
 */
export class FailureThrottle {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();
  private nextSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly clock: () => number = Date.now
  ) {}

  /** Records a failure; returns seconds to wait if this client is now over the limit, else 0. */
  fail(key: string): number {
    const now = this.clock();
    if (now >= this.nextSweep) {
      for (const [k, entry] of this.failures) if (entry.resetAt <= now) this.failures.delete(k);
      this.nextSweep = now + this.windowMs;
    }
    const entry = this.failures.get(key);
    if (!entry || entry.resetAt <= now) {
      this.failures.set(key, { count: 1, resetAt: now + this.windowMs });
      return 0;
    }
    entry.count += 1;
    return entry.count > this.limit ? Math.ceil((entry.resetAt - now) / 1000) : 0;
  }

  /** Seconds this key must still wait (it is over the limit), without recording anything; 0 when not blocked. */
  blocked(key: string): number {
    const entry = this.failures.get(key);
    const now = this.clock();
    if (!entry || entry.resetAt <= now || entry.count < this.limit) return 0;
    return Math.ceil((entry.resetAt - now) / 1000);
  }
}

export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer ([^\s]+)$/.exec(header ?? '');
  return match ? match[1] : null;
}
