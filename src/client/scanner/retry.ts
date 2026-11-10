import { ApiError } from '../api';

/** How long an unanswered scan keeps its requestId for a retry of the same code. */
export const RETRY_WINDOW_MS = 120_000;

/** 32 hex characters: within the server's 8–64 `[A-Za-z0-9_-]` requestId rule. Works without a secure context. */
export function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * True when the request may have reached the server without its answer
 * reaching us (timeout or dropped connection): the pass may already be
 * redeemed, so the retry must reuse the requestId to get the original verdict.
 */
export function isUnanswered(error: unknown): boolean {
  return error instanceof ApiError && error.status === 0;
}

/**
 * Remembers the requestId of scans whose response never arrived, keyed by the
 * exact code, so submitting the same code again within {@link RETRY_WINDOW_MS}
 * replays the server's stored result instead of judging it a second time
 * (which would wrongly say "Already used" for a guest who was in fact admitted).
 */
export class PendingScans {
  private readonly entries = new Map<string, { requestId: string; at: number }>();

  constructor(
    private readonly windowMs = RETRY_WINDOW_MS,
    private readonly createId: () => string = newRequestId
  ) {}

  /** The requestId to send for `code`: the unanswered one if still remembered, else a fresh one. */
  requestIdFor(code: string, now: number): string {
    this.prune(now);
    return this.entries.get(code)?.requestId ?? this.createId();
  }

  /** The request for `code` got no answer: keep its requestId for the retry window. */
  remember(code: string, requestId: string, now: number): void {
    this.entries.set(code, { requestId, at: now });
  }

  /** The server answered for `code`; its next scan is a new attempt. */
  forget(code: string): void {
    this.entries.delete(code);
  }

  has(code: string, now: number): boolean {
    this.prune(now);
    return this.entries.has(code);
  }

  private prune(now: number): void {
    for (const [code, entry] of this.entries) if (now - entry.at >= this.windowMs) this.entries.delete(code);
  }
}
