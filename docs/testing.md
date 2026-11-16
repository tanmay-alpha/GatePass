# Testing

How to run the checks. What each test covers and the latest recorded results are in [test-matrix.md](test-matrix.md); load-test method and numbers are in [performance.md](performance.md).

## Commands

| Command | What it runs |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` over `src/`, `scripts/`, `tests/`, `e2e/`, `vite.config.ts`, `vitest.config.ts` and `playwright.config.ts`. |
| `npm test` | `vitest run`: every `tests/**/*.test.ts`. |
| `npx vitest run tests/concurrency.test.ts` | One file only (here the worker-thread contention tests). |
| `npm run build` then `npm run test:e2e` | Playwright against the built server ([below](#end-to-end-tests)). |
| `npm run smoke:qr` | Renders a sample pass QR to `.local/smoke/`. |
| `npm run bench` | Fixed redeem scenarios ([below](#benchmark)). |
| `npx tsx --disable-warning=ExperimentalWarning scripts/load-test.ts` | HTTP load test plus the `synchronous` FULL vs NORMAL micro-benchmark ([below](#load-test)). |
| `FRONTEND_URL=… npx tsx scripts/release-check.ts` | Release check against a running deployment ([below](#release-check)). |
| `OLD_IMAGE=… NEW_IMAGE=… bash scripts/rollback-rehearsal.sh` | Rollback rehearsal across a schema migration with two Docker images ([below](#rollback-rehearsal)). |

CI (`.github/workflows/ci.yml`) runs `node --check vercel.mjs`, typecheck, tests, build, the QR smoke test and `npm audit --audit-level=high` (Ubuntu on Node 22 and 24, Windows on Node 24); Playwright once per browser project; a `linux/amd64` + `linux/arm64` image build; and a `docker-run` job that checks one-time scanner enrollment, restart persistence, the `verify`, `backup` and `restore` commands and a graceful stop of the real image. Three further workflows: `security.yml` (gitleaks secret scan, dependency review on pull requests), `codeql.yml` (CodeQL analysis) and `release-verify.yml` (runs `scripts/release-check.ts` after a deployment, on demand and on a schedule).

## Unit, API and recovery tests (`npm test`)

Tests use file-backed SQLite databases in a temporary directory, not `:memory:`, so WAL mode, locking and multiple connections are real. `tests/helpers.ts` creates the database, a controllable clock and seeded events, scanners and passes; HTTP tests call the Express app in process with supertest. Creating a scanner returns a one-time setup link, not a key: tests obtain the device key the way a phone does, through `POST /api/scanner/enroll`, with `enroll` (and `setupCode`) in `tests/helpers.ts`.

- `tests/concurrency.test.ts` and parts of `tests/database.test.ts` start one worker thread per operation, each with its own connection, released together by a barrier (`tests/threads.ts`). See [test-matrix.md](test-matrix.md#concurrency-what-the-history-check-shows) for what the history check does and does not show.
- `tests/recovery.test.ts` starts real server processes and kills them. Its graceful-SIGTERM test is skipped on Windows.
- `tests/migration.test.ts` migrates a populated version 2 database, and a version 3 database (accounts, scanner keys issued before enrollment) to version 4.
- `tests/invariants.test.ts` covers admission invariants at their edges: a scanner revoked between the key check and the redeem transaction, the triggers on `redemptions` and `policy_gates`, a held write lock answered with 503 over HTTP and retried with the same requestId, a transaction that fails after claiming capacity, exact window and gate boundaries, a comma-separated client IP header, and the `verify` and `backup` commands on an older schema.
- `tests/journey.test.ts` runs the whole organizer-to-door journey against a real server process, including a SIGKILL and restart.
- `tests/account-recovery.test.ts` covers password reset with and without email, emailed invitations, closed sign-up, the Resend adapter (against a fake provider; no email is sent) and the email configuration.

## End-to-end tests

`playwright.config.ts` starts the built server (`node dist/server/index.js`) on `http://127.0.0.1:3410` with `ALLOW_SIGNUP=true`, `TRUST_PROXY=loopback` and a fresh database under `.local/e2e/`, recreated on every run. Each project sends its own `X-Forwarded-For` address, so the per-address rate limits stay on and are counted per project. The specs sign up fresh organizer accounts through the UI; no admin token is used. Codes are entered through the scanner's manual entry field (no camera).

Projects: `chromium`, `firefox`, `webkit` (desktop) and `mobile-chrome` (Pixel 7 viewport, `e2e/onboarding.spec.ts` only).

Specs: `e2e/onboarding.spec.ts`, `e2e/admission.spec.ts`, `e2e/accounts.spec.ts`, `e2e/journey.spec.ts` (an event set up in the UI, admitted on a phone-sized scanner by the printed reference) and `e2e/scanner-failclosed.spec.ts` (aborted, slow, 503 and gateway-error answers, a revoked device and offline mode must never show "Admit" unconfirmed).

```sh
npx playwright install chromium firefox webkit
npm run build
npx playwright test                      # all projects
npx playwright test --project=webkit     # one project
```

Against a deployed instance, set `E2E_BASE_URL`; no local server is started and timeouts are longer. The deployment must have `ALLOW_SIGNUP=true`, because the specs create accounts; turn it off again afterwards if the instance should not accept sign-ups. A deployed instance ignores the `X-Forwarded-For` header the projects send: its CDN sets the client address.

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

## Release check

`scripts/release-check.ts` waits until the frontend's `/version.json` and `/api/health` (and the backend's `/api/health`, when `BACKEND_URL` is given) report the expected commit, health is ok and the schema version is present, then runs nondestructive smoke checks. It creates, changes and deletes nothing and uses no credentials. It exits 0 only when every check passes.

```sh
FRONTEND_URL=https://gate.example.com EXPECTED_COMMIT=$(git rev-parse origin/main) npx tsx scripts/release-check.ts
```

`FRONTEND_URL` is required; `BACKEND_URL`, `EXPECTED_COMMIT`, `PREVIEW_URL`, `RELEASE_CHECK_TIMEOUT` and `RELEASE_CHECK_INTERVAL` are optional and described at the top of the script.

## Rollback rehearsal

`scripts/rollback-rehearsal.sh` needs Docker and bash and two images: the release being rolled back to and the release being rolled back. On a throwaway volume it admits a pass on the old image, lets the new image migrate the database (which writes a pre-migration backup first), restores that backup with the old image's own `restore`, and checks that the old image starts on it with the first admission intact. The volume and containers are removed at the end (`KEEP=1` keeps them).

```sh
OLD_IMAGE=gatepass:old NEW_IMAGE=gatepass:new bash scripts/rollback-rehearsal.sh
```

## Verification status

Recorded results, the host they ran on, and what has not been verified (physical phones, GitHub-hosted runs of the new workflows, live email delivery, the durable hosting target, load on a hosted instance, SIGTERM on Windows) are kept in one place: [test-matrix.md](test-matrix.md#not-verified). The manual checklist for camera scanning on real iPhone and Android devices is in [test-matrix.md](test-matrix.md#manual-real-device-acceptance-checklist).
