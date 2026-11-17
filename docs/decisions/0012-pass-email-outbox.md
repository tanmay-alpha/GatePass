# 0012 — Attendee pass email: sealed outbox, rate-limited worker, bounded shutdown

Status: accepted (branch `feat/phase4-features`, schema version 5; revised in phase 5, schema version 6: ambiguous attempts, key ring, fair scheduling). Supersedes the line of ADR 0010 that says attendee pass delivery by email is not implemented (TODO MAIL-02).

## Context

Organizers wanted to email each attendee their pass link from "Issue passes" and "Import CSV". Three constraints shaped the design:

- **Passes store only token hashes** (ADR 0002). The link an email needs exists in clear only in the issuing request's memory.
- **Provider limits.** Resend rate-limits requests (documented default: 10 a second per team; the outbox sends 2 a second by default) and its free plan has a daily quota. A 2,000-row import cannot be sent inside one HTTP request, and no network call may run inside a database transaction (single writer, ADR 0001/0003).
- **Ambiguous answers.** A timeout, a server error or a crash after the request left does not tell whether the provider accepted the message. Retrying must not issue a second pass, and should not send a second email.

## Decision

### Outbox

`pass_deliveries` (migration 5, rebuilt by migration 6) holds one row per requested email. Issuing or importing with `emailPasses: true` inserts the rows **inside the issuance transaction**, after the passes, so passes and their emails commit together or not at all. The route returns as soon as the transaction commits; nothing is sent in the request.

