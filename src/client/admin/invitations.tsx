import { RotateCw, X } from 'lucide-react';
import type { Invitation, InvitationLink } from '../../shared/types';
import { Modal } from '../dialog';
import { TableMessage, ToneBadge, formatShortDateTime, type Tone } from '../ui';
import { CopyField } from './CopyField';
import { INVITATION_ROLE_LABEL } from './model';

const INVITATION_STATUS: Record<Invitation['status'], { label: string; tone: Tone }> = {
  pending: { label: 'Pending', tone: 'info' },
  accepted: { label: 'Accepted', tone: 'ok' },
  revoked: { label: 'Revoked', tone: 'bad' },
  expired: { label: 'Expired', tone: 'muted' }
};

export function InvitationStatusBadge({ status }: { status: Invitation['status'] }) {
  return <ToneBadge tone={INVITATION_STATUS[status].tone}>{INVITATION_STATUS[status].label}</ToneBadge>;
}

/** Invitations with status; pending ones can be revoked, pending or expired ones re-sent with a fresh link. Shared with the event Team tab. */
export function InvitationTable({
  invitations,
  loading,
  pending,
  onRevoke,
  onResend,
  showRole = false
}: {
  invitations: Invitation[] | null;
  loading: boolean;
  pending: string | null;
  onRevoke: (invitation: Invitation) => void;
  onResend: (invitation: Invitation) => void;
  showRole?: boolean;
}) {
  const columns = showRole ? 5 : 4;
  return (
    <div className="table-wrap">
      <table className="table-cards">
        <thead>
          <tr>
            <th scope="col">Email</th>
            {showRole ? <th scope="col">Role</th> : null}
            <th scope="col">Status</th>
            <th scope="col" className="num">Expires</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {invitations?.map((invitation) => (
            <tr key={invitation.id}>
              <td className="strong cell-primary">{invitation.email}</td>
              {showRole ? <td data-label="Role">{INVITATION_ROLE_LABEL[invitation.role]}</td> : null}
              <td className="cell-badge">
                <InvitationStatusBadge status={invitation.status} />
              </td>
              <td className="num muted nowrap" data-label="Expires">
                {invitation.status === 'pending' ? formatShortDateTime(invitation.expiresAt) : '—'}
              </td>
              <td className="row-actions">
                {invitation.status === 'pending' || invitation.status === 'expired' ? (
                  <button className="btn btn-ghost btn-small" onClick={() => onResend(invitation)} disabled={pending === invitation.id} aria-label={`New link for ${invitation.email}`}>
                    <RotateCw size={14} aria-hidden /> New link
                  </button>
                ) : null}
                {invitation.status === 'pending' ? (
                  <button className="btn btn-ghost btn-small danger" onClick={() => onRevoke(invitation)} disabled={pending === invitation.id} aria-label={`Revoke invitation for ${invitation.email}`}>
                    <X size={14} aria-hidden /> Revoke
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
          {loading ? <TableMessage colSpan={columns}>Loading invitations…</TableMessage> : null}
          {invitations?.length === 0 ? <TableMessage colSpan={columns}>No invitations yet.</TableMessage> : null}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Right after an invitation is created or renewed. When the provider accepted
 * the email, only the invitee holds the link; otherwise it is shown once to
 * share by hand. "Sent" means accepted by the provider, not delivered.
 */
export function InvitationLinkDialog({ link, onClose }: { link: InvitationLink; onClose: () => void }) {
  const { email } = link;
  return (
    <Modal title={`Invitation for ${link.invitation.email}`} onClose={onClose}>
      <div className="stack">
        {email.status === 'sent' ? (
          <p className="small">
            The invitation email was handed to the email provider for {link.invitation.email} (message id <code>{email.providerId}</code>). Delivery is not confirmed: if it does not arrive,
            use “New link” to send it again.
          </p>
        ) : (
          <p className="warning-text small">
            {email.status === 'failed' ? `The email could not be sent: ${email.error} ` : 'Email is not set up on this server. '}
            This link is shown only once: copy it now and send it to {link.invitation.email} yourself.
          </p>
        )}
        {link.url ? <CopyField label="Invitation link" value={link.url} hint={`Expires ${formatShortDateTime(link.invitation.expiresAt)}. It works once, for this email address only.`} /> : null}
        <div className="dialog-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
