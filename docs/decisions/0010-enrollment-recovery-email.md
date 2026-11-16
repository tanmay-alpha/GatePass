# 0010 — One-time scanner enrollment, account recovery and optional email

Status: accepted (branch `feat/production-readiness`, schema version 4). Supersedes the parts of ADR 0002 and ADR 0008 that describe scanner setup links carrying the key and reset links always being handed to an administrator.

## Context

Three residual risks were open in the engineering audit:

- **SEC-08.** The scanner setup link carried the permanent device key (`/scan#key=gps_…`). The link is shared by chat, shown on screens and photographed; whoever saw it held the device credential for as long as the scanner existed.
- **SR-02.** Without email, a platform administrator created a password-reset link for an organizer and received it. They could use it themselves and sign in as that organizer, which gives access to the organizer's events and attendee data.
- **SR-06.** Accepting a manager invitation created a full organizer account even when self-registration was closed, so any event owner could mint accounts able to create events.

No email provider was configured, so every invitation and reset link was copied by hand.

## Decision

### Scanner enrollment

Creating or rotating a scanner no longer returns a key. It returns a **one-time setup link** `/scan#enroll=<code>`:

- The code is 32 random bytes; only its SHA-256 is stored in `scanner_enrollments` with the creator, creation time, expiry (1 hour), `used_at` and `invalidated_at`.
- `POST /api/scanner/enroll { code }` claims it inside one `BEGIN IMMEDIATE` transaction: the row must be unused, not invalidated, unexpired and its scanner unrevoked. The transaction marks it used, mints the `gps_…` key, stores `sha256(key)` and `enrolled_at`, and audits `scanner.enrolled` with actor `scanner:<id>`. The key is returned exactly once to the device.
- Only the newest link of a device works: creating a new one invalidates earlier unused links. Revoking a scanner invalidates its unused links; a trigger refuses new links for revoked scanners.
- Until a device enrolls, the scanner row holds the hash of a random placeholder nobody knows, so it cannot authenticate.
- Rotation replaces the key hash with a placeholder at once (the old key stops) and returns a new setup link.
- `key_issued_by` stays the account that created the link, so removing that person from the team still revokes the key (SR-03).
- The endpoint is unauthenticated by design (the code is the credential). Bad codes count as failed authentication in the per-IP failure throttle; the route allows 60 requests a minute per address.
- Keys issued before migration 4, and their old `#key=` links, keep working until rotated (`setup: 'legacy'`).

The device still keeps its key in `localStorage` so a door phone survives a reload; CSP `script-src 'self'` and rotation/revocation remain the defences for that.

### Account recovery

- **Self-service** (`POST /api/auth/forgot`): when email is configured, an active account gets a one-time reset link at its own address. The response is `202` with the same body for every address and is sent before the lookup and the email, so the body reveals nothing and the response time is the same. (A weak statistical signal remains: the write for a real account briefly occupies the single thread after the response.) The general 20/min per-IP limit applies.
- **Administrator-started** (`POST /api/platform/users/:id/reset-link`):
  - With email configured, the link is emailed to the account's address and **not** returned. A platform administrator cannot request the link itself; only the operator (break-glass token) can, with a reason.
  - Without email, the link is returned to the caller only with a written reason of at least 10 characters. The reason is stored in the audit entry `user.password_reset_created`.
