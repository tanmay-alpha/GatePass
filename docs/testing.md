# Testing

| Command | What it runs |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` over `src/`, `scripts/`, `tests/`, `vite.config.ts` and `vitest.config.ts` (`tsconfig.json`; `e2e/` and `playwright.config.ts` are not included). |
| `npm test` | `vitest run`: every `tests/**/*.test.ts` (`vitest.config.ts`). |
| `npm run test:e2e` | Playwright against the built server. Run `npm run build` first. |
| `npm run smoke:qr` | Renders a sample pass QR to `.local/smoke/`. |
| `npm run bench` | Redemption benchmark ([below](#benchmark)). |

CI (`.github/workflows/ci.yml`) runs typecheck, tests, build, the QR smoke test and `npm audit --audit-level=high` on Node 22 and 24, the Playwright suite on Node 22, and a `linux/amd64` + `linux/arm64` image build.

## Unit and integration tests (`npm test`)

Tests use file-backed SQLite databases in a temporary directory, not `:memory:`, so WAL mode, locking and multiple connections are real. `tests/helpers.ts` creates the database, a controllable clock (default 2030-06-01 18:30 UTC, inside the test event's 18:00–23:00 window) and seeded events, scanners and passes. HTTP tests call the Express app in process with supertest.

| File | What it proves |
| --- | --- |
| `tests/admission.test.ts` | The pure `evaluateAdmission` rules: default policy admits at any gate inside the event window; identity and pass state are checked before time, gate and capacity; the event window is start-inclusive and end-exclusive; a policy window overrides the event window and falls back to it for an open side; gate restriction applies only when both scanner and policy name gates; a full policy reports its capacity. |
| `tests/policies-api.test.ts` | Gates and policies through the API: duplicate names 409, inverted windows rejected; cross-event gates, policies and scanner bindings refused (IDOR); unused passes can move between policies, redeemed ones cannot; capacity cannot drop below admissions. At the door: `wrong_gate` with the allowed gate names; timed windows; **passes scanned before the event starts are `too_early`**; issuance refuses an expiry before the event start; exactly 10 of 30 concurrent HTTP scans admitted for capacity 10; a `capacity_full` scan does not consume the pass; no policy details for another event's pass. Operations dashboard: totals, per-gate and per-policy counts, timeline bucket and all four alert kinds. |
| `tests/redemption.test.ts` | Admit once, then `already_redeemed` with the original time; exactly one of 25 concurrent HTTP scans admitted; expiry boundary; revoked passes; empty, garbage, unknown and SQL-injection-style codes reported as `invalid` without details; another event's pass neither admitted nor revealed; `event_closed` after archiving; scanner session and cursor-based scan feed. Pass page: viewing never redeems; unknown and malformed tokens get identical 404 pages; names are HTML-escaped. |
| `tests/database.test.ts` | Schema-level guarantees: foreign keys, uniqueness and checks; at most one `redemptions` row per pass; the capacity `CHECK` rejects over-admission even through direct SQL; triggers reject cross-event references; events with passes cannot be deleted; raw tokens never stored. Migrations: a version 1 database with data is upgraded, backed up first to `<file>.pre-v2.bak`, and its passes, scanners and redemptions keep working; a failing migration rolls back completely; a database from a newer schema is refused. Persistence: data survives reopen; a corrupt file fails loudly and is not replaced; a failed batch issuance rolls back; backup, verification and restore. Concurrency across connections (see below). |
| `tests/events-api.test.ts` | Event create/list/update/archive; UTC normalisation; validation errors; inverted windows; 404s; anonymous and named issuance with custom expiry; batch limits (1–500); no issuance for archived events; search with escaped `LIKE` wildcards; idempotent revocation with audit entries; reissue invalidates the old token and keeps the pass ID. |
| `tests/security-api.test.ts` | Every admin route rejects no token, a wrong token, a scanner key, a raw token without `Bearer`, and Basic auth; the admin token is not a scanner key; revoked scanner keys fail immediately; keys, tokens and hashes never appear in list responses; generic 500s; health check 503 when the database is closed; security and `no-store` headers; malformed and oversized bodies return 4xx; redeem is limited per device (240/min), and 625 scans from one IP across 3 devices are not throttled by any per-IP limit; after 60 failed authentications from one IP further invalid admin and scanner attempts get 429, while valid admin and scanner credentials from the same IP still succeed; spoofed `X-Forwarded-For` ignored when no proxy is trusted; `ORIGIN_SECRET` enforcement; `TRUST_PROXY=true` and short `ORIGIN_SECRET` refused at config load; `/api/qr/custom` requires the admin token and returns 400 for invalid input. |
| `tests/tokens.test.ts` | Token format and uniqueness (1,000 tokens); deterministic hashing; token extraction from raw codes and pass URLs only; constant-time comparison of different-length secrets. |
| `tests/security.test.ts` | Pass design input: SVG attribute injection and non-preset logos rejected; unknown keys dropped. |
| `tests/qr-core.test.ts` | Retained upstream renderer: templates, logo presets, SVG and PNG output, PDF/EPS disabled, `gradientOnEyes`. |
| `tests/csv.test.ts` | Attendee CSV export (`src/client/csv.ts`): cells starting with `=`, `+`, `-`, `@`, tab or carriage return are prefixed with `'`; RFC 4180 quoting of commas, quotes and newlines; `null` → empty cell. |