- **Sealed link.** The raw pass URL is encrypted with AES-256-GCM (`src/server/deliveries.ts`, `LinkSealer`): random 96-bit IV per link, 128-bit tag. Seal version 2 (schema 6) is `version (2) ‖ key id (8) ‖ IV (12) ‖ tag (16) ‖ ciphertext`; the key id is the first 8 bytes of SHA-256 over `gatepass:pass-delivery-key-id\0` and the key, and the additional authenticated data is `gatepass:pass-delivery:v2:<key id hex>:<deliveryId>:<passId>`, so a sealed link copied into another row, relabelled with another key id or altered anywhere does not open. Version 1 (schema 5: `version ‖ IV ‖ tag ‖ ciphertext`, AAD `gatepass:pass-delivery:v1:<deliveryId>:<passId>`) is still opened, with the active key and then each previous key.
- **Erasure.** `sealed_link` is set to NULL in the same statement that moves a row to `accepted`, `failed`, `cancelled` or `unconfirmed`; a CHECK constraint refuses a final row that still holds one. Queued emails whose link can no longer work (pass used, revoked, reissued since, or expired: `link_expires_at` is the pass expiry) are cancelled and erased by the worker's sweep (every 30 s and when a row is claimed).
- **Stale tokens.** Each row stores the token hash it carries. When the pass's current hash differs (reissued), the email is cancelled instead of sending a dead link.
- **One open email per pass** (partial unique index). Queuing again while one waits is refused (`already_queued`).
- **Without `PASS_DELIVERY_KEY`** the request is refused with 409 and nothing is issued: links are never stored in clear. `/api/health` reports `passEmail` so the UI disables the checkbox and says what the operator must set. (An ephemeral per-process key was rejected: a restart would turn every waiting email into a failure that needs a reissue, which is worse than refusing up front.)
- **Abuse limit.** One address receives at most 10 pass emails per 24 hours across the deployment (compared case-insensitively for ASCII letters, as SQLite's `lower()` does). Over the limit, issuance with email is refused as a whole (429: "Issue without email") rather than issuing passes whose email silently never comes; the per-pass and bulk endpoints skip the address (`recipient_limit`). The POST delivery routes are limited to 60 requests a minute per IP.

### Worker

`DeliveryWorker` runs in the server process (created by `deliveryWorkerFor` in `index.ts` when a mail provider and the key are configured):

1. **Start.** Rows left in `sending` by a crash go back to `queued` (see "Crash recovery"); then every waiting link not sealed under the active key is re-sealed under it in one transaction (see "Key management"). Both log counts only.
2. Waits for the rate-limit gap (`PASS_EMAIL_PER_SECOND`, default 2; one request in flight at a time).
3. **Claims** the next due row in a short `BEGIN IMMEDIATE` transaction: `queued → sending`, `attempts + 1`, `last_attempt_at = now`, link unsealed and checked against the stored hash. **Events take turns** (TODO MAIL-03): among the events with a due email, the one served longest ago goes first (never served = first; ties by earliest due), then that event's next email in queue order. A 2,000-email import no longer delays another event's first email by 17 minutes: a newly queued event goes next, and events with due emails then alternate, within the one global rate. The order is kept in memory and resets on restart, which only changes who goes first.
4. Sends through `Mailer.attempt` with `Idempotency-Key = delivery id`, outside any transaction.
5. **Records** the answer in a second short transaction. Every answer that is not "accepted" is either **ambiguous** (the provider may have accepted the message) or **definite** (this request sent nothing):

   | Answer | Kind | Next |
   | --- | --- | --- |
   | 2xx with a message id | — | `accepted`, provider id, link erased, audit `pass.email_accepted` |
   | timeout, network error, cancelled by shutdown, 5xx, 2xx without a readable id, an exception in the adapter, `send()` failure of a mailer without `attempt()` | ambiguous | `queued` with exponential backoff (30 s, 1 min, 2 min … capped at 1 h) and the **same id**; `uncertain_since` is set to this attempt's start unless already set |
   | 401/403 (credentials, sending domain), 409 `concurrent_idempotent_requests` | definite | `queued` with backoff and the same id |
   | 429 (rate limit, daily or monthly quota) | definite | `queued`, not counted as an attempt; the whole worker pauses for `Retry-After` or 1 s, 2 s, 4 s … up to 10 minutes while 429s follow each other, so an exhausted quota is asked about a few times an hour instead of every second |
   | other 4xx (refused) | definite | final: `failed` (audit `pass.email_failed`), or `unconfirmed` if an earlier attempt was ambiguous |

   After `PASS_EMAIL_MAX_ATTEMPTS` counted attempts (default 8) the row is final: `unconfirmed` when any attempt was ambiguous, otherwise `failed`.
6. **Crash recovery.** On start, rows left in `sending` go back to `queued` with their id; the interrupted attempt is ambiguous, so `uncertain_since` becomes its start (`last_attempt_at`). A server that cannot send (no provider or no key) still does this at start, so the rows read as waiting and can be cancelled.

#### The provider's de-duplication window

Resend skips a request whose idempotency key it saw **in the last 24 hours** with the same body and answers with the first message id ([Resend: idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys)); after 24 hours the same request sends a second email. GatePass therefore repeats a request automatically only while `now − uncertain_since < 23 hours` (`SAFE_RETRY_WINDOW_MS` = the 24-hour window minus 1 hour for the request's own duration and clock drift). A due row past that, for example after a server was down for a day, is closed as **`unconfirmed`** when claimed, without calling the provider (audit `pass.email_unconfirmed`, message: the provider may already have sent it; check its log, or send a new link: the attendee may get two emails and only the newest link works). Rows whose attempts were all definite are retried regardless of age: nothing can have been sent.

Resend also compares the request body. The body is composed again at every attempt from the current event, so editing the event's name, venue or start between an ambiguous attempt and its retry makes Resend refuse the retry (`invalid_idempotent_request`); because an attempt was ambiguous, the row ends `unconfirmed`, not `failed`.

#### What is and is not guaranteed

- A pass is never issued twice by the outbox, and a link is sent only while it still works (the pass is not used, revoked, reissued or expired).
- Within 23 hours of the first ambiguous attempt, retries reuse the delivery id, so the provider does not send a second message for the same row.
- GatePass never claims exactly-once email. An `unconfirmed` email may or may not have been sent; only the provider's log can tell. Sending a new link creates a new delivery id and a new pass link, so the attendee may receive two emails, and only the newest link works.
- "Accepted by provider" is the strongest status the product shows. It never says "delivered".

### Organizer actions (all scoped to the authorized event; other events' ids answer 404 or `not_found`)

| Route | Permission | Effect |
| --- | --- | --- |
| `GET /api/events/:eventId/deliveries` | view | Newest first, per-status counts (`failed` and `unconfirmed` leave out emails sent again since; `retrying` = queued after a failed attempt), paging, status filter, `paused` (`no_provider` / `no_key` while emails of the event wait but this server cannot send them). Never returns the sealed link or a raw provider answer. |
| `POST /api/events/:eventId/deliveries` `{ passes: [{ passId, token? }], reissue? }` | passes | Email existing passes. With `token` (passes still on screen after issuing) the current link is sent; otherwise `reissue: true` is required. |
| `POST /api/events/:eventId/passes/:passId/deliveries` `{ token? \| reissue? }` | passes | Same for one pass, with errors instead of a skip list. |
| `POST /api/events/:eventId/deliveries/retry` `{ deliveryIds, reissue? }` | passes | Waiting emails become due now (same link, same idempotency key; one past the 23-hour window is closed as `unconfirmed` instead). Final ones (`accepted`, `failed`, `cancelled`, `unconfirmed`) hold no link any more: they are sent again only with `reissue`, which replaces the pass link (audit `pass.reissued` with `via: 'email'`) and creates a new delivery. Emails already replaced by a later one are skipped (`superseded`). |
| `POST /api/events/:eventId/deliveries/cancel` `{ deliveryIds }` | passes | Cancels waiting emails and erases their links; one being sent right now cannot be cancelled. Works while sending is paused. |

The Pass emails card shows Queued, Sending, Retry scheduled (attempt, reason, next try), Accepted by provider (time, provider message id), Failed (reason), Cancelled (reason) and **Requires action** (= `unconfirmed`: the reason, when to look in the provider's log, and "Send new link" behind a confirmation that explains the duplicate risk), plus a banner while sending is paused.

Audit: `pass.email_queued` (one entry per request with the pass ids), `pass.email_retried`, `pass.email_accepted`, `pass.email_failed`, `pass.email_unconfirmed`, `pass.email_cancelled` (entity = pass id; details carry the delivery id, attempts, provider id, error or `uncertainSince`). Recipient addresses, tokens and links are never written to the audit log or to logs; log lines name the delivery id only.

### Shutdown (audit PR-R3)

`src/server/shutdown.ts`: on SIGTERM/SIGINT the server stops accepting connections, the worker stops claiming and the email in flight is answered and recorded, background work started by requests (`Accounts.runInBackground`, e.g. reset emails) finishes, then the database closes (WAL checkpointed) and the process exits 0. Bounds: keep-alive connections are cut at 5 s; provider requests still open at 7 s are cancelled and recorded as interrupted (ambiguous: queued again with the same idempotency key, within the 23-hour window); at 10 s the database is closed and the process exits 1 whatever still runs. An email abandoned in `sending` by that deadline or by a crash is re-queued on the next start.

## Key management (`PASS_DELIVERY_KEY`, `PASS_DELIVERY_PREVIOUS_KEYS`)

- **Where it lives.** An environment variable of the server process (Render/host secret store, `.env` locally), 32 random bytes in base64: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. It is never written to the database, logs or backups. Store it apart from database backups: a backup together with the key exposes the links of emails that were still waiting when the backup was taken (at most minutes to hours of data; sent, failed and unconfirmed rows hold no link).
- **What it protects.** Only links of emails not yet handed to the provider. A copy of the database without the key reveals no usable pass link.
- **Key ring.** `PASS_DELIVERY_PREVIOUS_KEYS` lists up to 4 earlier keys, comma-separated, same format; none may repeat the active key or each other (start-up refuses the configuration otherwise). New links are always sealed under `PASS_DELIVERY_KEY`; previous keys only open older links.
- **Rotation procedure.**
  1. Generate a new key. Set it as `PASS_DELIVERY_KEY` and move the old value into `PASS_DELIVERY_PREVIOUS_KEYS` (append it if the list is not empty). Restart (deploy).
  2. On start the worker re-seals every waiting link under the new key in one transaction and logs `pass email links re-sealed under the active key` with `resealed` and `unreadable` counts (nothing else). Emails keep being sent throughout; no drain is needed.
  3. On the next deploy, once a start logged no re-seal line (or `resealed: 0, unreadable: 0`), remove the old key from `PASS_DELIVERY_PREVIOUS_KEYS`.
  - Rotating **without** keeping the old key makes every waiting link sealed under it unreadable: start logs them as `unreadable`, and each one fails when claimed with "could not be decrypted with PASS_DELIVERY_KEY or PASS_DELIVERY_PREVIOUS_KEYS … Send a new link" (never sent, never dropped silently); the organizer uses "Send again", which reissues those passes.
- **Restoring a backup.** A restored copy needs a key that sealed its waiting links: the same `PASS_DELIVERY_KEY`, or the current key with the backup's key in `PASS_DELIVERY_PREVIOUS_KEYS` (re-sealed on start). With neither, the waiting emails fail with the decryption message above. Tested in `tests/delivery-keys.test.ts`.
- **Missing key or provider.** While emails wait but this server cannot send them (no `PASS_DELIVERY_KEY`, or email not configured), the deliveries list reports `paused` and the card says why instead of looking queued forever.
- **Deletion / incident response.** Removing the key turns pass email off (`passEmail: false`, issuing with email answers 409) and makes any stored sealed links unreadable (crypto-shredding). If the key leaks together with a database copy, reissue the affected passes; their old links stop working at once.

## Consequences

- Organizers see per-pass status within seconds; a 2,000-row import takes about 17 minutes at 2 a second, but other events' emails are interleaved with it. Raising `PASS_EMAIL_PER_SECOND` only helps up to one request in flight (provider latency bounds throughput).
- Retrying a failed or unconfirmed email needs a new link. This is deliberate: keeping links after a final state would mean keeping decryptable credentials indefinitely. The UI explains that the current QR code stops working before it reissues, and for unconfirmed emails that the attendee may get two.
- "Email these passes" on the just-issued card sends the links still on screen without a reissue; once that card is closed, only reissue can email a pass.
- Fair claims and the per-address limit use indexes added by migration 6 (`pass_deliveries_waiting_idx`, `pass_deliveries_recipient_idx`). Measured on the development laptop with 25,000 waiting emails: claim about 1.7 ms instead of 64–125 ms for the schema-5 query, per-address limit about 1 ms instead of 44–98 ms, both inside write transactions.
- The SIGTERM scenarios run on Linux only (`tests/shutdown.test.ts`): Node delivers SIGTERM to a Windows child as TerminateProcess. The drain itself (`gracefulShutdown`) and SIGKILL recovery are tested on every platform.
- Live delivery through Resend is still unverified (no key or verified domain); the adapter is tested against a fake provider over real HTTP, and the 24-hour window is modelled by the fake provider in `tests/mail-fakes.ts`.

## Alternatives

- **Send inside the request.** Rejected: provider limits and timeouts would make large imports fail halfway with no record of what was sent.
- **Store the raw token for the outbox.** Rejected: breaks ADR 0002 (a database copy would contain working credentials).
- **Reissue at send time instead of sealing.** The worker would rotate the token when it sends, so nothing secret waits in the database. Rejected: the organizer's links, CSV and printed passes from the issuance would stop working as soon as the email goes out.
- **External queue (Redis, SQS).** Adds infrastructure to a single-process SQLite deployment for a few messages a second.
- **Keep retrying past 24 hours with the same id.** Rejected: the provider no longer recognises it and would send a second email while GatePass reports one.
- **Rotation by draining the queue (the schema-5 procedure).** Rejected: emails retrying with backoff could wait up to an hour, and a rotation forced by an incident cannot wait; the key ring lets sending continue.
