# Performance

What was measured, how, on which machine, and what the numbers do **not** tell you. Every number below comes from the runs listed under [Commands](#commands); nothing is extrapolated.

## Tools

| Script | What it does |
| --- | --- |
| `scripts/bench-server.ts` | Server half of both tools. Forked as a separate Node process: real `createApp` with `rateLimits: false` (the documented benchmark option), production `openDatabase` (WAL, `synchronous = FULL`, `busy_timeout = 5000`) on a file in a fresh temp directory, deleted afterwards. Reports host and database settings read back from its own connection. Runs the TypeScript sources through `tsx`, not the production bundle. |
| `scripts/bench.ts` (`npm run bench`) | Four fixed redeem scenarios against one event and one scanner (see [docs/testing.md](testing.md#benchmark)). |
| `scripts/load-test.ts` | Load test with N scanners, M passes, several client counts and three traffic patterns, persisted-state checks after every run, plus the `synchronous` FULL vs NORMAL micro-benchmark. Writes JSON and a Markdown table to `--out` (default `.local/perf/`, git-ignored). |

`scripts/load-test.ts` only ever talks to the server it starts itself on `127.0.0.1`; it has no option to point it at a deployed host.

### Load-test method

- **Server:** `scripts/bench-server.ts` in its own process, so the load generator does not share the server's event loop. Rate limits are disabled through `createApp({ rateLimits: false })`; with them on, each scanner key is limited to 240 redeems/min, which a throughput test exceeds within seconds.
- **Provisioning:** every run gets a fresh event (window from one hour ago to six hours ahead, status `active`), N scanners and M passes, created through the API with the operator bearer token.
- **Clients:** *C* async loops share one request queue; loop *i* always uses scanner key *i* mod N. Each loop sends its next request when the previous response has arrived (closed loop). keep-alive `fetch` over loopback. Every request carries a fresh `requestId` (as the scanner app does), so no request is a replay.
- **Patterns:**
  - `distinct`: each of the M passes is scanned once.
  - `dup10`: each pass once, plus a re-scan of every 10th pass placed 1–50 positions after the original (seeded PRNG), so some re-scans are in flight at the same time as the first scan. Expected: M admitted, M/10 `already_redeemed`.
  - `onepass`: 100 clients on ONE pass, 5 requests each (500 requests). Expected: 1 admitted, 499 `already_redeemed`.
- **Measured per run:** requests; outcomes from 2xx bodies; non-2xx responses by status; network errors; latency (request start to parsed JSON body) p50/p95/p99/max, nearest-rank; throughput = requests ÷ wall-clock time of the run.
- **Checks after every run:** the database file is opened read-only in the load-test process and `verifyDatabase` (SQLite `integrity_check`, `foreign_key_check`, the nine admission invariants in `src/server/integrity.ts`) must pass; admitted responses must equal the event's `redemptions` rows; 2xx responses must equal the event's `scans` rows. A run that fails any check is marked `FAIL` and the script exits with code 1.
- **Warm-up:** one `distinct` run with 10 clients is executed first and discarded (its checks must still pass).

### Durability micro-benchmark method

- In-process, no HTTP, one connection. Each trial opens a fresh temp database with the production `openDatabase` (which sets `synchronous = FULL`); for the NORMAL trials the script then runs `PRAGMA synchronous = NORMAL` on that same connection and reads the value back. Server code is not changed.
- Seeds one event, one scanner and 2,100 passes through `GatePass`, runs 100 redeems as warm-up, then times 2,000 `GatePass.redeem(scanner, token, requestId)` calls back to back (each one `BEGIN IMMEDIATE … COMMIT` transaction), then runs `verifyDatabase`.
- 5 trials per mode; the order alternates (FULL first in odd trials, NORMAL first in even ones) so drift does not favour one mode.

## Host configuration

Recorded by the scripts (`host` and `serverDatabase` in the JSON output):

| Item | Value |
| --- | --- |
| OS | Windows_NT 10.0.26300 x64 |
| CPU | Intel(R) Core(TM) i7-14650HX, 24 logical cores |
| RAM | 15.7 GiB |
| Node | v24.14.1 |
| SQLite | 3.51.2 (`select sqlite_version()` on the server connection) |
| Disk holding the temp database | SAMSUNG MZVL21T0HCLR-00BH1, NVMe, SSD (`C:\Users\TANMAY\AppData\Local\Temp`) |
| Server database settings | `journal_mode = wal`, `synchronous = FULL`, `busy_timeout = 5000` |
| Network | loopback only |

The machine was not idle: other development processes ran during the measurements, including a TypeScript type check (7.6 s) started during the HTTP part of the load test. Outliers such as the `distinct`, 10 clients, repetition 2 row (p99 286.92 ms) may come from that interference; this was not isolated. Laptop power plan and thermal state were not controlled. Windows Defender real-time scanning of the temp directory was not checked.

## Commands

| Command | Started (UTC) | Wall time |
| --- | --- | --- |
| `npx tsx --disable-warning=ExperimentalWarning scripts/load-test.ts --repeat 3 --out .local/perf` | 2026-11-09 19:22 (report date `2026-11-09T19:22:45.084Z` written at the end) | 277.30 s |
| `npm run bench` | 2026-11-09 19:23 (report date `2026-11-09T19:23:20.877Z`) | 32.31 s |

Load-test defaults used: M = 2,000 passes per run, N = 10 scanners, client counts 1, 10, 50, 100, `onepass` with 100 clients × 5 rounds, 3 repetitions; micro-benchmark 2,000 redeems × 5 trials per mode.

## Results

### HTTP load test, `synchronous = FULL` (production setting)

Median of the 3 repetitions per configuration (each repetition is listed in the full table below):

| Pattern | Clients | Requests per run | req/s (3 runs) | median req/s | median p50 ms | median p99 ms | worst max ms |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| distinct | 1 | 2000 | 214, 252, 257 | 252 | 3.61 | 19 | 231.22 |
| distinct | 10 | 2000 | 273, 213, 284 | 273 | 34.27 | 83.45 | 448.14 |
| distinct | 50 | 2000 | 282, 277, 268 | 277 | 176.88 | 331.48 | 338.89 |
| distinct | 100 | 2000 | 286, 278, 280 | 280 | 348.8 | 546.05 | 1014.09 |
| dup10 | 1 | 2200 | 233, 252, 246 | 246 | 3.57 | 17.36 | 229.25 |
| dup10 | 10 | 2200 | 258, 272, 261 | 261 | 33.48 | 74.6 | 467.63 |
| dup10 | 50 | 2200 | 270, 282, 289 | 282 | 173.71 | 283.6 | 378.41 |
| dup10 | 100 | 2200 | 244, 282, 267 | 267 | 356.15 | 574.69 | 1028.98 |
| onepass | 100 | 500 | 295, 332, 267 | 295 | 323.85 | 382.58 | 604.54 |

All 27 runs: 0 non-2xx responses, 0 network errors, every persisted-state check passed. Full output of the run:

| Pattern | Clients | Rep | Requests | Admitted | Already redeemed | Other outcomes | HTTP errors | Network errors | p50 ms | p95 ms | p99 ms | max ms | req/s | Checks |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| distinct | 1 | 1 | 2000 | 2000 | 0 | 0 | 0 | 0 | 4.18 | 5.96 | 13.33 | 231.22 | 214 | pass (redemptions 2000, scans 2000) |
| distinct | 10 | 1 | 2000 | 2000 | 0 | 0 | 0 | 0 | 34.49 | 50.66 | 65.61 | 132.86 | 273 | pass (redemptions 2000, scans 2000) |
| distinct | 50 | 1 | 2000 | 2000 | 0 | 0 | 0 | 0 | 173.08 | 210.58 | 331.48 | 333.79 | 282 | pass (redemptions 2000, scans 2000) |
| distinct | 100 | 1 | 2000 | 2000 | 0 | 0 | 0 | 0 | 337.24 | 526.63 | 546.05 | 604.04 | 286 | pass (redemptions 2000, scans 2000) |
| dup10 | 1 | 1 | 2200 | 2000 | 200 | 0 | 0 | 0 | 3.87 | 6.29 | 16.77 | 145.85 | 233 | pass (redemptions 2000, scans 2200) |
| dup10 | 10 | 1 | 2200 | 2000 | 200 | 0 | 0 | 0 | 34.56 | 56.59 | 74.6 | 256.39 | 258 | pass (redemptions 2000, scans 2200) |
| dup10 | 50 | 1 | 2200 | 2000 | 200 | 0 | 0 | 0 | 185.38 | 205.31 | 283.6 | 285.84 | 270 | pass (redemptions 2000, scans 2200) |
| dup10 | 100 | 1 | 2200 | 2000 | 200 | 0 | 0 | 0 | 394.83 | 511 | 574.69 | 971.99 | 244 | pass (redemptions 2000, scans 2200) |
| onepass | 100 | 1 | 500 | 1 | 499 | 0 | 0 | 0 | 323.85 | 373.13 | 382.58 | 604.54 | 295 | pass (redemptions 1, scans 500) |
| distinct | 1 | 2 | 2000 | 2000 | 0 | 0 | 0 | 0 | 3.61 | 4.67 | 19 | 58.08 | 252 | pass (redemptions 2000, scans 2000) |
| distinct | 10 | 2 | 2000 | 2000 | 0 | 0 | 0 | 0 | 34.27 | 107.43 | 286.92 | 448.14 | 213 | pass (redemptions 2000, scans 2000) |
| distinct | 50 | 2 | 2000 | 2000 | 0 | 0 | 0 | 0 | 176.88 | 237.66 | 318.86 | 325.62 | 277 | pass (redemptions 2000, scans 2000) |
| distinct | 100 | 2 | 2000 | 2000 | 0 | 0 | 0 | 0 | 348.8 | 506 | 598.07 | 1014.09 | 278 | pass (redemptions 2000, scans 2000) |
| dup10 | 1 | 2 | 2200 | 2000 | 200 | 0 | 0 | 0 | 3.49 | 4.56 | 17.36 | 229.25 | 252 | pass (redemptions 2000, scans 2200) |
| dup10 | 10 | 2 | 2200 | 2000 | 200 | 0 | 0 | 0 | 33.48 | 56.63 | 64.66 | 81.29 | 272 | pass (redemptions 2000, scans 2200) |
| dup10 | 50 | 2 | 2200 | 2000 | 200 | 0 | 0 | 0 | 171.25 | 196.84 | 345 | 362.16 | 282 | pass (redemptions 2000, scans 2200) |
| dup10 | 100 | 2 | 2200 | 2000 | 200 | 0 | 0 | 0 | 338.55 | 483.13 | 500.21 | 651.01 | 282 | pass (redemptions 2000, scans 2200) |
| onepass | 100 | 2 | 500 | 1 | 499 | 0 | 0 | 0 | 297.74 | 317.95 | 327.84 | 328.9 | 332 | pass (redemptions 1, scans 500) |
| distinct | 1 | 3 | 2000 | 2000 | 0 | 0 | 0 | 0 | 3.41 | 4.3 | 20.59 | 141.67 | 257 | pass (redemptions 2000, scans 2000) |
| distinct | 10 | 3 | 2000 | 2000 | 0 | 0 | 0 | 0 | 31.35 | 58.45 | 83.45 | 148.5 | 284 | pass (redemptions 2000, scans 2000) |
| distinct | 50 | 3 | 2000 | 2000 | 0 | 0 | 0 | 0 | 180.31 | 281.99 | 335.94 | 338.89 | 268 | pass (redemptions 2000, scans 2000) |
| distinct | 100 | 3 | 2000 | 2000 | 0 | 0 | 0 | 0 | 353.76 | 422.59 | 450.02 | 597.33 | 280 | pass (redemptions 2000, scans 2000) |
| dup10 | 1 | 3 | 2200 | 2000 | 200 | 0 | 0 | 0 | 3.57 | 4.48 | 22.52 | 173.75 | 246 | pass (redemptions 2000, scans 2200) |
| dup10 | 10 | 3 | 2200 | 2000 | 200 | 0 | 0 | 0 | 32.39 | 58.26 | 77.06 | 467.63 | 261 | pass (redemptions 2000, scans 2200) |
| dup10 | 50 | 3 | 2200 | 2000 | 200 | 0 | 0 | 0 | 173.71 | 188.68 | 225.61 | 378.41 | 289 | pass (redemptions 2000, scans 2200) |
| dup10 | 100 | 3 | 2200 | 2000 | 200 | 0 | 0 | 0 | 356.15 | 578.86 | 639.1 | 1028.98 | 267 | pass (redemptions 2000, scans 2200) |
| onepass | 100 | 3 | 500 | 1 | 499 | 0 | 0 | 0 | 358.59 | 421.51 | 422.81 | 423.14 | 267 | pass (redemptions 1, scans 500) |

### `npm run bench`, `synchronous = FULL`

| Scenario | Requests | Concurrency | p50 ms | p95 ms | p99 ms | max ms | req/s | Outcomes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| sequential, 1000 unique passes | 1000 | 1 | 3.59 | 4.63 | 9.71 | 127.71 | 257 | admitted 1000 |
| 5000 unique passes | 5000 | 50 | 183.46 | 230.9 | 336.39 | 353.38 | 263 | admitted 5000 |
| one pass, 100 simultaneous scans | 100 | 100 | 163.33 | 319.2 | 332.33 | 332.33 | 296 | admitted 1, already_redeemed 99 |
| 1000 passes racing for capacity 250 | 1000 | 100 | 336.51 | 372.57 | 381.67 | 657.03 | 291 | admitted 250, capacity_full 750 |

### Durability cost: `synchronous = FULL` vs `NORMAL`

Same load-test command (sync part). One connection, `GatePass.redeem` back to back, no HTTP:

| synchronous | Trial | Redeems | mean ms | p50 ms | p95 ms | p99 ms | max ms | txn/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| FULL | 1 | 2000 | 3.191 | 2.81 | 3.83 | 11.04 | 51.05 | 313 |
| NORMAL | 1 | 2000 | 0.727 | 0.51 | 1.1 | 10.16 | 19.64 | 1376 |
| NORMAL | 2 | 2000 | 0.635 | 0.42 | 0.71 | 8.94 | 125.63 | 1575 |
| FULL | 2 | 2000 | 2.919 | 2.72 | 3.39 | 9.04 | 65.06 | 343 |
| FULL | 3 | 2000 | 2.863 | 2.69 | 3.19 | 8.29 | 49.71 | 349 |
| NORMAL | 3 | 2000 | 0.513 | 0.28 | 0.63 | 9.33 | 17.5 | 1949 |
| NORMAL | 4 | 2000 | 0.467 | 0.25 | 0.61 | 8.63 | 14.91 | 2140 |
| FULL | 4 | 2000 | 2.826 | 2.57 | 3.58 | 9.02 | 134.04 | 354 |
| FULL | 5 | 2000 | 2.828 | 2.62 | 4.41 | 8.68 | 47.67 | 354 |
| NORMAL | 5 | 2000 | 0.519 | 0.34 | 0.65 | 9.42 | 12.09 | 1927 |

Median of trial means: FULL 2.863 ms, NORMAL 0.519 ms per redeem transaction (FULL/NORMAL = 5.52). Median throughput: FULL 349 txn/s, NORMAL 1,927 txn/s.

## Reading the results

- **Correctness held under every load tested.** 27 HTTP runs, 0 errors, `verifyDatabase` passed after each, admitted responses always equalled redemption rows, 2xx responses always equalled scan rows. `onepass`: exactly 1 admission out of 500 requests from 100 clients in each repetition; `dup10`: exactly 2,000 admissions and 200 `already_redeemed` per run, including re-scans racing their original.
- **On this machine the commit's flush to disk is the bottleneck.** With `synchronous = FULL` a redeem transaction took a median of 2.863 ms in-process versus 0.519 ms with NORMAL. HTTP throughput stayed between 213 and 332 req/s whether 1 or 100 clients were sending, which is in the range of the in-process FULL ceiling (313–354 txn/s). One process with one SQLite writer handles redemptions one at a time, so more clients add queueing, not throughput: at 100 clients the median p50 was 348.8 ms (`distinct`), close to 100 ÷ 280 req/s ≈ 357 ms (Little's law).
- **Rejected scans cost the same as admissions.** `already_redeemed` still writes a `scans` row and commits, so `onepass` (499 of 500 rejected) ran at 267–332 req/s, like the admitting patterns.
- **What FULL buys.** In WAL mode, NORMAL syncs only at checkpoints: a committed transaction survives an application crash but may be rolled back after an OS crash or power loss; FULL syncs the WAL on every commit, so an admission that the door was told about survives power loss as well ([SQLite: PRAGMA synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous)). The measured price on this laptop is about 2.3 ms more per redemption (2.863 − 0.519 ms, medians) and roughly a 5.5× lower single-writer ceiling. This is a Windows NVMe figure: the cost of a flush depends on OS, file system, disk and its cache policy and was not measured anywhere else.
- **Comparison with older numbers.** [docs/testing.md](testing.md#benchmark) records 2,315–2,464 req/s from `npm run bench` on 2026-11-07 with `synchronous = NORMAL`. That run was made before this branch changed the schema and the redeem path (for example the `requestId` lookup and the event-wide capacity claim), so the difference to today's 257–296 req/s cannot be attributed to the pragma alone; the in-process micro-benchmark above is the like-for-like comparison.

## Limits: what these numbers do not establish

- **They are laptop numbers.** A 24-thread desktop-class CPU and a local NVMe SSD over loopback, with no TLS, no reverse proxy, no CDN and no phone network in the path. Clients were closed-loop scripts, not scanner phones.
- **They do not describe the deployed Render free instance.** That service (plan free, 1 instance) gets 0.1 CPU, sleeps after 15 minutes without traffic and takes about 50 seconds to wake on the next request, and it has no persistent disk, so the database does not survive a restart or redeploy at all. None of that was measured here, and no number in this document should be read as its capacity.
- **No event size is claimed.** These runs show that admission stayed correct and how latency grew with up to 100 concurrent closed-loop clients on this laptop. They do not show how many attendees, gates or scans per hour any deployment can handle.
- **Not measured:** the production bundle (`node dist/server/index.js`) instead of `tsx`; Linux or arm64; Docker; any network latency; TLS; the Vercel front; databases larger than a few tens of thousands of passes; long runs (WAL growth and checkpoints over hours); sustained load with rate limits on.

### What to measure on a target host before relying on it

1. On the host itself, with the temp databases on the persistent volume the server will use (both scripts create them under `os.tmpdir()`, so set `TMPDIR` on Linux): `npx tsx --disable-warning=ExperimentalWarning scripts/load-test.ts --part sync`. The per-commit cost of `synchronous = FULL` on that disk bounds the single-writer throughput.
2. The HTTP load test on the host (`--part http`, client counts matching the expected number of gate devices), and separately the latency from a phone on the venue network to the public URL, including TLS and any proxy.
3. CPU share: a 0.1-CPU instance must be measured, not scaled from these numbers.
4. Cold start: time from the first request after idle to a successful `/api/health` and a successful redeem, if the host sleeps.
5. Behaviour while `backup <file>` runs and across a restart under load.
