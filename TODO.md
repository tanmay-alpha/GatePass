# GatePass TODO

Open work only, by priority. Finished items live in [docs/engineering-audit.md](docs/engineering-audit.md) (per finding) and [docs/test-matrix.md](docs/test-matrix.md) (evidence). Each item has a testable acceptance criterion; an item is done only when that criterion has been observed and recorded.

Priorities: **P0** lost or duplicate admissions, authorization failures, data loss · **P1** unreliable scanning, access control gaps, deployment failure, key journeys · **P2** reporting, organizer features, polish, performance · **P3** informational.

Owners are the audit areas: A database/recovery, B security, C UI/scanner, D product, E deployment/CI, O orchestrator, **Owner** = repository owner decision.

Baseline for this list: `main` at `8b86114` (PR #14 merged 2026-11-16) plus branch `feat/phase4-features` (PR #15, 2026-11-17).

## P0

| ID | Item | Owner | Status | Acceptance criterion |
| --- | --- | --- | --- | --- |
| INF-05 | Durable storage for real events. The live API (`gatepass-api`, Render) was on the **free plan with no disk** at the last API check (2026-11-15: `plan: free`, `disk: null`); on 2026-11-17 `/api/health` still reports `demo: true` (plan not re-read: no `RENDER_API_KEY` in this environment). Every restart or deploy erases all data. | Owner, E | **BLOCKED — owner approval** (≈ $7.25/month Render Starter + 1 GB disk, or a single-VM Docker host). Container rehearsal on schema 5 passed 2026-11-17 (named volume: enroll → admit → restart → still `redeemed`, re-scan `already_redeemed`, `verify` 0; backup restored into a second container/volume with the admission present). | On the chosen target: admit a pass, redeploy/restart, the pass is still `redeemed`, a re-scan says `already_redeemed`, `verify` exits 0; `/api/health` shows no `demo`; `DEMO_MODE=false`. Recorded in the test matrix. |
| OPS-01 | Off-host backups for the durable target. | E | BLOCKED on INF-05 (procedure and `scripts/offsite-backup.sh` ready; local backup→restore rehearsal passed 2026-11-17). | A scheduled backup runs, passes `verify`, lands off the host, and a restore rehearsal from that copy on a scratch volume shows the expected admissions. |

## P1

| ID | Item | Owner | Status | Acceptance criterion |
| --- | --- | --- | --- | --- |
| REL-02 | Merge PR #15 (phase 4) once required checks are green on GitHub (Ubuntu Node 22/24, Windows, e2e matrix, docker-run, CodeQL, gitleaks). | O | Open (draft). Local: typecheck clean; Vitest 415 passed / 4 skipped (Windows); SIGTERM tests 34/34 in a Linux container. | All CI jobs on the PR head green; owner approves; merged. |
| REL-01 | Release verification on the live demo after PR #15 merges and Render deploys. | E | Pending merge. 2026-11-17 read-only check against `8b86114` passed 11/11. | `scripts/release-check.ts` passes against production: `/version.json` commit = `/api/health` `build.commit` = merged SHA, schema 5; nondestructive smoke checks pass. |
| ORCH-01 | Camera scanning, the readiness checklist, the camera test code and the installable scanner on physical phones (iPhone Safari, Android Chrome). | C, Owner | Pending — needs hardware; Playwright emulation (Chromium fake camera, Pixel 7) does not count. | Every step of the [manual checklist](docs/test-matrix.md#manual-real-device-acceptance-checklist) recorded P/F for one iPhone and one Android phone, with the commit tested, including: install from the browser, readiness checklist all green, camera test code decoded without a redeem request. |
| MAIL-01 | Live transactional email (invitations, password resets, attendee passes). | Owner, B | Implemented and tested with fake providers. **Live delivery BLOCKED**: no Resend key, verified sending domain or `PASS_DELIVERY_KEY` on the backend. | With a verified domain: an invitation, a self-service reset and an attendee pass arrive in a real inbox; the audit log shows `email.sent` / `pass.email_accepted` with the provider id; a refused send shows the failure and a retry path. |
| LOAD-01 | Throughput on the chosen durable host. | A, E | Blocked on INF-05. Laptop numbers in [performance.md](docs/performance.md). | `scripts/perf-phase7.ts` (or `load-test.ts`) against the host: zero lost or duplicate admissions; p95 redeem latency recorded in `docs/performance.md`. |
| BP-01 | Branch protection on `main` (currently none). | Owner | Recommendation written: [docs/branch-protection.md](docs/branch-protection.md). Not applied (needs owner authorisation). | Required checks and review rules from the doc are active; `release-check` is **not** required (it would deadlock Render's `checksPass` trigger). |

## P2

| ID | Item | Owner | Status | Acceptance criterion |
| --- | --- | --- | --- | --- |
| UX-R1 | Review findings in feature files: empty Alerts card stretches beside the chart at ≥ 1181 px; pass list card has no heading; Revoke button style differs in stacked scanner rows; `aria-describedby` points at absent hint/error ids in EventForm, IssueForm, ImportPasses, SettingsPanel, SaveTemplateSection, TemplatePicker, PoliciesSection. | C | Open ([ui-review-2026-11.md](docs/ui-review-2026-11.md)); no axe violation. | Fixed with the overflow and axe specs still green; before/after screenshots. |
| OPS-UI1 | `OperationsSummary.assistedAdmissions` (admissions made through "Find attendee") is in the API but not shown on the dashboard. | D | Open. | Operations panel shows the count; e2e asserts it after a lookup admit. |
| MAIL-03 | Pass emails are sent in queue order across events; a large import delays other events' emails. | D | Accepted for now (2/s default). | Fair scheduling per event, or a documented limit; test with two events. |
| TPL-02 | Templates are private per account; a manager's saved template belongs to the manager. | D | Accepted (ADR 0011). | Owner decision on team-shared templates. |
| SEC-06 | `scanId` is a global autoincrement (coarse platform scan volume visible to scanner devices). | B | Deferred: response contract change. | Scanner responses carry a per-event or random id; old clients keep working. |
| SR-07b | Failed operator-token attempts and bad invitation/reset tokens are throttled but not audited. | B | Deferred: auditing unauthenticated failures lets an attacker fill the audit log. | A bounded, aggregated audit record (count per window) for failed operator/one-time-link attempts. |
| SR-09 | Child-entity 404 messages ("Pass not found") differ from "Event not found". | B | Deferred (random v4 ids). | Same 404 body for missing and foreign entities. |
| PROD-07 | Setup-checklist skips stored per browser. | D | Deferred. | Skips shared across the event team (stored server-side). |
| DB-10 | Operations summary runs on the request thread. | A | Deferred; dashboard queries measured 62–95 ms on a 10k-pass event (laptop). | p95 redeem latency unchanged while the dashboard polls on the target host. |
| CQ-01 | CodeQL alerts #5 (session cookie "clear-text storage") and #7–#10 (`user-controlled-bypass` on credential checks) on `main`. | B, Owner | Reviewed as false positives (see engineering audit, phase-4 section); not dismissed. | Owner dismisses with the recorded justification, or the code is changed and the alerts close. |

## P3

| ID | Item | Owner | Status | Acceptance criterion |
| --- | --- | --- | --- | --- |
| DEP-02 | Five stale Dependabot branches (`docker/build-push-action-7`, `docker/setup-buildx-action-4`, `types/node-26.6.6`, `typescript-7.0.2`, `vitest-5.1.0`): PRs closed, superseded on `main`. | Owner | Safe to delete; not deleted. | Branches removed. |
| PA-10 | Repository visibility (public). | Owner | Owner decision. | — |
| MFA-01 | WebAuthn/TOTP for organizer accounts; breached-password check. | B | Not started. | Owners can require a second factor; sign-in tests cover it. |
| OFF-01 | Offline admission. | — | Not planned: the scanner never admits without a server answer, by design. The PWA caches only the app shell. | An explicit conflict model approved by the owner first. |

## Needs owner approval

1. Spend ≈ $7.25/month on Render Starter + 1 GB disk (or choose and operate the single-VM Docker path) — unblocks INF-05, OPS-01, LOAD-01.
2. A Resend account and a verified sending domain; set `RESEND_API_KEY`, `MAIL_FROM` and `PASS_DELIVERY_KEY` on the backend — unblocks MAIL-01.
3. Whether self-registration should stay open on the public demo (`ALLOW_SIGNUP=true` today).
4. Apply the branch protection in [docs/branch-protection.md](docs/branch-protection.md) (BP-01).
5. Enable the repository's Dependency graph (Settings → Security), then set the repository variable `DEPENDENCY_REVIEW=true` so the dependency-review job in `security.yml` runs on pull requests.
6. Dismiss or keep the false-positive CodeQL alerts (CQ-01); delete the stale Dependabot branches (DEP-02).
