import { createCipheriv, randomBytes } from 'node:crypto';
import type { MailAttempt, MailMessage, Mailer } from '../src/server/mailer';
import type { EmailReport } from '../src/shared/types';

// Test doubles and fixtures for the pass email outbox (src/server/deliveries.ts).

/** A link sealed the way schema-5 servers did (seal version 1: version ‖ IV ‖ tag ‖ ciphertext, no key id). */
export function sealV1(key: Buffer, link: string, deliveryId: string, passId: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`gatepass:pass-delivery:v1:${deliveryId}:${passId}`, 'utf8'));
  const body = Buffer.concat([cipher.update(link, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]);
}

export type Script = MailAttempt | 'accept' | 'accept-but-time-out';

/** How long the provider remembers an idempotency key (Resend: 24 hours). */
export const PROVIDER_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Provider double with the property the outbox relies on: a request with an
 * idempotency key it accepted less than 24 hours ago is not sent again, it
 * answers with the first message id. After that the key is forgotten and the
 * same request sends a second message, as with Resend. `script` decides each
 * answer in order; then `accept`. `now` is the clock the window is measured on
 * (the test clock); without it the window never ends.
 */
export class FakeProvider implements Mailer {
  readonly enabled = true;
  readonly calls: Array<{ message: MailMessage; at: number }> = [];
  /** Messages the provider accepted, by idempotency key (the latest one per key). */
  readonly accepted = new Map<string, { id: string; message: MailMessage; at: number }>();
  /** Distinct messages the provider actually sent: a duplicate counts twice. */
  sent = 0;
  script: Script[] = [];
  private waiting: { count: number; resolve: () => void } | null = null;

  constructor(private readonly now: () => number = () => 0) {}

  /** Resolves once `count` requests have arrived. */
  callsReached(count: number): Promise<void> {
    if (this.calls.length >= count) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.waiting = { count, resolve };
    return promise;
  }

  async send(message: MailMessage): Promise<EmailReport> {
    const result = await this.attempt(message);
    return result.status === 'accepted' ? { status: 'sent', providerId: result.providerId } : { status: 'failed', error: result.error };
  }

  async attempt(message: MailMessage): Promise<MailAttempt> {
    this.calls.push({ message, at: performance.now() });
    if (this.waiting && this.calls.length >= this.waiting.count) this.waiting.resolve();
    const step = this.script.shift() ?? 'accept';
    if (step !== 'accept' && step !== 'accept-but-time-out') return step;
    const key = message.idempotencyKey ?? `call-${this.calls.length}`;
    const known = this.accepted.get(key);
    if (!known || this.now() - known.at >= PROVIDER_WINDOW_MS) {
      this.sent += 1;
      this.accepted.set(key, { id: `msg_${this.sent}`, message, at: this.now() });
    }
    if (step === 'accept-but-time-out') return { status: 'retry', error: 'The email provider did not answer in time.', ambiguous: true };
    return { status: 'accepted', providerId: this.accepted.get(key)!.id };
  }
}
