# 0001 — SQLite through `node:sqlite`, one process

Status: accepted

## Context

GatePass serves one organiser running one event (or a few) at a time. The door path needs transactions, constraints and an atomic single-use check (ADR 0003). The upstream project stored everything in a JSON file that was rewritten in place and replaced with an empty store on any parse error (see [audit.md](../audit.md)). The recommended host is a small ARM64 VM (ADR 0007), and the operator should not have to run a second service.

## Decision

- Store all data in one SQLite file opened with Node's built-in `node:sqlite` (`DatabaseSync`), in `src/server/db.ts`.
- Pragmas: `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`, `synchronous = FULL` (every commit syncs the WAL, so an acknowledged admission survives power loss; see [ADR 0009](0009-durable-storage.md)). All tables are `STRICT`; foreign keys are `ON DELETE RESTRICT`.
- Schema changes are an append-only migration list tracked by `PRAGMA user_version`. Each migration runs in one transaction with its version bump. An existing file is backed up (`VACUUM INTO` + `integrity_check`) before pending migrations run; a file with a newer version than the build is refused.
- Exactly one Node.js process uses the database file. Rate-limit state is in that process's memory.

## Consequences

- No native addon and no build toolchain: `npm ci --omit=dev` on `linux/arm64` installs pure JavaScript. The Docker runtime image needs nothing beyond `node:22-bookworm-slim`.
- Node.js 22.13 or newer is required (`engines` in `package.json`). `node:sqlite` is still marked experimental; its API may change between Node releases, and the start scripts hide the `ExperimentalWarning`.
- All database calls are synchronous. A slow query blocks the event loop, so the redeem path uses indexed single-row lookups only. Measured throughput is in [performance.md](../performance.md).
- One SQLite writer serialises all writes. That is the property the redemption logic relies on. Together with the single Node process and `synchronous = FULL`, it bounds throughput: the commit's flush to disk is the ceiling on the measured machine. Figures, and what they do not establish, are in [performance.md](../performance.md).
- No horizontal scaling, no replicas against the same file, no high availability. Backup is a consistent single-file copy (`node dist/server/index.js backup <file>`, which uses `VACUUM INTO`).
- The database must live on persistent storage. That rules out hosts with ephemeral filesystems (ADR 0007).

## Alternatives

- **PostgreSQL.** `SELECT … FOR UPDATE`, row locks and multi-process access would allow several app instances. It adds a second service to install, secure, back up and upgrade, plus a connection pool and credentials, for a workload one SQLite writer handles. Reconsider if GatePass needs more than one app instance.
- **`better-sqlite3`.** Mature and fast, with the same synchronous model. It is a native addon: it relies on a prebuilt binary matching the platform, libc and Node ABI, and otherwise compiles with `node-gyp` (Python, make, a C++ compiler). On ARM64 and on every Node major upgrade that is one more thing that can fail at install time. `node:sqlite` avoids it entirely.
- **Keep the JSON file.** No transactions, no constraints, no concurrent-write safety; rejected in the audit.
