# Test matrix

Which requirement is covered by which test, what kind of test it is, and what the last recorded run showed. How to run the suites: [testing.md](testing.md). Load and throughput numbers: [performance.md](performance.md).

Results are copied from the recorded runs listed under [Recorded runs](#recorded-runs); nothing here is extrapolated. A requirement whose only evidence is a test that has not run yet is marked as such.

## Recorded runs

Runs of 2026-11-15/16 on branch `feat/production-readiness` (schema 4), on the host described under [Host configuration](#host-configuration), unless a row gives another date. Rows dated 2026-11-10/11 were recorded before this branch's changes.

| Key | Run | Result |
| --- | --- | --- |
| **T** | `npm run typecheck` (TypeScript 7.0.2) | 0 errors. |
| **V** | `npx vitest run` (full suite, Vitest 5.1.0) | 24 files, 298 passed, 1 skipped. The skipped test is the graceful SIGTERM test in `tests/recovery.test.ts` (Windows). |
| **B** | `npm run build`; `npm run smoke:qr`; `npm audit`; `node --check vercel.mjs` | Build ok, `dist/client/version.json` present; QR smoke ok; 0 vulnerabilities; ok. |
| **E** | 2026-11-16, final branch state: `npm run build && npx playwright test` (all four projects in one run, local built server) | 46 passed, 0 failed, 54.4 s: chromium, firefox and webkit 15 each, mobile-chrome 1. Two earlier all-project runs on this state failed and were fixed, not retried: (1) 10 of 43 failed because all projects shared one client address and hit the limit of 20 sign-ups a minute (429); `playwright.config.ts` now sets `TRUST_PROXY=loopback` and a distinct `X-Forwarded-For` per project (the limits stay on). (2) 1 of 46 failed in WebKit: after `setOffline(true)` the browser did not deliver the `offline` event, so the scanner kept showing "Online"; the scanner now also re-reads `navigator.onLine` every 2 s and when the tab becomes visible. |
| **D** | Docker, recorded 2026-11-15 on an earlier state of this branch: the script of the CI `docker-run` job run locally; `scripts/rollback-rehearsal.sh` | `docker-run` script passed, including scanner enrollment, restart persistence, backup, restore and graceful stop. Rollback rehearsal with old = `4a6ba5c` (schema 3) and new = this branch (schema 4): 9/9 checks. |
| **RC** | `scripts/release-check.ts` | Against a local built server: 9/9 passed; with a wrong expected commit: exit 1. Against production, read-only: exit 1, as expected, because production still runs `4a6ba5c`, which has neither `/version.json` nor `build` in `/api/health`; the smoke checks passed. |
| **A** | Accessibility: axe-core 4 | 21 screens at 320, 375, 768 and 1280 px, light and dark: zero serious or critical violations after fixes. Follow-up run on Access, Team, Platform, the reset dialog, Forgot password and Sign in at 320, 375, 768 and 1280 px: no page overflow, no axe violations. |
| **S** | gitleaks 8.30.1 over all commits, locally | No leaks. |
| **C** | 2026-11-10/11: `tests/concurrency.test.ts` alone | 9 passed, 49.7 s. |
| **R** | 2026-11-10/11: `tests/migration.test.ts` + `tests/recovery.test.ts` | Windows, twice: 9 passed + 1 skipped (10.4 s, 13.3 s). Linux in Docker `node:24-bookworm-slim`, twice: 10/10 (10.3 s, 13.7 s). |
| **L** | 2026-11-10: `npx tsx --disable-warning=ExperimentalWarning scripts/load-test.ts --repeat 3` | 27 runs, 0 HTTP or network errors, persisted-state checks held after every run; `onepass` (500 attempts on one pass) admitted exactly 1 in each run. Details: [performance.md](performance.md). |
| **P** | 2026-11-10: Vercel preview deployment `gatepass-34awy9su7` (branch push); `vercel curl /api/health` | Ready. `/api/health` → 503 `{"error":"This preview deployment has no backend. Previews never connect to production data.","preview":true}`. Unauthenticated access returns 302 (Vercel deployment protection). |

### Phase 4 runs (branch `feat/phase4-features`, schema 5, 2026-11-17)

| Key | Run | Result |
| --- | --- | --- |
| **T4** | `npm run typecheck` | 0 errors. |
| **V4** | `npx vitest run` (Windows, Node 24.14.1), final branch state `4d22ab9` | 35 files, 417 passed, 4 skipped. The skips are the Linux-only SIGTERM tests (`recovery.test.ts` graceful stop, three in `shutdown.test.ts`). New files: `enrollment` (15), `recovery-security` (12), `logging` (3), `deliveries`, `shutdown`, `templates` (13), `operations`, `assist`, `scanner-readiness` (12), `badge-layout` (8), `release-check` (6). |
| **R4** | `shutdown`, `recovery`, `deliveries` in Docker `node:24-bookworm-slim` | 34/34, including all four SIGTERM tests (slow, failing and non-responding email provider; the non-responding one exits 0 about 8 s after SIGTERM, delivery re-queued, WAL checkpointed). |
| **B4** | `npm run build`; `npm run smoke:qr` | Build ok (`dist/server/index.js` 271 kB, gzip 75 kB); QR smoke ok. |
| **E4** | `npm run build && npx playwright test` (all projects, local built server), final branch state `4d22ab9` | 333 listed: 159 passed, 0 failed, 174 skipped, 4.1 min. Every skip is a browser gate: the axe and overflow specs (84 tests) and the PDF badge spec run only in Chromium; the fake-camera and offline-start tests run only in Chromium. Includes `enroll-retry` (4 tests × 4 projects). |
| **A4** | `e2e/a11y.spec.ts` (axe 4.14, wcag2a/aa + 21a/aa) and `e2e/visual-review.spec.ts` | 21 screens, light and dark: 0 violations at 375 and 1280 px; no sideways scroll at 320, 375, 390, 768, 1024, 1280, 1440 px. |
| **PR4** | `e2e/badges.spec.ts` (Chromium) | Real A4 PDFs have `ceil(10/n)` pages for n = 1, 2, 4, 8; every QR decoded with zxing-wasm from a 150 dpi render of each sheet equals the issued pass URL; QR ≥ 30 mm, names ≥ 10 pt, no overflow. Samples: `docs/screenshots/badges/`. Not printed on paper. |
| **D4** | Docker Desktop 29.9.2: images from `git archive 8b86114` (old, schema 4) and `6d2f831` (new, schema 5) | Persistence: enroll (second use 410) → admit → `docker restart` → still `redeemed`, re-scan `already_redeemed`, `verify` 0; online backup restored into a second container and volume with the admission present; both stopped with exit 0; no token, key or code in the logs. Rollback rehearsal `scripts/rollback-rehearsal.sh`: 9/9. |
| **RC4** | `scripts/release-check.ts` against production (read-only), 2026-11-17 | 11/11 passed against `8b86114` (schema 4, `demo: true`); a run gated on this branch's head deferred with exit 0 as designed. |
| **CI4** | PR #15 GitHub Actions | First push: `check (ubuntu-latest, 22/24)`, all four e2e projects, `docker`, `docker-run`, gitleaks and both CodeQL analyses passed; the CodeQL result check reported five new alerts (service worker, release-check, two e2e helpers). After the fix in `4654f5a`: all 15 jobs green, including `check (windows-latest, 24)` and the CodeQL result check (`dependency-review` skipped: repository variable not set). |
| **P4** | Vercel preview for `feat/phase4-features` (`vercel curl --deployment …`) | `/version.json` → `4654f5a`; `/api/health` → 503 `{"error":"This preview deployment has no backend. Previews never connect to production data.","preview":true}`; `/sw.js` → 200, `Cache-Control: no-cache`, `text/javascript`; unauthenticated request → 302 (deployment protection). |

### Phase 5 runs (branch `feat/phase4-features`, schema 6, 2026-11-17)

Windows 10.0.26300, Node 24.14.1, Docker 29.9.2, unless a row says otherwise. Integration commit `9505667` (PR #15 head `6760640` + the Phase 5 branches) unless stated.

| Key | Run | Result |
| --- | --- | --- |
| **V5-base** | `npx vitest run` on `6760640` before any change | 35 files, 417 passed, 4 skipped. |
| **T5** | `npx tsc --noEmit` | 0 errors. |
| **V5** | `npx vitest run` (full suite) | 43 files, 501 passed, 4 skipped (the Linux-only SIGTERM tests). New files: `delivery-recovery`, `delivery-keys`, `delivery-fairness`, `mail-fakes` (helper), `exports`, `queries`, `report`, `scanner-reference`, `live-impact`. |
| **R5** | `shutdown`, `recovery`, `deliveries`, `delivery-recovery`, `delivery-keys`, `delivery-fairness`, `migration`, `exports` in Docker `node:24-bookworm-slim` (`git archive` of `3618985`, `npm ci`) | 8 files, 77/77, including every SIGTERM test. |
| **E5** | `npm run build && npx playwright test` (all four projects, local built server) | 227 passed, 0 failed, 272 skipped, 6.1 min: chromium 163, firefox 27, webkit 27, mobile-chrome 10. Skips are browser gates (axe, overflow, PDF, fake-camera and offline-start specs run in Chromium only). Earlier runs on intermediate states: 4 failures, all fixed or explained — 3 Chromium specs hit the 20-a-minute sign-up limit (fixed: each e2e sign-up has its own client address) and the WebKit flake E2E-01 (see below). |
| **E5-repeat** | WebKit `admission` + `live-changes`, `--repeat-each=8`; firefox + webkit `admission`, `operations-dashboard`, `--repeat-each=8` (QA) | 40/40; 79 passed, 1 failed (E2E-01). Across all repeats E2E-01 appeared in about 3 of ≈ 100 WebKit runs; base `273918b` 6/6. |
| **A5** | `e2e/a11y.spec.ts` and `e2e/visual-review.spec.ts` (Chromium, part of E5) | 32 screens (templates, CSV import preview, issued passes, badge preview and print, scanner setup, live-change dialogs added), light and dark: 0 axe violations at 375 and 1280 px; no sideways scroll at 320–1440 px. Screenshots: `docs/screenshots/review-2026-11-pass3/`. |
| **D5** | `scripts/rollback-rehearsal.sh`, OLD `273918b` (schema 5), NEW `3618985` (schema 6), `EXPECT_OLD_SCHEMA=5 EXPECT_NEW_SCHEMA=6` | 9/9 passed. A first invocation exited 1 without output (not diagnosed); the re-run passed every step. |
| **D5-run** | Docker restart persistence + SIGTERM, schema-5 image (ops agent) | Admission survives `docker restart`, re-scan `already_redeemed`; `docker stop` 312 ms, exit 0; no token, key, pass link, email or `Bearer` in the log. The schema-6 image's persistence is covered by CI `docker-run` on the PR. |
| **M5** | Base build `6760640` writes a schema-5 database (a redemption with a request id, sealed v1 emails in `queued` and `sending`); the new build opens it (QA, ad hoc) | Migrated to v6 with `.pre-v6.bak` at v5; the replayed request answered `admitted` (`replayed: true`), a re-scan `already_redeemed`; the interrupted email re-sent with the same idempotency key. The base build refuses the v6 file (exit 1, "newer than this build"); its `restore` of `.pre-v6.bak` works. |
| **C5** | `tests/concurrency.test.ts` + `tests/invariants.test.ts` under background CPU load (QA) | 22/22. |
| **RC5** | `scripts/release-check.ts` against production, read-only, with `PREVIEW_URL` | 12/12 against **`main` `8b86114`** (schema 4). This checks the current live demo, not PR #15. |
| **S5** | `npm audit` and `npm audit --omit=dev`; gitleaks (8.24.3 over the worktree and 72 commits; 8.30.1 over the Phase 5 diff and logs) | 0 vulnerabilities; no leaks. |
| **PF5** | `scripts/perf-phase5.ts` and `scripts/perf-queries.ts` (25,000-pass event, laptop) | Zero lost or duplicate admissions in every run; numbers in [performance.md](performance.md#2026-11-17-phase-5-large-events-exports-and-the-door). |
| **B5** | `npm run build` bundle (raw / gzip) | `/scan` loads entry 222.6 / 69.9 kB + `ScannerApp` 46.9 / 15.0 kB (+ CSS); `AdminApp` 194.1 / 51.4 kB is not requested on `/scan` (asserted in `e2e/scanner-readiness.spec.ts`). Before: one 502 / 147 kB bundle for both. `qr-detector` 43.8 / 15.1 kB loads with the camera or the design tab. |

Rows marked C or R below point to those dedicated runs for their detail; the same files also ran in V on the current state (all passed, SIGTERM test skipped).

PR CI results are recorded in the PR. The last recorded CI run on `main` is PR #13's run (all 11 jobs passed, 2026-11-14).

Test types: **unit** (pure function, no database or HTTP); **API** (Express app in process via supertest, file-backed SQLite); **concurrency** (worker threads, one SQLite connection each, released together); **process recovery** (real server child processes killed and restarted); **e2e** (Playwright against the built server); **docker** (production image); **load** (`scripts/load-test.ts`); **manual**.

Scanner keys in the API and process tests come from the one-time enrollment route (`POST /api/scanner/enroll`), through `enroll` in `tests/helpers.ts`.

## Data-integrity acceptance tests

| Requirement | Test file: test name | Type | Result |
| --- | --- | --- | --- |
| A pass admits at most once | `tests/redemption.test.ts`: "admits a valid pass once, then reports the original redemption" | API | V |
| | `tests/database.test.ts`: "allows at most one redemption row per pass" | unit (schema) | V |
| | `tests/database.test.ts`: "admits a pass once when a second connection redeems it too" | API (two connections) | V |
| | `tests/invariants.test.ts`: "makes an admission permanent: UPDATE and DELETE on redemptions abort and leave the row as it was" (DB-04) | unit (schema) | V |
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
| | `tests/invariants.test.ts`: "a redeem transaction that fails after claiming capacity" › "fails closed when %s fails: 5xx, never admitted, no counter or row changed" (three injected failures; policy and event counters stay as they were) | API | V |
| Scanner of another event cannot admit | `tests/redemption.test.ts`: "does not admit or reveal a pass from another event" | API | V |
| | `tests/concurrency.test.ts`: "keeps overlapping events isolated: each event admits only its own passes" | concurrency | C |
| | `tests/product-api.test.ts`: "accepts the 8-character reference only within the scanner’s own event" | API | V |
| | `tests/policies-api.test.ts`: "never reveals policy details for another event’s pass"; "refuses cross-event gates, policies and scanner bindings (IDOR)" | API | V |
| | `tests/database.test.ts`: "rejects cross-event references through triggers" | unit (schema) | V |
| | `tests/admission.test.ts`: "applies identity and pass-state rules before time, gate and capacity" (`wrong_event`) | unit | V |
| | `tests/invariants.test.ts`: "refuses a redemption row whose scanner, gate or policy belongs to another event"; "refuses re-pointing a policy gate at another event's gate or policy (UPDATE policy_gates)" (DB-04) | unit (schema) | V |
| Entry windows and gates at the exact boundary | `tests/invariants.test.ts`: "opensAt is inclusive, closesAt exclusive, time is judged before the gate, and an open-ended policy closes with the event" | API | V |
| Revocation | `tests/redemption.test.ts`: "rejects revoked passes" | API | V |
| | `tests/events-api.test.ts`: "revokes passes idempotently and records the action in the audit log" | API | V |
| | `tests/product-api.test.ts`: "bulk-revokes only unused passes of the same event" | API | V |
| | `tests/concurrency.test.ts`: "revocation racing redemption: either the pass is admitted and stays unrevoked, or it is revoked and never admitted" | concurrency | C |
| | `tests/security-api.test.ts`: "rejects a scanner key immediately after revocation" | API | V |
| | `tests/invariants.test.ts`: "refuses a redemption with a scanner identity that was revoked after the key check: 401, nothing written"; "answers 401 over HTTP when the revocation commits between the key check and the redeem transaction" (DB-05) | API | V |
| | `tests/invariants.test.ts`: "a revocation racing redemptions on other connections: no admission or scan by the device after its revocation" (DB-05) | concurrency | V |
| | `e2e/admission.spec.ts`: "revoked passes and revoked scanner devices are refused at the door" | e2e | E |
| | `e2e/scanner-failclosed.spec.ts`: "a device revoked mid-session is signed out at its next server answer (401), without admitting" | e2e | E |
| A revoked or reissued token is never valid again | `tests/events-api.test.ts`: "reissue invalidates the old token and keeps the same pass" | API | V |
| | `tests/product-api.test.ts`: "rotates a scanner key: the old key stops at once, history and gate are kept" | API | V |
| | `tests/redemption.test.ts`: "rejects revoked passes" | API | V |
| A failed transaction never returns `admitted` | `tests/concurrency.test.ts`: "%i simultaneous redemptions of one pass" › "admits exactly once, …" (`busy` attempts are never admitted and leave no scan row) | concurrency | C |
| | `tests/recovery.test.ts`: "admits a pass exactly once across processes; contention answers 503, never a second admission" (a 503 leaves nothing behind) | process recovery | R |
| | `tests/concurrency.test.ts`: "a transaction holding the write lock for 400 ms delays redemptions but never splits a pass" | concurrency | C |
| | `tests/invariants.test.ts`: "answers 503 with Retry-After while another connection holds the write lock; the same requestId then admits exactly once" (DB-06) | API (two connections) | V |
| | `tests/invariants.test.ts`: "fails closed when %s fails: 5xx, never admitted, no counter or row changed" (failure injected after the capacity claim: 500, no admission, the retry admits once) | API | V |
| | `tests/database.test.ts`: "rolls back a failed batch issuance completely and keeps serving" | API | V |
| | `tests/security-api.test.ts`: "returns a generic 500 without SQL or stack details and keeps serving" | API | V |
| | `tests/scanner-retry.test.ts`: "only an explicit admitted outcome is Admit"; "rejects malformed responses so they become Not verified"; "only timeouts and network failures count as unanswered"; "failures never read as admission" | unit (client) | V |
| | `e2e/scanner-failclosed.spec.ts`: "an aborted request is Not verified, never Admit; Retry verification reuses the requestId and admits once"; "a request that outlasts the 12 s deadline shows the slow notice, then Not verified"; "a 503 from a busy server is Not verified and offers no retry of the stored verdict; the next scan is judged normally"; "offline, scanning pauses: manual entry cannot submit and nothing is sent; back online the same code is checked" | e2e | E |
| Failed or repeated requests create no duplicate records | `tests/product-api.test.ts`: "returns the stored result for a retried request instead of judging it again"; "keeps request ids per device: another scanner reusing an id gets its own judgement" | API | V |
| | `tests/concurrency.test.ts`: "the same request id sent from 10 threads at once yields one judgement and one scan row" | concurrency | C |
| | `tests/recovery.test.ts`: "persists every admission acknowledged before a SIGKILL that lands mid-burst (50 passes)" (an unacknowledged but committed admission is returned through `requestId` replay) | process recovery | R |
| | `tests/scanner-retry.test.ts`: "reuses the requestId of an unanswered scan of the same code, then starts fresh once answered"; "forgets unanswered scans after two minutes"; "keeps the requestId whenever the server may have judged the scan: no answer, any 5xx, or a 2xx that is not a verdict" | unit (client) | V |
| | `e2e/scanner-failclosed.spec.ts`: "after a lost response, entering the same code again replays the stored verdict: Admit, confirmed after reconnect"; "a gateway error after the server admitted is Not verified; the next scan of that code confirms the admission instead of "Already used"" (a 504 after the commit keeps the requestId) | e2e | E |
| | `scripts/load-test.ts` pattern `dup10` | load | L |
| | `tests/accounts-api.test.ts`: "refuses a requestId reused for a different pass instead of replaying the other pass’s verdict" (security review R10: 409) | API | V |
| A restart keeps admissions | `tests/recovery.test.ts`: "keeps an acknowledged admission across SIGKILL and restart; retries and re-scans are answered correctly" | process recovery | R |
| | `tests/recovery.test.ts`: "persists every admission acknowledged before a SIGKILL that lands mid-burst (50 passes)" | process recovery | R |
| | `tests/recovery.test.ts`: "stops gracefully on SIGTERM: exit code 0 and the WAL checkpointed into the main file" | process recovery | R on Linux only; skipped on Windows |
| | `tests/database.test.ts`: "keeps data across reopen without re-running migrations" | API | V |
| | `tests/journey.test.ts`: "runs the full admission journey, survives SIGKILL, and leaves a verifiable, consistent file" (real server process, organizer sign-up to door, SIGKILL and restart) | process recovery | V |
| | CI job `docker-run` (`.github/workflows/ci.yml`): enroll a scanner, admit, `docker restart`, pass still redeemed, backup, restore, graceful stop | docker | D (script run locally) |
| A restored backup is consistent with its audit log | `tests/recovery.test.ts`: "backs up while serving, restores to exactly the backup point and keeps the replaced files" (redemptions, scans, audit rows and revocations equal the backup point; later admissions gone, as documented) | process recovery | R |
| | `tests/recovery.test.ts`: "refuses a corrupt or non-database backup and leaves the current database untouched" | process recovery | R |
| | `tests/database.test.ts`: "backs up a live database, verifies it, and restores it" | API | V |
| | CI job `docker-run`: backup and restore of the real image | docker | D (script run locally) |

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
| Second device with the same setup link | Claiming a link that another device already claimed → refused | `tests/product-api.test.ts`: "lets exactly one of two racing devices claim a link" | API | V |
| Holder of an expired, superseded or revoked setup link | Enrollment → refused | `tests/product-api.test.ts`: "refuses expired, superseded and revoked links, and audits the enrollment" | API | V |
| Disabled platform admin | Reset links, renewed invitations and scanner setup links they still hold stop working | `tests/account-recovery.test.ts`: "disabling an administrator cancels the reset links, renewed invitations and scanner setup links they still hold (SR-03)" | API | V |
| Account created from a manager invitation while sign-up is closed | Creating or cloning events → refused until a platform admin allows it | `tests/account-recovery.test.ts`: "accounts created from a manager invitation cannot create or clone events until a platform admin allows it" (security review R6); control: "keeps the old behaviour while sign-up is open" | API | V |
| Member who does not manage an invitation | Renewing it → refused | `tests/account-recovery.test.ts`: "only lets people who manage the invitation renew it" | API | V |

Not covered by a named test: a platform admin attempting event writes (only reads and the export are probed), and one manager acting on another manager's membership.

## Security tests

| Threat | Test file: test name | Type | Result |
| --- | --- | --- | --- |
| Role escalation | `tests/accounts-api.test.ts`: "lets a manager run operations but not change lifecycle, team, ownership or export attendee data" (ownership transfer, invitations, platform invitations) | API | V |
| | `tests/accounts-api.test.ts`: "lets only the operator reset a platform administrator, and a password change cancels open reset links" | API | V |
| | `tests/account-recovery.test.ts`: "without email: needs a written reason, is audited with it, and leaves a notice that a password change cannot hide"; "with email: using a link someone else created notifies the owner’s own mailbox"; "with email: the link goes only to the account address, never to the administrator" (security review R2) | API | V |
| | `tests/account-recovery.test.ts`: "accounts created from a manager invitation cannot create or clone events until a platform admin allows it" (security review R6) | API | V |
| | `tests/accounts-api.test.ts`: "accepts an invitation exactly once, even when two acceptances race"; "refuses revoked and expired invitations"; "binds an invitation to its email: an existing account must be signed in as that email" | API | V |
| Cross-tenant access | `tests/accounts-api.test.ts`: "shows each organizer only their own events and answers 404 for anyone else’s"; "does not let a platform admin read organizers’ events through their role alone" | API | V |
| | `tests/policies-api.test.ts`: "refuses cross-event gates, policies and scanner bindings (IDOR)" | API | V |
| | `tests/product-api.test.ts`: "bulk-revokes only unused passes of the same event" | API | V |
| Token and credential disclosure | `tests/security-api.test.ts`: "never returns tokens or token hashes from list endpoints"; "never returns scanner keys after creation" | API | V |
| | `tests/database.test.ts`: "never stores raw tokens" | unit (schema) | V |
| | `tests/accounts-api.test.ts`: "stores only hashes of passwords and session ids"; "signs up with an HttpOnly, Secure, SameSite=Strict host-only cookie and never returns a credential in the body" | API | V |
| | `tests/redemption.test.ts`: "answers unknown and malformed tokens identically" | API | V |
| | `tests/tokens.test.ts`: "generates distinct 256-bit base64url tokens"; "hashes deterministically without revealing the token"; "compares secrets of different lengths without throwing" | unit | V |
| | `tests/product-api.test.ts`: "never puts the device key in the setup link; the link works exactly once" | API | V |
| | `tests/account-recovery.test.ts`: "answers the same for known and unknown addresses, emails only real active accounts, and limits requests per address"; "omits the link when the provider accepted the email, and a new link replaces the old one"; "reports refusals and timeouts as failures without logging the recipient or key" | API | V |
| | `tests/vercel-config.test.ts`: "builds a static-only preview with a 503 backend route and no production secret" | unit | V, P |
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
| | `tests/product-api.test.ts`: "never puts the device key in the setup link; the link works exactly once"; "lets exactly one of two racing devices claim a link"; "refuses expired, superseded and revoked links, and audits the enrollment" | API | V |
| | `tests/account-recovery.test.ts`: "cancels a reset link the provider did not accept"; "disabling an administrator cancels the reset links, renewed invitations and scanner setup links they still hold (SR-03)" | API | V |
| | `e2e/admission.spec.ts`: "organiser configures gates and a capped policy; door staff see admit, duplicate, wrong gate and full" (opening a second setup link on a set-up device asks "Replace this scanner's setup?") | e2e | E |
| Proxy-header spoofing | `tests/security-api.test.ts`: "ignores spoofed X-Forwarded-For when no proxy is trusted"; "rate-limits by the CDN-provided client IP, not by spoofable X-Forwarded-For"; "refuses requests without the origin secret when a CDN fronts the API"; "rejects configuration that would trust spoofed forwarding headers" | API | V |
| | `tests/invariants.test.ts`: "throttles failed authentication by the last x-vercel-forwarded-for entry, which the CDN appended" (SEC-03) | API | V |
| | `tests/vercel-config.test.ts`: "proxies /api and /p in production with the ORIGIN_SECRET transform" | unit | V |
| API abuse and rate limits | `tests/security-api.test.ts`: "rate-limits scans per device, so gates sharing one NAT address do not throttle each other"; "throttles failed authentication per IP without locking out valid credentials from that IP"; "maps malformed JSON and oversized bodies to 4xx" | API | V |
| | `tests/accounts-api.test.ts`: "throttles repeated failures for one account even across addresses, without locking out other accounts"; "gives the same answer for an unknown email and a wrong password, and audits failures"; "rejects weak passwords and refuses sign-up when registration is closed" | API | V |
| | `tests/accounts-api.test.ts`: "keeps a locked account locked even for the correct password (guessing from many addresses gains nothing)" | API | V |
| | `tests/security-api.test.ts`: "requires the admin token (CPU-heavy rendering is not public)"; "answers invalid input with 400 instead of 500" | API | V |
| | `tests/product-api.test.ts`: "throttles repeated bad codes from one address" (scanner enrollment) | API | V |
| | `tests/account-recovery.test.ts`: "answers the same for known and unknown addresses, emails only real active accounts, and limits requests per address"; "re-inviting an address renews its pending invitation instead of adding one, and caps emails per recipient" | API | V |
| Unauthorized exports | `tests/accounts-api.test.ts`: "lets a manager run operations but not change lifecycle, team, ownership or export attendee data" (three exports → 403); "shows each organizer only their own events and answers 404 for anyone else’s" (export → 404); "does not let a platform admin read organizers’ events through their role alone" (export → 404) | API | V |
| | `tests/product-api.test.ts`: "exports attendance with formula injection neutralised and records the download" (download audited) | API | V |
| | `e2e/accounts.spec.ts`: "owner invites a manager who can issue passes but not manage the team or export" | e2e | E |

The security review itself was static (no proof-of-concept execution); its findings and their status are in [security-and-threat-model.md](security-and-threat-model.md).

## Migration and recovery

| Requirement | Test file: test name | Type | Result |
| --- | --- | --- | --- |
| Populated v2 migration keeps every row and hash | `tests/migration.test.ts`: "preserves every row, hash, constraint and invariant, and keeps legacy passes and keys working" | API (database) | R |
| v3 → v4 migration (accounts, pre-enrollment scanner keys) | `tests/migration.test.ts`: "keeps accounts able to create events, keeps issued scanner keys working, and lets them move to one-time setup links" | API (database) | V |
| A bad migration rolls back | `tests/migration.test.ts`: "rolls back a migration that would leave a foreign-key violation, leaving the version unchanged"; "commits each migration on its own: a failing later migration leaves the upgrade from version 2 intact and itself fully rolled back" | API (database) | R |
| An existing pre-migration backup does not block start-up (DB-03) | `tests/migration.test.ts`: "opens and migrates when a pre-migration backup from an earlier failed attempt already exists (DB-03)" | API (database) | R |
| Older migrations and schema guard | `tests/database.test.ts`: "upgrades a version 1 database with data, keeps old passes valid and backs it up first"; "rolls back a failing migration completely"; "refuses to open a database written by a newer schema" | API (database) | V |
| Maintenance commands never migrate an older file (ORCH-03) | `tests/invariants.test.ts`: "verify reports a schema-3 rollback copy as not current and leaves it at version 3, byte for byte; backup copies it without migrating" | process recovery (CLI) | V |
| Rollback across the schema 3 → 4 migration | `scripts/rollback-rehearsal.sh` (old and new Docker images on a throwaway volume) | docker | D: 9/9 checks |
| Corrupt database is not replaced | `tests/database.test.ts`: "fails loudly on a corrupt database file instead of replacing it" | API (database) | V |
| Readiness: health reflects the database and the build | `tests/security-api.test.ts`: "reports an unavailable database through the health check"; "is not ready while the database schema differs from the build (half-applied deploy or wrong file)"; "reports the build commit for release checks and tags every response with a request id" | API | V |
| | `tests/vercel-config.test.ts`: "serves /version.json with Cache-Control: no-store before the filesystem phase" | unit | V |
| | `scripts/release-check.ts` | release check | RC |
| Crash, restart, backup, restore | see [Data-integrity acceptance tests](#data-integrity-acceptance-tests): "A restart keeps admissions" and "A restored backup is consistent with its audit log" | process recovery | R |

## Browser end-to-end tests

`playwright.config.ts` defines four projects. `mobile-chrome` runs only `e2e/onboarding.spec.ts`. Codes are entered through the scanner's manual entry field; no camera is involved.

Locally the server runs with `TRUST_PROXY=loopback` and each Playwright project sends its own `X-Forwarded-For` address, so the per-address rate limits stay on and are counted per project (see `playwright.config.ts`).

| Spec: test | chromium | firefox | webkit | mobile-chrome (Pixel 7) |
| --- | --- | --- | --- | --- |
| `e2e/onboarding.spec.ts`: "a first-time organiser is guided from a new event to \"Ready for doors\"" | Pass | Pass | Pass | Pass |
| `e2e/admission.spec.ts`: "organiser configures gates and a capped policy; door staff see admit, duplicate, wrong gate and full" (includes the "Replace this scanner's setup?" confirmation) | Pass | Pass | Pass | not run |
| `e2e/admission.spec.ts`: "revoked passes and revoked scanner devices are refused at the door" | Pass | Pass | Pass | not run |
| `e2e/admission.spec.ts`: "expired passes are refused once their expiry passes, and the pass page says so" | Pass | Pass | Pass | not run |
| `e2e/accounts.spec.ts`: "owner invites a manager who can issue passes but not manage the team or export" (includes sign-out) | Pass | Pass | Pass | not run |
| `e2e/accounts.spec.ts`: "CSV import previews rejected duplicates, and the attendance export lists the admitted attendee" | Pass | Pass | Pass | not run |
| `e2e/journey.spec.ts`: "organiser sets up an event in the UI; a phone admits by the printed reference; dashboard and pass page agree" | Pass | Pass | Pass | not run |
| `e2e/scanner-failclosed.spec.ts`: "an aborted request is Not verified, never Admit; Retry verification reuses the requestId and admits once" | Pass | Pass | Pass | not run |
| `e2e/scanner-failclosed.spec.ts`: "a request that outlasts the 12 s deadline shows the slow notice, then Not verified" | Pass | Pass | Pass | not run |
| `e2e/scanner-failclosed.spec.ts`: "a 503 from a busy server is Not verified and offers no retry of the stored verdict; the next scan is judged normally" | Pass | Pass | Pass | not run |
| `e2e/scanner-failclosed.spec.ts`: "after a lost response, entering the same code again replays the stored verdict: Admit, confirmed after reconnect" | Pass | Pass | Pass | not run |
| `e2e/scanner-failclosed.spec.ts`: "a gateway error after the server admitted is Not verified; the next scan of that code confirms the admission instead of \"Already used\"" | Pass | Pass | Pass | not run |
| `e2e/scanner-failclosed.spec.ts`: "a device revoked mid-session is signed out at its next server answer (401), without admitting" | Pass | Pass | Pass | not run |
| `e2e/scanner-failclosed.spec.ts`: "offline, scanning pauses: manual entry cannot submit and nothing is sent; back online the same code is checked" | Pass | Pass | Pass | not run |
| `e2e/scanner-failclosed.spec.ts`: "re-opening a used setup link on a working scanner keeps its key: the phone can still scan" | Pass | Pass | Pass | not run |
| Recorded run (E) | 15/15 | 15/15 | 15/15 | 1/1 |

Run on the local built server (Windows host), 46/46 in 54.4 s. Not run against a deployed URL from this branch.

## Docker

| Check | Where defined | Result |
| --- | --- | --- |
| Image builds (`linux/amd64`) | `Dockerfile`; CI job `docker-run` | D: built locally |
| Scanner enrollment, restart persistence, backup, restore, graceful stop | CI job `docker-run` | D: script run locally on 2026-11-15; passed |
| Rollback across the schema migration | `scripts/rollback-rehearsal.sh` | D: old = `4a6ba5c` (schema 3), new = schema 4; 9/9 checks |
| Multi-arch build (`linux/amd64`, `linux/arm64`) | CI job `docker` | Not run locally |
| Recovery tests on Linux | `tests/migration.test.ts`, `tests/recovery.test.ts` in `node:24-bookworm-slim` | R: 10/10, twice (2026-11-10/11) |

## Concurrency: what the history check shows

`tests/concurrency.test.ts` runs each redemption in its own worker thread (`tests/threads.ts`, `redeemHistory`), and each worker opens **its own SQLite connection** to the same file (`tests/fixtures/redeem-worker.mjs`). Workers report ready and block on `Atomics.wait`; the main thread releases them all at once, so their transactions contend for SQLite's write lock. Each worker records an invocation instant just before calling `GatePass.redeem` and a response instant just after it returns, both as `performance.timeOrigin + performance.now()`.

`singlePassViolations` in `tests/threads.ts` checks the resulting history of one pass against the sequential specification "the first redemption admits, every later one is `already_redeemed`", using the real-time-order condition of Herlihy and Wing (1990): if operation A responded before operation B was invoked, A must come before B in any valid linearization. For this object that reduces to two conditions:

1. exactly one operation returned `admitted`;
2. no operation returned `already_redeemed` with a response instant earlier than the admitting operation's invocation instant (it would have to be ordered before the admission, when the pass was still unused).

Any outcome other than `admitted`, `already_redeemed` or `busy` is also reported as a violation. `busy` (a lock wait beyond `busy_timeout`, which the API answers with 503 and the scanner shows as "Not verified") is treated as an operation that took no effect; the test separately asserts that the number of `scans` rows equals the number of non-`busy` attempts, that there is one `redemptions` row and one admitted scan, and that `verifyDatabase` reports no violations.

What this is and is not:

- It is **evidence about the histories observed** in these runs (2, 25 and 100 threads, plus the 400 ms lock-holder test, which applies the same check; run C), on one Windows laptop, with in-process calls to `GatePass.redeem` rather than HTTP. A passing run means none of those observed histories violated the condition. The HTTP mapping of a held write lock (503, then one admission on retry with the same requestId) is tested separately in `tests/invariants.test.ts` (DB-06).
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
| TypeScript | 7.0.2 |
| Vitest | 5.1.0 |
| SQLite | 3.51.2 |
| Linux runs | Docker on the same machine: container `node:24-bookworm-slim` (run R); the `docker-run` script and `scripts/rollback-rehearsal.sh` (run D) |
| Browsers | Playwright's bundled Chromium, Firefox and WebKit; versions not recorded |

Full host details for the load tests (OS build, disk model, database pragmas, background load) are in [performance.md](performance.md#host-configuration).

## Not verified

- **Physical devices.** Camera scanning, the readiness checklist, the camera test code and installing the scanner have not been tried on a real iPhone or Android phone (no devices available). Playwright uses Chromium's fake camera (runs E4, E5) and Pixel 7 emulation; neither counts as device verification. Use the [manual checklist](#manual-real-device-acceptance-checklist) below together with the Phase 5 additions in [physical-device-checklist.md](physical-device-checklist.md) (PWA install and reopen, screen lock and unlock, revocation while locked, slow backend, camera switching, low light, network loss and recovery).
- **Printed badges.** Badge QR readability was checked on PDF renders (run PR4), not on paper from a real printer.
- **`release-verify.yml` against the new release.** It runs on schedule and manual dispatch only. One scheduled run on `main` succeeded (run 43998983005, against `8b86114`); it has not run against a deployment of PR #15.
- **Live email delivery.** No Resend key, sending domain or `PASS_DELIVERY_KEY` was available. Invitations, resets and attendee pass email are tested against fake providers (`account-recovery`, `deliveries`, `shutdown`); no message has been sent through Resend.
- **Durable hosting target.** A Render instance with a persistent disk, or a VM, has never been exercised; the container rehearsal (D4) used a local Docker volume. Production still runs the free demo (`demo: true`, RC4).
- **Load on a hosted instance.** All performance numbers are from the laptop. No hosted instance has been load-tested.
- **SIGTERM on Windows.** Windows has no catchable SIGTERM for a child process, so the graceful-stop tests are skipped there; they run on Linux (R4, CI).
- **Client path of the setup retry (SA2-3)** is covered by `e2e/enroll-retry.spec.ts` (4 tests × chromium, firefox, webkit, mobile-chrome: 16/16, twice) in emulation only.

## Manual real-device acceptance checklist

Run once on an iPhone with Safari and once on an Android phone with Chrome. Record every step in the results table; a step passes only if every expectation in it is observed.

### Preparation

1. A deployment reachable over **HTTPS** (the camera is blocked on plain HTTP), built from the commit under test. Write down the commit.
2. As an owner: one `active` event whose window contains the test time, one scanner device with a fresh **one-time setup link** that has not been opened yet (it works once and expires after an hour; create it shortly before the run), and at least four passes: A (valid), B (valid), C (revoked), D (valid, used for the reconnect step). Print the passes or show them on a second screen at normal brightness. Note pass A's 8-character reference.
3. A second event with one valid pass E (for the wrong-event case).
4. A second scanner device in the first event with its own unopened setup link (for step 22).
5. Phone: site permissions for the deployment reset (never asked before), sound on, ring/silent switch off on iPhone.

### Steps

| # | Step | Expected |
| --- | --- | --- |
| 1 | Open the one-time scanner setup link. | "Setting up this device…" briefly, then the scanner page for the event; the setup code (the link carries a code, not a key) is removed from the address bar; the viewfinder shows "Tap to start scanning". Footer reads "Decoder: starts with the camera". |
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
| 18 | After a "Not verified" (from a timeout, or from a server or gateway error), present the same code again immediately. | It is checked again at once (no 12 s suppression after "Not verified"). If the failed attempt had reached the server, the verdict is "Admit" with the note "Confirmed after reconnect", never "Already used". |
| 19 | Rotate to landscape and scan a new valid pass. | Layout usable in landscape: viewfinder, overlay and buttons fully visible; verdict readable. Rotate back. |
| 20 | VoiceOver (iPhone) / TalkBack (Android) on. Scan an already used pass, keep it out of view for more than 12 s, then scan it again. | Each verdict is announced (verdict, reason, name), including the second of two identical consecutive verdicts; the result overlay can be reached and dismissed with the screen reader. |
| 21 | Turn the camera off with the "Camera" button. | "Camera off. Use manual entry below."; manual entry still works. |
| 22 | Open the second device's setup link on this phone, which is already set up. | A dialog asks "Replace this scanner's setup?" with the buttons "Use the new setup" and "Keep the current setup". "Keep the current setup" returns to the scanner unchanged. |
| 23 | Open the first setup link (already used in step 1) in a private tab. | No scanner session: "This setup link is invalid, expired or already used. Ask the organiser for a new setup link." |

### Results

Copy one row per device run. Mark each step P (pass), F (fail, add a note) or N/A (with reason).

| Device | OS version | Browser and version | Date | Tester | Commit | 1 | 2 | 3 | 4 | 5 | 6 | 7 (decoder) | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 (variant) | 18 | 19 | 20 | 21 | 22 | 23 | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| iPhone: | iOS | Safari | | | | | | | | | | | | | | | | | | | | | | | | | | | |
| Android: | Android | Chrome | | | | | | | | | | | | | | | | | | | | | | | | | | | |

No row has been filled in yet.
