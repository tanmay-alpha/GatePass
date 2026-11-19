# Deployment runbook

How GatePass gets from a merged commit to the live demo, and how to check, roll back, back up and restore it. Hosting choices are recorded in [ADR 0007](decisions/0007-hosting.md) and [ADR 0009](decisions/0009-durable-storage.md); the live configuration is in [deployment-live.md](deployment-live.md). Test results referenced here are recorded in [test-matrix.md](test-matrix.md).

Rules that apply to every step:

- Never print secret values. Env var *names* are fine.
- Do not change paid plans without the owner's approval.
- Do not run destructive operations on a production database without the owner's approval.
- **A release is complete only when `scripts/release-check.ts` passes against production** (gate 6). A green deploy page on Vercel or Render is not enough.

## Environments

| Environment | What runs | Data | Purpose |
| --- | --- | --- | --- |
| Local | `npm run dev`, or `npm run build` + `node dist/server/index.js`; optionally Docker Compose (`docker compose up -d --build`) | `.local/data/gatepass.db` (or the `gatepass-data` volume) | Development, the `backup`/`verify`/`restore` and rollback rehearsals |
| CI (GitHub Actions) | `ci.yml`: `check` (typecheck, unit/integration tests, build, QR smoke, `npm audit`), `e2e` (Playwright per browser project), `docker` (multi-arch build), `docker-run` (see gate 1). `security.yml`: gitleaks secret scan, dependency review on PRs (only when the repository variable `DEPENDENCY_REVIEW=true`). `codeql.yml`: CodeQL for JavaScript/TypeScript and the workflows | Temporary files and volumes | Release gate 1 |
| Staging | No hosted staging service. See [Staging strategy](#staging-strategy) | Synthetic only | Release gate 4 |
| Vercel preview | Static SPA only. `/api/*` and `/p/*` answer 503 with `preview-no-backend.json` unless a separate `GATEPASS_PREVIEW_BACKEND_ORIGIN` is configured (none is today) | None | UI review. Previews never reach production (`vercel.mjs`, INF-01) |
| Production (free demo) | Vercel project `gatepass` (team `tanmay-alphas-projects`) serves `https://gatepass-sandy.vercel.app` and proxies to Render service `gatepass-api` (`srv-dbng57u7bikc73cfc5bg`; Free plan, Docker, Singapore, 1 instance, no disk, health check `/api/health`, auto-deploy from `main`) | **Ephemeral**: the SQLite file is lost on every restart, deploy or idle spin-down | Public demo with `DEMO_MODE=true` |
| Production (durable, **not created**) | `render.yaml` Blueprint: `gatepass-api-durable`, Starter, 1 GB disk at `/data` | Persistent SQLite on the disk | Target after owner approval; see [Durable switch-over](#durable-switch-over) |

## Environment variables (names only)

| Variable | Local | CI | Vercel Production | Vercel Preview | Render (production) |
| --- | --- | --- | --- | --- | --- |
| `ADMIN_TOKEN` (≥ 24 chars, operator break-glass) | `.env` | fixed test value in `playwright.config.ts` / the `docker-run` job | — | — | set |
| `APP_PUBLIC_URL` | `.env` (`http://localhost:3000`) | test URL | — | — | set (`https://gatepass-sandy.vercel.app`; HTTPS turns on the `__Host-` session cookie; scanner enrollment links use it) |
| `DATABASE_FILE` | `.env` | temp path | — | — | image default `/data/gatepass.db` |
| `HOST`, `PORT`, `CLIENT_DIR` | `.env` | test values | — | — | image defaults (`0.0.0.0`, `3000`, `/app/dist/client`) |
| `NODE_ENV` | — | — | — | — | `production` |
| `TRUST_PROXY` | when behind a proxy | — | — | — | set |
| `ORIGIN_SECRET` (≥ 32 chars) | — | — | **set, Production only** | **not set** | set (same value as on Vercel) |
| `CLIENT_IP_HEADER` | — | — | — | — | `x-vercel-forwarded-for` |
| `DEMO_MODE` | optional | — | — | — | `true` until durable storage is approved |
| `ALLOW_SIGNUP` | optional | `true` (e2e web server) | — | — | `true` (set 2026-11-10 via the Render API; owner decision; the live demo allows self-registration, and deployed e2e signs up fresh accounts) |
| `RESEND_API_KEY`, `MAIL_FROM` | optional | — | — | — | **not set** (no credentials; emailed invitations and resets are off, links are handed over by hand) |
| `PASS_DELIVERY_KEY` (32 random bytes, base64), `PASS_DELIVERY_PREVIOUS_KEYS` (rotation only), `PASS_EMAIL_PER_SECOND`, `PASS_EMAIL_MAX_ATTEMPTS` | optional | — | — | — | **not set** (attendee pass email off; needs `RESEND_API_KEY` too). Add it as a `sync: false` secret, stored apart from database backups ([ADR 0012](decisions/0012-pass-email-outbox.md)) |
| `GATEPASS_COMMIT` | optional (`GATEPASS_COMMIT=$(git rev-parse HEAD) docker compose up -d --build`) | `docker build --build-arg GATEPASS_COMMIT=$GITHUB_SHA` | — | — | not needed: Render sets `RENDER_GIT_COMMIT` at runtime and the server falls back to it |
| `VERCEL_GIT_COMMIT_SHA` | — | — | system variable, written into `/version.json` at build | same | — |
| `GATEPASS_BACKEND_ORIGIN` | when running `vercel` locally | — | **set, Production only** | not set (ignored by previews) | — |
| `GATEPASS_PREVIEW_BACKEND_ORIGIN`, `PREVIEW_ORIGIN_SECRET` | — | — | — | optional; must point at a non-production server | — |
| `HTTPS_CERT_FILE`, `HTTPS_KEY_FILE` | optional | — | — | — | — |

The Render env var names above were taken from a read-only inspection (latest 2026-11-15: `ALLOW_SIGNUP`, `DEMO_MODE`, `ADMIN_TOKEN`, `CLIENT_IP_HEADER`, `APP_PUBLIC_URL`, `NODE_ENV`, `TRUST_PROXY`, `ORIGIN_SECRET`).

GitHub repository variables used by `release-verify.yml` (optional; defaults in the workflow): `GATEPASS_FRONTEND_URL`, `GATEPASS_BACKEND_URL`.

## Build identity

Every build says which commit it came from, so a release can be checked instead of assumed:

- **Frontend:** `vite build` writes `dist/client/version.json` = `{"commit": "<sha>"}` from `VERCEL_GIT_COMMIT_SHA`, then `GATEPASS_COMMIT`, then `git rev-parse HEAD`, else `null`. Vercel serves it with `Cache-Control: no-store` (`vercel.mjs`).
- **Backend:** `GET /api/health` → `{"ok":true,"service":"gatepass","signup":…,"email":…,"build":{"commit":"<sha>|null","schema":<n>}}` (plus `"demo":true` on the demo). `commit` comes from `GATEPASS_COMMIT`, falling back to `RENDER_GIT_COMMIT`. It answers 503 `{"ok":false}` when the database is not ready.
- **Docker image:** `ARG GATEPASS_COMMIT` feeds both. `.git` is not in the build context, so an image built without the argument reports `null` (Render still reports its `RENDER_GIT_COMMIT`).

## Release gates

All must be ticked before the change counts as released. Record the evidence (command, result, time) in [test-matrix.md](test-matrix.md).

- [ ] **1. All required GitHub checks pass** on the PR head commit: `gh pr checks <number>`.
  - `ci.yml`: `check`, `e2e`, `docker`, `docker-run`. `docker-run` boots the real image and requires: `/api/health` and `/version.json` report the built commit and a schema; a scanner enrolls with the one-time code from its setup link, and a second use of the code is refused; an admission survives `docker restart`; `verify` passes; an online `backup` verifies; after a graceful stop, `restore` in a one-off container on the same volume brings back the admitted pass and drops a pass issued after the backup; `verify` passes again; the operator token, scanner key, enrollment code and pass token never appear in the container log; every stop exits 0.
  - `security.yml`: `secret scan (gitleaks)` (PR commits; full history on `main`, weekly and on demand) and `dependency-review` (fails on a new dependency with a high or critical advisory; the job is skipped unless the repository variable `DEPENDENCY_REVIEW=true`, which needs the repository's Dependency graph — off today, see [TODO.md](../TODO.md)).
  - `codeql.yml`: `analyze (javascript-typescript)`, `analyze (actions)`.
- [ ] **2. Migration and backup verification passes.**
  - Locally: `npx vitest run tests/migration.test.ts tests/recovery.test.ts` (migration with row counts and hashes preserved, `.pre-vN.bak` written at the old version, backup → restore → `verify`, corrupt backup refused).
  - In CI: the `docker-run` backup/restore round trip (gate 1).
  - For a release that adds a migration: `scripts/rollback-rehearsal.sh` with the previous release's image as `OLD_IMAGE` and the candidate as `NEW_IMAGE` ([Rollback rehearsal](#rollback-rehearsal)).
- [ ] **3. Frontend and backend revisions are compatible.** Vercel deploys on push; Render deploys after CI. In between, the two sides run different commits; for the demo this window is accepted. `release-check` (gate 6) fails until both report the same commit.
  - Scanner setup across that window (reviewed 2026-11-17): the scanner never stores a key or admits anyone without a server answer, so every skew fails closed. A new frontend against a backend from before one-time setup links (before `621ab3c`): `POST /api/scanner/enroll` answers 404, the scanner shows "Could not set up this device" and stores nothing; that backend still issues `#key=` links, which the new frontend accepts. An old frontend against a newer backend: it only understands `#key=`, so an `#enroll=` link is ignored and the device stays unconfigured until the frontend updates (Vercel is normally the first side to update, so this order is rare). Between `main` (`8b86114`, schema 4) and this branch (schema 5) the scanner API is unchanged: both have `/api/scanner/enroll`, and the rollback rehearsal admitted a pass on the schema-5 build with a key enrolled on the schema-4 build.
- [ ] **4. Staging E2E passes.** See [Staging strategy](#staging-strategy).
- [ ] **5. Production deployment is approved and safe.** The owner has approved merging and deploying once the gates pass. No paid plan changes are made. On the ephemeral demo a migration cannot destroy retained data; on a durable service, take a backup first ([Backups](#backup-verify-and-restore)).
- [ ] **6. Release check passes against production.** This is the gate that closes a release:
  ```sh
  FRONTEND_URL=https://gatepass-sandy.vercel.app \
  BACKEND_URL=https://gatepass-api-mvle.onrender.com \
  EXPECTED_COMMIT=$(git rev-parse origin/main) \
  npx tsx scripts/release-check.ts          # or: node scripts/release-check.ts (Node ≥ 22.18)
  ```
  It waits (default up to 15 min, tolerant of the free instance's ~50 s cold start) until `/version.json`, the frontend's `/api/health` and the backend's `/api/health` all report `EXPECTED_COMMIT` with `ok: true` and a schema version. Then it runs nondestructive smoke checks: CSP, `nosniff` and HSTS on the SPA; `/api/health` `no-store`; unauthenticated `GET /api/events` → 401; `POST /api/scanner/redeem` without a key → 401; an unknown 43-character pass link → 404 page with its own CSP; the backend origin refuses unproxied API requests (401/403); with `PREVIEW_URL`, a preview does not reach a backend (503 `preview-no-backend`, or Vercel Deployment Protection: 401/403, or a redirect to `https://vercel.com/sso-api`, which is what this project's previews answer). Exit 0 = released; 1 = a check failed (the report says which); 2 = bad input. It uses no credentials and changes nothing.
  - On GitHub: run `release-verify.yml` with `workflow_dispatch` once **both** deployments report the release live; the run summary shows the report. It is deliberately not triggered by the deployment: the Render service deploys only after every GitHub check on the commit has completed successfully (`autoDeployTrigger: checksPass`, read from the Render API on 2026-11-16; [Render docs](https://render.com/docs/deploys#integrating-with-ci): `success`, `neutral` and `skipped` count as passing, anything else skips the deploy), so a check that waits for Render to serve that commit would keep Render waiting until it failed.
  - Every run of `release-verify.yml` on `main` (scheduled or manual) is itself a check on main's head commit. So the workflow passes `GATED_COMMIT=$GITHUB_SHA` and its committer time, and `release-check.ts` **defers** when that commit is less than an hour old (`DEPLOY_PENDING_GRACE`, default 3600 s) and the backend's `/api/health` reports another commit: it prints "Release check DEFERRED", writes a "deferred (not a pass)" summary and exits 0 at once, so it neither holds back nor cancels the pending Render deploy. A deferred run is **not** a release pass; run it again once Render is live. Only a positive commit mismatch defers; an unreachable or unhealthy backend is checked and fails as usual. Covered by `tests/release-check.test.ts`.
- [ ] **7. Key application journeys pass.** See [Smoke journey](#smoke-journey).
- [ ] **8. No unexpected errors in logs.** See [Monitoring](#monitoring). Expect no stack traces, 5xx lines, "database is locked" or `"ok":false` health answers since the deploy went live, beyond the smoke run's expected 4xx.
- [ ] **9. Rollback procedure is documented and rehearsed.** The procedure is [Rollback](#rollback); the database part is rehearsed by `scripts/rollback-rehearsal.sh`. A Render rollback and a `vercel rollback` have **not** been exercised on the real providers; record that honestly unless an operator performs one.

## Staging strategy

There is no hosted staging service, and production data never leaves production. In order of preference:

1. **Local production-like stack (default, free).** `GATEPASS_COMMIT=$(git rev-parse HEAD) docker compose up -d --build` with a throwaway `.env` (synthetic `ADMIN_TOKEN`, `APP_PUBLIC_URL=http://localhost:3000`). Then:
   - `E2E_BASE_URL=http://localhost:3000 npx playwright test --project=chromium`
   - `FRONTEND_URL=http://localhost:3000 EXPECTED_COMMIT=$(git rev-parse HEAD) npx tsx scripts/release-check.ts`
   - for migrations, `scripts/rollback-rehearsal.sh`.
   `docker compose down -v` removes the volume afterwards.
2. **CI** (gate 1) runs the same image and specs on every PR.
3. **Hosted preview pair (optional, costs nothing on free tiers but needs owner setup).** A second Render service (for example `gatepass-api-preview`, Free plan, `DEMO_MODE=true`, its own `ADMIN_TOKEN` and `ORIGIN_SECRET`) and, in Vercel's **Preview** environment only, `GATEPASS_PREVIEW_BACKEND_ORIGIN` + `PREVIEW_ORIGIN_SECRET` pointing at it. `vercel.mjs` refuses a preview origin equal to the production origin. Seed it only with synthetic data. Run the release check against the preview URL (Vercel Deployment Protection may require a bypass token for automated requests). Not set up today.
4. **After deploying**, the e2e specs can run against the demo (`E2E_BASE_URL=https://gatepass-sandy.vercel.app npx playwright test --project=chromium`; needs `ALLOW_SIGNUP=true`). They create synthetic data that the next restart erases. Do not do this against a durable production service.

## Deploy steps

1. Merge the PR into `main` once gates 1, 2 and 4 are green.
2. Vercel builds production from `main` automatically (`VERCEL_ENV=production`; the build fails if `GATEPASS_BACKEND_ORIGIN` is missing, which is intended).
3. Render builds the Docker image from `main`. If it does not start, use Dashboard → Manual Deploy → "Deploy latest commit".
4. Wait for the Render deploy to show `live`. A failed deploy keeps the **previous** instance and environment serving (production audit, finding 3).
5. Run the release check (gate 6): from a laptop, or `release-verify.yml` with `workflow_dispatch`. Start it after Render shows `live`; a run started earlier on `main` defers (exit 0, summary "deferred (not a pass)") instead of holding the deploy back, and must be re-run.
6. Run gates 7–8.
7. Bootstrap accounts on a new, empty database:
   - Sign up an organizer account in the UI (sign-up is open on the demo).
   - If a platform admin is needed, create the invitation with the operator token:
     ```sh
     curl -fsS -X POST https://gatepass-sandy.vercel.app/api/platform/invitations \
       -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
       -d '{"email":"<owner email>","role":"platform_admin"}'
     ```
     Open the returned `url` and set a password. Without `RESEND_API_KEY` no email is sent; hand the link over in person.

On a server with retained data (the durable setup), events created before migration 3 have no owner and are visible only to the operator. Assign each one with `POST /api/events/<id>/owner {"userId":"<id>"}` using the operator bearer token.

## Verify the deployed SHA

`release-check` does this from the outside (`/version.json`, `/api/health` `build.commit`). To cross-check with the providers:

```sh
# Render: the newest deploys, with status and commit (API key from the operator's local secret store)
curl -fsS -H "Authorization: Bearer $RENDER_API_KEY" \
  "https://api.render.com/v1/services/srv-dbng57u7bikc73cfc5bg/deploys?limit=5" \
  | jq -r '.[].deploy | [.id, .status, .commit.id, .finishedAt] | @tsv'

# Vercel: the production deployment behind the alias
vercel inspect https://gatepass-sandy.vercel.app
vercel ls gatepass --prod
```

## Health checks

```sh
curl -fsS https://gatepass-sandy.vercel.app/api/health                                        # ok, build.commit, build.schema
curl -fsS https://gatepass-sandy.vercel.app/version.json                                      # {"commit": …}
curl -fsS https://gatepass-api-mvle.onrender.com/api/health                                   # origin, no secret needed
curl -s -o /dev/null -w '%{http_code}\n' https://gatepass-api-mvle.onrender.com/api/events    # 403: origin-secret gate
```

The first request after 15 idle minutes wakes the free instance and takes about 50 s.

## Monitoring

- **Synthetic check:** `release-verify.yml` runs every 6 hours (`schedule`) without an expected commit: health, frontend/backend commit agreement and the smoke checks. A failed run emails the repository's watchers per their GitHub notification settings. GitHub disables scheduled workflows in a public repository after 60 days without repository activity; re-enable it on the Actions page. A scheduled run that starts while a release is still deploying (head commit under an hour old, backend on the previous commit) defers instead of failing, so it cannot cancel Render's `checksPass` deploy; a skew that outlasts the hour fails.
- **Platform health check:** Render probes `/api/health` (503 when the database is not ready) and restarts or holds back an unhealthy deploy. The Docker image has its own `HEALTHCHECK` for Compose and CI.
- **Structured logs:** the server writes one JSON line per request to stdout (method, route pattern, status, duration, request id; tokens are never logged) plus JSON error lines. Read them on Render's Logs page (or `docker compose logs gatepass` on a single host) and filter for `"status":5` or error entries. Vercel: `vercel logs https://gatepass-sandy.vercel.app`.
- **Code and supply chain:** CodeQL and gitleaks run weekly as well as on every PR; Dependabot opens update PRs weekly.

## Smoke journey

Automated: `E2E_BASE_URL=https://gatepass-sandy.vercel.app npx playwright test --project=chromium`.

Manual, on a phone where possible:

1. Sign up. The response sets a `__Host-gatepass_session` cookie; check in the browser's dev tools that it is HttpOnly and Secure.
2. Create an event (time zone, capacity), set it active, add a gate, issue two passes, create a scanner.
3. Open the scanner setup link on the phone within its validity (about an hour; the link works once) and tap "Tap to start scanning".
4. Scan pass 1: **Admit**. Scan it again after 12 s out of view: **Already used**, with "on this device".
5. Type pass 2's 8-character reference into manual entry: **Admit**.
6. Revoke the scanner. Its next scan is refused, and the phone returns to setup.
7. Download the attendance CSV as the owner. Sign out.

## Rollback

**Render (backend).** Use one of these:

- Dashboard → `gatepass-api` → Deploys → choose the previous successful deploy → **Rollback**. This also disables auto-deploy until it is re-enabled in Settings.
- API: `POST https://api.render.com/v1/services/srv-dbng57u7bikc73cfc5bg/rollback` with `{"deployId":"<previous deploy id>"}` ([Render API: Roll back deploy](https://api-docs.render.com/reference/rollback-deploy)). This does **not** disable auto-deploy.

Per [Render's rollback documentation](https://render.com/docs/rollbacks): a rollback reuses the target deploy's build artifact **and its environment variables**; disks are **not** rolled back.

**Vercel (frontend).** `vercel rollback` returns to the previous production deployment (on the Hobby plan only the immediately previous one, [Vercel CLI: rollback](https://vercel.com/docs/cli/rollback)); `vercel promote <deployment-url>` undoes it. Roll back both sides together, then run the release check with `EXPECTED_COMMIT` set to the rolled-back commit.

**Database.** The schema is forward-only. A build older than the database refuses to start ("Database schema version N is newer than this build supports"). Rolling code back across a migration therefore needs either:

- **roll forward** with a fix on the newer build (preferred whenever data written since the upgrade matters); or
- restore the automatic pre-migration backup `<DATABASE_FILE>.pre-vN.bak` (written by the new build before migration N ran, at the old schema), **with the server stopped and using the OLD build**:
  ```sh
  # Docker single host, OLD_IMAGE = the release being rolled back to
  docker compose stop gatepass
  docker run --rm -v gatepass_gatepass-data:/data "$OLD_IMAGE" node dist/server/index.js verify  /data/gatepass.db.pre-vN.bak
  docker run --rm -v gatepass_gatepass-data:/data "$OLD_IMAGE" node dist/server/index.js restore /data/gatepass.db.pre-vN.bak
  # then start the old image (pin it in docker-compose.yml or re-tag it gatepass:local)
  ```
  On Render with a disk, the Shell runs inside the live server, and there is no tested way to stop the server while keeping access to the disk. Prefer rolling forward there. A database rollback on Render needs a maintenance procedure that has not been designed or rehearsed (UNVERIFIED); do not improvise one while doors are open.
- **Never** restore a `.pre-vN.bak` with the NEW build's `restore`: it migrates the restored file to the new schema, and the old build then refuses to start (shown by the rehearsal's control step).
- Builds before the `restore` command existed (before schema 3): restore by hand: stop, move `gatepass.db`, `-wal` and `-shm` aside, copy the `.bak` to `gatepass.db`, start the old build ([deployment.md](deployment.md#restore)).
- Restoring a `.pre-vN.bak` drops every account, session and admission written since the upgrade.

On the free demo none of this applies in practice: the disk is ephemeral, so a rolled-back deploy starts on an empty database at the old schema.

### Rollback rehearsal

`scripts/rollback-rehearsal.sh` rehearses the database part on a throwaway Docker volume with synthetic data, needing only Docker and bash:

```sh
git worktree add ../gatepass-old <previous release commit>
docker build --build-arg GATEPASS_COMMIT=<previous release commit> -t gatepass:old ../gatepass-old
docker build --build-arg GATEPASS_COMMIT=$(git rev-parse HEAD) -t gatepass:new .
OLD_IMAGE=gatepass:old NEW_IMAGE=gatepass:new bash scripts/rollback-rehearsal.sh
```

Optional `EXPECT_OLD_SCHEMA` / `EXPECT_NEW_SCHEMA` make the run fail unless the two images produce exactly those schema versions, so a rehearsal of a specific migration cannot silently pass against the wrong pair of builds. On Windows run the script with Git Bash (`C:/Git/usr/bin/bash.exe` on the maintainer's laptop); a bare `bash` may resolve to WSL's, which cannot see Docker Desktop's CLI from Git Bash paths.

It starts OLD, seeds an event, a scanner and one admission; starts NEW (migration, `.pre-vN.bak` written), checks the admission survived and admits a second pass with the scanner key enrolled on OLD; verifies the `.bak` with OLD's `verify`; shows that NEW's `restore` would make the file unusable for OLD (control); restores with OLD's `restore`; starts OLD and requires the first admission present, the second gone and `verify` ok. It prints a PASS/FAIL report and removes its containers and volume (`KEEP=1` keeps them).

Last run: 2026-11-18, OLD = `273918b` (PR #15 before Phase 5, schema 5, from `git archive`), NEW = `feat/phase4-features` `3618985` (schema 6), Docker 29 on Windows, `EXPECT_OLD_SCHEMA=5 EXPECT_NEW_SCHEMA=6`: all 9 steps passed (v5 → v6 kept admission 1; the device set up on v5 admitted pass 2 on v6; the pre-migration backup was at v5; v5 refused the control v6 file; v5's `restore` brought back admission 1 without admission 2; `verify` ok). A first invocation of the same command exited 1 without output and was not diagnosed; the immediate re-run passed. Previous runs: 2026-11-17, `8b86114` → `273918b` (4 → 5) 9/9, with `EXPECT_NEW_SCHEMA=6` failing as intended; 2026-11-17 at `6d2f831` (4 → 5); 2026-11-15 (3 → 4).

The same day, a persistence rehearsal on the schema-5 image (named volume, published port, operator token set locally) passed: event, scanner (one-time enrollment), pass issued and admitted; `docker restart`; the pass was still `redeemed` and a re-scan answered `already_redeemed`; `docker stop -t 10` took about 0.3 s and exited 0 (`"shutting down","signal":"SIGTERM"` then `"stopped","code":0` in the log). The 15-line log had no error lines and none of: the operator token, scanner key, pass token, `/p/` links, `@` (email addresses), `re_` (Resend key prefix) or `Bearer`. The only warning was the expected "APP_PUBLIC_URL is not HTTPS".

### Rehearsal for schema 6 (`pass_deliveries` migration)

Run once migration 6 is merged into `feat/phase4-features`. OLD is the schema-5 build that is live (or about to be) before migration 6; NEW is the merged head. From the orchestrator's checkout, with Docker Desktop running:

```sh
OLD_COMMIT=273918b   # last schema-5 commit on feat/phase4-features (or the deployed main once PR #15 is merged)
NEW_COMMIT=$(git rev-parse HEAD)
tmp=$(mktemp -d)
git archive "$OLD_COMMIT" | tar -x -C "$tmp"
docker build --build-arg GATEPASS_COMMIT="$OLD_COMMIT" -t gatepass:v5 "$tmp"
docker build --build-arg GATEPASS_COMMIT="$NEW_COMMIT" -t gatepass:v6 .
rm -rf "$tmp"
OLD_IMAGE=gatepass:v5 NEW_IMAGE=gatepass:v6 EXPECT_OLD_SCHEMA=5 EXPECT_NEW_SCHEMA=6 \
  bash scripts/rollback-rehearsal.sh          # Windows: C:/Git/usr/bin/bash.exe scripts/rollback-rehearsal.sh
docker rmi gatepass:v5 gatepass:v6
```

Pass criteria (the script enforces them): v5 database seeded and one admission; v6 starts on it, writes `/data/gatepass.db.pre-v6.bak` at schema 5, keeps admission 1 and admits a second pass; v5's `verify` accepts the `.bak`; v5 refuses to start on a v6 file ("newer than this build"); v5's `restore` of `.pre-v6.bak` gives back a schema-5 database with admission 1 and without admission 2; `verify` ok; every stop exits 0. Record the report lines in [test-matrix.md](test-matrix.md).

Production procedure for "deploy schema 6 → roll back to the previous build":

- **Free demo (today):** no disk, so the rolled-back v5 build starts on an empty database. Roll back Render (previous deploy → Rollback) and Vercel (`vercel rollback`) together, then run the release check with `EXPECTED_COMMIT=<v5 commit>`. Nothing to restore.
- **Docker single host:** `docker compose stop gatepass`; `docker run --rm -v gatepass_gatepass-data:/data gatepass:v5 node dist/server/index.js verify /data/gatepass.db.pre-v6.bak`; `docker run --rm -v gatepass_gatepass-data:/data gatepass:v5 node dist/server/index.js restore /data/gatepass.db.pre-v6.bak`; start v5 (re-tag it `gatepass:local` or pin it in `docker-compose.yml`), then `verify` and the release check. Everything written on v6 (admissions, accounts, queued pass emails) is lost; take an `offsite-backup.sh` copy of the v6 database first.
- **Render with a disk:** prefer rolling forward. A Render rollback alone starts v5 on the v6 disk, which refuses to open it, so the deploy fails and Render keeps v6 serving ([INFERENCE] from Render's failed-deploy behaviour, not exercised).

## Backup, verify and restore

The built server has three maintenance commands (`src/server/index.ts`). They use `DATABASE_FILE`.

```sh
# Consistent online copy (VACUUM INTO + integrity_check). Safe while the server runs (separate connection, WAL).
node dist/server/index.js backup /data/backups/gatepass-$(date +%Y%m%d-%H%M%S).db

# Read-only check: integrity_check, foreign_key_check and the admission invariants (exit 0 = ok).
node dist/server/index.js verify                 # the live DATABASE_FILE
node dist/server/index.js verify /data/backups/gatepass-YYYYMMDD-HHMMSS.db

# Restore (server STOPPED). The current files are kept as <file>.replaced-<time>[-wal|-shm];
# the restored file is migrated to this build's schema, verified, and the old files are put back on any failure.
node dist/server/index.js restore /data/backups/gatepass-YYYYMMDD-HHMMSS.db
```

Notes:

- `verify` opens the file read-only and never migrates it. For a file at an older schema version it reports the version mismatch instead of checking the admission invariants, and exits 1. Verify an old file with the build of its own schema.
- A restore drops every admission made after the backup was taken. Back up immediately before and after an event, and never restore while doors are open.
- A restore also brings back pass emails that were still waiting in the backup, including ones the provider accepted after the backup was taken. Within 24 hours the provider de-duplicates them (same request id); after that the attendee may receive the same, still valid link a second time. Before starting a restored server with email on, check the Pass emails card of each event and cancel what was already sent, or start it without `RESEND_API_KEY` first.
- In Docker the server must be stopped for `restore`; run it in a one-off container on the same volume, as CI does: `docker compose stop gatepass && docker compose run --rm --no-deps gatepass node dist/server/index.js restore /data/backups/<file> && docker compose start gatepass`.

### Off-host backups (Docker single host)

`scripts/offsite-backup.sh` runs on the Docker host:

1. `backup` inside the running container to `/data/backups/gatepass-<UTC time>.db`;
2. `verify` that copy (the JSON report is kept next to the host copy);
3. `docker cp` it to `BACKUP_DIR` (default `./backups`) and compares SHA-256 inside and outside the container;
4. runs `BACKUP_UPLOAD_CMD` if set (the file is `$1`), e.g. `rclone copy "$1" offsite:gatepass-backups/` or `scp -q "$1" backup@vault.example.com:gatepass/`. The tool's credentials live in its own config on the host, never in this repository;
5. keeps the newest `BACKUP_KEEP` (default 14) copies in the container and on the host. Pruning runs only after every earlier step succeeded; any failure exits non-zero.

```sh
GATEPASS_CONTAINER=gatepass-gatepass-1 BACKUP_DIR=/srv/gatepass/backups BACKUP_KEEP=14 \
BACKUP_UPLOAD_CMD='rclone copy "$1" offsite:gatepass-backups/' bash scripts/offsite-backup.sh
# cron, hourly on event days:
# 15 * * * * cd /srv/gatepass && bash scripts/offsite-backup.sh >> backups/backup.log 2>&1
```

Without an upload hook the copy stays on the same host, which does not protect against losing the host. Restore-test an off-host copy periodically: copy it into the volume and run `verify` on it.

On Render with a disk (after approval): run `backup` from the service's **Shell** page and copy the file off with SCP over Render SSH or `magic-wormhole` ([Render disks](https://render.com/docs/disks#transferring-files)). Render's daily disk snapshots (kept seven days) are a last resort; Render advises against restoring snapshots of disks that back a database. `offsite-backup.sh` does not apply to Render.

## Secret rotation

| Secret | Steps | Verify |
| --- | --- | --- |
| `ADMIN_TOKEN` | Generate 32 random bytes (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`). Set it on Render (Environment, or `PUT /v1/services/<id>/env-vars/ADMIN_TOKEN`). Store it only in the operator's local secret store. | Deploy reaches `live`. `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer <new>" https://gatepass-sandy.vercel.app/api/events` gives 200, and the old token gives 401. A failed deploy keeps the old token live. |
| `ORIGIN_SECRET` | Generate ≥ 32 characters. Set the same value on Render and on Vercel (**Production** only), then redeploy both: Render first, then `vercel deploy --prod` or a push. | Requests through Vercel succeed. A direct origin request without the header gets 403. Expect 403s through Vercel while only one side has the new value. |
| Scanner key | Admin UI or `POST /api/scanners/:id/rotate`. This returns a new one-time setup link (valid about an hour); open it on the device. | The old key gets 401 at once. A used or expired setup link answers 410. |
| Account password / sessions | The user changes it (ends their other sessions), or a platform admin issues a reset link (ends all sessions). Disable an account to end every session immediately. | `GET /api/auth/session` with the old cookie gives 401. |
| `RESEND_API_KEY` (when configured) | Create a new key in Resend, set it on Render, redeploy, then revoke the old key in Resend. | An invitation email arrives. |
| `PASS_DELIVERY_KEY` (when configured) | Generate 32 random bytes (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`). Set it as `PASS_DELIVERY_KEY` and move the old value into `PASS_DELIVERY_PREVIOUS_KEYS` (comma-separated, at most 4), redeploy. No drain is needed: on start, waiting links are re-sealed under the new key and the log line `pass email links re-sealed under the active key` gives counts. Remove the old key on the next deploy once a start logs no re-seal line. A link no configured key opens fails closed ("could not be decrypted … Send a new link"); it is never sent. | `/api/health` reports `passEmail: true`; a test pass email reaches "Accepted by provider". |

## Durable switch-over

The owner decided on 2026-11-10 to keep SQLite with a single writer on a persistent disk as the target ([ADR 0009](decisions/0009-durable-storage.md)), and to spend nothing yet. Until approval, the live site stays a labelled demo (`DEMO_MODE=true`). **Nothing in this section has been applied.**

**Cost.** As recorded in [ADR 0007](decisions/0007-hosting.md) from [render.com/pricing](https://render.com/pricing), checked 2026-11-07: Starter (0.5 CPU, 512 MB) $7/month plus $0.25 per GB per month of disk, so about $7.25/month for 1 GB, before bandwidth or build-minute overage. Re-check the pricing page before approving.

`render.yaml` describes the target: service `gatepass-api-durable`, Docker, Singapore, `plan: starter`, one instance, 1 GB disk `gatepass-data` at `/data`, `DATABASE_FILE=/data/gatepass.db`, health check `/api/health`, deploy after the commit's GitHub checks pass (`checksPass`, like the live service), previews off, `DEMO_MODE=false`, `ALLOW_SIGNUP=false`, secrets as `sync: false`. It validates against Render's Blueprint JSON schema. Render ignores the file until a Blueprint is created from it, and its name differs from the live `gatepass-api`, so it never touches the demo.

**Once the owner approves**, choose one path:

- **A. New service from the Blueprint (clean cut-over).**
  1. Dashboard → New → Blueprint → this repository. Review the plan and the disk, enter the `sync: false` values (`ADMIN_TOKEN`, `ORIGIN_SECRET` — a new value, `APP_PUBLIC_URL`, `TRUST_PROXY`, and the optional `RESEND_API_KEY`/`MAIL_FROM`/`PASS_DELIVERY_KEY`). Leave the optional ones empty until the owner has a Resend API key, a verified sending domain for `MAIL_FROM` and a generated `PASS_DELIVERY_KEY`; without them email stays off and `/api/health` reports `email:false` (`passEmail` appears only once email is on, and is `false` until `PASS_DELIVERY_KEY` is set too).
  2. Wait for `live`. Check `curl -fsS https://<new service host>/api/health`: `ok: true`, `build.commit` = `git rev-parse origin/main`, a `build.schema`, and no `"demo":true`. (Everything else on the origin answers 403 until requests come through Vercel with the origin secret, so the full release check runs after step 3.)
  3. Point Vercel at it: Production env `GATEPASS_BACKEND_ORIGIN=https://<new service host>` and `ORIGIN_SECRET` = the new service's value; redeploy production. Run the release check (gate 6) against `https://gatepass-sandy.vercel.app` with `BACKEND_URL` set to the new origin.
  4. Durability: create an event through the frontend, trigger Manual Deploy on the new service (a restart), confirm the event is still there, and run `node dist/server/index.js verify` from the Shell.
  5. Suspend or delete the old free `gatepass-api` once the new one has passed for a day.
- **B. Upgrade the existing service in place.**
  1. Render Dashboard → `gatepass-api` → Settings → Instance type: **Free** → **Starter**.
  2. Disk page → Add disk: mount path **`/data`**, size **1 GB**. Render redeploys; the disk is available once the deploy is live.
  3. Environment: `DEMO_MODE=false` (or delete it). `/api/health` must no longer contain `"demo":true`. Decide `ALLOW_SIGNUP` with the owner: the demo has `true`; the Blueprint uses `false` (accounts by invitation only).
  4. Durability check as in A.4, then the release check (gate 6).
- **C. Single Docker host instead of Render (Caddy, [deployment.md](deployment.md#oracle-cloud-arm64-ampere-a1-with-docker)).** `docker compose --profile proxy up -d --build` with `GATEPASS_DOMAIN`, `APP_PUBLIC_URL=https://<domain>` and `ADMIN_TOKEN` in `.env`; the database lives in the `gatepass_gatepass-data` volume on the host's local disk; Caddy terminates TLS. Cost: $0 on an Oracle Cloud Always Free Ampere A1 instance within its free allowance (capacity is not guaranteed; the owner must accept Oracle's terms and card verification), otherwise the price of any small VM plus a domain. The Vercel front is not needed (the container serves the SPA); if it is kept, point `GATEPASS_BACKEND_ORIGIN` at the host and set `ORIGIN_SECRET` on both. Backups: `scripts/offsite-backup.sh` with an off-host `BACKUP_UPLOAD_CMD`. Durability check: admit a pass, `docker compose restart gatepass`, re-scan → "Already used" (rehearsed locally on 2026-11-17, [Rollback rehearsal](#rollback-rehearsal)).

If the server cannot write `/data` (for example because of mount ownership), it fails at startup and the deploy does not go live; check the logs. This has not been exercised on Render.

After either path: schedule backups and copy them off Render ([Off-host backups](#off-host-backups-docker-single-host)), update [deployment-live.md](deployment-live.md) (plan, disk, monthly cost) and the README hosting note.

Consequences to accept:

- One instance only: a disk prevents scaling to several instances.
- Each deploy has a few seconds of downtime, because a disk disables zero-downtime deploys ([Render disks](https://render.com/docs/disks#disk-limitations-and-considerations)).
- Do not deploy while doors are open.

## What is unverified

Stated plainly so nobody mistakes a plan for evidence:

- `release-verify.yml` has run on GitHub on a schedule (`gh run list --workflow release-verify.yml`: run 43998983005 on `main`, 2026-11-17T01:53Z, success); it has not been dispatched by hand after a release yet. `security.yml`, `codeql.yml` and the extended `ci.yml` ran on pull requests #14 and #15 (all green on PR #15 head `6760640`). `actionlint` 1.7.12 (with shellcheck) reports no findings on the workflows.
- `VERCEL_GIT_COMMIT_SHA` reaches the Vercel build: observed on 2026-11-17, production `/version.json` reports `8b86114ff1352777abb03d67ff5b0f038311c932`, the same commit as `/api/health`.
- The production release check passed read-only on 2026-11-17 against `main` `8b86114` (frontend `/version.json`, frontend and backend `/api/health` all on `8b86114`, schema 4, demo, `email:false`; 12 of 12 checks with `PREVIEW_URL` set to the newest Vercel preview, which answers 302 to `vercel.com/sso-api`). This is a check of current `main`, not of PR #15. Render's plan and disk were not read on that day (no Render CLI or `RENDER_API_KEY` on the laptop); the last API read is the one in [Environments](#environments).
- Render: a rollback, a disk, the Blueprint, and backups from the Render Shell have never been exercised. Vercel: `vercel rollback` has never been exercised.
- `offsite-backup.sh` was run locally against a container of this branch (backup, verify, copy, checksum, upload hook to a local directory, retention, failure exits). A real off-host target (rclone/scp) has not been used.
- Transactional email (Resend) is implemented but not configured anywhere: live delivery is untested.
- CodeQL advanced setup conflicts with GitHub's CodeQL "default setup"; on 2026-11-17 default setup was `not-configured` (`gh api repos/tanmay-alpha/GatePass/code-scanning/default-setup`), so the advanced workflow's uploads are accepted.