- A link that the provider did not accept is cancelled immediately.
- **Notice.** `GET /api/auth/session` and sign-in return `securityNotice` while `users.password_set_by` names someone other than the owner (the creator of the reset link that set the current password). Changing the password does not clear it — otherwise whoever holds an administrator-set password could hide it; only an explicit acknowledgement (`POST /api/auth/security-notice/acknowledge`, audited as `user.security_notice_acknowledged`) or the owner's own emailed reset does. With email configured, using a link that someone else created also sends a notification to the owner's address. Limit: inside the product nothing distinguishes the owner from an administrator who used the link; the audit log and the owner's mailbox are the independent records.
- **Self-service links do not cancel each other** (anyone who knows an address could otherwise keep cancelling the owner's link); using one cancels the rest. Limits: 3 per address and requester per hour, 10 per address per hour.
- **Disabling an account** cancels reset links for it and reset links it created for others, pending invitations it created or last renewed (`invitations.issued_by`), and unused scanner setup links it created.
- **Invitations.** Inviting an address that already has a pending invitation for the same event renews that invitation (new link, old one dead) instead of adding a row. Invitation creation and renewal are limited to 30 a minute per IP and, when email is configured, 5 emails per recipient per hour. The email subject is fixed; the organizer-chosen event name appears only in the body.
- Unchanged: only the operator can reset a platform administrator; only the newest administrator-created link works; a password change cancels open links; using a link ends every session.

### Closed sign-up

`users.can_create_events` (default 1). While `ALLOW_SIGNUP=false`, an account created by accepting a **manager** invitation gets 0: it can work on the events it is invited to but `POST /api/events` and clone answer 403. Platform administrators grant or withdraw the right (audited). Organizer invitations from a platform administrator are unchanged.

### Email

Optional, through the Resend HTTP API (`RESEND_API_KEY`, `MAIL_FROM`; `src/server/mailer.ts`):

- Used for organizer, platform-admin and manager invitations, password resets, and the notification to the owner when a reset link someone else created is used.
- `sent` means the provider accepted the message and returned an id; the UI says "handed to the email provider … delivery is not confirmed", never "delivered".
- When the provider accepts an invitation email, the link is not returned to the inviter. When it refuses or email is off, the link is returned once for manual sharing.
- No automatic retries: a timeout is ambiguous. Re-sending is a user action ("New link") that rotates the token, so at most the newest link works. Each send carries an idempotency key derived from the token hash.
- 10-second timeout. Logs contain the provider name, status and reason; never the recipient, the link or the API key. The audit log records `email.sent` (provider id) and `email.failed` (reason).
- Attendee pass delivery by email is **not** implemented: a 2,000-row import cannot be sent inside one request within provider rate limits, so it needs a durable outbox and worker (TODO MAIL-02).

## Consequences

- A leaked or photographed setup link is useless after first use or one hour. If two people open it, one wins and the other is told to ask for a new link; the organizer sees "Waiting for device", "Setup link expired" or "Active" per device.
- If the enrollment response is lost in transit, the code is spent and the device has no key: the organizer creates a new link. This is deliberate (fail closed); the UI says so.
- The API contract changed: `POST /api/events/:id/scanners` and `POST /api/scanners/:id/rotate` return `{ scanner, enrollment }` instead of `{ scanner, key }`. Scripts must call `/api/scanner/enroll`. Frontend and backend must therefore be released together; `scripts/release-check.ts` verifies both run the same commit.
- Rolling back across migration 4 uses the `.pre-v4.bak` backup with the old build's `restore` (rehearsed with `scripts/rollback-rehearsal.sh`). Devices enrolled after the migration must be set up again after such a rollback.
- Without email, an administrator with a stated reason can still take over an organizer account. This is attributable in the audit log and leaves a notice on the account, but is not prevented. Configuring email removes the path for platform administrators.
- Accounts that existed before migration 4 keep the right to create events (the column defaults to 1), including accounts created from manager invitations while sign-up was closed. To review them: `SELECT u.email FROM users u JOIN invitations i ON i.accepted_by = u.id WHERE i.role = 'manager' AND u.can_create_events = 1;` then withdraw the right in Platform → Accounts where it is not wanted.
- A phone that is already a scanner asks for confirmation before a newly opened setup link replaces its setup, so a stray or hostile link cannot silently re-point a door device at another event.
- Live email delivery has not been verified: no provider key or verified sending domain was available. The adapter is tested against a fake provider and a mocked HTTP endpoint (`tests/account-recovery.test.ts`).

## Alternatives

- **Keep permanent keys in links, rely on rotation.** Rejected: rotation only helps after someone notices a leak.
- **Short-lived device keys with refresh.** More moving parts on a device that must keep working through a bad network at the door; a revocable long-lived key obtained through a one-time code gives the same exposure reduction for the link without adding a failure mode during scanning.
- **Security questions or administrator identity checks in the product.** Out of scope; email to the address on the account is the independent channel.
- **Remove the administrator reset without email.** Rejected: a deployment without email would have no recovery path except the operator editing the database.
- **SMTP instead of an HTTP provider.** Would add a dependency and connection handling; the HTTP API needs none. The `Mailer` interface leaves room for another adapter.
