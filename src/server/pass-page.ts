import type { EventSummary, Pass } from '../shared/types';

export interface PassView {
  pass: Pass;
  event: EventSummary;
  admission: {
    policyName: string | null;
    gates: string[];
  };
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
  if (!view) {
    return layout(
      'Pass not found',
      `<div class="card not-found">
        <p class="brand">GATEPASS</p>
        <h1 class="event-name">Pass not found</h1>
        <p class="desc">Check the link or ask the organiser for a new pass.</p>
      </div>`
    );
  }
  const { pass, event, admission, qrSvg } = view;
  const attendee = pass.attendeeName ? escapeHtml(pass.attendeeName) : 'Guest';
  const venue = event.venue ? escapeHtml(event.venue) : '—';
  const admissionText = escapeHtml(formatAdmission(admission));
  const redeemed = pass.redeemedAt ? ` Checked in ${escapeHtml(formatDate(pass.redeemedAt))}.` : '';

  const body = `
    <div class="card">
      <p class="brand">GATEPASS</p>
      <h1 class="event-name">${escapeHtml(event.name)}</h1>
      <div class="grid">
        <div class="field">
          <span class="label">Date</span>
          <span class="value">${escapeHtml(formatPassDate(event.startsAt))}</span>
        </div>
        <div class="field">
          <span class="label">Venue</span>
          <span class="value">${venue}</span>
        </div>
        <div class="field">
          <span class="label">Attendee</span>
          <span class="value">${attendee}</span>
        </div>
        <div class="field">
          <span class="label">Admission</span>
          <span class="value">${admissionText}</span>
        </div>
      </div>
      <div class="divider" aria-hidden="true">
        <div class="notch notch-left"></div>
        <div class="dashed-line"></div>
        <div class="notch notch-right"></div>
      </div>
      ${pass.status === 'active'
        ? `<div class="qr-container"><div class="qr">${qrSvg}</div></div><p class="ref">${escapeHtml(pass.id.slice(0, 8).toUpperCase())}</p>`
        : `<div class="inactive-wrap"><p class="ref">${escapeHtml(pass.id.slice(0, 8).toUpperCase())}</p></div>`}
    </div>
    <p class="status ${pass.status}" role="status">${STATUS_TEXT[pass.status]}${redeemed}</p>
    <p class="fine">Valid until ${escapeHtml(formatDate(pass.expiresAt))}. Opening this page does not check you in.</p>`;

  return layout(event.name, body);
}

function formatAdmission(admission: { policyName: string | null; gates: string[] }): string {
  if (!admission.policyName) return 'General admission';
  if (admission.gates.length === 0) return admission.policyName;
  return `${admission.policyName} · ${admission.gates.join(', ')}`;
}

