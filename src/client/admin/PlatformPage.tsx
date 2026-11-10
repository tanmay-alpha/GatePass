import { Ban, CircleCheck, KeyRound, Send } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { AccountUser, Invitation, InvitationLink } from '../../shared/types';
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
  const [resetLink, setResetLink] = useState<{ user: PlatformUser; url: string; expiresAt: string } | null>(null);
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

  async function createResetLink(target: PlatformUser) {
    const ok = await confirm({
      title: `Create a password reset link for ${target.name}?`,
      body: 'Anyone with the link can set a new password for this account until it expires. No email is sent: you deliver it yourself over a channel you trust.',
      confirmLabel: 'Create link'
    });
    if (!ok) return;
    setPending(target.id);
    setError('');
    try {
      const result = await adminApi<{ url: string; expiresAt: string }>(`/api/platform/users/${target.id}/reset-link`, { method: 'POST' });
      setResetLink({ user: target, ...result });
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
        <table aria-busy={users.loading}>
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
                <td>
                  <div className="strong">
                    {account.name}
                    {account.id === me.id ? <span className="muted"> (you)</span> : null}
                  </div>
                  <div className="muted small">{account.email}</div>
                </td>
                <td>{PLATFORM_ROLE_LABEL[account.platformRole]}</td>
                <td className="num">{account.eventCount}</td>
                <td className="num muted nowrap">{formatShortDateTime(account.createdAt)}</td>
                <td>{account.disabledAt ? <ToneBadge tone="bad">Disabled</ToneBadge> : <ToneBadge tone="ok">Active</ToneBadge>}</td>
                <td className="row-actions">
                  {account.id === me.id ? null : (
                    <>
                      <button className="btn btn-ghost btn-small" onClick={() => void createResetLink(account)} disabled={pending === account.id} aria-label={`Create reset link for ${account.email}`}>
                        <KeyRound size={14} aria-hidden /> Reset link
                      </button>
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
      {resetLink ? (
        <Modal title={`Reset link for ${resetLink.user.name}`} onClose={() => setResetLink(null)}>
          <div className="stack">
            <p className="warning-text small">This link is shown only once. No email is sent: copy it now and send it to {resetLink.user.email} yourself.</p>
            <CopyField label="Reset link" value={resetLink.url} hint={`Expires ${formatShortDateTime(resetLink.expiresAt)}. Using it signs the account out everywhere.`} />
            <div className="dialog-actions">
              <button type="button" className="btn btn-primary" onClick={() => setResetLink(null)}>
                Done
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
      {dialog}
    </section>
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
      <SectionHead id="platform-invites-title" title="Invitations" description="Invite organizers (they can create events) or other platform admins. No email is sent; you share the link." />
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
      <InvitationTable invitations={invitations.data} loading={invitations.data === null && !invitations.error} pending={pending} onRevoke={revoke} showRole />
      {link ? <InvitationLinkDialog link={link} onClose={() => setLink(null)} /> : null}
      {dialog}
    </section>
  );
}