### Thread-based contention tests

A single Node process cannot run two `node:sqlite` transactions at the same time (the API is synchronous), so in-process concurrent HTTP tests only prove ordering inside one connection. To make transactions genuinely contend for SQLite's write lock, `tests/threads.ts` (`redeemInThreads`) starts one worker thread per job running `tests/fixtures/redeem-worker.mjs`. Each worker opens **its own connection** to the same database file, reports ready, and blocks on `Atomics.wait` on a shared barrier; the main thread releases all workers at once with `Atomics.notify`. `tests/database.test.ts` uses it for:

- 8 workers redeeming one pass → exactly 1 `admitted`, 7 `already_redeemed`, 1 `redemptions` row, 8 `scans` rows;
- 12 workers redeeming different passes of a capacity-5 policy → exactly 5 `admitted`, 7 `capacity_full`, and `admitted_count` equals the number of `redemptions` rows.

The worker loads TypeScript sources through `tsx/esm/api`.

## End-to-end tests (`npm run test:e2e`)

`playwright.config.ts` starts the **built** server (`node dist/server/index.js`) on `http://127.0.0.1:3410` with a fixed test admin token and a fresh database under `.local/e2e/` (deleted and recreated by the main runner process on every run). Specs live in `e2e/` and run in Desktop Chrome (Chromium). Install the browser once with `npx playwright install chromium`. Codes are entered through the scanner's manual entry field (headless Chromium has no camera).

`e2e/admission.spec.ts`:

- organiser creates an event, two gates, a capacity-1 VIP policy bound to North and two gate-bound scanner devices in the admin UI; opening a setup link removes the key from the address bar; door staff see wrong gate (South), then admitted with the attendee name, already used and policy full (North), and an unknown code rejected as not valid for the event;
- a revoked pass is refused at the door, and revoking the scanner device returns the page to key entry;
- an expired pass is refused once its expiry passes, and the pass page says so.

```sh
npm run build
npm run test:e2e
```

## Benchmark

`npm run bench` runs `scripts/bench.ts`.

### Method

