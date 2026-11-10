import { X } from 'lucide-react';
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

/** Invitations with status; pending ones can be revoked. Shared with the event Team tab. */
export function InvitationTable({
  invitations,
  loading,
  pending,
  onRevoke,
  showRole = false
}: {
  invitations: Invitation[] | null;
  loading: boolean;
  pending: string | null;
  onRevoke: (invitation: Invitation) => void;
  showRole?: boolean;
}) {
  const columns = showRole ? 5 : 4;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Email</th>
            {showRole ? <th scope="col">Role</th> : null}
            <th scope="col">Status</th>
            <th scope="col">Expires</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {invitations?.map((invitation) => (
            <tr key={invitation.id}>
              <td className="strong">{invitation.email}</td>
              {showRole ? <td>{INVITATION_ROLE_LABEL[invitation.role]}</td> : null}
              <td>
                <InvitationStatusBadge status={invitation.status} />
              </td>
              <td className="num muted nowrap">{invitation.status === 'pending' ? formatShortDateTime(invitation.expiresAt) : '—'}</td>
              <td className="row-actions">
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

/** The invitation link, shown once right after it is created. */
export function InvitationLinkDialog({ link, onClose }: { link: InvitationLink; onClose: () => void }) {
  return (
    <Modal title={`Invitation for ${link.invitation.email}`} onClose={onClose}>
      <div className="stack">
        <p className="warning-text small">This link is shown only once and no email is sent. Copy it now and send it to {link.invitation.email} yourself.</p>
        <CopyField label="Invitation link" value={link.url} hint={`Expires ${formatShortDateTime(link.invitation.expiresAt)}. It works once, for this email address only.`} />
        <div className="dialog-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
