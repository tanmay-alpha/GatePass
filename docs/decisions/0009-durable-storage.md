# 0009 — Durable storage: SQLite single writer on a persistent disk

Status: accepted design. Durable hosting is not yet enabled: it waits for the owner's approval of the spend, and until then the live demo runs with `DEMO_MODE=true` and loses its data on every restart, deploy or idle spin-down.

## Context

The live backend is the Render service `gatepass-api` on the free plan: one instance, no disk (read-only inspection, 2026-11-10). Render free web services have an ephemeral filesystem (ADR 0007), so the SQLite file, and with it every account, session, pass and admission, is lost whenever the instance restarts. The demo shows a warning (`DEMO_MODE`), but a real event cannot run on it: an admission the door was told about must still be there after a restart, and the operator must be able to back up, check and restore the data.

Two ways to make the data durable were compared:

- **Option A**: keep SQLite (ADR 0001) with its single writer, and put the file on a persistent disk.
- **Option B**: move to PostgreSQL, run as a managed service or on the same host.

## Decision

**Option A.** SQLite through `node:sqlite`, exactly one process and one writer, the database file on a persistent volume mounted at `/data` (`DATABASE_FILE=/data/gatepass.db` in the image). The owner chose this on 2026-11-10 and decided not to spend money yet. On Render this means the Starter instance plus a 1 GB disk; the steps are in [deployment-runbook.md](../deployment-runbook.md#owner-approval-path-durable-storage). On the single-host path of ADR 0007 it is the `gatepass-data` Docker volume.

What makes Option A durable in the code:

- `PRAGMA synchronous = FULL` with WAL (`src/server/db.ts`): every commit syncs the WAL, so an acknowledged admission survives power loss as well as a process crash.
- Graceful shutdown finishes in-flight requests and closes the database, which checkpoints the WAL (`src/server/index.ts`).
- Maintenance CLI (`src/server/index.ts`, `src/server/integrity.ts`):
  - `backup <file>`: `VACUUM INTO` a new file, then `integrity_check` on the copy. Safe while the server runs.
  - `verify [file]`: read-only `integrity_check`, `foreign_key_check` and the admission invariants; exit 0 means no violations.
  - `restore <backup>`: with the server stopped, verifies the backup, keeps the current files as `<file>.replaced-<time>`, opens, migrates and verifies the restored file, and puts the old files back on any failure.
- Migrations take a verified backup before they run and refuse a file newer than the build (ADR 0001).

## Comparison

| | Option A: SQLite on a persistent disk | Option B: PostgreSQL |
| --- | --- | --- |
| Hosting cost | Render: Starter $7/month plus disk $0.25/GB/month, about $7.25/month for a 1 GB disk before overage (ADR 0007, from render.com/pricing checked 2026-11-07). The single-host path of ADR 0007 on an Oracle Always Free VM has no charge within the Always Free terms | The app host as in Option A plus a database. Render's free Postgres expires 30 days after creation (ADR 0007). A paid database was not priced in ADR 0007 and is not priced here |
| Migration work | None: the current code | Every query is synchronous `node:sqlite` (`DatabaseSync`; about 130 `prepare`/`exec` call sites in `src/server`). A Postgres driver is asynchronous, so every service method, the transaction helper and their callers become `async`; the schema (STRICT tables, triggers, partial indexes, `user_version` migrations) and the backup, verify and restore commands would be rewritten |
| Transaction semantics | See below: one writer, nothing to retry | See below: conditional updates or row locks, plus retries |
| Operations | One file; backups are files; no credentials, pool or second service | A second service to secure, upgrade and back up, a connection string secret and a connection pool |
| Several app instances | Not supported | Possible |

**Transactional semantics.** Every write runs in `transaction()` (`src/server/db.ts`), which starts with `BEGIN IMMEDIATE`: the write lock is taken before the first read, so read-then-write sequences (single use of a pass, policy and event capacity, `requestId` replay, the revoked-scanner re-check) cannot interleave with another writer (ADR 0003). Writers are totally ordered, and each redemption takes effect at its `COMMIT`. That commit is the linearization point in the sense of Herlihy and Wing, "Linearizability: a correctness condition for concurrent objects", ACM TOPLAS 12(3), 1990 ([doi:10.1145/78969.78972](https://doi.org/10.1145/78969.78972)): the history of redemptions is equivalent to a sequential one that respects real-time order. `tests/concurrency.test.ts` checks this for 2, 25 and 100 worker threads, each with its own connection, redeeming one pass: exactly one attempt is admitted, and no `already_redeemed` answer arrives before the admitting attempt was sent (`singlePassViolations` in `tests/threads.ts`).

PostgreSQL under its default READ COMMITTED isolation uses MVCC: two transactions can both read "not redeemed" or "capacity 6 of 7". The same guarantees would need each check rewritten as a conditional update (`UPDATE … WHERE admitted_count < capacity`, `INSERT … ON CONFLICT DO NOTHING` with the changed-row count checked) or a `SELECT … FOR UPDATE` row lock, chosen per invariant; or SERIALIZABLE isolation, where conflicting transactions fail with SQLSTATE `40001` and the application must retry them. Each path is a new place for a race that the current design does not have.

**Expected load.** All figures are from [performance.md](../performance.md) and were measured on one Windows laptop (local NVMe, loopback, no TLS); none was measured on Render or any other host. With `synchronous = FULL` the HTTP redeem throughput was about 213–332 req/s whether 1 or 100 clients were sending, with a median p50 of about 349 ms at 100 clients; `npm run bench` gave 257–296 req/s. A redeem transaction took a median of 2.863 ms in-process with FULL versus 0.519 ms with NORMAL. One writer handles redemptions one at a time, so on that machine the commit's flush is the ceiling and more clients add queueing, not throughput. The Render Starter instance (0.5 CPU) and its disk have not been measured; performance.md lists what to measure on a target host before relying on it.

**Concurrent scanners.** Many scanner devices talk to the one process. Its database calls are synchronous on one connection, so their redemptions run one after another; nothing has to be retried. With 100 separate connections in `tests/concurrency.test.ts` (not the deployed model) some attempts on the test laptop waited longer than `busy_timeout` (5 s) and failed closed with `SQLITE_BUSY`, which the HTTP layer answers with 503 and `Retry-After` (`src/server/http.ts`); none was admitted and nothing was written, so scanning again is judged afresh. A scan whose response never arrived is re-sent by the scanner with the same `requestId` (kept for 2 minutes), and the server returns its stored result instead of judging it a second time.

**Maintenance burden.** Option A: run `backup` before and after each event and copy the file off the host; run `verify` on backups; restore only with doors closed, because a restore drops every admission made after the backup ([deployment-runbook.md](../deployment-runbook.md#backup-verify-and-restore)). Upgrades of Node.js need care because `node:sqlite` is still experimental (ADR 0001). Option B adds database upgrades, credential rotation and the provider's backup tooling on top of the application's own.

## Consequences

- Correctness rests on one process and one writer. Running two app instances against the file is **not supported**. `tests/recovery.test.ts` shows that two server processes on one file still admit a pass exactly once out of 40 concurrent scans (the `SQLITE_BUSY` path was not exercised in that run), but rate limits and login throttles live in process memory and would not be shared.
- No horizontal scaling and no failover: one instance on one disk. On Render, attaching a disk also disables zero-downtime deploys (ADR 0007), so each deploy is a short outage.
- Durability is verified by tests, not on the target host: `tests/recovery.test.ts` (acknowledged admissions survive SIGKILL and restart, including a kill mid-burst; backup and restore through the CLI; corrupt, garbage and missing backups refused), run on Windows and on Linux in Docker, and a local Docker check (`docker restart`, the admitted pass still redeemed, `verify` reports 0 violations). Neither Render with a disk nor the single-host VM has been exercised.
- Until the owner approves the spend, the live demo stays non-durable and labelled (`DEMO_MODE=true`).

**Revisit this decision** if any of these becomes true: GatePass needs more than one app instance (availability or load); a measured target host cannot keep up with the expected gate traffic with `synchronous = FULL`; zero-downtime deploys become a requirement; or a hosting choice without a persistent disk is forced.

## Alternatives

- **Option B, PostgreSQL**, as compared above. Rejected for now: more cost and operations for one organiser's events, a rewrite of every query to async, and weaker default isolation that would need per-invariant locking or retry logic.
- **Stay on the free plan without a disk.** Data loss on every restart; acceptable only for the labelled demo.
- **Render's daily disk snapshots as the only backup.** Render advises against restoring snapshots of disks that back a database; the `backup`/`restore` commands are the supported path ([deployment-runbook.md](../deployment-runbook.md#backup-verify-and-restore)).
- **Lower `synchronous` to `NORMAL` for throughput.** About 5.5 times the single-writer ceiling on the test laptop, but in WAL mode a committed admission can be lost on an OS crash or power loss. Rejected: an admission the door was told about must persist.
