# 0003 — Redemption atomicity: `BEGIN IMMEDIATE` plus database constraints

Status: accepted

## Context

Several door devices can scan the same pass (a forwarded screenshot) or different passes of one capacity-limited slot within the same millisecond. Exactly one scan of a pass may be admitted, and a slot may never admit more than its capacity, including when a second connection (the backup command, a test, a future worker) writes to the same file.

## Decision

`GatePass.redeem` (`src/server/gatepass.ts`) runs the whole decision in one `transaction()` from `src/server/db.ts`, which starts with `BEGIN IMMEDIATE`:

1. `BEGIN IMMEDIATE` takes SQLite's write lock before the first read. Any other writer waits (`busy_timeout = 5000` ms) and then reads the committed state.
2. Read the pass by token hash with its redemption row, the event window, and the policy with its gates; apply `evaluateAdmission`.
3. Capacity: `UPDATE admission_policies SET admitted_count = admitted_count + 1 WHERE id = ? AND (capacity IS NULL OR admitted_count < capacity)`. Zero changed rows → `capacity_full`.
4. `INSERT INTO redemptions … ON CONFLICT (pass_id) DO NOTHING`. One changed row is required; zero throws and rolls back (unreachable while step 1 holds the lock).
5. Insert the `scans` row and commit. Any error rolls back the counter, the redemption and the scan together.

The schema enforces the same rules independently: `redemptions.pass_id` is the primary key, and `admission_policies` has `CHECK (capacity IS NULL OR admitted_count <= capacity)`.

## Consequences

- Double admission and capacity overrun are prevented by the database even if the application rules were wrong.
- All redemptions are serialised through one writer. Under load, latency is queueing time, not work time (see [testing.md](../testing.md#benchmark)).
- A denied scan (`capacity_full`, `too_early`, …) changes nothing except the `scans` log, so the pass can be scanned again later.
- Tests: `tests/redemption.test.ts` "admits exactly one of 25 concurrent HTTP scans of the same pass"; `tests/database.test.ts` "admits a pass once when a second connection redeems it too", "admits exactly one of 8 simultaneous redemptions of one pass" and "never exceeds slot capacity when 12 different passes race for 5 places" (worker threads, one connection each, released together by `tests/threads.ts`); "allows at most one redemption row per pass" and "makes over-admitting a capacity-limited policy impossible even with direct SQL"; `tests/policies-api.test.ts` "stops at capacity under 30 concurrent HTTP scans of different passes".

## Alternatives

- **Optimistic check-then-insert in a deferred transaction** (`BEGIN`, `SELECT`, then `INSERT`). Two connections can both read "not redeemed". In WAL mode the second one's write then fails with `SQLITE_BUSY` (its read snapshot is stale) instead of waiting, so the caller gets an error and must retry, and the capacity counter read becomes a lost-update risk. `BEGIN IMMEDIATE` removes the race instead of detecting it.
- **Rely on the primary key alone.** Enough for single use, but capacity, the scan log and the reported outcome all depend on reads that must be consistent with the insert.
- **`SELECT … FOR UPDATE`.** SQLite has no row locks and does not support it; the database-level write lock taken by `BEGIN IMMEDIATE` is the SQLite equivalent.
- **Count redemptions per policy at scan time** instead of a counter. Discussed in [ADR 0004](0004-admission-policy-engine.md): correct under the lock but O(admitted) per scan, with the cap enforced only in application code.