function formatPassDate(iso: string): string {
  const d = new Date(iso);
  const weekday = d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
  const day = d.toLocaleDateString('en-GB', { day: 'numeric', timeZone: 'UTC' });
  const month = d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
  return `${weekday}, ${day} ${month} · ${time} UTC`;
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
:root{
  color-scheme:dark light;
  --bg:#0b0c0e;
  --card:#111316;
  --border:#24272c;
  --fg:#ededef;
  --muted:#8b8f98;
  --ok:#3fb950;
  --warn:#e3a008;
  --bad:#f05252;
}
@media (prefers-color-scheme:light){
  :root{
    --bg:#f6f7f9;
    --card:#ffffff;
    --border:#e2e4e9;
    --fg:#111316;
    --muted:#6b7280;
    --ok:#1a7f37;
    --warn:#9a6700;
    --bad:#cf222e;
  }
}
body{
  margin:0;
  background:var(--bg);
  color:var(--fg);
  font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  min-height:100vh;
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:center;
  padding:32px 16px;
  box-sizing:border-box;
}
main{
  width:100%;
  max-width:380px;
  box-sizing:border-box;
  display:flex;
  flex-direction:column;
  align-items:center;
}
.card{
  width:100%;
  background:var(--card);
  border:1px solid var(--border);
  border-radius:16px;
  padding:24px;
  box-sizing:border-box;
  position:relative;
}
.card.not-found{
  text-align:center;
}
.brand{
  margin:0 0 6px;
  font-size:0.75rem;
  font-weight:600;
  letter-spacing:0.08em;
  text-transform:uppercase;
  color:var(--muted);
}
.event-name{
  font-size:1.35rem;
  font-weight:700;
  line-height:1.25;
  margin:0 0 20px;
  color:var(--fg);
}
.card.not-found .event-name{
  margin-bottom:12px;
}
.desc{
  color:var(--muted);
  font-size:0.875rem;
  margin:0;
  line-height:1.5;
}
.grid{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:16px 12px;
}
.field{
  display:flex;
  flex-direction:column;
  gap:3px;
  min-width:0;
}
.label{
  font-size:0.72rem;
  font-weight:500;
  color:var(--muted);
  text-transform:uppercase;
  letter-spacing:0.03em;
}
.value{
  font-size:0.85rem;
  font-weight:600;
  color:var(--fg);
  line-height:1.35;
  word-break:break-word;
  font-feature-settings:'tnum';
  font-variant-numeric:tabular-nums;
}
.divider{
  position:relative;
  margin:22px -24px;
  height:20px;
  display:flex;
  align-items:center;
}
.dashed-line{
  flex:1;
  border-top:1px dashed var(--border);
  margin:0 10px;
}
.notch{
  position:absolute;
  width:20px;
  height:20px;
  background:var(--bg);
  border:1px solid var(--border);
  border-radius:50%;
  box-sizing:border-box;
  top:50%;
  z-index:2;
}
.notch-left{
  left:-1px;
  transform:translate(-50%,-50%);
  border-left-color:transparent;
  -webkit-clip-path:polygon(50% -10%,110% -10%,110% 110%,50% 110%);
  clip-path:polygon(50% -10%,110% -10%,110% 110%,50% 110%);
}
.notch-right{
  right:-1px;
  transform:translate(50%,-50%);
  border-right-color:transparent;
  -webkit-clip-path:polygon(-10% -10%,50% -10%,50% 110%,-10% 110%);
  clip-path:polygon(-10% -10%,50% -10%,50% 110%,-10% 110%);
}
.qr-container{
  display:flex;
  justify-content:center;
  margin:6px 0 14px;
}
.qr{
  background:#ffffff;
  border-radius:12px;
  padding:12px;
  width:220px;
  height:220px;
  box-sizing:border-box;
  display:flex;
  align-items:center;
  justify-content:center;
}
.qr svg{
  display:block;
  width:100%;
  height:100%;
  border-radius:6px;
}
.ref{
  font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;
  font-size:0.8rem;
  letter-spacing:0.12em;
  color:var(--muted);
  text-align:center;
  margin:0;
  font-feature-settings:'tnum';
  font-variant-numeric:tabular-nums;
}
.inactive-wrap{
  padding:28px 0 16px;
  display:flex;
  justify-content:center;
}
.status{
  display:flex;
  align-items:center;
  justify-content:center;
  gap:8px;
  font-size:0.85rem;
  font-weight:500;
  margin:18px 0 6px;
  text-align:center;
}
.status::before{
  content:'';
  display:inline-block;
  width:7px;
  height:7px;
  border-radius:50%;
  background:currentColor;
  flex-shrink:0;
}
.status.active{color:var(--ok)}
.status.redeemed{color:var(--warn)}
.status.revoked,.status.expired{color:var(--bad)}
.fine{
  font-size:0.72rem;
  color:var(--muted);
  text-align:center;
  margin:4px 0 0;
  line-height:1.5;
  font-feature-settings:'tnum';
  font-variant-numeric:tabular-nums;
}
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
