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
 * Counts only 401 responses per IP (credential guessing). Valid credentials
 * are never slowed down by a neighbour's failures beyond this IP bucket.
 */
export function authFailureLimit(maxPerFiveMinutes: number): Middleware {
  const limiter = expressRateLimit({
    windowMs: 5 * 60_000,
    limit: maxPerFiveMinutes,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => res.statusCode !== 401,
    message: { error: 'Too many failed authentication attempts' }
  });
  return (req, res, next) => void limiter(req as Request, res, next);
}

export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer ([^\s]+)$/.exec(header ?? '');
  return match ? match[1] : null;
}
