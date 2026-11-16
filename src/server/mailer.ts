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
 * Transactional email. `sent` means the provider accepted the message and
 * returned its id; it does not prove the message reached the inbox, so the
 * UI never says "delivered".
 */
export interface Mailer {
  readonly enabled: boolean;
  send(message: MailMessage): Promise<EmailReport>;
}

export const disabledMailer: Mailer = {
  enabled: false,
  send: async () => ({ status: 'disabled' })
};

export interface ResendOptions {
  apiKey: string;
  from: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const RESEND_URL = 'https://api.resend.com/emails';

/**
 * Resend HTTP API (https://resend.com/docs/api-reference/emails/send-email).
 * No retries here: a timeout is ambiguous (the provider may have accepted
 * the message), so callers surface the failure and the person decides to
 * re-send, which is safe because each re-send carries a fresh link and the
 * previous one stops working. Recipients and keys are never logged.
 */
export function resendMailer({ apiKey, from, fetch: fetchImpl = fetch, timeoutMs = 10_000 }: ResendOptions): Mailer {
  return {
    enabled: true,
    async send(message) {
      try {
        const response = await fetchImpl(RESEND_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...(message.idempotencyKey ? { 'Idempotency-Key': message.idempotencyKey } : {})
          },
          body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
          signal: AbortSignal.timeout(timeoutMs)
        });
        const body = (await response.json().catch(() => ({}))) as { id?: unknown; name?: unknown; message?: unknown };
        if (response.ok && typeof body.id === 'string') return { status: 'sent', providerId: body.id };
        const reason = typeof body.name === 'string' ? body.name : `HTTP ${response.status}`;
        console.error(JSON.stringify({ level: 'error', msg: 'email provider refused message', provider: 'resend', status: response.status, reason }));
        return { status: 'failed', error: `The email provider refused the message (${reason}).` };
      } catch (error) {
        const reason = error instanceof Error ? error.name : 'unknown';
        console.error(JSON.stringify({ level: 'error', msg: 'email provider unreachable', provider: 'resend', reason }));
        return { status: 'failed', error: reason === 'TimeoutError' ? 'The email provider did not answer in time.' : 'The email provider could not be reached.' };
      }
    }
  };
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Plain text plus a minimal HTML twin; every interpolated value is escaped. */
export function composeEmail(input: { to: string; subject: string; lines: string[]; action: { label: string; url: string }; footer: string; idempotencyKey?: string }): MailMessage {
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
