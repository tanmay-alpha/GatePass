# Implementation roadmap

Starting point: `main` at `4ff70f1f1db92b7d24f7a27e41c5f4db0f714c36` (2026-11-07). Work branch: `feat/accounts-durability-operations`. The per-finding tracker is [engineering-audit.md](engineering-audit.md); test evidence is in [test-matrix.md](test-matrix.md).

## Order of work and why

Admission correctness and data durability come before features, and features before visual polish. A prettier UI on top of a system that can lose or double an admission is worth nothing at the door.

| Milestone | Scope | Priority | State |
| --- | --- | --- | --- |
| 0. Audit | Five parallel audits (database, security, frontend/scanning, product, infrastructure) plus read-only inspection of Vercel and Render. | — | Done |
| 1. Admission integrity | `synchronous=FULL`; foreign-key check inside each migration transaction; no pre-migration backup crash loop; cross-event triggers on `policy_gates` updates and `redemptions`; immutable `redemptions`; revoked-scanner re-check under the write lock; idempotent redeem (`requestId`); `SQLITE_BUSY` → 503; graceful shutdown that closes idle sockets and the database. | P0/P1 | Done |
| 2. Recovery tooling | `verify` (integrity, foreign keys, nine admission invariants) and `restore` (verified, reversible) commands next to `backup`; migration from a populated v2 database; crash/restart tests against a real server process. | P0/P1 | Done |
| 3. Identity and access | Organizer accounts (scrypt), HTTP-only cookie sessions, CSRF header, per-event owner/manager roles enforced in the API (404 for non-members, 403 for missing permission), one-time invitations and password-reset links, platform administrators without access to event data, break-glass operator token kept out of the UI, security audit trail. | P1 | Done |
| 4. Event product | Lifecycle (draft/active/ended/archived), IANA time zone, event-wide capacity, clone, gate rename/delete, policy delete, server-side pass paging, RFC 4180 CSV import with dry-run preview and de-duplication, bulk revoke, printable passes, attendance/scan/audit CSV exports (owner only, audited), audit search. | P1/P2 | Done |
| 5. Scanning | Retry with the same `requestId`, decoding paused during results and offline, 12 s same-code suppression, camera fallback and per-error guidance, camera choice, torch, native → WebAssembly decoder fallback, accessible result dialog, reference-code manual entry, event-zone clock. | P1 | Done (physical devices not verified — see test matrix) |
| 6. Operations dashboard | Issued vs admitted from the passes table, capacity remaining, pass state summary, scanner health (heartbeat), plus the existing gates, policies, timeline and alerts. | P2 | Done |
| 7. Deployment | Vercel previews build static-only and never reach production; CI adds Windows, Firefox/WebKit, container restart-persistence; runbook with release gates and rollback. | P1 | Done in repository; production release follows the gates in [deployment-runbook.md](deployment-runbook.md) |
| 8. Durable hosting | Persistent-disk SQLite (ADR 0009). Requires owner approval of a paid Render instance + disk (or the free single-VM path). | P0 for real events | **Blocked on owner approval** — the live demo stays `DEMO_MODE=true` |

## Deferred (with reason)

| Item | Why deferred | What it needs |
| --- | --- | --- |
| Persistent disk on Render | Costs money; owner chose "no spend now" on 2026-11-10. | Owner approval (≈ $7.25/month per ADR 0007), then the steps in the runbook. |
| PostgreSQL | Not required by expected load or single-writer model; every query is synchronous `node:sqlite`; large rewrite (ADR 0009). | Revisit only for multi-instance or multi-region requirements. |
| Email delivery of invitations/resets | No provider configured; links are shown once to the inviter and copied manually. The UI says no email is sent. | A transactional email provider with opt-in, rate limits and bounce handling. |
| One-time scanner enrollment tokens (SEC-08) | Rotation (new) and revocation cover the lifecycle; enrollment would add a second token type. | Short-lived enrollment token exchanged for a device key. |
| MFA, breached-password API | Scope; a local common-password list and 10-character minimum are in place. | WebAuthn/TOTP; k-anonymity breached-password check. |
| Offline admission | Unsafe by default: the scanner never admits without a server answer. | An explicit conflict model and owner risk approval. |
| Distributed rate limiting | In-memory limits are correct for the single-process deployment. | A shared store if more than one instance ever runs. |
