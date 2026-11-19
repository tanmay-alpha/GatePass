# GatePass TODO

Open work only, by priority. Finished items live in [docs/engineering-audit.md](docs/engineering-audit.md) (per finding) and [docs/test-matrix.md](docs/test-matrix.md) (evidence). Each item has a testable acceptance criterion; an item is done only when that criterion has been observed and recorded.

Priorities: **P0** lost or duplicate admissions, authorization failures, data loss · **P1** unreliable scanning, access control gaps, deployment failure, key journeys · **P2** reporting, organizer features, polish, performance · **P3** informational.

Owners are the audit areas: A database/recovery, B security, C UI/scanner, D product, E deployment/CI, O orchestrator, **Owner** = repository owner decision.

Baseline for this list: `main` at `8b86114` (PR #14, schema 4) plus branch `feat/phase4-features` (PR #15, schema 6) after the Phase 5 review of 2026-11-17/18.

Closed in Phase 5 (details in the engineering audit, "Phase 5 review"): **UX-R1** and **OPS-UI1** were already fixed in `782bf49` (empty Alerts card, pass list heading, Revoke style, `describedBy()`, Assisted admissions tile); the tracker was stale. OPS-UI1 now also has its browser test (`e2e/operations-dashboard.spec.ts`). **MAIL-03** (fair email scheduling) is fixed (M-05). **DB-10** is fixed as far as the laptop can show: the summary yields between its queries and is shared between dashboards; redeem p95 under dashboards is recorded in [performance.md](docs/performance.md#2026-11-17-phase-5-large-events-exports-and-the-door), and the host measurement stays under LOAD-01.

## P0

| ID | Item | Owner | Status | Acceptance criterion |
| --- | --- | --- | --- | --- |
| INF-05 | Durable storage for real events. The live API (`gatepass-api`, Render) was on the **free plan with no disk** at the last API read (2026-11-15). On 2026-11-17 `/api/health` reported `demo: true`, schema 4, commit `8b86114`; the plan could not be re-read (no `RENDER_API_KEY` on this machine). Every restart or deploy erases all data. | Owner, E | **BLOCKED — owner approval.** Three options in the [runbook](docs/deployment-runbook.md): A new Render Starter service + 1 GB disk (≈ $7.25/month), B upgrade the demo service in place (same cost), C single Docker host with Caddy ($0 on an Oracle Always Free VM). Container rehearsals passed 2026-11-17 (restart persistence, SIGTERM, schema 5→6 rollback). | On the chosen target: admit a pass, redeploy/restart, the pass is still `redeemed`, a re-scan says `already_redeemed`, `verify` exits 0; `/api/health` shows no `demo`; `DEMO_MODE=false`. Recorded in the test matrix. |
| OPS-01 | Off-host backups for the durable target. | E | BLOCKED on INF-05 (procedure and `scripts/offsite-backup.sh` ready). | A scheduled backup runs, passes `verify`, lands off the host, and a restore rehearsal from that copy on a scratch volume shows the expected admissions. |

## P1

| ID | Item | Owner | Status | Acceptance criterion |
| --- | --- | --- | --- | --- |
| REL-02 | Merge PR #15 (phases 4 and 5, schema 6). | O, Owner | Open. Local evidence in the test matrix (Phase 5 runs). | All CI jobs on the PR head green; owner approves; merged. |
| REL-01 | Release verification on the live demo after PR #15 merges and Render deploys. | E | Pending merge. The 2026-11-17 read-only check passed 12/12 against **`8b86114`** (schema 4) — it does not verify the new release. | `scripts/release-check.ts` passes against production: `/version.json` commit = `/api/health` `build.commit` = merged SHA, schema 6; nondestructive smoke checks pass. |
| ORCH-01 | Camera scanning, readiness checklist, camera test code and the installable scanner on physical phones. | C, Owner | **UNVERIFIED — needs hardware.** Playwright emulation (Chromium fake camera, Pixel 7) does not count. Checklist: [docs/physical-device-checklist.md](docs/physical-device-checklist.md). | Every step of the checklist recorded P/F for one iPhone (Safari) and one Android phone (Chrome), with the commit tested. |
| MAIL-01 | Live transactional email (invitations, password resets, attendee passes). | Owner, B | Implemented and tested with fake providers. **Live delivery BLOCKED**: no Resend key, verified sending domain or `PASS_DELIVERY_KEY`. Resend's 24 h idempotency window and quota `Retry-After` behaviour are taken from its documentation, not observed. | With a verified domain: an invitation, a reset and an attendee pass arrive in a real inbox; the audit log shows `pass.email_accepted` with the provider id; a refused send shows the failure and a retry path; a `Retry-After` on a quota 429 is observed or its absence recorded. |
| LOAD-01 | Throughput on the chosen durable host. | A, E | Blocked on INF-05. Laptop numbers only, in [performance.md](docs/performance.md). | `scripts/perf-phase5.ts` (or `load-test.ts`) against the host: zero lost or duplicate admissions; redeem p95 alone, under dashboards and under 25k-row exports recorded. |
| BP-01 | Branch protection on `main` (currently none). | Owner | Recommendation updated with the current check names: [docs/branch-protection.md](docs/branch-protection.md). Not applied. | Required checks and review rules from the doc are active; `release-check` is **not** required (it would deadlock Render's `checksPass` trigger). |
| E2E-01 | WebKit `e2e/admission.spec.ts` "organiser configures gates…": in about 3 of ≈ 100 runs the "Device label" field is empty right after `fill` and "Add device" stays disabled (QA2-6). Also: under heavy CPU load the verdict overlay can close before the spec's 5 s assertion matches. | C | Open; cause not found (no code path clears the field). Not seen on the base build in 6 runs. | A trace of a failing run explains it; fixed in the app or the spec; 50 consecutive WebKit runs pass. |
| LOCAL-01 | Final local Windows suite encountered a native worker exit (`3221226505`), a password-derivation error (`Deriving bits failed`) and a recovery-process startup failure after test concurrency was bounded. | O | Unresolved; cause not established. Earlier recorded suites passed; do not describe this final local run as green. | Explain and resolve the native/runtime failures, then record a complete passing run on this host without retries hiding failures. |

## P2

| ID | Item | Owner | Status | Acceptance criterion |
| --- | --- | --- | --- | --- |
| ASSIST-01 | Door search budget: 300 attendee searches per device per 24 h (`ASSIST_DAILY_LIMIT`, `src/server/assist.ts`). | Owner | Value is a judgement call (limits guest-list scraping with a stolen device key). | Owner confirms or changes the value; door staff can still admit by scan or reference when it is used up (already true). |
| BADGE-01 | Badge sheets are A4 only (`@page size: A4`); US Letter printing is untested. | C, Owner | Open. | Owner decides whether Letter is needed; if so `BadgeSheetLayout.ts` takes a page size and `e2e/badges.spec.ts` checks Letter PDFs. |
| TPL-02 | Templates are private per account; a manager's saved template belongs to the manager. | D, Owner | Accepted (ADR 0011). Team-shared templates assessed in Phase 5: useful for repeat organizers, but needs a team/organisation concept GatePass does not have (teams are per event). | Owner decision; if yes, templates shared with an event's team keep private ones private. |
| SEC-06 | `scanId` is a global autoincrement (coarse platform scan volume visible to scanner devices). | B | Deferred: response contract change. | Scanner responses carry a per-event or random id; old clients keep working. |
| SR-07b | Failed operator-token attempts and bad invitation/reset tokens are throttled but not audited. | B | Deferred: auditing unauthenticated failures lets an attacker fill the audit log. | A bounded, aggregated audit record (count per window). |
| SR-09 | Child-entity 404 messages ("Pass not found") differ from "Event not found". | B | Deferred (random v4 ids). | Same 404 body for missing and foreign entities. |
| PROD-07 | Setup-checklist skips stored per browser. | D | Deferred. | Skips shared across the event team (stored server-side). |
| PERF-01 | Event-loop delay spikes of 400–700 ms seen with no admin load in both the base and the Phase 5 build (laptop). | A | Cause not found. | Spikes explained (GC, fsync, Windows timer) or removed; measured on the durable host. |
| CQ-01 | CodeQL alerts #5 (session cookie "clear-text storage"), #6 (SPA fallback rate limit, fixed on the branch) and #7–#10 (`user-controlled-bypass` on credential checks) on `main`. | B, Owner | Reviewed as false positives ([branch-protection.md](docs/branch-protection.md), engineering audit); not dismissed. | Owner dismisses with the recorded justification, or the alerts close. |

## P3

| ID | Item | Owner | Status | Acceptance criterion |
| --- | --- | --- | --- | --- |
| PERF-02 | Pass search uses `LIKE '%…%'` (22–35 ms at 25,000 passes, laptop). | A | Acceptable at this size. | Full-text search only if events grow well beyond 25,000 passes. |
| PERF-03 | Shared `styles.css` (41 KB) carries admin-only rules into the scanner. | C | Open. | Admin-only rules move to the admin chunk; scanner CSS shrinks; visual and axe specs green. |
| PERF-04 | A larger SQLite page cache halved the 25k operations summary in one (noisy) laptop run. | A | Not repeated on a quiet machine. | Measured on the durable host before changing `cache_size`. |
| DEP-02 | Five stale Dependabot branches. | Owner | Safe to delete; not deleted. | Branches removed. |
| PA-10 | Repository visibility (public). | Owner | Owner decision. | — |
| MFA-01 | WebAuthn/TOTP for organizer accounts; breached-password check. | B | Assessed, not started: use an established library (e.g. `@simplewebauthn/server` or an RFC 6238 TOTP implementation) behind a per-account opt-in; no blocker for current workflows. | Owners can require a second factor; sign-in tests cover it. |
| OFF-01 | Offline admission. | — | Not planned: the scanner never admits without a server answer, by design. The PWA caches only the app shell, scanner chunks and decoder. | An explicit conflict model approved by the owner first. |

## Needs owner approval

1. Durable storage: option A, B (≈ $7.25/month each) or C ($0 on an Always Free VM, operated by you) — unblocks INF-05, OPS-01, LOAD-01.
2. A Resend account and a verified sending domain; set `RESEND_API_KEY`, `MAIL_FROM` and `PASS_DELIVERY_KEY` on the backend — unblocks MAIL-01.
3. Whether self-registration should stay open on the public demo (`ALLOW_SIGNUP=true` today).
4. Apply the branch protection in [docs/branch-protection.md](docs/branch-protection.md) (BP-01).
5. Enable the Dependency graph, then set `DEPENDENCY_REVIEW=true` so the dependency-review job runs.
6. Dismiss or keep the false-positive CodeQL alerts (CQ-01); delete the stale Dependabot branches (DEP-02).
7. The door search budget (ASSIST-01), Letter badge sheets (BADGE-01) and team-shared templates (TPL-02).
8. Physical-device testing (ORCH-01): one iPhone and one Android phone with the checklist.
