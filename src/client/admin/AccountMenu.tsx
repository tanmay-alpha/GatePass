import { ChevronDown, KeyRound, LogOut } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { AccountUser, SessionInfo } from '../../shared/types';
import { api } from '../api';
import { Modal } from '../dialog';
import { ErrorNote, ToneBadge, errorMessage, focusFirstInvalid } from '../ui';
import { MIN_PASSWORD, PasswordField, newPasswordErrors } from './AuthScreens';
import { PLATFORM_ROLE_LABEL } from './model';
import { useToast } from './toast';

interface Props {
  user: AccountUser;
  onSignOut: () => Promise<void>;
  onSession: (session: SessionInfo) => void;
}

/** Top-bar disclosure: who is signed in, Change password, Sign out. */
export function AccountMenu({ user, onSignOut, onSession }: Props) {
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="account" ref={root}>
      <button ref={button} type="button" className="btn btn-ghost btn-small account-button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
        <span className="account-initial" aria-hidden>
          {user.name.trim().charAt(0).toUpperCase() || '?'}
        </span>
        <span className="account-name">{user.name}</span>
        <ChevronDown size={14} aria-hidden />
      </button>
      {open ? (
        <div id={panelId} className="account-panel">
          <div className="account-who">
            <span className="strong">{user.name}</span>
            <span className="muted small">{user.email}</span>
            {user.platformRole === 'platform_admin' ? <ToneBadge tone="info">{PLATFORM_ROLE_LABEL.platform_admin}</ToneBadge> : null}
          </div>
          <button
            type="button"
            className="btn btn-ghost account-item"
            onClick={() => {
              setOpen(false);
              setChanging(true);
            }}
          >
            <KeyRound size={15} aria-hidden /> Change password
          </button>
          <button
            type="button"
            className="btn btn-ghost account-item"
            disabled={signingOut}
            onClick={() => {
              setSigningOut(true);
              void onSignOut().finally(() => setSigningOut(false));
            }}
          >
            <LogOut size={15} aria-hidden /> {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      ) : null}
      {changing ? (
        <ChangePasswordDialog
          onClose={() => setChanging(false)}
          onChanged={(session) => {
            setChanging(false);
            onSession(session);
          }}
        />
      ) : null}
    </div>
  );
}

function ChangePasswordDialog({ onClose, onChanged }: { onClose: () => void; onChanged: (session: SessionInfo) => void }) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const notify = useToast();
  const validate = () => ({ ...(current ? {} : { current: 'Enter your current password.' }), ...newPasswordErrors(password, confirm) });
  const errors: { current?: string; password?: string; confirm?: string } = showErrors ? validate() : {};

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (Object.keys(validate()).length) {
      setShowErrors(true);
      focusFirstInvalid(e.currentTarget);
      return;
    }
    setBusy(true);
    setError('');
    try {
      // Plain `api`: a wrong current password must show an error, not sign the user out.
      const session = await api<SessionInfo>('/api/auth/password', { body: { currentPassword: current, newPassword: password } });
      notify('Password changed. Every other device was signed out.');
      onChanged(session);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Change password" onClose={onClose}>
      <form className="stack" onSubmit={submit} noValidate>
        <PasswordField label="Current password" value={current} onChange={setCurrent} autoComplete="current-password" error={errors.current} />
        <PasswordField label="New password" value={password} onChange={setPassword} autoComplete="new-password" error={errors.password} hint={`At least ${MIN_PASSWORD} characters.`} />
        <PasswordField label="Repeat new password" value={confirm} onChange={setConfirm} autoComplete="new-password" error={errors.confirm} />
        <p className="muted small">Changing your password signs you out everywhere else; this browser stays signed in.</p>
        <ErrorNote message={error} />
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Change password'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
