# Testing

How to run the checks. What each test covers and the latest recorded results are in [test-matrix.md](test-matrix.md); load-test method and numbers are in [performance.md](performance.md).

## Commands

| Command | What it runs |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` over `src/`, `scripts/`, `tests/`, `vite.config.ts` and `vitest.config.ts` (`e2e/` and `playwright.config.ts` are not included). |
| `npm test` | `vitest run`: every `tests/**/*.test.ts`. |
| `npx vitest run tests/concurrency.test.ts` | One file only (here the worker-thread contention tests). |
| `npm run build` then `npm run test:e2e` | Playwright against the built server ([below](#end-to-end-tests)). |
| `npm run smoke:qr` | Renders a sample pass QR to `.local/smoke/`. |
| `npm run bench` | Fixed redeem scenarios ([below](#benchmark)). |
| `npx tsx --disable-warning=ExperimentalWarning scripts/load-test.ts` | HTTP load test plus the `synchronous` FULL vs NORMAL micro-benchmark ([below](#load-test)). |

CI (`.github/workflows/ci.yml`) runs `node --check vercel.mjs`, typecheck, tests, build, the QR smoke test and `npm audit --audit-level=high` (Ubuntu on Node 22 and 24, Windows on Node 24); Playwright once per browser project; a `linux/amd64` + `linux/arm64` image build; and a `docker-run` job that checks restart persistence, the `verify` command and a graceful stop of the real image.

## Unit, API and recovery tests (`npm test`)

Tests use file-backed SQLite databases in a temporary directory, not `:memory:`, so WAL mode, locking and multiple connections are real. `tests/helpers.ts` creates the database, a controllable clock and seeded events, scanners and passes; HTTP tests call the Express app in process with supertest.

- `tests/concurrency.test.ts` and parts of `tests/database.test.ts` start one worker thread per operation, each with its own connection, released together by a barrier (`tests/threads.ts`). See [test-matrix.md](test-matrix.md#concurrency-what-the-history-check-shows) for what the history check does and does not show.
- `tests/recovery.test.ts` starts real server processes and kills them. Its graceful-SIGTERM test is skipped on Windows.
- `tests/migration.test.ts` migrates a populated version 2 database.

## End-to-end tests

`playwright.config.ts` starts the built server (`node dist/server/index.js`) on `http://127.0.0.1:3410` with `ALLOW_SIGNUP=true` and a fresh database under `.local/e2e/`, recreated on every run. The specs sign up fresh organizer accounts through the UI; no admin token is used. Codes are entered through the scanner's manual entry field (no camera).

Projects: `chromium`, `firefox`, `webkit` (desktop) and `mobile-chrome` (Pixel 7 viewport, `e2e/onboarding.spec.ts` only).

```sh
npx playwright install chromium firefox webkit
npm run build
npx playwright test                      # all projects
npx playwright test --project=webkit     # one project
```

Against a deployed instance, set `E2E_BASE_URL`; no local server is started and timeouts are longer. The deployment must have `ALLOW_SIGNUP=true`, because the specs create accounts; turn it off again afterwards if the instance should not accept sign-ups.

```sh
E2E_BASE_URL=https://gate.example.com npx playwright test   # POSIX shell
```

## Benchmark

`npm run bench` (`scripts/bench.ts`) starts `scripts/bench-server.ts` in a separate process (production database settings, rate limits off, temp database) and runs four fixed redeem scenarios over loopback. Knobs: `BENCH_SEQUENTIAL`, `BENCH_TOTAL`, `BENCH_CONCURRENCY`. It prints JSON. Method and current results: [performance.md](performance.md).

## Load test

`scripts/load-test.ts` drives the same server with N scanners and M passes at several client counts, checks the persisted database after every run, and times `synchronous = FULL` against `NORMAL` in process. It only talks to the server it starts itself. Options are listed at the top of the script; for example:

```sh
npx tsx --disable-warning=ExperimentalWarning scripts/load-test.ts --repeat 3 --out .local/perf
npx tsx --disable-warning=ExperimentalWarning scripts/load-test.ts --part sync
```

Reports (JSON and Markdown) go to `--out` (default `.local/perf/`, git-ignored). Method, host and results: [performance.md](performance.md).

## Verification status

Recorded results, the host they ran on, and what has not been verified (physical phones, GitHub-hosted runs, the Render free instance, SIGTERM on Windows, `SQLITE_BUSY` across processes) are kept in one place: [test-matrix.md](test-matrix.md#not-verified). The manual checklist for camera scanning on real iPhone and Android devices is in [test-matrix.md](test-matrix.md#manual-real-device-acceptance-checklist).
