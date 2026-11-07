# Security policy

## Reporting a vulnerability

Report vulnerabilities privately using this repository's GitHub private vulnerability reporting ("Report a vulnerability" on the Security tab). If that is unavailable, contact the maintainer privately before you disclose any details. Do not put exploit details, secrets, pass links, scanner keys or personal data in public issues.

Please include the affected route or file, steps to reproduce, and the impact. Only the latest commit on the default branch is supported.

## Threat model summary

GatePass is meant for one organiser (or one trusted team sharing a token) running a single instance. The full model is in [README.md#security-model](README.md#security-model). In short:

| Asset | Protection |
| --- | --- |
| Pass tokens | 256-bit random; only SHA-256 stored; shown once at issue/reissue; reissue rotates the token. |
| Single-use entry | Redemption inside a `BEGIN IMMEDIATE` transaction plus a primary key on `redemptions.pass_id`; checked under concurrent HTTP requests, a second connection, and 8 worker threads. |
| Admin API | Mandatory `ADMIN_TOKEN` (at least 24 chars) bearer auth, compared in constant time; the server will not start without it. |
| Scanner API | Per-device `gps_` keys, stored as SHA-256 hashes, scoped to one event, individually revocable. |
| Attendee privacy across events | A pass scanned at another event is reported as `invalid`, with no details. |
| Server internals | Generic 500 responses; zod validation with 400 responses; strict CSP; `no-store` on API and pass page responses. |
| Abuse | Per-IP rate limits: 600/min API, 240/min redeem, 60/min pass page, 120/min QR render. |

Known gaps, by design:

- `ADMIN_TOKEN` is one shared secret. There are no user accounts, no roles, and no per-person audit identity.
- Rate limits are kept in process memory. They reset on restart and are not shared across processes. Add proxy-level limits for anything larger.
- Anyone with a pass link can see the event and the attendee name on `/p/<token>`.
- A scanner key stays valid on its device until it is revoked.
- `/api/qr/custom` requires the admin token (it was public in earlier versions) and is rate-limited.
- The application does not enforce HTTPS. Terminate TLS at a reverse proxy, or set `HTTPS_CERT_FILE`/`HTTPS_KEY_FILE`.

## Operator responsibilities

- Generate `ADMIN_TOKEN` randomly. Keep it in the runtime environment or an ignored `.env` file, never in source control. To rotate it, change the variable and restart.
- Serve GatePass over HTTPS and set `APP_PUBLIC_URL` to that HTTPS origin. Set `TRUST_PROXY` to match your proxy so rate limits see real client IPs.
- Store the database directory on a private persistent volume and back it up. It contains attendee names and emails.
- Revoke the scanner key of any lost door device.
- Run `npm audit` when updating dependencies.

Deployment specifics are in [docs/deployment.md](docs/deployment.md). Tests and the dependency audit are not a full security assessment.
