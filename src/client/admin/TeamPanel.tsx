import { Crown, Send, UserMinus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { EventMember, EventSummary, Invitation, InvitationLink } from '../../shared/types';
import { useConfirm } from '../dialog';
import { ErrorNote, SectionHead, TableMessage, ToneBadge, errorMessage } from '../ui';
import { formatShortInZone } from '../time';
import { useCurrentUser } from './current-user';
import { useResource } from './hooks';
import { adminApi } from './http';
import { InvitationLinkDialog, InvitationTable } from './invitations';
import { ROLE_LABEL, can } from './model';
import { useToast } from './toast';

/** Who works on this event. The owner invites and removes managers and can hand over ownership. */
export function TeamPanel({ event, onChanged }: { event: EventSummary; onChanged: () => Promise<void> }) {
  const manage = can(event, 'team');
  const me = useCurrentUser();
  const members = useResource<EventMember[]>(`/api/events/${event.id}/members`);
  const invitations = useResource<Invitation[]>(manage ? `/api/events/${event.id}/invitations` : null);
  const [email, setEmail] = useState('');
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
      const created = await adminApi<InvitationLink>(`/api/events/${event.id}/invitations`, { body: { email: email.trim() } });
      setLink(created);
      setEmail('');
      await invitations.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(member: EventMember) {
    const ok = await confirm({
      title: `Remove ${member.name} from ${event.name}?`,
      body: `${member.email} loses access to this event immediately. Their past actions stay in the audit log. Invite them again to restore access.`,
      confirmLabel: 'Remove manager',
      danger: true
    });
    if (!ok) return;
    setPending(member.userId);
    setError('');
    try {
      await adminApi(`/api/events/${event.id}/members/${member.userId}`, { method: 'DELETE' });
      await members.reload();
      notify(`${member.name} removed`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  async function transfer(member: EventMember) {
    const ok = await confirm({
      title: `Make ${member.name} the owner?`,
      body: `${member.name} gets full control of ${event.name}, including the team, event status and exports. You become a manager: you can still run passes, gates and devices, but cannot undo this yourself.`,
      confirmLabel: 'Transfer ownership',
      danger: true
    });
    if (!ok) return;
    setPending(member.userId);
    setError('');
    try {
      await adminApi<EventMember[]>(`/api/events/${event.id}/owner`, { body: { userId: member.userId } });
      notify(`${member.name} now owns this event`);
      // Permissions change with the role; the refreshed event re-renders this tab.
      await Promise.all([members.reload(), onChanged()]);
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
    <div className="stack-lg">
      <section className="card" aria-labelledby="members-title">
        <SectionHead
          id="members-title"
          title="Team"
          description={
            manage
              ? 'Managers can issue passes and run gates, policies and devices. Only the owner manages the team, changes the event status and exports data.'
              : 'People who can work on this event. Only the owner can invite or remove managers.'
          }
        >
          <span className="card-meta">
            Your role: <ToneBadge tone="info">{ROLE_LABEL[event.myRole]}</ToneBadge>
          </span>
        </SectionHead>
        <ErrorNote message={error || members.error} />
        <div className="table-wrap">
          <table aria-busy={members.loading}>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Role</th>
                <th scope="col" className="num">Added</th>
                {manage ? (
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {members.data?.map((member) => (
                <tr key={member.userId}>
                  <td>
                    <div className="strong">
                      {member.name}
                      {member.userId === me?.id ? <span className="muted"> (you)</span> : null}
                    </div>
                    <div className="muted small">{member.email}</div>
                  </td>
                  <td>
                    <ToneBadge tone={member.role === 'owner' ? 'info' : 'muted'}>{ROLE_LABEL[member.role]}</ToneBadge>
                  </td>
                  <td className="num muted nowrap">{formatShortInZone(member.createdAt, event.timeZone)}</td>
                  {manage ? (
                    <td className="row-actions">
                      {member.role === 'manager' ? (
                        <>
                          <button className="btn btn-ghost btn-small" onClick={() => void transfer(member)} disabled={pending === member.userId} aria-label={`Make ${member.name} the owner`}>
                            <Crown size={14} aria-hidden /> Make owner
                          </button>
                          <button className="btn btn-ghost btn-small danger" onClick={() => void remove(member)} disabled={pending === member.userId} aria-label={`Remove ${member.name}`}>
                            <UserMinus size={14} aria-hidden /> Remove
                          </button>
                        </>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
              {members.data === null && !members.error ? <TableMessage colSpan={manage ? 4 : 3}>Loading team…</TableMessage> : null}
              {members.data?.length === 0 ? <TableMessage colSpan={manage ? 4 : 3}>No members.</TableMessage> : null}
            </tbody>
          </table>
        </div>
      </section>

      {manage ? (
        <section className="card" aria-labelledby="invite-title">
          <SectionHead id="invite-title" title="Invite a manager" description="Creates a one-time link for that email address. No email is sent; you share the link yourself." />
          <form className="inline-form" onSubmit={invite}>
            <label className="grow">
              Manager email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" required />
            </label>
            <button className="btn btn-secondary" disabled={busy || !email.trim()}>
              <Send size={15} aria-hidden /> {busy ? 'Creating…' : 'Create invitation'}
            </button>
          </form>
          <ErrorNote message={invitations.error} />
          <h3 className="label">Invitations</h3>
          <InvitationTable invitations={invitations.data} loading={invitations.data === null && !invitations.error} pending={pending} onRevoke={(invitation) => void revoke(invitation)} />
        </section>
      ) : null}
      {link ? <InvitationLinkDialog link={link} onClose={() => setLink(null)} /> : null}
      {dialog}
    </div>
  );
}
