import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import type { AccountUser, InvitationPreview, SessionInfo } from '../../shared/types';
import { api, ApiError, WAKING_MESSAGE } from '../api';
import { ErrorNote, FieldError, errorMessage, focusFirstInvalid } from '../ui';
import { DemoBanner } from './DemoBanner';
import { INVITATION_ROLE_LABEL } from './model';

/** The free demo backend can take most of a minute to wake from sleep. */
export const WAKE_TIMEOUT_MS = 70_000;

/** Minimum password length; the server enforces the same rule and its message is shown on failure. */
export const MIN_PASSWORD = 10;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function authError(err: unknown): string {
  if (err instanceof ApiError && err.status === 429) {
    const minutes = err.retryAfter ? Math.max(1, Math.ceil(err.retryAfter / 60)) : null;
    return minutes ? `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` : 'Too many attempts. Wait a few minutes and try again.';
  }
  return errorMessage(err);
}

/** Centered card used by every signed-out screen. */
export function AuthLayout({ title, intro, demo, children }: { title: string; intro?: ReactNode; demo: boolean; children: ReactNode }) {
  return (
    <main className="login">
      <DemoBanner demo={demo} />
      <section className="card login-card" aria-labelledby="auth-title">
        <div className="login-head">
          <span className="brand">GatePass</span>
          <h1 id="auth-title">{title}</h1>
          {intro ? <div className="muted small">{intro}</div> : null}
        </div>
        {children}
      </section>
    </main>
  );
}

function WakingNote({ busy, slow }: { busy: boolean; slow: boolean }) {
  return busy && slow ? (
    <p className="muted small" role="status">
      {WAKING_MESSAGE}
    </p>
  ) : null;
}

interface PasswordFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  error?: string;
  hint?: string;
}