- `scripts/bench-server.ts` runs the real Express app in a **separate Node process** (forked), with a file-backed SQLite database (WAL, `synchronous = NORMAL`) in a fresh temp directory, deleted afterwards. Rate limits are off (`rateLimits: false`); nothing else differs from production code. It runs the TypeScript sources through `tsx`, not the production bundle.
- The load generator creates an event (window from one hour ago to six hours ahead), one unrestricted scanner and passes through the admin API, then measures `POST /api/scanner/redeem` with keep-alive `fetch` over loopback.
- Concurrency *N* = *N* async loops in the client, each sending its next request when the previous response arrives.
- Latency = request start to parsed JSON body. Percentiles are nearest-rank on the sorted latencies. req/s = completed requests ÷ wall-clock time of the scenario.
- A 300-request warm-up at concurrency 10 is run and discarded.
- Scenarios: sequential unique passes; unique passes at concurrency `BENCH_CONCURRENCY`; one pass scanned 100 times at concurrency 100; 1000 passes of a capacity-250 policy at concurrency 100.

Environment knobs:

| Variable | Default | Meaning |
| --- | --- | --- |
| `BENCH_SEQUENTIAL` | 1000 | Passes in the sequential scenario. |
| `BENCH_TOTAL` | 5000 | Passes in the concurrent scenario. |
| `BENCH_CONCURRENCY` | 50 | Concurrency of that scenario. |

```sh
npm run bench
BENCH_TOTAL=20000 BENCH_CONCURRENCY=100 npm run bench   # POSIX shell
```

The script prints JSON with the environment, the method and one result object per scenario.

### Results

Node v24.14.1, SQLite 3.51.2, Windows_NT 10.0.26300 x64, Intel Core i7-14650HX (24 logical CPUs), 16 GiB RAM, 2026-11-07. Server in a separate process, file-backed WAL database, rate limits off, keep-alive fetch over loopback, 300-request warm-up discarded.

| Scenario | Requests | Concurrency | p50 ms | p95 ms | p99 ms | max ms | req/s | Outcomes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| sequential, 1000 unique passes | 1000 | 1 | 0.55 | 0.83 | 4.17 | 8.59 | 1519 | admitted 1000 |
| 5000 unique passes | 5000 | 50 | 16.01 | 28.96 | 47.07 | 49.62 | 2464 | admitted 5000 |
| one pass, 100 simultaneous scans | 100 | 100 | 26.9 | 38.24 | 39.06 | 39.06 | 2457 | admitted 1, already_redeemed 99 |
| 1000 passes racing for capacity 250 | 1000 | 100 | 41.49 | 51.54 | 65.18 | 96.9 | 2315 | admitted 250, capacity_full 750 |

### Reading the results

- **Correctness under load:** exactly one admission for one pass under 100 simultaneous scans, and exactly 250 admissions for a capacity of 250 under 1000 racing scans.
- **Latency under concurrency is queueing, not work.** One Node process with one SQLite writer handles redemptions one at a time: a request costs about 0.4–0.7 ms of server time, and the rest of the latency is waiting behind other requests. The numbers fit Little's law: 50 in flight ÷ 2464 req/s ≈ 20 ms mean at concurrency 50; 100 ÷ 2315 ≈ 43 ms at concurrency 100 (p50 41.49 ms). More concurrency raises latency, not throughput.
- **Earlier run, before a fix.** The first run had the load generator and the server in one process, and `redeem` loaded the event through `getEvent()`, which computes per-event pass, attendee, redemption and revocation counts (O(passes) per scan). With 5000+ passes in the event it measured 273 req/s at concurrency 50 (p50 161.92 ms). `redeem` now reads only the event's window and status; the table above is after that change, with the server in its own process. The two runs differ in both respects, so the gain is not attributable to the query change alone.
- **Not measured:** ARM64 hardware (including the Oracle Ampere A1 target), real network latency between phones and the server, TLS and reverse-proxy (Caddy, Vercel) overhead, and the production bundle (`dist/server/index.js`) instead of `tsx`.

## Deployment verification (2026-11-07, temporary public HTTPS)

A staging check was conducted on a laptop (not a production host) using Docker Desktop and a temporary public HTTPS tunnel. The tunnel was torn down afterwards.

