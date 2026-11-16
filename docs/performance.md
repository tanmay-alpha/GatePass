# Performance

What was measured, how, on which machine, and what the numbers do **not** tell you. Every number below comes from the runs listed under [Commands](#commands); nothing is extrapolated.

## Tools

| Script | What it does |
| --- | --- |
| `scripts/bench-server.ts` | Server half of both tools. Forked as a separate Node process: real `createApp` with `rateLimits: false` (the documented benchmark option), production `openDatabase` (WAL, `synchronous = FULL`, `busy_timeout = 5000`) on a file in a fresh temp directory, deleted afterwards. Reports host and database settings read back from its own connection. Runs the TypeScript sources through `tsx`, not the production bundle. |
| `scripts/bench.ts` (`npm run bench`) | Four fixed redeem scenarios against one event and one scanner (see [docs/testing.md](testing.md#benchmark)). |
| `scripts/load-test.ts` | Load test with N scanners, M passes, several client counts and three traffic patterns, persisted-state checks after every run, plus the `synchronous` FULL vs NORMAL micro-benchmark. Writes JSON and a Markdown table to `--out` (default `.local/perf/`, git-ignored). |
| `scripts/perf-phase7.ts` | Phase 7 run against the **built** server: builds client and server bundles into `.local/perf/build` (never `dist/`), reports browser bundle sizes, then runs one synthetic event (gates, policies, 10 scanners, 5,000 passes incl. a 2,000-row CSV import) against `node <bundle>` on a temp data dir and a free loopback port, with and without admin dashboards polling. See [2026-11-17](#2026-11-17-phase-7-built-server-synthetic-event). |
| `scripts/perf-server.ts` | Saturation server for `perf-phase7.ts`: the same start-up as `src/server/index.ts` with only `rateLimits: false`, bundled with the same `vite build --ssr` step and run with plain `node`. |

`scripts/load-test.ts` and `scripts/perf-phase7.ts` only ever talk to the servers they start themselves on `127.0.0.1`; they have no option to point them at a deployed host.

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
- **Comparison with older numbers.** The 2026-11-07 `npm run bench` run (recorded in git history of `docs/testing.md`) measured 2,315–2,464 req/s with `synchronous = NORMAL`. That run was made before this branch changed the schema and the redeem path (for example the `requestId` lookup and the event-wide capacity claim), so the difference to today's 257–296 req/s cannot be attributed to the pragma alone; the in-process micro-benchmark above is the like-for-like comparison.

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

## 2026-11-17: Phase 7, built server, synthetic event

**Developer-laptop numbers.** Everything below ran on the laptop described in [Host configuration](#host-configuration) over loopback, while other development processes (other agents' builds and test runs) were active. It is not a statement about the Render/Vercel deployment or about any production throughput; see [Limits](#limits-what-these-numbers-do-not-establish), which all apply here as well.

### What was run

Commit measured: `e75ff981224fe9b4aa57c6c4b36ea2b01c724a2c` ("Expand the operations dashboard: …"), built from a clean `git archive` of that commit, so uncommitted edits in the working tree were not part of the build.

```sh
# Build + both server kinds (one run ≈ 4 min); repeated twice:
npx tsx --disable-warning=ExperimentalWarning scripts/perf-phase7.ts --ref e75ff98 --out .local/perf/phase7
# Third run, production server only:
npx tsx --disable-warning=ExperimentalWarning scripts/perf-phase7.ts --ref e75ff98 --servers production --out .local/perf/phase7
npm audit --omit=dev
npm audit
```

Runs started 2026-11-16 20:51, 20:55 and 20:58 UTC (2026-11-17 local time). The script writes one JSON report per run (`.local/perf/phase7/perf-phase7-<time>.json`, git-ignored) and the Vite build log (`vite-client-build.txt`).

**Build.** The script builds into `.local/perf/build` (never `dist/`) with the same commands as `npm run build` (`vite build`; `vite build --ssr src/server/index.ts`), plus `scripts/perf-server.ts` with the same SSR bundler. The TypeScript check (`tsc --noEmit`) is not part of this build.

**Servers.** Each one is `node <bundle>` in its own process on a free `127.0.0.1` port, with a fresh temp data directory (`DATABASE_FILE` under `%TEMP%`, deleted afterwards), a clean environment (no `.env`, no mail key), `NODE_ENV=production` and request logging on (stdout read by the script).

| Server | Entry | Rate limits | Scanner traffic | Dashboards (segment 2) |
| --- | --- | --- | --- | --- |
| production | `.local/perf/build/server/index.js` (the production entry point) | on (per device 240 redeems/min; admin 600 req/min per IP) | each device one request at a time, paced at 3.5 scans/s (just under the per-device limit) = 35 scans/s for 10 devices | 3 dashboards, every 5 s (`LIVE_POLL_MS`); exports every 20 s |
| saturation | `.local/perf/build/perf-server/perf-server.js` (same start-up, only `rateLimits: false`) | off | closed loop: next request as soon as the answer arrives | 3 dashboards, every 1 s; exports every 5 s (5× the UI rate, a stress setting) |

**Synthetic event** (identical on both servers, seeded PRNG): 6 gates; policies *General* (gates 1–4), *VIP* (gates 5–6, capacity 450), *Staff* (any gate); 10 enrolled scanners bound to gates 1, 2, 3, 4, 5, 6, 1, 2, 3, 4. Passes: General 2,000 issued + 2,000 imported from a generated CSV, VIP 500, Staff 500, plus race passes (20 on production, 200 on saturation). Traffic: every pass is scanned once at an allowed gate; 541 passes are also re-scanned by a *different* allowed device at about the same queue position (cross-device duplicate race); 72 General passes are first shown at a VIP gate (`wrong_gate`). Segment 1 = first half of every device queue, no dashboards; segment 2 = second half, with dashboards. A dashboard cycle is `GET …/operations`, `GET …/scans?after=<last>&limit=100`, `GET …/passes?limit=50` (with `q=attendee 1` every other cycle), and every N cycles `attendance.csv` + `scans.csv`. Then the race: each race pass is sent by all 10 devices at the same moment. Then each admin endpoint 5× sequentially with no other traffic.

**Correctness checks (separate from timing), on a read-only connection after the traffic:** `verifyDatabase` (integrity, foreign keys, admission invariants); admitted responses = redemption rows = expected (every General/Staff/race pass + exactly 450 VIP); VIP redemption rows = 450; 2xx redeem responses = scan rows; no pass token received `admitted` twice; every race pass admitted exactly once.

### Correctness and errors

| Run | Server | Redeem requests | Admitted (expected) | `already_redeemed` | `wrong_gate` | `capacity_full` | Passes admitted twice | Race passes admitted exactly once | Non-2xx | 429 | 503 / `database busy` log lines | 5xx | Network errors | Checks |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 20:51 | production | 5,813 | 4,970 (4,970) | 735 | 49 | 59 | 0 | 20 / 20 | 0 | 0 | 0 / 0 | 0 | 0 | pass |
| 20:55 | production | 5,813 | 4,970 (4,970) | 735 | 49 | 59 | 0 | 20 / 20 | 0 | 0 | 0 / 0 | 0 | 0 | pass |
| 20:58 | production | 5,813 | 4,970 (4,970) | 735 | 49 | 59 | 0 | 20 / 20 | 0 | 0 | 0 / 0 | 0 | 0 | pass |
| 20:51 | saturation | 7,613 | 5,150 (5,150) | 2,355 | 49 | 59 | 0 | 200 / 200 | 0 | 0 | 0 / 0 | 0 | 0 | pass |
| 20:55 | saturation | 7,613 | 5,150 (5,150) | 2,358 | 46 | 59 | 0 | 200 / 200 | 0 | 0 | 0 / 0 | 0 | 0 | pass |

In every run VIP admissions stopped at exactly 450 and `verifyDatabase` reported no violation. One process holds the only write connection, so `SQLITE_BUSY` could only come from a second connection (for example a CLI backup); none was run here, and none occurred. The outcome split differs by a few requests in the second saturation run because a duplicate can reach the server before or after its original; the totals that matter (admissions, redemption rows) are fixed.

### Admission throughput and redeem latency

Latency = client-side, request start to parsed JSON, nearest-rank percentiles, ms. "Server p50/p95/p99" = the handler time from the server's own request log for all redeems of that run.

| Run | Server | Segment | Requests | req/s | p50 | p95 | p99 | max |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 20:51 | production | 1: scanning only | 2,781 | 23.6 | 4.62 | 486.49 | 4,903.74 | 6,798.60 |
| 20:51 | production | 2: + 3 dashboards / 5 s | 2,832 | 33.5 | 4.55 | 36.07 | 183.55 | 378.65 |
| 20:55 | production | 1: scanning only | 2,781 | 34.4 | 4.90 | 108.72 | 301.62 | 614.80 |
| 20:55 | production | 2: + 3 dashboards / 5 s | 2,832 | 33.5 | 4.28 | 20.33 | 156.29 | 348.19 |
| 20:58 | production | 1: scanning only | 2,781 | 34.3 | 7.64 | 18.75 | 30.23 | 890.57 |
| 20:58 | production | 2: + 3 dashboards / 5 s | 2,832 | 33.5 | 3.86 | 8.84 | 38.65 | 366.51 |
| 20:51 | saturation | 1: scanning only | 2,781 | 297.7 | 30.80 | 42.75 | 55.83 | 279.36 |
| 20:51 | saturation | 2: + 3 dashboards / 1 s | 2,832 | 232.4 | 36.11 | 77.26 | 89.73 | 118.10 |
| 20:55 | saturation | 1: scanning only | 2,781 | 345.7 | 26.90 | 36.05 | 42.38 | 261.75 |
| 20:55 | saturation | 2: + 3 dashboards / 1 s | 2,832 | 294.1 | 28.41 | 55.49 | 65.25 | 194.77 |
| 20:51 | production | race: 10 devices × 20 passes | 200 | 290.1 | 17.10 | 41.93 | 94.92 | 100.54 |
| 20:55 | production | race | 200 | 356.7 | 15.45 | 28.34 | 37.26 | 41.00 |
| 20:58 | production | race | 200 | 353.3 | 16.13 | 29.48 | 38.47 | 41.19 |
| 20:51 | saturation | race: 10 devices × 200 passes | 2,000 | 308.5 | 17.25 | 33.22 | 45.06 | 169.84 |
| 20:55 | saturation | race | 2,000 | 347.3 | 15.47 | 29.54 | 38.12 | 124.25 |

Server-side redeem handler time (whole run): production p50 2.9–3.6 ms, p95 4.3–14.1 ms, p99 12.9–219.7 ms, max 507–1,054 ms; saturation p50 2.5–2.9 ms, p95 3.2–3.6 ms, p99 10.8–13.6 ms, max 129–198 ms.

### Admin API while scanning and at rest

Client-side ms. "While scanning" = the dashboards' own requests in segment 2 (48 per endpoint on production, 29–36 on saturation, 5–12 per export); range over the runs. "At rest" = median of 5 sequential calls after all traffic, range over the five server runs; the data set then held 5,020 passes / 5,813 scans (production) or 5,200 / 7,613 (saturation).

| Endpoint | Response size | At rest p50 (5 runs) | While scanning, production: p50 / p95 | While scanning, saturation: p50 / p95 |
| --- | ---: | ---: | --- | --- |
| `GET …/operations` | 13 kB | 30.9–53.0 | 25.4–43.9 / 37.7–268.3 | 53.0–73.6 / 74.2–103.0 |
| `GET …/scans?after&limit=100` (feed) | 34 kB | — | 7.2–13.6 / 17.4–101.1 | 33.2–39.9 / 46.5–60.3 |
| `GET …/scans?limit=200` | 68 kB | 5.6–10.6 | — | — |
| `GET …/passes?limit=50` | 21 kB | 6.9–16.0 | 8.0–12.8 / 11.9–36.6 | 35.0–44.3 / 51.2–65.8 |
| `GET …/passes?limit=50&q=attendee 1` | 21 kB | 6.7–13.4 | (in the row above) | (in the row above) |
| `GET …/passes?limit=50&status=active` | 17 kB | 10.0–19.1 | — | — |
| `GET …/passes?limit=5000` | 2.0 MB | 26.9–46.8 | — | — |
| `GET …/audit?limit=500` | 212–216 kB | 5.6–12.1 | — | — |
| `GET …/exports/attendance.csv` | 0.88–0.90 MB | 26.3–49.4 | 26.8–42.5 / 37.4–159.7 | 54.6–75.6 / 58.9–94.2 |
| `GET …/exports/scans.csv` | 0.41–0.54 MB | 21.4–51.8 | 20.1–36.9 / 26.2–79.8 | 49.0–61.8 / 54.3–74.5 |
| `GET …/exports/audit.csv` | 214–221 kB | 8.6–15.8 | — | — |

Server-side handler time of `GET …/operations` over each whole run: p50 25.0–43.8 ms (production), 26.2–40.2 ms (saturation).

### CSV import, 2,000 rows

Generated file: 2,000 rows + header, 82,933 bytes, every 7th name quoted with an embedded comma and quotes; all 2,000 accepted, 0 rejected, policy General. Request body 122,426 bytes; the commit response (every issued pass with its token and link) is 1,006,408 bytes.

| Step | Range over 5 runs |
| --- | --- |
| Parse in Node (`parseCsv` + `attendeesFromCsv` from `src/client/csv.ts`, median of 5) | 0.73–2.31 ms |
| `POST …/passes/import` with `dryRun: true` (client-side) | 6.0–9.9 ms |
| `POST …/passes/import` commit, one transaction (client-side) | 30.8–99.7 ms |
| same commit, server handler time | 28.0–95.1 ms |

For comparison, issuing 500 passes by count took 10.5–12.3 ms per request (client-side p50). Browser parse time was not measured; the in-Node figure only shows the parser's algorithmic cost.

### Memory (server process)

Windows working set (`Get-Process`: `WorkingSet64`, `PeakWorkingSet64`), MiB, range over the 5 server runs:

| Point | RSS | Peak so far |
| --- | ---: | ---: |
| idle after start | 79.5–85.5 | 112.2–117.9 |
| after provisioning ~5,000 passes + import | 94.9–101.9 | 112.2–117.9 |
| after segment 1 (scanning only) | 82.2–102.0 | 112.2–117.9 |
| after segment 2 (scanning + dashboards + exports) | 146.1–176.8 | 157.2–186.0 |
| after the at-rest API timings | 154.4–176.5 | 181.5–189.6 |

Database at the end: 7.6–8.9 MiB plus a 4.2 MiB WAL. These are single samples; a leak would need a long run to show and none was made.

### Browser bundle

`vite build` of `e75ff98` (Vite 8.3.8, 2,138 modules). Gzip −9 and Brotli q11 computed by the script; Vite's own gzip column is shown for the files it reports.

| Asset | Raw bytes | gzip −9 | Brotli | Vite's gzip | When the browser loads it |
| --- | ---: | ---: | ---: | ---: | --- |
| `assets/index-*.js` (one chunk: public pass page, admin and scanner) | 472,531 | 139,241 | 117,671 | 140.72 kB | every page |
| `assets/index-*.css` | 60,758 | 12,215 | 10,709 | 12.33 kB | every page |
| `assets/zxing_reader-*.wasm` | 946,860 | 411,054 | 321,338 | 414.30 kB | only on `/scan` when the native `BarcodeDetector` is missing or fails (`src/client/qr-detector.ts`) |
| 7 Inter `woff2` subsets | 218,512 | — (already compressed) | — | — | per `unicode-range`; Latin pages need the latin subset (48,256) [INFERENCE: browser subset selection not measured] |
| `index.html`, `version.json` | 676 | — | — | 0.30 / 0.07 kB | every page |

### `npm audit` (2026-11-17, npm 11.11.0, working-tree `package-lock.json`)

| Command | info | low | moderate | high | critical |
| --- | ---: | ---: | ---: | ---: | ---: |
| `npm audit --omit=dev` | 0 | 0 | 0 | 0 | 0 |
| `npm audit` (99 prod, 171 dev, 80 optional dependencies) | 0 | 0 | 0 | 0 | 0 |

The committed lockfile of the measured commit `e75ff98` also reported 0 vulnerabilities with `npm audit --package-lock-only`, with and without `--omit=dev`.

### Reading the results

- **Correctness held in every run:** 0 passes admitted twice across 32,665 redeem requests in five server runs, including 541 cross-device duplicates per run and 460 race passes (20 or 200 per run) each sent by 10 devices at the same instant (exactly one admission each); VIP capacity held at exactly 450; 0 non-2xx, 0 `SQLITE_BUSY`/503, 0 rate-limit 429s on the production build at 35 scans/s.
- **Throughput:** with limits on, admission rate was set by the pacing (34.3–34.4 req/s for 10 devices; the 20:51 run fell to 23.6 req/s during a stall described below); the per-device limit (4 scans/s) is far above a human-operated door. With limits off, the built server took 298–346 req/s from 10 closed-loop devices, in the range of the 2026-11-09 `tsx` runs (213–332 req/s); the ceiling is still the per-commit flush of `synchronous = FULL` (server handler p50 2.5–3.6 ms per redeem).
- **Does dashboard polling move redeem p95?** Under saturation, yes, every time: 3 dashboards polling every second lowered throughput by 15–22% (298→232, 346→294 req/s) and raised redeem p95 by 54–81% (42.8→77.3, 36.1→55.5 ms). The admin handlers are synchronous SQLite calls on the same event loop (operations ≈ 25–44 ms, each CSV export ≈ 25–50 ms server-side), so a redeem that arrives during one waits for it. At the production pace with the real 5 s interval the effect was **not measurable** on this host: in all three runs segment 1 (no dashboards) had the *worse* p95 (18.8–486 ms against 8.8–36 ms), and redeem p50 stayed at 3.9–7.6 ms. Those segment-1 tails were stalls with no dashboard running: in the 20:51 run requests waited up to 6.8 s end to end while the slowest redeem handler of the whole run took 1,054 ms, so most of the wait was outside the handler (process or loopback scheduling, on the server or in the load generator, which shares the machine). The cause was not isolated; other agents' builds and test suites were running on the same laptop at the time [INFERENCE: contention, not GatePass code, is the likely cause].
- **Hotspot: `GET …/operations`.** It is the costliest request a dashboard repeats (every 5 s per open tab), ~40 ms at ~5,000 passes / 7,600 scans and growing with the number of scans, since most of its queries aggregate over all of the event's scans. A per-query profile of `operationsSummary` at `e75ff98` against the saturation database (5,200 passes, 7,613 scans; 39–41 ms per call, 10 calls) showed: the multi-gate alert query (`COUNT(DISTINCT s.gate_id) … GROUP BY s.pass_id` over all of the event's gate-bound scans, no time bound) 11.6 ms; the 15-minute timeline buckets (`strftime` per scan row) 6.4 ms; the event row with pass-count sub-selects 5.4 ms; per-gate totals 3.9 ms; repeated-duplicate alert (all `already_redeemed` scans, no time bound) 3.4 ms; pass totals 3.2 ms; 5-minute buckets 2.9 ms. Suggested changes (not made here, since other agents own `src/server/`): bound the two alert queries to a recent window, and/or cache the summary per event for 1–2 s so N open tabs cost one computation. CSV exports are the other blocking handlers (25–50 ms at this size); they would need chunked/streamed generation to stop delaying redeems at much larger events.
- **CSV import of 2,000 rows** is one 31–100 ms transaction; the 1 MB commit response is the largest single admin response apart from `passes?limit=5000` (2.0 MB, 27–47 ms).
- **Memory** stayed under 190 MiB peak working set with ~5,000 passes and repeated exports; idle ~80 MiB.
- **Bundle:** one 472.5 kB JS chunk (139 kB gzip) serves the pass page, the admin app and the scanner, so an attendee opening a pass link downloads the admin code too. Splitting the routes with dynamic `import()` would reduce the pass page and scanner download [INFERENCE: saving not measured]. The 947 kB ZXing WebAssembly decoder is loaded only when needed.

### Limits of this run

- The production pace (3.5 scans/s per device) is a machine-driven upper bound near the rate limit, not a model of real door traffic; the 5,000-pass event took ~2.8 minutes.
- The host was shared with other active development work (see the stalls above); laptop power plan *Balanced*, on AC power; Windows Defender scanning of `%TEMP%` not checked. CPU: 16 cores / 24 threads; RAM: 2 × 8 GiB DDR5-5600.
- Not measured: Linux/Docker, TLS, a proxy, a phone on Wi-Fi, events larger than ~5,200 passes, runs longer than a few minutes, `backup` during load, the 0.1-CPU Render instance.