export function PasswordField({ label, value, onChange, autoComplete, error, hint }: PasswordFieldProps) {
  const id = useId();
  return (
    <label>
      {label}
      <input
        type="password"
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint ${id}-error`}
      />
      {hint ? (
        <span id={`${id}-hint`} className="field-hint">
          {hint}
        </span>
      ) : null}
      <FieldError id={`${id}-error`} message={error} />
    </label>
  );
}

/** New password plus confirmation, validated together. */
export function newPasswordErrors(password: string, confirm: string): { password?: string; confirm?: string } {
  const errors: { password?: string; confirm?: string } = {};
  if (password.length < MIN_PASSWORD) errors.password = `Use at least ${MIN_PASSWORD} characters.`;
  else if (confirm !== password) errors.confirm = 'The passwords do not match.';
  return errors;
}

interface SignInProps {
  demo: boolean;
  signupAllowed: boolean;
  notice?: string;
  onSignedIn: (session: SessionInfo) => void;
}

export function SignIn({ demo, signupAllowed, notice, onSignedIn }: SignInProps) {
  return (
    <AuthLayout title="Sign in to GatePass" intro="Organizers and event managers sign in with their own account." demo={demo}>
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}
      <SignInForm onSignedIn={onSignedIn} />
      <div className="login-foot stack-sm muted small">
        {signupAllowed ? (
          <p>
            New to GatePass? <a href="#/signup">Create an account</a>
          </p>
        ) : (
          <p>New accounts are by invitation. Ask your GatePass administrator for an invitation link.</p>
        )}
        <p>Forgot your password? Ask your GatePass administrator for a reset link.</p>
        <p>
          Door staff: open <a href="/scan">the scanner</a> instead.
        </p>
      </div>
    </AuthLayout>
  );
}

/** Email and password; `fixedEmail` locks the address (accepting an invitation as an existing account). */
function SignInForm({ onSignedIn, fixedEmail, submitLabel = 'Sign in' }: { onSignedIn: (session: SessionInfo) => void | Promise<void>; fixedEmail?: string; submitLabel?: string }) {
  const [email, setEmail] = useState(fixedEmail ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setSlow(false);
    setError('');
    try {
      const session = await api<SessionInfo>('/api/auth/login', {
        body: { email: email.trim(), password },
        timeoutMs: WAKE_TIMEOUT_MS,
        onSlow: () => setSlow(true)
      });
      await onSignedIn(session);
    } catch (err) {
      setError(authError(err));
    } finally {
      setBusy(false);
      setSlow(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <label>
        Email
        <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} readOnly={fixedEmail !== undefined} required />
      </label>
      <PasswordField label="Password" value={password} onChange={setPassword} autoComplete="current-password" />
      <ErrorNote message={error} />
      <button className="btn btn-primary btn-block" disabled={busy || !email.trim() || !password}>
        {busy ? 'Signing in…' : submitLabel}
      </button>
      <WakingNote busy={busy} slow={slow} />
    </form>
  );
}

export function SignUp({ demo, onSignedIn }: { demo: boolean; onSignedIn: (session: SessionInfo) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const id = useId();

  const validate = () => {
    const errors: { name?: string; email?: string; password?: string } = {};
    if (!name.trim()) errors.name = 'Enter your name.';
    if (!EMAIL_PATTERN.test(email.trim())) errors.email = 'Enter an email address, for example ana@example.com.';
    if (password.length < MIN_PASSWORD) errors.password = `Use at least ${MIN_PASSWORD} characters.`;
    return errors;
  };
  const errors = showErrors ? validate() : {};

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (Object.keys(validate()).length) {
      setShowErrors(true);
      focusFirstInvalid(e.currentTarget);
      return;
    }
    setBusy(true);
    setSlow(false);
    setError('');
    try {
      const session = await api<SessionInfo>('/api/auth/register', {
        body: { name: name.trim(), email: email.trim(), password },
        timeoutMs: WAKE_TIMEOUT_MS,
        onSlow: () => setSlow(true)
      });
      onSignedIn(session);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setError('An account with this email already exists. Sign in instead.');
      else if (err instanceof ApiError && err.status === 403) setError('Self-registration is turned off on this server. Ask your GatePass administrator for an invitation.');
      else setError(authError(err));
      setBusy(false);
      setSlow(false);
    }
  }

  return (
    <AuthLayout title="Create your organizer account" intro="You can create events and invite managers once you are in." demo={demo}>
      <form className="stack" onSubmit={submit} noValidate>
        <label>
          Your name
          <input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required aria-invalid={errors.name ? true : undefined} aria-describedby={`${id}-name`} />
          <FieldError id={`${id}-name`} message={errors.name} />
        </label>
        <label>
          Email
          <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required aria-invalid={errors.email ? true : undefined} aria-describedby={`${id}-email`} />
          <FieldError id={`${id}-email`} message={errors.email} />
        </label>
        <PasswordField label="Password" value={password} onChange={setPassword} autoComplete="new-password" error={errors.password} hint={`At least ${MIN_PASSWORD} characters. A short sentence is easy to remember.`} />
        <ErrorNote message={error} />
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Creating account…' : 'Create account'}
        </button>
        <WakingNote busy={busy} slow={slow} />
      </form>
      <p className="login-foot muted small">
        Already have an account? <a href="#/">Sign in</a>
      </p>
    </AuthLayout>
  );
}

export function ResetPassword({ demo, token, onReset }: { demo: boolean; token: string; onReset: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const errors = showErrors ? newPasswordErrors(password, confirm) : {};

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (Object.keys(newPasswordErrors(password, confirm)).length) {
      setShowErrors(true);
      focusFirstInvalid(e.currentTarget);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/reset', { body: { token, password }, timeoutMs: WAKE_TIMEOUT_MS });
      onReset();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 410 || err.status === 404)) setError('This reset link is no longer valid. It may have expired or already been used. Ask your GatePass administrator for a new one.');
      else setError(authError(err));
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Choose a new password" intro="Setting a new password signs you out on every device." demo={demo}>
      <form className="stack" onSubmit={submit} noValidate>
        <PasswordField label="New password" value={password} onChange={setPassword} autoComplete="new-password" error={errors.password} hint={`At least ${MIN_PASSWORD} characters.`} />
        <PasswordField label="Repeat new password" value={confirm} onChange={setConfirm} autoComplete="new-password" error={errors.confirm} />
        <ErrorNote message={error} />
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Saving…' : 'Set password'}
        </button>
      </form>
      <p className="login-foot muted small">
        <a href="#/">Back to sign in</a>
      </p>
    </AuthLayout>
  );
}

function inviteSummary(preview: InvitationPreview): string {
  if (preview.role === 'manager') return `You are invited to help manage ${preview.eventName ?? 'an event'} on GatePass as an event manager.`;
  if (preview.role === 'platform_admin') return 'You are invited to administer this GatePass server as a platform admin.';
  return 'You are invited to create and run events on GatePass as an organizer.';
}

interface InviteProps {
  demo: boolean;
  token: string;
  user: AccountUser | null;
  onSignOut: () => Promise<void>;
  /** The invitation was accepted; `eventId` is set for event manager invitations. */
  onAccepted: (eventId: string | null) => Promise<void>;
}

/** `#/invite/<token>`: preview, then accept as the signed-in account, by signing in, or by creating the account. */
export function InvitePage({ demo, token, user, onSignOut, onAccepted }: InviteProps) {
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setLoadError('');
    api<InvitationPreview>('/api/invitations/preview', { body: { token }, timeoutMs: WAKE_TIMEOUT_MS })
      .then((value) => live && setPreview(value))
      .catch((err) => {
        if (!live) return;
        if (err instanceof ApiError && (err.status === 410 || err.status === 404))
          setLoadError('This invitation link is no longer valid. It may have expired, been revoked or already been used. Ask the person who invited you for a new link.');
        else setLoadError(errorMessage(err));
      });
    return () => {
      live = false;
    };
  }, [token, attempt]);

  async function accept(body: { name?: string; password?: string } = {}) {
    setBusy(true);
    setError('');
    try {
      const result = await api<{ user: AccountUser; eventId: string | null }>('/api/invitations/accept', { body: { token, ...body } });
      await onAccepted(result.eventId);
    } catch (err) {
      setError(authError(err));
      setBusy(false);
    }
  }

  if (!preview) {
    return (
      <AuthLayout title="Invitation" demo={demo}>
        {loadError ? (
          <>
            <ErrorNote message={loadError} />
            <div className="actions">
              <button type="button" className="btn btn-secondary" onClick={() => setAttempt((value) => value + 1)}>
                Try again
              </button>
              <a className="btn btn-ghost" href="#/">
                Go to sign in
              </a>
            </div>
          </>
        ) : (
          <p className="muted" role="status">
            Loading invitation…
          </p>
        )}
      </AuthLayout>
    );
  }

  const matches = user !== null && user.email.toLowerCase() === preview.email.toLowerCase();
  const intro = (
    <>
      <p>{inviteSummary(preview)}</p>
      <p>
        For <strong>{preview.email}</strong> · {INVITATION_ROLE_LABEL[preview.role]} · expires {new Date(preview.expiresAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}
      </p>
    </>
  );

  return (
    <AuthLayout title={preview.eventName ? `Join ${preview.eventName}` : 'Accept invitation'} intro={intro} demo={demo}>
      {matches ? (
        <div className="stack">
          <p className="small">You are signed in as {user.email}.</p>
          <ErrorNote message={error} />
          <button type="button" className="btn btn-primary btn-block" onClick={() => void accept()} disabled={busy}>
            {busy ? 'Accepting…' : 'Accept invitation'}
          </button>
        </div>
      ) : user && preview.accountExists ? (
        <div className="stack">
          <p className="notice">
            You are signed in as {user.email}, but this invitation is for {preview.email}. Sign out, then sign in as {preview.email} to accept.
          </p>
          <button type="button" className="btn btn-primary btn-block" onClick={() => void onSignOut()}>
            Sign out
          </button>
        </div>
      ) : preview.accountExists ? (
        <>
          <p className="small">Sign in as {preview.email} to accept.</p>
          <SignInForm fixedEmail={preview.email} submitLabel="Sign in and accept" onSignedIn={() => accept()} />
          <ErrorNote message={error} />
        </>
      ) : (
        <>
          {user ? <p className="notice">You are signed in as {user.email}. Creating the account for {preview.email} signs you out of that account in this browser.</p> : null}
          <CreateInvitedAccount email={preview.email} busy={busy} error={error} onSubmit={(name, password) => accept({ name, password })} />
        </>
      )}
    </AuthLayout>
  );
}

function CreateInvitedAccount({ email, busy, error, onSubmit }: { email: string; busy: boolean; error: string; onSubmit: (name: string, password: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const id = useId();
  const validate = () => {
    const errors: { name?: string; password?: string } = {};
    if (!name.trim()) errors.name = 'Enter your name.';
    if (password.length < MIN_PASSWORD) errors.password = `Use at least ${MIN_PASSWORD} characters.`;
    return errors;
  };
  const errors = showErrors ? validate() : {};

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (Object.keys(validate()).length) {
      setShowErrors(true);
      focusFirstInvalid(e.currentTarget);
      return;
    }
    void onSubmit(name.trim(), password);
  }

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <label>
        Email
        <input type="email" autoComplete="username" value={email} readOnly />
      </label>
      <label>
        Your name
        <input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required aria-invalid={errors.name ? true : undefined} aria-describedby={`${id}-name`} />
        <FieldError id={`${id}-name`} message={errors.name} />
      </label>
      <PasswordField label="Choose a password" value={password} onChange={setPassword} autoComplete="new-password" error={errors.password} hint={`At least ${MIN_PASSWORD} characters.`} />
      <ErrorNote message={error} />
      <button className="btn btn-primary btn-block" disabled={busy}>
        {busy ? 'Creating account…' : 'Create account and accept'}
      </button>
    </form>
  );
}
