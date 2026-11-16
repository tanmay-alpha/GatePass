# Security policy

## Reporting a vulnerability

Report vulnerabilities privately using this repository's GitHub private vulnerability reporting ("Report a vulnerability" on the Security tab). If that is unavailable, contact the maintainer privately before you disclose any details. Do not put exploit details, secrets, pass links, scanner keys or personal data in public issues.

Please include the affected route or file, steps to reproduce, and the impact. Only the latest commit on the default branch is supported.

## Threat model summary

GatePass runs as a single instance. Organizers sign in with individual accounts and work on events through event roles (owner, manager); platform admins manage accounts; an operator break-glass token exists for API-only recovery. The full threat model, with the role matrix, mitigations, tests, the security review findings and outstanding risks, is in [docs/security-and-threat-model.md](docs/security-and-threat-model.md); the README lists the [known limitations](README.md#known-limitations). In short:

| Asset | Protection |
| --- | --- |
| Pass tokens | 256-bit random; only SHA-256 stored; shown once at issue/reissue; reissue rotates the token. |
| Single-use entry and capacity | Redemption inside a `BEGIN IMMEDIATE` transaction plus a primary key on `redemptions.pass_id` and a capacity `CHECK`; checked under concurrent HTTP requests, a second connection, and worker threads with separate connections. |
| Admin API | Individual accounts: scrypt password hashes; session cookie `__Host-gatepass_session` (HttpOnly, Secure, SameSite=Strict), stored only as a SHA-256 hash; CSRF header required on cookie writes. Every event route checks the caller's event role on the server (non-members get 404). `ADMIN_TOKEN` (at least 24 chars, compared in constant time) is an API-only break-glass operator credential, audited as `operator`; the server will not start without it. |
| Scanner API | Per-device `gps_` keys, stored as SHA-256 hashes, scoped to one event, individually revocable and rotatable. A device gets its key by claiming a **one-time setup link** (`/scan#enroll=<code>`, 256-bit, stored as a hash, single use, expires after 1 hour, only the newest link of a device works); the permanent key never appears in a link, chat or screen. Keys handed out before migration 4 keep working until rotated. |
| Account recovery | With email configured (`RESEND_API_KEY`, `MAIL_FROM`): self-service "forgot password" and administrator-started resets email a one-time link to the account's own address only; a platform administrator never sees it, and the owner's mailbox is notified whenever a link someone else created is used. Without email: an administrator gets the link only after giving a written reason, which is audited; the account then shows a notice at sign-in that a password change cannot hide (only an audited acknowledgement clears it). Platform admins can only be reset by the operator. Disabling an account cancels the reset links, invitations and scanner setup links it still holds. |
| Attendee privacy across events | A pass scanned at another event is reported as `invalid`, with no details. |
| Server internals | Generic 500 responses; zod validation with 400 responses; strict CSP; `no-store` on API and pass page responses. |
| Abuse | Per IP: 600/min on `/api` except scanner routes, 60/min pass page, 120/min QR render, 20/min sign-in/registration/reset routes, 30/min invitation create/renew, 60/min scanner enrollment. Per scanner device: 60/min session, 240/min redeem. Per account: 10 failed sign-ins in 15 minutes lock it. Email: 3 self-service reset emails per address and requester per hour (10 per address overall), 5 invitation emails per recipient per hour; re-inviting an address renews its pending invitation. Failed authentication (including bad setup codes): after 60 failures per IP in 5 minutes, further invalid attempts get 429; valid credentials are not blocked. |
| Logs | One JSON line per request with the route pattern (`/p/:token`), status, duration and a request id that is also sent as `X-Request-Id`; raw paths, bodies, headers, tokens, keys and email recipients are never logged by the application. |

Known gaps, by design:

- `ADMIN_TOKEN` grants the operator full API access to every event. It is meant for break-glass use only and is not offered in the UI.
- Without email, a platform admin who gives a reason can obtain a reset link for an organizer account and so take it over. It is audited with the reason and leaves a notice on the account, but nothing in the product can tell the real owner from the administrator holding the new password; the audit log is the independent record. With email configured, only the operator can take a link directly and the owner's mailbox is notified when it is used.
- Rate limits are kept in process memory. They reset on restart and are not shared across processes. Add proxy-level limits for anything larger.
- Anyone with a pass link can see the event and the attendee name on `/p/<token>`.
- A scanner key stays valid on its device (in `localStorage`) until it is rotated or revoked; a strict CSP (`script-src 'self'`) is the defence against script access to it.
- Hosting platforms (Vercel, Render) may record full request paths, including `/p/<token>`, in their own logs.
- `/api/qr/custom` requires a signed-in account or the operator token (it was public in earlier versions) and is rate-limited.
- The application does not enforce HTTPS. Terminate TLS at a reverse proxy, or set `HTTPS_CERT_FILE`/`HTTPS_KEY_FILE`.

## Operator responsibilities

- Generate `ADMIN_TOKEN` randomly. Keep it in the runtime environment or an ignored `.env` file, never in source control, and use it only for break-glass operations. To rotate it, change the variable, restart, and confirm the new value works once the new deploy is live.
- Serve GatePass over HTTPS and set `APP_PUBLIC_URL` to that HTTPS origin. Set `TRUST_PROXY` to match your proxy so rate limits see real client IPs.
- Store the database directory on a private persistent volume and back it up. It contains attendee names and emails.
- Revoke the scanner key of any lost door device. Hand out scanner setup links only to the device that will scan; an unused link expires after an hour.
- When email is configured, keep `RESEND_API_KEY` in the runtime environment only and send from a domain you control.
- Run `npm audit` when updating dependencies.

Deployment specifics are in [docs/deployment.md](docs/deployment.md). Tests and the dependency audit are not a full security assessment.
