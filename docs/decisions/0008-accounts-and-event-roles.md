# 0008 — Accounts with cookie sessions and per-event roles

Status: accepted

## Context

Until this branch every organiser action used one global `ADMIN_TOKEN` bearer token: whoever held it could see and change every event, and the audit log could not say which person did what. A second organiser or a day-of manager could only be given the whole token. GatePass needs named accounts, more than one person per event with different powers, and a way to remove one person without rotating a secret everybody shares. There is no email provider, and the operator should not have to run a second service (ADR 0001).

## Decision

**Accounts** (`src/server/accounts.ts`):

- Passwords are hashed with scrypt, N = 2^15, r = 8, p = 3, 32-byte key, 16-byte random salt (the OWASP Password Storage Cheat Sheet scrypt parameters). The stored string is `scrypt$N$r$p$salt$hash`, so the parameters can be raised later without invalidating existing hashes. Passwords are 10–128 characters, NFKC-normalised, and a small list of common passwords is refused.
- Sign-in answers the same for an unknown email, a wrong password and a disabled account; an unknown email is checked against a dummy hash so the timing matches. Failures are throttled per IP and per account (`FailureThrottle` in `src/server/app.ts`), and a locked account is refused before its password is checked.
- Self-registration is off unless `ALLOW_SIGNUP=true`. Otherwise accounts come from invitations.

**Sessions** (`src/server/app.ts`, `accounts.ts`):

- The session id is 32 random bytes; only its SHA-256 is stored (`sessions.id_hash`). A new id is issued on sign-in, registration, invitation acceptance and password change.
- Cookie: `__Host-gatepass_session`, `HttpOnly; Secure; SameSite=Strict; Path=/`, no `Domain`, when `APP_PUBLIC_URL` is HTTPS (plain `gatepass_session` without `Secure` over HTTP in local development).
- Lifetime: 7 days absolute (`SESSION_ABSOLUTE_MS`), ended after 24 hours without use (`SESSION_IDLE_MS`). Sign-out revokes the row. A password change ends every other session; a password reset or disabling the account ends all of them.

**CSRF.** On `/api`, every unsafe request that carries the session cookie, and every request to the session-issuing `/api/auth/*` and `/api/invitations/*` routes, must send `X-GatePass-CSRF: 1`. A request with `Sec-Fetch-Site: cross-site` is refused even with the header. Cross-site forms cannot set a custom header, and a cross-site `fetch` that sets one needs a CORS preflight the server never approves. Bearer requests (scanner devices, operator) carry no ambient credential and are exempt.

**Event roles** (`src/server/permissions.ts`). Membership is a row in `event_members`, with exactly one owner per event (partial unique index).

| Role | Permissions |
| --- | --- |
| owner | `view`, `edit`, `lifecycle`, `team`, `access`, `passes`, `scanners`, `audit`, `export` |
| manager | `view`, `edit`, `access`, `passes`, `scanners`, `audit` |

A manager runs the event day to day but cannot change its lifecycle or team or export attendee data. Door staff are not accounts; they use scanner devices.

`GatePass.authorize` (`src/server/gatepass.ts`) resolves the caller's role on the event named by the route. A caller who is not on the event's team gets **404**, the same answer as for an event that does not exist, so event ids cannot be probed. A member whose role lacks the permission gets **403**.

**Platform administrators** (`users.platform_role = 'platform_admin'`) manage accounts: invite organisers and administrators, disable and enable accounts, issue password reset links. They see no event data unless they are on that event's team, and then only with that team role's permissions. Residual risk (finding R2 of the static security review; item 8 under "Outstanding threats and accepted risks" in [security-and-threat-model.md](../security-and-threat-model.md)): a platform administrator can issue a reset link for an organiser and sign in as them. Mitigations: resetting a platform administrator needs the operator; creation and use of the link are audited (use records `requestedBy`); the reset ends the organiser's sessions; a password change cancels open reset links. The owner accepted this residual.

**Operator** (break glass). The `ADMIN_TOKEN` bearer token is still accepted, on the API only. It is never offered in the UI, has no account, password or session, and every action is audited as `operator`. It is the only way to reset a platform administrator.

**Invitations and resets** are one-time links, shown once to the person who created them, because no email provider is configured. Each token is 32 random bytes and only its SHA-256 is stored. Use is claimed with a conditional `UPDATE … WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?` (resets: `used_at IS NULL`) inside the transaction, so two concurrent uses cannot both succeed. Invitations last 7 days; reset links last 1 hour and only the newest one per account works. The invitation token travels in the URL fragment and is sent to the server in a request body (`POST /api/invitations/preview`), not in a path.

**Scanner keys** stay bearer device credentials (ADR 0002), not accounts. They are created, rotated (`POST /api/scanners/:id/rotate`) and revoked by members with the `scanners` permission; each key records who issued it (`scanners.key_issued_by`). Removing a person from an event's team revokes, in the same transaction, the keys they issued for that event. Disabling an account revokes the pending invitations it created and cancels its open reset links.

## Consequences

- Each audit row names a person (`user:<id>`) or `operator`; platform actions are audited with `event_id` NULL.
- One person can be removed from one event, or locked out everywhere, without rotating a shared secret.
- scrypt with these parameters needs 32 MiB of memory per hash (`maxmem` is 64 MiB). Concurrent sign-ins cost memory and CPU on a small host; the throttles bound how many failures one client can cause.
- Sessions are server-side rows, so revocation takes effect on the next request. Session state lives in the same SQLite file and is lost with it on a non-durable host (ADR 0009).
- Login throttles are in process memory: a restart clears them, and a known account can be kept locked by an attacker (documented trade-off in `app.ts`).
- Without email, an invitation or reset link must be passed on by hand, and anyone who obtains it before it is used can use it. There is no email verification, MFA or breached-password check ([security-and-threat-model.md](../security-and-threat-model.md)).
- Tests: `tests/accounts-api.test.ts`; browser coverage in `e2e/accounts.spec.ts` (owner invites a manager; manager can issue passes but has no team controls or exports). Results: [testing.md](../testing.md).

## Alternatives

- **Extend the global token with scopes** (several admin tokens, each limited to events or actions). Still shared bearer secrets with no person behind them: no per-person audit, no password recovery, and every token has to be distributed and stored by hand. Removing one person means rotating whatever token they knew. A bearer token used by the browser UI also has to be kept where page scripts can read it; an `HttpOnly` cookie cannot be read by script.
- **JWTs as session tokens.** A signed token cannot be revoked before it expires without a server-side denylist, and sign-out, password change, disabling an account and removal from a team all need immediate revocation. With a denylist the server does a lookup on every request anyway, which is what the session row already is. A JWT also adds a signing key to manage and rotate.
- **Third-party authentication provider (Clerk, Auth0).** Would bring email delivery, MFA and social sign-in. Not now: it adds an external service, account and secret to a deployment that is meant to be one process with no paid dependencies (ADR 0007); the live demo would depend on that service's availability and free-tier terms; and event membership and roles would still have to live in GatePass's own database. Reconsider if email-based recovery or MFA becomes a requirement.
