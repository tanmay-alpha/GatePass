import { AlertTriangle, ChevronLeft, ChevronRight, Mail, RefreshCw, Send, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { DeliveryActionResult, DeliveryList, DeliveryPause, DeliverySkipReason, DeliveryStatus, EventSummary, IssuedPass, PassDelivery } from '../../shared/types';
import { api } from '../api';
import { useConfirm } from '../dialog';
import { formatShortInZone } from '../time';
import { ErrorNote, SectionHead, TableMessage, ToneBadge, errorMessage, type Tone } from '../ui';
import { LIVE_POLL_MS, useResource } from './hooks';
import { adminApi } from './http';
import { can } from './model';
import { useToast } from './toast';
import './deliveries.css';

// Attendee pass email: the issue/import checkbox, "Email these passes" on
// freshly issued passes, and the per-event delivery status card
// (docs/decisions/0012-pass-email-outbox.md). "Accepted by provider" is the
// strongest claim the product makes: delivery to the inbox is never confirmed.
// "Requires action" (unconfirmed) means the email may or may not have been
// sent; only the organizer can decide whether to send a new link.

const PAGE_SIZE = 50;
/** The bulk endpoints accept at most this many ids per request. */
const BULK_LIMIT = 500;
/** Fired after anything queued email, so the status card refreshes at once. */
const CHANGED_EVENT = 'gatepass:deliveries-changed';

const STATUS_META: Record<DeliveryStatus, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'info' },
  sending: { label: 'Sending', tone: 'info' },
  accepted: { label: 'Accepted by provider', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
  unconfirmed: { label: 'Requires action', tone: 'warn' }
};

const PAUSED: Record<DeliveryPause, string> = {
  no_provider: 'this server has no email provider set up (RESEND_API_KEY and MAIL_FROM).',
  no_key:
    'the server is missing PASS_DELIVERY_KEY, the key that unlocks the waiting links. Ask the operator to set it again; a new key needs the old one in PASS_DELIVERY_PREVIOUS_KEYS, or these emails fail and need new links.'
};

/** Why an unconfirmed email needs a decision, shown before a new link is sent. */
const DUPLICATE_RISK =
  'The email provider may already have sent the earlier email: it took a request GatePass could not confirm in time. Check the provider’s log if you can. Sending a new link replaces the pass link, so the current QR code and link stop working, including copies already printed or forwarded; the attendee may get two emails, and only the newest link works.';

const SKIP_LABEL: Record<DeliverySkipReason, string> = {
  not_found: 'not found',
  no_email: 'no email address',
  redeemed: 'already used',
  revoked: 'revoked',
  expired: 'expired',
  already_queued: 'already waiting',
  needs_reissue: 'needs a new link',
  link_changed: 'link replaced since',
  recipient_limit: 'daily email limit for that address',
  in_progress: 'being sent right now',
  not_queued: 'no longer waiting',
  superseded: 'emailed again since'
};

export function announceDeliveries(): void {
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

let health: Promise<{ email: boolean; passEmail: boolean }> | null = null;

/** Whether this server can email passes (`GET /api/health`), fetched once per page load. */
export function usePassEmail(): { email: boolean; passEmail: boolean } | null {
  const [state, setState] = useState<{ email: boolean; passEmail: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    health ??= api<{ email?: boolean; passEmail?: boolean }>('/api/health').then(
      (body) => ({ email: body.email === true, passEmail: body.passEmail === true }),
      () => {
        health = null;
        return { email: false, passEmail: false };
      }
    );
    void health.then((value) => live && setState(value));
    return () => {
      live = false;
    };
  }, []);
  return state;
}

function skippedSummary(result: DeliveryActionResult): string {
  if (result.skipped.length === 0) return '';
  const reasons = new Map<string, number>();
  for (const skip of result.skipped) reasons.set(SKIP_LABEL[skip.reason], (reasons.get(SKIP_LABEL[skip.reason]) ?? 0) + 1);
  return `; ${result.skipped.length} skipped (${[...reasons].map(([reason, count]) => `${count} ${reason}`).join(', ')})`;
}

/** Checkbox for issuing and importing; hidden when the server has no email provider. */
export function EmailPassesOption({ checked, onChange, withEmail }: { checked: boolean; onChange: (checked: boolean) => void; withEmail?: number }) {
  const capability = usePassEmail();
  if (!capability?.email) return null;
  return (
    <div>
      <label className="check">
        <input type="checkbox" checked={checked && capability.passEmail} disabled={!capability.passEmail} onChange={(e) => onChange(e.target.checked)} />
        Email each attendee their pass{withEmail === undefined ? '' : ` (${withEmail} with an address)`}
      </label>
      <span className="field-hint">
        {capability.passEmail
          ? 'Sent in the background, a few a second; follow progress under Pass emails. Rows without an email address get no email.'
          : 'Not available: the server operator has to set PASS_DELIVERY_KEY first.'}
      </span>
    </div>
  );
}

