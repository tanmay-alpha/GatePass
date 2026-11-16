# 0012 — Attendee pass email: sealed outbox, rate-limited worker, bounded shutdown

Status: accepted (branch `feat/phase4-features`, schema version 5). Supersedes the line of ADR 0010 that says attendee pass delivery by email is not implemented (TODO MAIL-02).

## Context

Organizers wanted to email each attendee their pass link from "Issue passes" and "Import CSV". Three constraints shaped the design:

- **Passes store only token hashes** (ADR 0002). The link an email needs exists in clear only in the issuing request's memory.
- **Provider limits.** Resend accepts about 2 requests a second on a default account. A 2,000-row import cannot be sent inside one HTTP request, and no network call may run inside a database transaction (single writer, ADR 0001/0003).
- **Ambiguous answers.** A timeout or a crash after the request left does not tell whether the provider accepted the message. Retrying must not send twice and must not issue a second pass.

## Decision

### Outbox

`pass_deliveries` (migration 5) holds one row per requested email. Issuing or importing with `emailPasses: true` inserts the rows **inside the issuance transaction**, after the passes, so passes and their emails commit together or not at all. The route returns as soon as the transaction commits; nothing is sent in the request.

- **Sealed link.** The raw pass URL is encrypted with AES-256-GCM (`src/server/deliveries.ts`, `LinkSealer`): random 96-bit IV per link, 128-bit tag, layout `version ‖ IV ‖ tag ‖ ciphertext`. The additional authenticated data is `gatepass:pass-delivery:v1:<deliveryId>:<passId>`, so a sealed link copied into another row does not open.
- **Erasure.** `sealed_link` is set to NULL in the same statement that moves a row to `accepted`, `failed` or `cancelled`; a CHECK constraint refuses a final row that still holds one. Queued emails whose link can no longer work (pass used, revoked, reissued since, or expired: `link_expires_at` is the pass expiry) are cancelled and erased by the worker's sweep (every 30 s and when a row is claimed).
- **Stale tokens.** Each row stores the token hash it carries. When the pass's current hash differs (reissued), the email is cancelled instead of sending a dead link.
- **One open email per pass** (partial unique index). Queuing again while one waits is refused (`already_queued`).
- **Without `PASS_DELIVERY_KEY`** the request is refused with 409 and nothing is issued: links are never stored in clear. `/api/health` reports `passEmail` so the UI disables the checkbox and says what the operator must set. (An ephemeral per-process key was rejected: a restart would turn every waiting email into a failure that needs a reissue, which is worse than refusing up front.)
- **Abuse limit.** One address receives at most 10 pass emails per 24 hours across the deployment. Over the limit, issuance with email is refused as a whole (429: "Issue without email") rather than issuing passes whose email silently never comes; the per-pass and bulk endpoints skip the address (`recipient_limit`). The POST delivery routes are limited to 60 requests a minute per IP.

### Worker

`DeliveryWorker` runs in the server process (started in `index.ts` when a mail provider and the key are configured):

1. Waits for the rate-limit gap (`PASS_EMAIL_PER_SECOND`, default 2; one request in flight at a time).
2. **Claims** the next due row in a short `BEGIN IMMEDIATE` transaction: `queued → sending`, `attempts + 1`, link unsealed and checked against the stored hash.
3. Sends through `Mailer.attempt` with `Idempotency-Key = delivery id`, outside any transaction.
4. **Records** the answer in a second short transaction:
   - accepted → `accepted`, provider id, link erased, audit `pass.email_accepted`;
   - refused (4xx other than 401/403/429) → `failed`, link erased, audit `pass.email_failed`;
   - ambiguous (timeout, network error, 5xx, 401/403, concurrent idempotent request) → back to `queued` with exponential backoff (30 s, 1 min, 2 min … capped at 1 h) and the **same id**, until `PASS_EMAIL_MAX_ATTEMPTS` (default 8) → `failed`;
   - rate limited (429) → back to `queued` after `Retry-After`, not counted as an attempt.
5. **Crash recovery.** On start, rows left in `sending` go back to `queued` with their id. Resend de-duplicates a repeated idempotency key for 24 hours, so a message the provider had already accepted is not sent again.

"Accepted by provider" is the strongest status the product shows. It never says "delivered".

### Organizer actions (all scoped to the authorized event; other events' ids answer 404 or `not_found`)

