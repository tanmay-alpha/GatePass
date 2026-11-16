import type { EmailReport } from '../shared/types';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Provider-side de-duplication: a retried request with the same key sends at most once. */
  idempotencyKey?: string;
}

/**
 * One provider request with retry semantics, for the pass email outbox
 * (src/server/deliveries.ts):
 * - `accepted`: the provider took the message and returned its id;
 * - `refused`: the provider answered and said no; the same request would be refused again;
 * - `retry`: no answer, a timeout, a server error, a credential problem or a rate limit.
 *   The provider may already have accepted it, so a retry must reuse the same
 *   idempotency key. `throttled` (rate limited) attempts do not count against
 *   the attempt limit.
 */
export type MailAttempt =
  | { status: 'accepted'; providerId: string }
  | { status: 'refused'; error: string }
  | { status: 'retry'; error: string; throttled?: boolean; retryAfterMs?: number };

/**
 * Transactional email. `sent` means the provider accepted the message and
 * returned its id; it does not prove the message reached the inbox, so the
 * UI never says "delivered".
 */
export interface Mailer {
  readonly enabled: boolean;
  send(message: MailMessage): Promise<EmailReport>;
  /** Same request as `send`, classified for retries and cancellable by `signal`. Optional: `attemptSend` derives it from `send`. */
  attempt?(message: MailMessage, signal?: AbortSignal): Promise<MailAttempt>;
}

export const disabledMailer: Mailer = {
  enabled: false,
  send: async () => ({ status: 'disabled' })
};

/** `mailer.attempt`, or `send` with every failure treated as retryable (safe: the idempotency key prevents duplicates). */
export async function attemptSend(mailer: Mailer, message: MailMessage, signal?: AbortSignal): Promise<MailAttempt> {
  if (mailer.attempt) return mailer.attempt(message, signal);
  const report = await mailer.send(message);
  if (report.status === 'sent') return { status: 'accepted', providerId: report.providerId };
  if (report.status === 'failed') return { status: 'retry', error: report.error };
  return { status: 'refused', error: 'Email is not configured on this server.' };
}

export interface ResendOptions {
  apiKey: string;
  from: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Endpoint override (RESEND_API_URL); tests point it at a local fake provider. */
  url?: string;
}

const RESEND_URL = 'https://api.resend.com/emails';

/**
 * Resend HTTP API (https://resend.com/docs/api-reference/emails/send-email).
 * No retries here: a timeout is ambiguous (the provider may have accepted
 * the message). `send` callers surface the failure and the person decides to
 * re-send, which is safe because each re-send carries a fresh link and the
 * previous one stops working; the pass outbox retries through `attempt` with
 * the same idempotency key instead. Recipients and keys are never logged.
 */
export function resendMailer({ apiKey, from, fetch: fetchImpl = fetch, timeoutMs = 10_000, url = RESEND_URL }: ResendOptions): Mailer {
  async function attempt(message: MailMessage, signal?: AbortSignal): Promise<MailAttempt> {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...(message.idempotencyKey ? { 'Idempotency-Key': message.idempotencyKey } : {})
        },
        body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout
      });
      const body = (await response.json().catch(() => ({}))) as { id?: unknown; name?: unknown; message?: unknown };
      if (response.ok && typeof body.id === 'string') return { status: 'accepted', providerId: body.id };
      const reason = typeof body.name === 'string' ? body.name : `HTTP ${response.status}`;
      console.error(JSON.stringify({ level: 'error', msg: 'email provider refused message', provider: 'resend', status: response.status, reason }));
      const error = `The email provider refused the message (${reason}).`;
      if (response.status === 429) return { status: 'retry', error, throttled: true, retryAfterMs: retryAfterMs(response.headers.get('retry-after')) };
      // Server errors, credential or sending-domain problems the operator can fix, and a
      // concurrent request with the same idempotency key are worth another try later.
      if (response.status >= 500 || response.status === 401 || response.status === 403 || reason === 'concurrent_idempotent_requests') return { status: 'retry', error };
      return { status: 'refused', error };
    } catch (error) {
      const interrupted = Boolean(signal?.aborted) && !timeout.aborted;
      const reason = interrupted ? 'interrupted' : error instanceof Error ? error.name : 'unknown';
      console.error(JSON.stringify({ level: 'error', msg: 'email provider unreachable', provider: 'resend', reason }));
      return {
        status: 'retry',
        error: interrupted
          ? 'Sending was interrupted by a server shutdown; the provider may have accepted it.'
          : reason === 'TimeoutError'
            ? 'The email provider did not answer in time.'
            : 'The email provider could not be reached.'
      };
    }
  }
  return {
    enabled: true,
    attempt,
    async send(message) {
      const result = await attempt(message);
      return result.status === 'accepted' ? { status: 'sent', providerId: result.providerId } : { status: 'failed', error: result.error };
    }
  };
}

/** `Retry-After` in seconds (the only form Resend sends); 1 s when absent or unreadable, at most 10 minutes. */
function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 600) * 1000 : 1000;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Plain text plus a minimal HTML twin; every interpolated value is escaped and the action link must be http(s). */
export function composeEmail(input: { to: string; subject: string; lines: string[]; action: { label: string; url: string }; footer: string; idempotencyKey?: string }): MailMessage {
  const { protocol } = new URL(input.action.url);
  if (protocol !== 'https:' && protocol !== 'http:') throw new Error('Email action links must be http(s) URLs.');
  const text = [...input.lines, '', `${input.action.label}: ${input.action.url}`, '', input.footer].join('\n');
  const html = [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:520px">',
    ...input.lines.map((line) => `<p>${escapeHtml(line)}</p>`),
    `<p><a href="${escapeHtml(input.action.url)}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;border-radius:8px;text-decoration:none">${escapeHtml(input.action.label)}</a></p>`,
    `<p style="color:#555;font-size:13px">${escapeHtml(input.footer)}</p>`,
    '</div>'
  ].join('');
  return { to: input.to, subject: input.subject, text, html, idempotencyKey: input.idempotencyKey };
}