/** "Email these passes" for passes still on screen right after issuing: their current links are sent, nothing is reissued. */
export function EmailIssuedPasses({ eventId, passes }: { eventId: string; passes: IssuedPass[] }) {
  const capability = usePassEmail();
  const notify = useToast();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const withEmail = passes.filter((pass) => pass.attendeeEmail);
  if (!capability?.passEmail || withEmail.length === 0) return null;

  async function send() {
    setBusy(true);
    try {
      let done = 0;
      const skipped: DeliveryActionResult['skipped'] = [];
      for (let start = 0; start < withEmail.length; start += BULK_LIMIT) {
        const result = await adminApi<DeliveryActionResult>(`/api/events/${eventId}/deliveries`, {
          body: { passes: withEmail.slice(start, start + BULK_LIMIT).map((pass) => ({ passId: pass.id, token: pass.token })) }
        });
        done += result.done;
        skipped.push(...result.skipped);
      }
      setSent(true);
      announceDeliveries();
      notify(`${done} email${done === 1 ? '' : 's'} queued${skippedSummary({ done, reissued: 0, skipped })}`);
    } catch (err) {
      notify(errorMessage(err), 'bad');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className="btn btn-secondary btn-small" onClick={() => void send()} disabled={busy || sent}>
      <Mail size={14} aria-hidden /> {sent ? 'Emails queued' : busy ? 'Queuing…' : `Email ${withEmail.length === 1 ? 'this pass' : `these ${withEmail.length} passes`}`}
    </button>
  );
}

/** Queued again after an attempt that did not go through (a provider error, a rate limit or a restart). */
function retryScheduled(delivery: PassDelivery): boolean {
  return delivery.status === 'queued' && delivery.lastError !== null;
}

/** What happened and what comes next, in plain words; never the sealed link or a raw provider answer. */
function statusDetail(delivery: PassDelivery, zone: string): string {
  const at = (iso: string | null) => formatShortInZone(iso, zone);
  const lines: Array<string | null | false> = [];
  if (retryScheduled(delivery)) {
    lines.push(
      `${delivery.attempts ? `Attempt ${delivery.attempts} did not go through` : 'Not sent yet'}: ${delivery.lastError}`,
      Boolean(delivery.nextAttemptAt) && `Next try ${at(delivery.nextAttemptAt)}.`
    );
  } else if (delivery.status === 'sending') {
    lines.push(`Being handed to the email provider (attempt ${delivery.attempts}).`);
  } else if (delivery.status === 'accepted') {
    lines.push(`Handed to the email provider ${at(delivery.acceptedAt)}; delivery to the inbox is not confirmed.`, Boolean(delivery.providerId) && `Provider message id ${delivery.providerId}.`);
  } else if (delivery.status === 'unconfirmed') {
    lines.push(delivery.lastError, Boolean(delivery.uncertainSince) && `Look in the provider’s log from ${at(delivery.uncertainSince)}.`);
  } else if (delivery.status !== 'queued') {
    lines.push(delivery.lastError);
  }
  if (delivery.superseded) lines.push('A later email replaced this one.');
  return lines.filter(Boolean).join(' ');
}

/** Per-event status of pass emails, with retry and cancel. Hidden until the event has any. */
export function DeliveriesSection({ event }: { event: EventSummary }) {
  const [status, setStatus] = useState<DeliveryStatus | ''>('');
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [confirm, dialog] = useConfirm();
  const notify = useToast();
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (status) params.set('status', status);
  const list = useResource<DeliveryList>(`/api/events/${event.id}/deliveries?${params}`);
  const { reload } = list;
  const counts = list.data?.counts;
  const waiting = counts ? counts.queued + counts.sending : 0;
  const manage = can(event, 'passes') && event.status !== 'archived';
  const zone = event.timeZone;

  // Live while emails are waiting; otherwise only on demand and after new emails are queued.
  useEffect(() => {
    if (waiting === 0) return;
    const timer = setInterval(() => void reload(), LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, reload]);
  useEffect(() => {
    const onChanged = () => void reload();
    window.addEventListener(CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CHANGED_EVENT, onChanged);
  }, [reload]);
  useEffect(() => setOffset(0), [status]);

  const act = useCallback(
    async (key: string, path: 'retry' | 'cancel', deliveryIds: string[], reissue: boolean, verb: string) => {
      setPending(key);
      setError('');
      try {
        const total: DeliveryActionResult = { done: 0, reissued: 0, skipped: [] };
        for (let start = 0; start < deliveryIds.length; start += BULK_LIMIT) {
          const result = await adminApi<DeliveryActionResult>(`/api/events/${event.id}/deliveries/${path}`, {
            body: { deliveryIds: deliveryIds.slice(start, start + BULK_LIMIT), ...(reissue ? { reissue: true } : {}) }
          });
          total.done += result.done;
          total.reissued += result.reissued;
          total.skipped.push(...result.skipped);
        }
        await reload();
        notify(`${total.done} email${total.done === 1 ? '' : 's'} ${verb}${skippedSummary(total)}`);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setPending(null);
      }
    },
    [event.id, notify, reload]
  );

  async function sendAgain(deliveries: PassDelivery[], key: string) {
    const many = deliveries.length > 1;
    const unconfirmed = deliveries.some((delivery) => delivery.status === 'unconfirmed');
    const who = deliveries[0].attendeeName || deliveries[0].recipient;
    const ok = await confirm({
      title: unconfirmed
        ? many
          ? `Send ${deliveries.length} new links? Some attendees may already have their email.`
          : `Send ${who} a new link? They may already have the email.`
        : many
          ? `Send ${deliveries.length} passes again with new links?`
          : `Send the pass for ${who} again?`,
      body: unconfirmed
        ? DUPLICATE_RISK
        : 'Links are erased once an email is accepted, fails or is cancelled, so sending again creates a new link: the current QR code and link of the pass stop working, including any copy already printed or forwarded.',
      confirmLabel: unconfirmed ? (many ? `Send ${deliveries.length} new links` : 'Send new link') : many ? `Reissue and email ${deliveries.length}` : 'Reissue and email'
    });
    if (ok) await act(key, 'retry', deliveries.map((delivery) => delivery.id), true, 'queued with new links');
  }

  /** Every failed or unconfirmed email not replaced since, up to one batch per click (the count shrinks as they are sent again). */
  async function sendAllWith(state: 'failed' | 'unconfirmed') {
    setError('');
    try {
      const found = await adminApi<DeliveryList>(`/api/events/${event.id}/deliveries?status=${state}&limit=${BULK_LIMIT}`);
      const open = found.deliveries.filter((delivery) => !delivery.superseded);
      if (open.length) await sendAgain(open, `bulk-${state}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (!counts || (Object.values(counts).every((count) => count === 0) && !status)) return null;
  const rows = list.data?.deliveries ?? [];
  const total = list.data?.total ?? 0;

  return (
    <section className="card" aria-labelledby="deliveries-title">
      <SectionHead
        id="deliveries-title"
        title="Pass emails"
        description="“Accepted by provider” means the email service took the message. It does not confirm that it reached the inbox."
      >
        <button type="button" className="btn btn-ghost btn-small" onClick={() => void reload()} disabled={list.loading}>
          <RefreshCw size={14} aria-hidden /> Refresh
        </button>
      </SectionHead>
      <div className="delivery-counts" role="status">
        <ToneBadge tone={waiting ? 'info' : 'muted'}>{waiting} waiting</ToneBadge>
        {counts.retrying ? <ToneBadge tone="warn">{counts.retrying} retry scheduled</ToneBadge> : null}
        <ToneBadge tone={counts.accepted ? 'ok' : 'muted'}>{counts.accepted} accepted by provider</ToneBadge>
        {counts.unconfirmed ? <ToneBadge tone="warn">{counts.unconfirmed} require action</ToneBadge> : null}
        <ToneBadge tone={counts.failed ? 'bad' : 'muted'}>{counts.failed} failed</ToneBadge>
        <ToneBadge tone="muted">{counts.cancelled} cancelled</ToneBadge>
      </div>
      {list.data?.paused ? (
        <p className="notice delivery-paused" role="status">
          <AlertTriangle size={16} aria-hidden className="warning-text" /> Sending is paused: {PAUSED[list.data.paused]} Waiting emails stay queued until then; you can still cancel them.
        </p>
      ) : null}
      <div className="pass-actions">
        <label>
          <span className="sr-only">Filter pass emails by status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as DeliveryStatus | '')}>
            <option value="">All pass emails</option>
            {(Object.keys(STATUS_META) as DeliveryStatus[]).map((value) => (
              <option key={value} value={value}>
                {STATUS_META[value].label}
              </option>
            ))}
          </select>
        </label>
        {manage && (counts.failed > 0 || counts.unconfirmed > 0) ? (
          <span className="pass-actions-end actions">
            {counts.unconfirmed > 0 ? (
              <button type="button" className="btn btn-secondary btn-small" onClick={() => void sendAllWith('unconfirmed')} disabled={pending !== null}>
                <Send size={14} aria-hidden /> {pending === 'bulk-unconfirmed' ? 'Queuing…' : `Send ${counts.unconfirmed} new link${counts.unconfirmed === 1 ? '' : 's'}`}
              </button>
            ) : null}
            {counts.failed > 0 ? (
              <button type="button" className="btn btn-secondary btn-small" onClick={() => void sendAllWith('failed')} disabled={pending !== null}>
                <Send size={14} aria-hidden /> {pending === 'bulk-failed' ? 'Queuing…' : `Send ${counts.failed} failed again`}
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
      <ErrorNote message={error || list.error} />
      <div className="table-wrap">
        <table className="table-cards" aria-busy={list.loading}>
          <thead>
            <tr>
              <th scope="col">Attendee</th>
              <th scope="col">Status</th>
              <th scope="col" className="num">
                Attempts
              </th>
              <th scope="col" className="num">
                Updated
              </th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((delivery) => {
              const detail = statusDetail(delivery, zone);
              const retrying = retryScheduled(delivery);
              // An unconfirmed email replaced by a later one needs no decision any more.
              const badge = retrying
                ? { label: 'Retry scheduled', tone: 'warn' as const }
                : delivery.status === 'unconfirmed' && delivery.superseded
                  ? { label: 'Not confirmed', tone: 'muted' as const }
                  : STATUS_META[delivery.status];
              return (
                <tr key={delivery.id}>
                  <td className="cell-primary">
                    <div className="strong">{delivery.attendeeName || <span className="muted">Unnamed</span>}</div>
                    <div className="muted small">{delivery.recipient}</div>
                  </td>
                  <td className="delivery-status" data-label="Status">
                    <ToneBadge tone={badge.tone}>{badge.label}</ToneBadge>
                    {detail ? <div className="muted small delivery-detail">{detail}</div> : null}
                  </td>
                  <td className="num muted" data-label="Attempts">
                    {delivery.attempts}
                  </td>
                  <td className="num muted nowrap" data-label="Updated">
                    {formatShortInZone(delivery.updatedAt, zone)}
                  </td>
                  <td className="row-actions">
                    {manage && retrying ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        onClick={() => void act(delivery.id, 'retry', [delivery.id], false, 'retried now')}
                        disabled={pending !== null}
                        title="Retry now with the same link"
                      >
                        <RefreshCw size={15} aria-hidden />
                        <span className="row-action-text">Retry now</span>
                      </button>
                    ) : null}
                    {manage && delivery.status === 'queued' ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon danger"
                        onClick={() => void act(delivery.id, 'cancel', [delivery.id], false, 'cancelled')}
                        disabled={pending !== null}
                        aria-label={`Cancel the email to ${delivery.recipient}`}
                        title="Cancel"
                      >
                        <X size={15} aria-hidden />
                        <span className="row-action-text">Cancel</span>
                      </button>
                    ) : null}
                    {manage && !delivery.superseded && delivery.status === 'unconfirmed' ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        onClick={() => void sendAgain([delivery], delivery.id)}
                        disabled={pending !== null}
                        aria-label={`Send new link to ${delivery.recipient}`}
                        title="Send a new link (the attendee may get two emails)"
                      >
                        <Send size={15} aria-hidden />
                        <span className="row-action-text">Send new link</span>
                      </button>
                    ) : null}
                    {manage && !delivery.superseded && (delivery.status === 'failed' || delivery.status === 'cancelled' || delivery.status === 'accepted') ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        onClick={() => void sendAgain([delivery], delivery.id)}
                        disabled={pending !== null}
                        aria-label={`Send again to ${delivery.recipient} with a new link`}
                        title="Send again with a new link"
                      >
                        <Send size={15} aria-hidden />
                        <span className="row-action-text">Send again</span>
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 ? <TableMessage colSpan={5}>No pass emails with this status.</TableMessage> : null}
          </tbody>
        </table>
      </div>
      {total > PAGE_SIZE ? (
        <nav className="pager" aria-label="Pass email pages">
          <span className="muted small num">
            {Math.min(offset + 1, total)}–{Math.min(offset + rows.length, total)} of {total}
          </span>
          <span className="actions">
            <button type="button" className="btn btn-secondary btn-small" onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0 || list.loading}>
              <ChevronLeft size={14} aria-hidden /> Previous
            </button>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => setOffset(offset + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total || list.loading}>
              Next <ChevronRight size={14} aria-hidden />
            </button>
          </span>
        </nav>
      ) : null}
      {dialog}
    </section>
  );
}
