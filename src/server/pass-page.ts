import type { EventSummary, Pass } from '../shared/types';

interface PassView {
  pass: Pass;
  event: EventSummary;
  qrSvg: string;
}

const STATUS_TEXT: Record<Pass['status'], string> = {
  active: 'Valid — show this code at the entrance.',
  redeemed: 'Already used.',
  revoked: 'This pass has been revoked.',
  expired: 'This pass has expired.'
};

/**
 * Server-rendered, script-free page an attendee opens from the QR or a shared
 * link. Unknown and malformed tokens get the same response.
 */
export function renderPassPage(view: PassView | null): string {
  if (!view) return layout('Pass not found', '<h1>Pass not found</h1><p>Check the link or ask the organiser for a new pass.</p>');
  const { pass, event, qrSvg } = view;
  const when = `${formatDate(event.startsAt)} – ${formatDate(event.endsAt)}`;
  const attendee = pass.attendeeName ? `<p class="attendee">${escapeHtml(pass.attendeeName)}</p>` : '';
  const redeemed = pass.redeemedAt ? ` Checked in ${escapeHtml(formatDate(pass.redeemedAt))}.` : '';
  const body = `
    <p class="eyebrow">GatePass</p>
    <h1>${escapeHtml(event.name)}</h1>
    <p class="meta">${escapeHtml(when)}${event.venue ? ` · ${escapeHtml(event.venue)}` : ''}</p>
    ${attendee}
    <div class="qr ${pass.status}">${pass.status === 'active' ? qrSvg : ''}</div>
    <p class="status ${pass.status}" role="status">${STATUS_TEXT[pass.status]}${redeemed}</p>
    <p class="fine">Valid until ${escapeHtml(formatDate(pass.expiresAt))}. Opening this page does not check you in.</p>`;
  return layout(event.name, body);
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)} · GatePass</title>
<style>
:root{color-scheme:light dark;--fg:#111827;--muted:#4b5563;--bg:#f9fafb;--card:#fff;--ok:#047857;--bad:#b91c1c;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--fg:#f3f4f6;--muted:#9ca3af;--bg:#111827;--card:#1f2937;--ok:#34d399;--bad:#f87171;--warn:#fbbf24}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:420px;margin:24px auto;padding:24px;background:var(--card);border-radius:12px}
h1{font-size:1.5rem;margin:0 0 4px}.eyebrow{margin:0 0 8px;font-size:.75rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.meta,.fine{color:var(--muted);margin:0 0 12px}.fine{font-size:.85rem}.attendee{font-weight:600;font-size:1.1rem;margin:0 0 12px}
.qr svg{display:block;width:100%;height:auto;border-radius:8px;background:#fff}
.status{font-weight:600}.status.active{color:var(--ok)}.status.revoked,.status.expired{color:var(--bad)}.status.redeemed{color:var(--warn)}
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
}

function escapeHtml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}
