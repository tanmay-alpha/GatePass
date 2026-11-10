import type { EventSummary, Pass } from '../shared/types';

export interface PassView {
  pass: Pass;
  /** Only the columns the attendee page needs; no aggregate counts. */
  event: Pick<EventSummary, 'name' | 'venue' | 'timeZone' | 'startsAt' | 'endsAt' | 'status' | 'design'>;
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
 * link. Unknown and malformed tokens get the same response. Every time is
 * shown in the event's own time zone, labelled, so attendees elsewhere are not
 * misled by their device clock.
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
  const zone = validZone(event.timeZone);
  const attendee = pass.attendeeName ? escapeHtml(pass.attendeeName) : 'Guest';
  const venue = event.venue ? escapeHtml(event.venue) : '—';
  const admissionText = escapeHtml(formatAdmission(admission));
  const redeemed = pass.redeemedAt ? ` Checked in ${escapeHtml(formatMoment(pass.redeemedAt, zone))}.` : '';
  const reference = escapeHtml(pass.id.slice(0, 8).toUpperCase());
  const referenceBlock = `<p class="ref-label" id="ref-label">Reference (for manual entry at the door)</p>
      <p class="ref" aria-describedby="ref-label">${reference}</p>`;
  const eventOver = event.status === 'ended' || event.status === 'archived' ? ' This event has ended.' : '';

  const body = `
    <div class="card">
      <p class="brand">GATEPASS</p>
      <h1 class="event-name">${escapeHtml(event.name)}</h1>
      <div class="grid">
        <div class="field field-wide">
          <span class="label">Date</span>
          <span class="value">${escapeHtml(formatEventWhen(event.startsAt, event.endsAt, zone))}</span>
          <span class="zone">${escapeHtml(zoneLabel(event.startsAt, zone))}</span>
        </div>
        <div class="field">
          <span class="label">Venue</span>
          <span class="value">${venue}</span>
        </div>
        <div class="field">
          <span class="label">Attendee</span>
          <span class="value">${attendee}</span>
        </div>
        <div class="field field-wide">
          <span class="label">Admission</span>
          <span class="value">${admissionText}</span>
        </div>
      </div>
      <div class="divider" aria-hidden="true">
        <div class="notch notch-left"></div>
        <div class="dashed-line"></div>
        <div class="notch notch-right"></div>
      </div>
      ${pass.status === 'active' ? `<div class="qr-container"><div class="qr">${qrSvg}</div></div>` : '<div class="inactive-wrap"></div>'}
      ${referenceBlock}
    </div>
    <p class="status ${pass.status}" role="status">${STATUS_TEXT[pass.status]}${redeemed}</p>
    <p class="fine">Valid until ${escapeHtml(formatMoment(pass.expiresAt, zone))}.${eventOver} Opening this page does not check you in.</p>`;

  return layout(event.name, body);
}

function formatAdmission(admission: { policyName: string | null; gates: string[] }): string {
  if (!admission.policyName) return 'General admission';
  if (admission.gates.length === 0) return admission.policyName;
  return `${admission.policyName} · ${admission.gates.join(', ')}`;
}

/** The event's IANA zone, or UTC when the stored value is not one this runtime knows. */
function validZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

/** "Sun, 15 Nov 2026" in `timeZone`. */
function formatDay(date: Date, timeZone: string): string {
  const part = (options: Intl.DateTimeFormatOptions) => date.toLocaleDateString('en-GB', { ...options, timeZone });
  return `${part({ weekday: 'short' })}, ${part({ day: 'numeric' })} ${part({ month: 'short' })} ${part({ year: 'numeric' })}`;
}

/** "19:00" (24-hour) in `timeZone`. */
function formatClock(date: Date, timeZone: string): string {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone });
}

/** Short zone name at that instant: "UTC", "BST", "GMT+5:30". */
function zoneAbbreviation(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'short' }).formatToParts(date);
  return parts.find((part) => part.type === 'timeZoneName')?.value ?? timeZone;
}

/** "Sun, 15 Nov 2026 · 19:00–23:00", or both days when the event runs past midnight. */
export function formatEventWhen(startsAt: string, endsAt: string, timeZone: string): string {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const startDay = formatDay(start, timeZone);
  const endDay = formatDay(end, timeZone);
  if (startDay === endDay) return `${startDay} · ${formatClock(start, timeZone)}–${formatClock(end, timeZone)}`;
  return `${startDay} · ${formatClock(start, timeZone)} – ${endDay} · ${formatClock(end, timeZone)}`;
}

/** "Times in Asia/Kolkata (GMT+5:30)"; just "Times in UTC" for UTC. */
export function zoneLabel(at: string, timeZone: string): string {
  const abbreviation = zoneAbbreviation(new Date(at), timeZone);
  return timeZone === 'UTC' || abbreviation === timeZone ? `Times in ${timeZone}` : `Times in ${timeZone} (${abbreviation})`;
}

/** One instant with its zone: "Sun, 15 Nov 2026 · 23:00 GMT+5:30". */
export function formatMoment(iso: string, timeZone: string): string {
  const date = new Date(iso);
  return `${formatDay(date, timeZone)} · ${formatClock(date, timeZone)} ${zoneAbbreviation(date, timeZone)}`;
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
    --muted:#5f6673;
    --ok:#1a7f37;
    --warn:#805600;
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
  word-break:break-word;
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
.field-wide{
  grid-column:1 / -1;
}
.label,.ref-label{
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
.zone{
  font-size:0.75rem;
  color:var(--muted);
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
.ref-label{
  text-align:center;
  margin:0 0 2px;
}
.ref{
  font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;
  font-size:1.25rem;
  font-weight:600;
  letter-spacing:0.16em;
  color:var(--fg);
  text-align:center;
  margin:0;
  font-feature-settings:'tnum';
  font-variant-numeric:tabular-nums;
  user-select:all;
  -webkit-user-select:all;
}
.inactive-wrap{
  padding:12px 0 0;
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
  font-size:0.75rem;
  color:var(--muted);
  text-align:center;
  margin:4px 0 0;
  line-height:1.5;
  font-feature-settings:'tnum';
  font-variant-numeric:tabular-nums;
}
@page{
  margin:12mm;
}
@media print{
  :root{
    color-scheme:light;
    --bg:#ffffff;
    --card:#ffffff;
    --border:#000000;
    --fg:#000000;
    --muted:#333333;
    --ok:#000000;
    --warn:#000000;
    --bad:#000000;
  }
  body{
    display:block;
    min-height:0;
    padding:0;
    font-size:12pt;
  }
  main{
    margin:0 auto;
    max-width:90mm;
  }
  .card{
    border:1px solid #000000;
    break-inside:avoid;
    page-break-inside:avoid;
  }
  .notch{
    display:none;
  }
  .qr{
    -webkit-print-color-adjust:exact;
    print-color-adjust:exact;
  }
  .status::before{
    display:none;
  }
}
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}
