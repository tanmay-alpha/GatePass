import { Ban, CalendarPlus, CircleCheck, KeyRound, Send } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { AccountUser, Invitation, InvitationLink, PasswordResetResult } from '../../shared/types';
import { Modal, useConfirm } from '../dialog';
import { ErrorNote, SectionHead, TableMessage, ToneBadge, errorMessage, formatShortDateTime } from '../ui';
import { CopyField } from './CopyField';
import { useResource } from './hooks';
import { adminApi } from './http';
import { InvitationLinkDialog, InvitationTable } from './invitations';
import { PLATFORM_ROLE_LABEL } from './model';
import { useToast } from './toast';

type PlatformUser = AccountUser & { eventCount: number };

/** Platform admins: accounts (disable, reset links) and organizer / platform-admin invitations. No event data. */
export function PlatformPage({ user }: { user: AccountUser }) {
  return (
    <div className="stack-lg">
      <div>
        <h1>Platform administration</h1>
        <p className="muted small">
          Manage accounts on this GatePass server. Platform admins do not see other organizers' events or attendee data.
        </p>
      </div>
      <UsersSection me={user} />
      <PlatformInvitations />
    </div>
  );
}

function UsersSection({ me }: { me: AccountUser }) {
  const users = useResource<PlatformUser[]>('/api/platform/users');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [resetTarget, setResetTarget] = useState<PlatformUser | null>(null);
  const health = useResource<{ email?: boolean }>('/api/health');
  const emailEnabled = health.data?.email === true;
  const [confirm, dialog] = useConfirm();
  const notify = useToast();

  async function toggle(target: PlatformUser) {
    const disabling = target.disabledAt === null;
    const ok = await confirm(
      disabling
        ? {
            title: `Disable ${target.name}?`,
            body: `${target.email} is signed out everywhere and cannot sign in until enabled again. Their events keep working; another owner or manager cannot take them over automatically.`,
            confirmLabel: 'Disable account',
            danger: true
          }
        : { title: `Enable ${target.name}?`, body: `${target.email} can sign in again with their existing password.`, confirmLabel: 'Enable account' }
    );
    if (!ok) return;
    setPending(target.id);
    setError('');
    try {
      await adminApi<AccountUser>(`/api/platform/users/${target.id}/${disabling ? 'disable' : 'enable'}`, { method: 'POST' });
      await users.reload();
      notify(disabling ? `${target.name} disabled` : `${target.name} enabled`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  async function toggleEventCreation(target: PlatformUser) {
    setPending(target.id);
    setError('');
    try {
      await adminApi<AccountUser>(`/api/platform/users/${target.id}/event-creation`, { body: { allowed: !target.canCreateEvents } });
      await users.reload();
      notify(target.canCreateEvents ? `${target.name} can no longer create events` : `${target.name} can create events`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="card" aria-labelledby="users-title">
      <SectionHead id="users-title" title="Accounts" description="Everyone who can sign in. Disabling an account signs it out everywhere." />
      <ErrorNote message={error || users.error} />
      {users.error ? (
        <div className="actions">
          <button type="button" className="btn btn-secondary btn-small" onClick={() => void users.reload()}>
            Retry
          </button>
        </div>
      ) : null}
      <div className="table-wrap">
        <table className="table-cards" aria-busy={users.loading}>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Role</th>
              <th scope="col" className="num">
                Events
              </th>
              <th scope="col">Created</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.data?.map((account) => (
              <tr key={account.id}>
                <td className="cell-primary">
                  <div className="strong">
                    {account.name}
                    {account.id === me.id ? <span className="muted"> (you)</span> : null}
                  </div>
                  <div className="muted small">{account.email}</div>
                </td>
                <td data-label="Role">
                  {PLATFORM_ROLE_LABEL[account.platformRole]}
                  {account.canCreateEvents ? null : <div className="muted small">Invited events only</div>}
                </td>
                <td className="num" data-label="Events">
                  {account.eventCount}
                </td>
                <td className="num muted nowrap" data-label="Created">
                  {formatShortDateTime(account.createdAt)}
                </td>
                <td className="cell-badge">{account.disabledAt ? <ToneBadge tone="bad">Disabled</ToneBadge> : <ToneBadge tone="ok">Active</ToneBadge>}</td>
                <td className="row-actions row-actions-wrap">
                  {account.id === me.id ? null : (
                    <>
                      <button className="btn btn-ghost btn-small" onClick={() => setResetTarget(account)} disabled={pending === account.id} aria-label={`Reset password for ${account.email}`}>
                        <KeyRound size={14} aria-hidden /> Reset password
                      </button>
                      {account.platformRole === 'organizer' ? (
                        <button
                          className="btn btn-ghost btn-small"
                          onClick={() => void toggleEventCreation(account)}
                          disabled={pending === account.id}
                          aria-label={`${account.canCreateEvents ? 'No new events' : 'Allow new events'} for ${account.email}`}
                        >
                          <CalendarPlus size={14} aria-hidden /> {account.canCreateEvents ? 'No new events' : 'Allow new events'}
                        </button>
                      ) : null}
                      <button
                        className={`btn btn-ghost btn-small${account.disabledAt ? '' : ' danger'}`}
                        onClick={() => void toggle(account)}
                        disabled={pending === account.id}
                        aria-label={`${account.disabledAt ? 'Enable' : 'Disable'} ${account.email}`}
                      >
                        {account.disabledAt ? <CircleCheck size={14} aria-hidden /> : <Ban size={14} aria-hidden />} {account.disabledAt ? 'Enable' : 'Disable'}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {users.data === null && !users.error ? <TableMessage colSpan={6}>Loading accounts…</TableMessage> : null}
            {users.data?.length === 0 ? <TableMessage colSpan={6}>No accounts yet.</TableMessage> : null}
          </tbody>
        </table>
      </div>
      {resetTarget ? <ResetPasswordDialog target={resetTarget} emailEnabled={emailEnabled} onClose={() => setResetTarget(null)} /> : null}
      {dialog}
    </section>
  );
}

/**
 * Administrator-started recovery. With email, the link goes only to the
 * account's address and the administrator never sees it. Without email the
 * administrator receives the link and must give a reason (audited); the
 * account then shows a notice at sign-in until someone acknowledges it.
 */
function ResetPasswordDialog({ target, emailEnabled, onClose }: { target: PlatformUser; emailEnabled: boolean; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<PasswordResetResult | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      setResult(await adminApi<PasswordResetResult>(`/api/platform/users/${target.id}/reset-link`, { body: emailEnabled ? {} : { reason: reason.trim() } }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Reset password for ${target.name}`} onClose={onClose}>
      {result ? (
        <div className="stack">
          {result.delivery === 'link' ? (
            <>
              <p className="warning-text small">This link is shown only once. Send it to {target.email} over a channel you trust. Using it signs the account out everywhere.</p>
              <CopyField label="Reset link" value={result.url} hint={`Expires ${formatShortDateTime(result.expiresAt)}.`} />
            </>
          ) : result.email.status === 'sent' ? (
            <p className="small">
              The reset email was handed to the email provider for {target.email} (message id <code>{result.email.providerId}</code>). Delivery is not confirmed. The link expires{' '}
              {formatShortDateTime(result.expiresAt)}.
            </p>
          ) : (
            <ErrorNote message={`The reset email was not sent${result.email.status === 'failed' ? `: ${result.email.error}` : ''}. The link was cancelled; try again.`} />
          )}
          <div className="dialog-actions">
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form className="stack" onSubmit={submit}>
          {emailEnabled ? (
            <p className="small">A one-time reset link is emailed to {target.email}. You will not see the link, so you cannot use it yourself.</p>
          ) : (
            <>
              <p className="warning-text small">
                Email is not set up on this server, so you will receive the reset link and must hand it over yourself. Whoever holds it can take over the account. The reason is recorded
                in the audit log, and the account shows a notice at its next sign-in that you created a reset link for it.
              </p>
              <label>
                Reason
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  minLength={10}
                  maxLength={500}
                  rows={3}
                  required
                  aria-describedby="reset-reason-hint"
                  placeholder="e.g. Asked by phone on 12 May; identity checked by call-back"
                />
                <span id="reset-reason-hint" className="field-hint">
                  At least 10 characters.
                </span>
              </label>
            </>
          )}
          <ErrorNote message={error} />
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={busy || (!emailEnabled && reason.trim().length < 10)}>
              {busy ? 'Working…' : emailEnabled ? 'Send reset email' : 'Create reset link'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function PlatformInvitations() {
  const invitations = useResource<Invitation[]>('/api/platform/invitations');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'organizer' | 'platform_admin'>('organizer');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [link, setLink] = useState<InvitationLink | null>(null);
  const [confirm, dialog] = useConfirm();
  const notify = useToast();

  async function invite(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const created = await adminApi<InvitationLink>('/api/platform/invitations', { body: { email: email.trim(), role } });
      setLink(created);
      setEmail('');
      await invitations.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function resend(invitation: Invitation) {
    setPending(invitation.id);
    setError('');
    try {
      setLink(await adminApi<InvitationLink>(`/api/invitations/${invitation.id}/resend`, { method: 'POST' }));
      await invitations.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  async function revoke(invitation: Invitation) {
    const ok = await confirm({
      title: `Revoke the invitation for ${invitation.email}?`,
      body: 'The link stops working immediately. You can invite the same address again later.',
      confirmLabel: 'Revoke invitation',
      danger: true
    });
    if (!ok) return;
    setPending(invitation.id);
    setError('');
    try {
      await adminApi<Invitation>(`/api/invitations/${invitation.id}/revoke`, { method: 'POST' });
      await invitations.reload();
      notify(`Invitation for ${invitation.email} revoked`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="card" aria-labelledby="platform-invites-title">
      <SectionHead
        id="platform-invites-title"
        title="Invitations"
        description="Invite organizers (they can create events) or other platform admins. The link is emailed when email is set up on this server; otherwise you share it yourself."
      />
      <form className="device-form" onSubmit={invite}>
        <label className="grow">
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" required />
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as 'organizer' | 'platform_admin')}>
            <option value="organizer">Organizer</option>
            <option value="platform_admin">Platform admin</option>
          </select>
        </label>
        <button className="btn btn-secondary" disabled={busy || !email.trim()}>
          <Send size={15} aria-hidden /> {busy ? 'Creating…' : 'Create invitation'}
        </button>
      </form>
      <ErrorNote message={error || invitations.error} />
      <InvitationTable
        invitations={invitations.data}
        loading={invitations.data === null && !invitations.error}
        pending={pending}
        onRevoke={revoke}
        onResend={(invitation) => void resend(invitation)}
        showRole
      />
      {link ? <InvitationLinkDialog link={link} onClose={() => setLink(null)} /> : null}
      {dialog}
    </section>
  );
}
