# GatePass TODO

Open work only, by priority. Finished items live in [docs/engineering-audit.md](docs/engineering-audit.md) (per finding) and [docs/test-matrix.md](docs/test-matrix.md) (evidence). Each item has a testable acceptance criterion; an item is done only when that criterion has been observed and recorded.

Priorities: **P0** lost or duplicate admissions, authorization failures, data loss · **P1** unreliable scanning, access control gaps, deployment failure, key journeys · **P2** reporting, organizer features, polish, performance · **P3** informational.

Baseline for this list: `main` at `4a6ba5c` (2026-11-15 audit) plus branch `feat/production-readiness`.

## P0

| ID | Item | Status | Acceptance criterion |
| --- | --- | --- | --- |
| INF-05 | Durable storage for real events. The live API (`gatepass-api`, Render) is still on the **free plan with no disk** (checked through the Render API on 2026-11-15: `plan: free`, `disk: null`), so every restart or deploy erases all data. | **BLOCKED — owner approval** (cost ≈ $7.25/month for Render Starter + 1 GB disk, or a free single-VM Docker host the owner operates). Deployment-ready: `render.yaml`, `docker-compose.yml`, runbook switch-over steps. | On the chosen target: admit a pass, redeploy/restart, the pass is still `redeemed`, a re-scan says `already_redeemed`, `verify` exits 0; `/api/health` shows no `demo`; `DEMO_MODE=false`. Recorded in the test matrix. |
| OPS-01 | Off-host backups for the durable target. | BLOCKED on INF-05 (procedure and `scripts/offsite-backup.sh` ready). | A scheduled backup runs, passes `verify`, lands off the host, and a restore rehearsal from that copy on a scratch volume shows the expected admissions. |

## P1

| ID | Item | Status | Acceptance criterion |
| --- | --- | --- | --- |
| ORCH-01 | Camera scanning on physical phones (iPhone Safari, Android Chrome). | Pending — needs hardware; Playwright emulation does not count. | Every step of the [manual checklist](docs/test-matrix.md#manual-real-device-acceptance-checklist) recorded P/F for one iPhone and one Android phone, with the commit tested. |
| MAIL-01 | Live transactional email (invitations, password resets). | Implemented behind `RESEND_API_KEY` + `MAIL_FROM`; tested with a fake provider. **Live delivery BLOCKED**: no Resend key or verified sending domain. | With a verified domain: an invitation and a self-service reset arrive in a real inbox; the audit log shows `email.sent` with the provider id; a refused send shows `email.failed` and returns the manual link. |
| REL-01 | Release verification on the live demo after this branch merges. | Pending merge. | `scripts/release-check.ts` passes against production: `/version.json` commit = `/api/health` `build.commit` = merged SHA; nondestructive smoke checks pass. |
| LOAD-01 | Throughput on the chosen durable host. | Blocked on INF-05. | `scripts/load-test.ts` against the host: zero lost or duplicate admissions; p95 redeem latency recorded in `docs/performance.md`. |

## P2

| ID | Item | Status | Acceptance criterion |
| --- | --- | --- | --- |
| MAIL-02 | Optional email delivery of attendee passes. | Deferred: needs a durable outbox and rate-limited worker (provider limits are a few messages per second; a 2,000-row import cannot be sent inside one request). | Issue/import with "email passes": every pass with an email gets one message, failures are listed and can be retried without duplicates. |
| SEC-06 | `scanId` is a global autoincrement (coarse platform scan volume visible to scanner devices). | Deferred: response contract change. | Scanner responses carry a per-event or random id; old clients keep working. |
| SR-07b | Failed operator-token attempts and bad invitation/reset tokens are throttled but not audited. | Deferred: auditing unauthenticated failures lets an attacker fill the audit log. | A bounded, aggregated audit record (count per window) for failed operator/one-time-link attempts. |
| SR-09 | Child-entity 404 messages ("Pass not found") differ from "Event not found". | Deferred (random v4 ids). | Same 404 body for missing and foreign entities. |
| PROD-07 | Setup-checklist skips stored per browser. | Deferred. | Skips shared across the event team (stored server-side). |
| PROD-12b | Multi-pass badge sheets for printing. | Deferred. | Print 8 passes per A4 page with readable QR codes. |
| DB-10 | Operations summary runs on the request thread. | Deferred until measured on the target host. | p95 redeem latency unchanged while the dashboard polls on the target host. |
| DEP-01 | Major dependency upgrades (TypeScript 7, Vitest 5, @types/node 26). | See the PR description for the evaluation results. | Upgrade only when typecheck, the full Vitest suite and the build pass unchanged. |

## P3

| ID | Item | Status | Acceptance criterion |
| --- | --- | --- | --- |
| PA-10 | Repository visibility (public). | Owner decision. | — |
| MFA-01 | WebAuthn/TOTP for organizer accounts; breached-password check. | Not started. | Owners can require a second factor; sign-in tests cover it. |
| OFF-01 | Offline admission. | Not planned: the scanner never admits without a server answer, by design. | An explicit conflict model approved by the owner first. |

## Needs owner approval

1. Spend ≈ $7.25/month on Render Starter + 1 GB disk (or choose and operate the free single-VM Docker path) — unblocks INF-05, OPS-01, LOAD-01.
2. A Resend account and a verified sending domain; set `RESEND_API_KEY` and `MAIL_FROM` on the backend — unblocks MAIL-01.
3. Whether self-registration should stay open on the public demo (`ALLOW_SIGNUP=true` today).
4. Enable the repository's Dependency graph (Settings → Security), then set the repository variable `DEPENDENCY_REVIEW=true` so the dependency-review job in `security.yml` runs on pull requests. Until then `npm audit` in CI covers known advisories.