- **Setup:** Production Docker image (`linux/amd64`, built from this repo, `node dist/server/index.js`, non-root) on Docker Desktop (Windows host), named volume for `/data`, published on `127.0.0.1` only; public HTTPS via a Cloudflare quick tunnel (`trycloudflare.com`, no account, temporary URL) with `TRUST_PROXY=1` and `APP_PUBLIC_URL` set to the tunnel URL.
- **First attempt:** The quick tunnel over QUIC dropped its connection about every 2 minutes (`cloudflared` log: `'datagram manager error: timeout: no recent network activity'`), producing a Cloudflare 524 page and scanner requests stuck in 'Checking…'. Switching cloudflared to `--protocol http2` fixed it; the app itself logged no errors.
- **Playwright test run:** `E2E_BASE_URL=<tunnel> E2E_ADMIN_TOKEN=<token> npx playwright test`: all 3 specs passed over public HTTPS (organiser flow with gates/policy/scanners incl. wrong gate, admit, already used, capacity full, invalid; revoked pass and revoked device; pass expiry incl. pass page).
- **Container replacement and restart:** Container replaced with a newly built image and restarted with `docker restart`: event/pass/redemption counts identical before and after (8 events checked).
- **Backup/restore drill:**
  - `docker exec ... node dist/server/index.js backup /data/backup-<ts>.db` -> 'Backup written and verified'.
  - A marker event was created after the backup.
  - Container stopped.
  - Live `gatepass.db`, `-wal`, `-shm` deleted.
  - Backup copied into place (owner uid 1000).
  - Container started.
  - All counts equal to the backup state and the marker event gone (expected: restore loses changes after the backup).
- **Headers on the public URL:** CSP (`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; frame-ancestors 'none' …`), HSTS `max-age=31536000; includeSubDomains`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy: camera=(self)`, `nosniff`; `/api` responses `Cache-Control: no-store`. `POST /api/qr/custom` without token -> 401.
- **Proxy trust and throttling through the tunnel:** 62 requests with a wrong admin token, each with a different spoofed `X-Forwarded-For` -> first 60 were 401, then 429 (spoofing did not create new buckets); a valid admin request from the same client right after -> 200; an invalid scanner key -> 429; unknown pass page -> 404; container logs showed no errors or warnings.
- **Not verified:** Real phone camera scanning (no physical device available), Oracle Cloud VM, Vercel deployment, Caddy/Let's Encrypt on a real domain, arm64 hardware (only QEMU build/run).

## Verification status

Verified in this repository:

- Unit, integration and thread-contention tests (`npm test`) and the type check.
- The benchmark above, on the listed machine.
- Staging deployment verification (2026-11-07): Docker image (`linux/amd64`, non-root) on Docker Desktop with temporary Cloudflare quick tunnel (`--protocol http2`), Playwright e2e suite over public HTTPS, container replacement and restart persistence, backup/restore drill, security headers, proxy trust and failed-auth rate limiting.
- Docker image build: built and run on `linux/amd64`; `linux/arm64` image built under QEMU emulation.
- Pass design decoding in headless Chromium through the ZXing WebAssembly path.
- `npm audit`: 0 known vulnerabilities on 2026-11-07. This only matches installed package versions against published advisories; it is not a security review.

Not verified:

- Real phone camera scanning (no physical device available).
- Native `BarcodeDetector` path on Android Chrome or iOS Safari (no device available in test environment).
- Real Oracle Cloud VM deployment (needs the owner's Oracle VM; arm64 image only built under emulation, not run on Ampere hardware).
- Vercel deployment (`vercel.mjs`; needs owner's Vercel account; never deployed to a live Vercel project).
- Caddy/Let's Encrypt on a real domain.
- Performance on arm64 hardware (only QEMU build/run; benchmark ran on x64 over loopback only).