| Route | Permission | Effect |
| --- | --- | --- |
| `GET /api/events/:eventId/deliveries` | view | Newest first, per-status counts (`failed` excludes failed emails sent again since; `retrying`), paging, status filter. Never returns the sealed link. |
| `POST /api/events/:eventId/deliveries` `{ passes: [{ passId, token? }], reissue? }` | passes | Email existing passes. With `token` (passes still on screen after issuing) the current link is sent; otherwise `reissue: true` is required. |
| `POST /api/events/:eventId/passes/:passId/deliveries` `{ token? \| reissue? }` | passes | Same for one pass, with errors instead of a skip list. |
| `POST /api/events/:eventId/deliveries/retry` `{ deliveryIds, reissue? }` | passes | Waiting emails become due now (same link, same idempotency key). Final ones hold no link any more: they are sent again only with `reissue`, which replaces the pass link (audit `pass.reissued` with `via: 'email'`). Emails already replaced by a later one are skipped (`superseded`). |
| `POST /api/events/:eventId/deliveries/cancel` `{ deliveryIds }` | passes | Cancels waiting emails and erases their links; one being sent right now cannot be cancelled. |

Audit: `pass.email_queued` (one entry per request with the pass ids), `pass.email_retried`, `pass.email_accepted`, `pass.email_failed`, `pass.email_cancelled` (entity = pass id; details carry the delivery id, attempts, provider id or error). Recipient addresses, tokens and links are never written to the audit log or to logs; log lines name the delivery id only.

### Shutdown (audit PR-R3)

`src/server/shutdown.ts`: on SIGTERM/SIGINT the server stops accepting connections, the worker stops claiming and the email in flight is answered and recorded, background work started by requests (`Accounts.runInBackground`, e.g. reset emails) finishes, then the database closes (WAL checkpointed) and the process exits 0. Bounds: keep-alive connections are cut at 5 s; provider requests still open at 7 s are cancelled and recorded as interrupted (queued again, same idempotency key); at 10 s the database is closed and the process exits 1 whatever still runs. An email abandoned in `sending` by that deadline or by a crash is re-queued on the next start.

## Key management (`PASS_DELIVERY_KEY`)

- **Where it lives.** An environment variable of the server process (Render/host secret store, `.env` locally), 32 random bytes in base64: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. It is never written to the database, logs or backups. Store it apart from database backups: a backup together with the key exposes the links of emails that were still waiting when the backup was taken (at most minutes to hours of data; sent and failed rows hold no link).
- **What it protects.** Only links of emails not yet handed to the provider. A copy of the database without the key reveals no usable pass link.
- **Rotation.** Let the outbox drain (Pass emails shows 0 waiting), set the new key, restart. Emails still waiting under the old key fail with "could not be decrypted … Send a new link"; the organizer uses "Send again", which reissues those passes. There is no key ring: links live minutes, so a second decryption key would add configuration without a real benefit.
- **Deletion / incident response.** Removing the key turns pass email off (`passEmail: false`, issuing with email answers 409) and makes any stored sealed links unreadable (crypto-shredding). If the key leaks together with a database copy, reissue the affected passes; their old links stop working at once.

## Consequences

- Organizers see per-pass status within seconds; a 2,000-row import takes about 17 minutes at 2 a second. Raising `PASS_EMAIL_PER_SECOND` only helps up to one request in flight (provider latency bounds throughput).
- Retrying a failed email needs a new link. This is deliberate: keeping links after a final state would mean keeping decryptable credentials indefinitely. The UI explains that the current QR code stops working before it reissues.
- "Email these passes" on the just-issued card sends the links still on screen without a reissue; once that card is closed, only reissue can email a pass.
- The SIGTERM scenarios run on Linux only (`tests/shutdown.test.ts`): Node delivers SIGTERM to a Windows child as TerminateProcess. The drain itself (`gracefulShutdown`) and SIGKILL recovery are tested on every platform.
- Live delivery through Resend is still unverified (no key or verified domain); the adapter is tested against a fake provider over real HTTP.

## Alternatives

- **Send inside the request.** Rejected: provider limits and timeouts would make large imports fail halfway with no record of what was sent.
- **Store the raw token for the outbox.** Rejected: breaks ADR 0002 (a database copy would contain working credentials).
- **Reissue at send time instead of sealing.** The worker would rotate the token when it sends, so nothing secret waits in the database. Rejected: the organizer's links, CSV and printed passes from the issuance would stop working as soon as the email goes out.
- **External queue (Redis, SQS).** Adds infrastructure to a single-process SQLite deployment for a few messages a second.
