import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 random bytes → 43 base64url characters (256 bits of entropy). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 of the token, hex encoded. Tokens carry 256 bits of entropy, so an
 * unsalted fast hash is sufficient: a leaked database cannot be brute-forced
 * back into usable tokens.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PASS_URL_TOKEN = /\/p\/([A-Za-z0-9_-]{43})\/?(?:[?#].*)?$/;

/** Accepts the raw token or the full pass URL encoded in the QR code. */
export function extractPassToken(input: string): string | null {
  const value = input.trim();
  if (TOKEN.test(value)) return value;
  return PASS_URL_TOKEN.exec(value)?.[1] ?? null;
}

export function isWellFormedToken(value: string): boolean {
  return TOKEN.test(value);
}

/** Constant-time string comparison (hashing equalises lengths first). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
