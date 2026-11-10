# Test matrix

Which requirement is covered by which test, what kind of test it is, and what the last recorded run showed. How to run the suites: [testing.md](testing.md). Load and throughput numbers: [performance.md](performance.md).

Results are copied from the recorded runs listed under [Recorded runs](#recorded-runs); nothing here is extrapolated. A requirement whose only evidence is a test that has not run yet is marked as such.

## Recorded runs

All runs on 2026-11-10/11 on the host described under [Host configuration](#host-configuration).

| Key | Run | Result |
| --- | --- | --- |
| **V** | `npx vitest run` (full suite) | 21 files, 256 passed, 1 skipped, 41.8 s, after the security-review fixes and their regression tests (`tests/accounts-api.test.ts`, "security review regressions", including R8 and R10). The skipped test is the graceful SIGTERM test in `tests/recovery.test.ts` (Windows). Three full runs have been green since `openDatabase` was changed to set `busy_timeout` before `journal_mode`. |
| **T** | `npx tsc --noEmit -p .` | 0 errors. |
| **C** | `tests/concurrency.test.ts` alone | 9 passed, 49.7 s. |
| **R** | `tests/migration.test.ts` + `tests/recovery.test.ts` | Windows, twice: 9 passed + 1 skipped (10.4 s, 13.3 s). Linux in Docker `node:24-bookworm-slim`, twice: 10/10 (10.3 s, 13.7 s). |
| **VC** | `tests/vercel-config.test.ts`; `node --check vercel.mjs` | 9/9; ok. |
| **E** | `npm run build && npx playwright test` | chromium 6/6 (39.3 s); firefox, webkit and mobile-chrome together 13/13 (55.6 s). |
| **D** | `docker build`, then the steps of the CI `docker-run` job executed locally (inside an Alpine container with bash) | Build 49.85 s. Healthy → admitted → `docker restart` → pass still redeemed, re-scan `already_redeemed` → `verify` ok (schemaVersion 3, 0 violations) → `docker stop` exit code 0 with "SIGTERM received, shutting down". |
| **L** | `npx tsx --disable-warning=ExperimentalWarning scripts/load-test.ts --repeat 3` | 27 runs, 0 HTTP or network errors, persisted-state checks held after every run; `onepass` (500 attempts on one pass) admitted exactly 1 in each run. Details: [performance.md](performance.md). |
| **P** | Vercel preview deployment `gatepass-34awy9su7` (branch push); `vercel curl /api/health` | Ready. `/api/health` → 503 `{"error":"This preview deployment has no backend. Previews never connect to production data.","preview":true}`. Unauthenticated access returns 302 (Vercel deployment protection). |

GitHub Actions is running on this branch; no result is recorded yet (see [Not verified](#not-verified)).

Test types: **unit** (pure function, no database or HTTP); **API** (Express app in process via supertest, file-backed SQLite); **concurrency** (worker threads, one SQLite connection each, released together); **process recovery** (real server child processes killed and restarted); **e2e** (Playwright against the built server); **docker** (production image); **load** (`scripts/load-test.ts`); **manual**.

## Data-integrity acceptance tests

| Requirement | Test file: test name | Type | Result |
| --- | --- | --- | --- |
| A pass admits at most once | `tests/redemption.test.ts`: "admits a valid pass once, then reports the original redemption" | API | V |
| | `tests/database.test.ts`: "allows at most one redemption row per pass" | unit (schema) | V |
| | `tests/database.test.ts`: "admits a pass once when a second connection redeems it too" | API (two connections) | V |
| | `e2e/admission.spec.ts`: "organiser configures gates and a capped policy; door staff see admit, duplicate, wrong gate and full" | e2e | E |
| Simultaneous scans of one pass | `tests/concurrency.test.ts`: "%i simultaneous redemptions of one pass" › "admits exactly once, persists one redemption, and yields a linearizable history" (2, 25 and 100 threads) | concurrency | C. At 100 threads some attempts exceeded `busy_timeout` and failed closed (`busy`, HTTP 503 at the API); none admitted. |
| | `tests/database.test.ts`: "admits exactly one of 8 simultaneous redemptions of one pass" | concurrency | V |
| | `tests/redemption.test.ts`: "admits exactly one of 25 concurrent HTTP scans of the same pass" | API | V |
| | `tests/recovery.test.ts`: "admits a pass exactly once across processes; contention answers 503, never a second admission" | process recovery | R. Exactly 1 of 40 concurrent scans admitted; the `SQLITE_BUSY` path was not exercised in that run. |
| | `scripts/load-test.ts` pattern `onepass` | load | L |
| Capacity never exceeded | `tests/concurrency.test.ts`: "never exceeds a policy capacity or the event capacity when 40 passes race for 7 places" | concurrency | C |
| | `tests/concurrency.test.ts`: "event capacity binds across policies and unrestricted passes: 30 racers, 12 places" | concurrency | C |
| | `tests/database.test.ts`: "never exceeds slot capacity when 12 different passes race for 5 places" | concurrency | V |
| | `tests/database.test.ts`: "makes over-admitting a capacity-limited policy impossible even with direct SQL" | unit (schema) | V |
| | `tests/policies-api.test.ts`: "stops at capacity under 30 concurrent HTTP scans of different passes"; "a pass denied for capacity does not consume it and can be retried after capacity grows"; "refuses to lower capacity below admissions already made" | API | V |
| | `tests/product-api.test.ts`: "enforces an event-wide capacity across policies and refuses lowering it below admissions" | API | V |
| | `tests/admission.test.ts`: "reports a full policy with its capacity"; "enforces the event-wide capacity at the equality boundary, after the policy limit" | unit | V |
| | `e2e/admission.spec.ts`: "organiser configures gates and a capped policy; door staff see admit, duplicate, wrong gate and full" | e2e | E |
| Scanner of another event cannot admit | `tests/redemption.test.ts`: "does not admit or reveal a pass from another event" | API | V |
| | `tests/concurrency.test.ts`: "keeps overlapping events isolated: each event admits only its own passes" | concurrency | C |
| | `tests/product-api.test.ts`: "accepts the 8-character reference only within the scanner’s own event" | API | V |
| | `tests/policies-api.test.ts`: "never reveals policy details for another event’s pass"; "refuses cross-event gates, policies and scanner bindings (IDOR)" | API | V |
| | `tests/database.test.ts`: "rejects cross-event references through triggers" | unit (schema) | V |
| | `tests/admission.test.ts`: "applies identity and pass-state rules before time, gate and capacity" (`wrong_event`) | unit | V |
| Revocation | `tests/redemption.test.ts`: "rejects revoked passes" | API | V |
| | `tests/events-api.test.ts`: "revokes passes idempotently and records the action in the audit log" | API | V |
| | `tests/product-api.test.ts`: "bulk-revokes only unused passes of the same event" | API | V |
| | `tests/concurrency.test.ts`: "revocation racing redemption: either the pass is admitted and stays unrevoked, or it is revoked and never admitted" | concurrency | C |
| | `tests/security-api.test.ts`: "rejects a scanner key immediately after revocation" | API | V |
| | `e2e/admission.spec.ts`: "revoked passes and revoked scanner devices are refused at the door" | e2e | E |
| A revoked or reissued token is never valid again | `tests/events-api.test.ts`: "reissue invalidates the old token and keeps the same pass" | API | V |
| | `tests/product-api.test.ts`: "rotates a scanner key: the old key stops at once, history and gate are kept" | API | V |
| | `tests/redemption.test.ts`: "rejects revoked passes" | API | V |
| A failed transaction never returns `admitted` | `tests/concurrency.test.ts`: "%i simultaneous redemptions of one pass" › "admits exactly once, …" (`busy` attempts are never admitted and leave no scan row) | concurrency | C |
| | `tests/recovery.test.ts`: "admits a pass exactly once across processes; contention answers 503, never a second admission" (a 503 leaves nothing behind) | process recovery | R |
| | `tests/concurrency.test.ts`: "a transaction holding the write lock for 400 ms delays redemptions but never splits a pass" | concurrency | C |
| | `tests/database.test.ts`: "rolls back a failed batch issuance completely and keeps serving" | API | V |
| | `tests/security-api.test.ts`: "returns a generic 500 without SQL or stack details and keeps serving" | API | V |
| | `tests/scanner-retry.test.ts`: "only an explicit admitted outcome is Admit"; "rejects malformed responses so they become Not verified"; "only timeouts and network failures count as unanswered" | unit (client) | V |
| Failed or repeated requests create no duplicate records | `tests/product-api.test.ts`: "returns the stored result for a retried request instead of judging it again"; "keeps request ids per device: another scanner reusing an id gets its own judgement" | API | V |
| | `tests/concurrency.test.ts`: "the same request id sent from 10 threads at once yields one judgement and one scan row" | concurrency | C |
| | `tests/recovery.test.ts`: "persists every admission acknowledged before a SIGKILL that lands mid-burst (50 passes)" (an unacknowledged but committed admission is returned through `requestId` replay) | process recovery | R |
| | `tests/scanner-retry.test.ts`: "reuses the requestId of an unanswered scan of the same code, then starts fresh once answered"; "forgets unanswered scans after two minutes" | unit (client) | V |
| | `scripts/load-test.ts` pattern `dup10` | load | L |
| | `tests/accounts-api.test.ts`: "refuses a requestId reused for a different pass instead of replaying the other pass’s verdict" (security review R10: 409) | API | V |
| A restart keeps admissions | `tests/recovery.test.ts`: "keeps an acknowledged admission across SIGKILL and restart; retries and re-scans are answered correctly" | process recovery | R |
| | `tests/recovery.test.ts`: "persists every admission acknowledged before a SIGKILL that lands mid-burst (50 passes)" | process recovery | R |
| | `tests/recovery.test.ts`: "stops gracefully on SIGTERM: exit code 0 and the WAL checkpointed into the main file" | process recovery | R on Linux only; skipped on Windows |
| | `tests/database.test.ts`: "keeps data across reopen without re-running migrations" | API | V |
| | CI job `docker-run` (`.github/workflows/ci.yml`): admit, `docker restart`, pass still redeemed, re-scan `already_redeemed` | docker | D (executed locally; not yet on GitHub Actions) |
| A restored backup is consistent with its audit log | `tests/recovery.test.ts`: "backs up while serving, restores to exactly the backup point and keeps the replaced files" (redemptions, scans, audit rows and revocations equal the backup point; later admissions gone, as documented) | process recovery | R |
| | `tests/recovery.test.ts`: "refuses a corrupt or non-database backup and leaves the current database untouched" | process recovery | R |
| | `tests/database.test.ts`: "backs up a live database, verifies it, and restores it" | API | V |

The process-recovery tests and most concurrency tests also run `verifyDatabase` (`src/server/integrity.ts`: `integrity_check`, `foreign_key_check` and the nine admission invariants) on the persisted file, not only on the returned outcomes. The two exceptions, the 400 ms lock-holder test and the same-request-id test, assert `redemptions` and `scans` row counts instead.

## Role negative tests

Each row is one principal attempting another role's actions. Non-members get 404 (the event's existence is not revealed); members lacking a permission get 403.

| Principal | Attempted actions | Test file: test name | Type | Result |
| --- | --- | --- | --- | --- |
| Manager | Lifecycle changes (archive, end), invitations (create, list), removing the owner, ownership transfer, attendance/scans/audit CSV exports, platform user list and platform invitations → 403; nothing changed | `tests/accounts-api.test.ts`: "lets a manager run operations but not change lifecycle, team, ownership or export attendee data" | API | V |
| Manager | Team controls and exports absent from the UI | `e2e/accounts.spec.ts`: "owner invites a manager who can issue passes but not manage the team or export" | e2e | E |
| Removed manager | Event read and pass issuance → 404 | `tests/accounts-api.test.ts`: "removing a manager ends their access immediately" | API | V |
| Removed manager | Scanner keys they issued stop working; the owner's keys keep working | `tests/accounts-api.test.ts`: "revokes the scanner keys a removed manager issued, and a disabled admin’s pending invitations" | API | V |
| Organizer of another event (non-member) | Every event, pass, scanner, gate, policy, audit, team, invitation, export and clone route of someone else's event → 404; nothing changed | `tests/accounts-api.test.ts`: "shows each organizer only their own events and answers 404 for anyone else’s" | API | V |
| Platform admin (not a member) | Event read and attendance export → 404 | `tests/accounts-api.test.ts`: "does not let a platform admin read organizers’ events through their role alone" | API | V |
| Platform admin | Reset link for another platform admin → 403 (operator only); reset link cancelled by the user's password change | `tests/accounts-api.test.ts`: "lets only the operator reset a platform administrator, and a password change cancels open reset links" | API | V |
| Disabled platform admin | Invitations they created stop working | `tests/accounts-api.test.ts`: "revokes the scanner keys a removed manager issued, and a disabled admin’s pending invitations" | API | V |
| Disabled account | Existing sessions and new sign-in refused | `tests/accounts-api.test.ts`: "a disabled account is signed out everywhere and cannot sign in" | API | V |
| Signed-in user with a different email | Accepting an invitation addressed to someone else → 409 | `tests/accounts-api.test.ts`: "binds an invitation to its email: an existing account must be signed in as that email" | API | V |
| Scanner key | Account API with a scanner key → 401; account session on the scanner API → 401 | `tests/accounts-api.test.ts`: "never accepts scanner keys or account sessions in place of each other" | API | V |
| Scanner key, wrong token, Basic auth, raw token, no token | Every operator route → 401 | `tests/security-api.test.ts`: "%s %s requires the admin token" (one case per route) | API | V |
| Operator token | Scanning with the operator token → 401 | `tests/security-api.test.ts`: "requires a scanner key for scanning; the admin token is not a scanner key" | API | V |

Not covered by a named test: a platform admin attempting event writes (only reads and the export are probed), and one manager acting on another manager's membership.

## Security tests

| Threat | Test file: test name | Type | Result |
| --- | --- | --- | --- |
| Role escalation | `tests/accounts-api.test.ts`: "lets a manager run operations but not change lifecycle, team, ownership or export attendee data" (ownership transfer, invitations, platform invitations) | API | V |
| | `tests/accounts-api.test.ts`: "lets only the operator reset a platform administrator, and a password change cancels open reset links" | API | V |
| | `tests/accounts-api.test.ts`: "accepts an invitation exactly once, even when two acceptances race"; "refuses revoked and expired invitations"; "binds an invitation to its email: an existing account must be signed in as that email" | API | V |
| Cross-tenant access | `tests/accounts-api.test.ts`: "shows each organizer only their own events and answers 404 for anyone else’s"; "does not let a platform admin read organizers’ events through their role alone" | API | V |
| | `tests/policies-api.test.ts`: "refuses cross-event gates, policies and scanner bindings (IDOR)" | API | V |
| | `tests/product-api.test.ts`: "bulk-revokes only unused passes of the same event" | API | V |
| Token and credential disclosure | `tests/security-api.test.ts`: "never returns tokens or token hashes from list endpoints"; "never returns scanner keys after creation" | API | V |
| | `tests/database.test.ts`: "never stores raw tokens" | unit (schema) | V |
| | `tests/accounts-api.test.ts`: "stores only hashes of passwords and session ids"; "signs up with an HttpOnly, Secure, SameSite=Strict host-only cookie and never returns a credential in the body" | API | V |
| | `tests/redemption.test.ts`: "answers unknown and malformed tokens identically" | API | V |
| | `tests/tokens.test.ts`: "generates distinct 256-bit base64url tokens"; "hashes deterministically without revealing the token"; "compares secrets of different lengths without throwing" | unit | V |
| | `tests/vercel-config.test.ts`: "builds a static-only preview with a 503 backend route and no production secret" | unit | VC, P |
| XSS and injection | `tests/redemption.test.ts`: "escapes attendee and event names" | API | V |
| | `tests/pass-page.test.ts`: "escapes organiser- and attendee-controlled text"; "has no scripts and renders a not-found page" | unit | V |
| | `tests/security.test.ts`: "rejects SVG attribute injection and unsafe logo references"; "drops unknown keys so arbitrary client data is never persisted" | unit | V |
| | `tests/security-api.test.ts`: "sends security headers and disables caching on API responses" (CSP) | API | V |
| | CSV formula injection: `tests/csv.test.ts`: "neutralises spreadsheet formulas in attendee-controlled cells"; `tests/product-api.test.ts`: "exports attendance with formula injection neutralised and records the download" | unit, API | V |
| CSRF | `tests/accounts-api.test.ts`: "refuses cookie-authenticated writes without the custom header or from a cross-site context"; "does not require the header for bearer credentials, which browsers never attach on their own" | API | V |
| | `tests/accounts-api.test.ts`: "applies the CSRF header rule to auth routes whatever the URL case" (security review R8: `/API/AUTH/LOGIN` without the header → 403) | API | V |
| Replay | `tests/product-api.test.ts`: "returns the stored result for a retried request instead of judging it again" | API | V |
| | `tests/accounts-api.test.ts`: "accepts an invitation exactly once, even when two acceptances race"; "uses a password reset link once, ends existing sessions, and only the newest link works" | API | V |
| | `tests/accounts-api.test.ts`: "ends sessions on sign-out, after 24 h idle and after 7 days regardless of activity"; "ends every other session when the password changes" | API | V |
| Proxy-header spoofing | `tests/security-api.test.ts`: "ignores spoofed X-Forwarded-For when no proxy is trusted"; "rate-limits by the CDN-provided client IP, not by spoofable X-Forwarded-For"; "refuses requests without the origin secret when a CDN fronts the API"; "rejects configuration that would trust spoofed forwarding headers" | API | V |
| | `tests/vercel-config.test.ts`: "proxies /api and /p in production with the ORIGIN_SECRET transform" | unit | VC |
| API abuse and rate limits | `tests/security-api.test.ts`: "rate-limits scans per device, so gates sharing one NAT address do not throttle each other"; "throttles failed authentication per IP without locking out valid credentials from that IP"; "maps malformed JSON and oversized bodies to 4xx" | API | V |
| | `tests/accounts-api.test.ts`: "throttles repeated failures for one account even across addresses, without locking out other accounts"; "gives the same answer for an unknown email and a wrong password, and audits failures"; "rejects weak passwords and refuses sign-up when registration is closed" | API | V |
| | `tests/accounts-api.test.ts`: "keeps a locked account locked even for the correct password (guessing from many addresses gains nothing)" | API | V |
| | `tests/security-api.test.ts`: "requires the admin token (CPU-heavy rendering is not public)"; "answers invalid input with 400 instead of 500" | API | V |
| Unauthorized exports | `tests/accounts-api.test.ts`: "lets a manager run operations but not change lifecycle, team, ownership or export attendee data" (three exports → 403); "shows each organizer only their own events and answers 404 for anyone else’s" (export → 404); "does not let a platform admin read organizers’ events through their role alone" (export → 404) | API | V |
| | `tests/product-api.test.ts`: "exports attendance with formula injection neutralised and records the download" (download audited) | API | V |
| | `e2e/accounts.spec.ts`: "owner invites a manager who can issue passes but not manage the team or export" | e2e | E |

The security review itself was static (no proof-of-concept execution); its findings and their status are in [security-and-threat-model.md](security-and-threat-model.md).

## Migration and recovery

| Requirement | Test file: test name | Type | Result |
| --- | --- | --- | --- |
| Populated v2 → v3 migration keeps every row and hash | `tests/migration.test.ts`: "preserves every row, hash, constraint and invariant, and keeps legacy passes and keys working" | API (database) | R |
| A bad migration rolls back | `tests/migration.test.ts`: "rolls back a migration that would leave a foreign-key violation, leaving the version unchanged"; "commits each migration on its own: a failing later migration leaves the upgrade from version 2 intact and itself fully rolled back" | API (database) | R |
| An existing pre-migration backup does not block start-up (DB-03) | `tests/migration.test.ts`: "opens and migrates when a pre-migration backup from an earlier failed attempt already exists (DB-03)" | API (database) | R |
| Older migrations and schema guard | `tests/database.test.ts`: "upgrades a version 1 database with data, keeps old passes valid and backs it up first"; "rolls back a failing migration completely"; "refuses to open a database written by a newer schema" | API (database) | V |
| Corrupt database is not replaced | `tests/database.test.ts`: "fails loudly on a corrupt database file instead of replacing it" | API (database) | V |
| Crash, restart, backup, restore | see [Data-integrity acceptance tests](#data-integrity-acceptance-tests): "A restart keeps admissions" and "A restored backup is consistent with its audit log" | process recovery | R |

## Browser end-to-end tests

`playwright.config.ts` defines four projects. `mobile-chrome` runs only `e2e/onboarding.spec.ts`. Codes are entered through the scanner's manual entry field; no camera is involved.

| Spec: test | chromium | firefox | webkit | mobile-chrome (Pixel 7) |
| --- | --- | --- | --- | --- |
| `e2e/onboarding.spec.ts`: "a first-time organiser is guided from a new event to \"Ready for doors\"" | Pass | Pass | Pass | Pass |
| `e2e/admission.spec.ts`: "organiser configures gates and a capped policy; door staff see admit, duplicate, wrong gate and full" | Pass | Pass | Pass | not run |
| `e2e/admission.spec.ts`: "revoked passes and revoked scanner devices are refused at the door" | Pass | Pass | Pass | not run |
| `e2e/admission.spec.ts`: "expired passes are refused once their expiry passes, and the pass page says so" | Pass | Pass | Pass | not run |
| `e2e/accounts.spec.ts`: "owner invites a manager who can issue passes but not manage the team or export" (includes sign-out) | Pass | Pass | Pass | not run |
| `e2e/accounts.spec.ts`: "CSV import previews rejected duplicates, and the attendance export lists the admitted attendee" | Pass | Pass | Pass | not run |
| Recorded run | 6/6, 39.3 s | 13/13 for firefox, webkit and mobile-chrome together, 55.6 s | (same run) | (same run) |

Run on the local built server (Windows host). Not yet run on GitHub Actions or against a deployed URL from this branch.

## Docker

| Check | Where defined | Result |
| --- | --- | --- |
| Image builds (`linux/amd64`) | `Dockerfile`; CI job `docker-run` | D: built locally, 49.85 s |
| Restart persistence, `verify`, graceful stop | CI job `docker-run` | D: steps executed locally; all passed |
| Multi-arch build (`linux/amd64`, `linux/arm64`) | CI job `docker` | Not run on this branch |
| Recovery tests on Linux | `tests/migration.test.ts`, `tests/recovery.test.ts` in `node:24-bookworm-slim` | R: 10/10, twice |

## Concurrency: what the history check shows

`tests/concurrency.test.ts` runs each redemption in its own worker thread (`tests/threads.ts`, `redeemHistory`), and each worker opens **its own SQLite connection** to the same file (`tests/fixtures/redeem-worker.mjs`). Workers report ready and block on `Atomics.wait`; the main thread releases them all at once, so their transactions contend for SQLite's write lock. Each worker records an invocation instant just before calling `GatePass.redeem` and a response instant just after it returns, both as `performance.timeOrigin + performance.now()`.

`singlePassViolations` in `tests/threads.ts` checks the resulting history of one pass against the sequential specification "the first redemption admits, every later one is `already_redeemed`", using the real-time-order condition of Herlihy and Wing (1990): if operation A responded before operation B was invoked, A must come before B in any valid linearization. For this object that reduces to two conditions:

1. exactly one operation returned `admitted`;
2. no operation returned `already_redeemed` with a response instant earlier than the admitting operation's invocation instant (it would have to be ordered before the admission, when the pass was still unused).

Any outcome other than `admitted`, `already_redeemed` or `busy` is also reported as a violation. `busy` (a lock wait beyond `busy_timeout`, which the API answers with 503 and the scanner shows as "Not verified") is treated as an operation that took no effect; the test separately asserts that the number of `scans` rows equals the number of non-`busy` attempts, that there is one `redemptions` row and one admitted scan, and that `verifyDatabase` reports no violations.

What this is and is not:

- It is **evidence about the histories observed** in these runs (2, 25 and 100 threads, plus the 400 ms lock-holder test, which applies the same check; run C), on one Windows laptop, with in-process calls to `GatePass.redeem` rather than HTTP. A passing run means none of those observed histories violated the condition.
- It is **not a proof** that the system is linearizable in general, under other schedules, on other machines or file systems, over HTTP, or across processes. The check covers one pass and one operation type; it does not check revocation, capacity or reissue histories against a specification (those tests assert final counts and invariants instead).
- Instants come from each worker thread's own `performance.timeOrigin`; skew between threads was not measured, so orderings closer together than that skew are not reliably distinguished.
- The production topology is one process with one connection; the multi-connection setting here is deliberately harsher than production and is why `busy` outcomes occur at 100 threads.

The atomicity argument itself (one `BEGIN IMMEDIATE` transaction per redemption, database constraints as a backstop) is in [ADR 0003](decisions/0003-redemption-atomicity.md).

## Host configuration

All recorded runs used one machine:

| Item | Value |
| --- | --- |
| Machine | Windows laptop, Intel Core i7-14650HX, 24 logical cores, 15.7 GiB RAM, NVMe SSD |
| Node | 24.14.1 |
| SQLite | 3.51.2 |
| Linux runs | Docker container `node:24-bookworm-slim` on the same machine (run R); Alpine container with bash for the `docker-run` steps (run D) |
| Browsers | Playwright's bundled Chromium, Firefox and WebKit; versions not recorded |

Full host details for the load tests (OS build, disk model, database pragmas, background load) are in [performance.md](performance.md#host-configuration).

## Not verified

- **Physical devices.** Camera scanning on a real iPhone or Android phone has not been tried (no devices available). The decoder tests (`tests/scanner-detector.test.ts`) and camera tests (`tests/scanner-camera.test.ts`) use fakes and a generated frame; Playwright enters codes by hand. Use the [manual checklist](#manual-real-device-acceptance-checklist) below.
- **GitHub-hosted runs.** The CI workflow (`check` on Ubuntu with Node 22 and 24 and on Windows with Node 24, `e2e` per browser project, `docker`, `docker-run`) is running on this branch, but no result has been recorded. Until one is, nothing here is evidence for those runners.
- **Render free instance load.** All performance numbers are from the laptop. The deployed Render free instance (0.1 CPU) has not been load-tested.
- **SIGTERM on Windows.** Windows has no catchable SIGTERM for a child process, so the graceful-stop test is skipped there; graceful stop was verified on Linux only (runs R and D).
- **`SQLITE_BUSY` across processes.** The two-process test admitted exactly once, but no attempt hit `SQLITE_BUSY` in that run, so the 503 path across processes was not exercised. (Across connections in one process it was, at 100 threads in run C.) Two processes on one file is an unsupported topology.

## Manual real-device acceptance checklist

Run once on an iPhone with Safari and once on an Android phone with Chrome. Record every step in the results table; a step passes only if every expectation in it is observed.

### Preparation

1. A deployment reachable over **HTTPS** (the camera is blocked on plain HTTP), built from the commit under test. Write down the commit.
2. As an owner: one `active` event whose window contains the test time, one scanner device (setup link or key), and at least four passes: A (valid), B (valid), C (revoked), D (valid, used for the reconnect step). Print the passes or show them on a second screen at normal brightness. Note pass A's 8-character reference.
3. A second event with one valid pass E (for the wrong-event case).
4. Phone: site permissions for the deployment reset (never asked before), sound on, ring/silent switch off on iPhone.

### Steps

| # | Step | Expected |
| --- | --- | --- |
| 1 | Open the scanner setup link. | Scanner page for the event; the key is removed from the address bar; the viewfinder shows "Tap to start scanning". Footer reads "Decoder: starts with the camera". |
| 2 | Tap "Tap to start scanning". | The browser asks for camera permission (first visit). |
| 3 | **Deny** the permission. | An error explains how to allow the camera (iPhone: aA → Website Settings → Camera; Android: icon left of the address → Permissions → Camera) and a "Retry camera" button is shown. No crash, manual entry still usable. |
| 4 | Allow the camera in the browser's site settings as described, return, tap "Retry camera". | The camera starts without reloading the page. |
| 5 | Check the camera in use. | The **rear** camera is used by default. If the phone has more than one camera, a "Camera" selector appears; switching to another camera works, and after reloading and starting again the chosen camera is used. |
| 6 | Torch. | Android Chrome: a "Flashlight" button appears and switches the light on and off. iPhone Safari: record whether the button appears (it is shown only if the browser reports torch support); if it appears, it must work. |
| 7 | Decoder label. | Once the camera runs, the footer shows "Decoder: native" or "Decoder: wasm". Record which. If it changes from native to wasm during the session, record that. |
| 8 | Sound unlock. | The first verdict after "Tap to start scanning" plays a tone without any further tap. The "Sound" button mutes and unmutes it. |
| 9 | Scan pass A. | Green "Admit" overlay with the attendee name; tone plays. |
| 10 | Keep pass A in view, then move it away and back within a few seconds. | No second check while it stays in view, and no new check when presented again within 12 s of last being seen. |
| 11 | Keep pass A out of view for more than 12 s, then scan it again. | "Already used" with the original check-in details. |
| 12 | Scan pass C (revoked). | "Denied", reason revoked. |
| 13 | Scan pass E (other event). | "Denied"; no attendee name or policy details of the other event shown. |
| 14 | Type pass B's reference in lower case in the manual field ("Pass link or code") and submit. | "Admit" for pass B (reference matched case-insensitively). Then type pass A's reference: "Already used". |
| 15 | Enable airplane mode. Present pass D to the camera and try the manual field. | Banner "Scanning paused — offline. Do not admit anyone until the connection returns."; the viewfinder shows "Paused — offline"; no code is checked and the manual submit button is disabled. No "Admit" appears. |
| 16 | Disable airplane mode. Scan pass D, and as soon as "Checking…" appears enable airplane mode again (or use a link weak enough that the check times out). | "Not verified" overlay telling staff not to admit, with a "Retry verification" button. It stays until staff act. |
| 17 | Reconnect, tap "Retry verification". | If the first attempt had reached the server: "Admit" with the note "Confirmed after reconnect". If it had not: plain "Admit". In no case "Already used" for pass D. Record which variant was seen; repeat step 16–17 with new passes until the "Confirmed after reconnect" variant is seen, or record "not produced" after five attempts. |
| 18 | After a "Not verified", present the same code again immediately. | It is checked again at once (no 12 s suppression after "Not verified"). |
| 19 | Rotate to landscape and scan a new valid pass. | Layout usable in landscape: viewfinder, overlay and buttons fully visible; verdict readable. Rotate back. |
| 20 | VoiceOver (iPhone) / TalkBack (Android) on. Scan an already used pass, keep it out of view for more than 12 s, then scan it again. | Each verdict is announced (verdict, reason, name), including the second of two identical consecutive verdicts; the result overlay can be reached and dismissed with the screen reader. |
| 21 | Turn the camera off with the "Camera" button. | "Camera off. Use manual entry below."; manual entry still works. |

### Results

Copy one row per device run. Mark each step P (pass), F (fail, add a note) or N/A (with reason).

| Device | OS version | Browser and version | Date | Tester | Commit | 1 | 2 | 3 | 4 | 5 | 6 | 7 (decoder) | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 (variant) | 18 | 19 | 20 | 21 | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| iPhone: | iOS | Safari | | | | | | | | | | | | | | | | | | | | | | | | | |
| Android: | Android | Chrome | | | | | | | | | | | | | | | | | | | | | | | | | |

No row has been filled in yet.
