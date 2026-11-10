# Deployment runbook

How GatePass gets from a merged commit to the live demo, and how to check, roll back, back up and restore it. Hosting choices are recorded in [ADR 0007](decisions/0007-hosting.md) and [ADR 0009](decisions/0009-durable-storage.md); the live configuration is in [deployment-live.md](deployment-live.md). Test results referenced here are recorded in [test-matrix.md](test-matrix.md).

Rules that apply to every step:

- Never print secret values. Env var *names* are fine.
- Do not change paid plans without the owner's approval.
- Do not run destructive operations on a production database without the owner's approval.

## Environments

| Environment | What runs | Data | Purpose |
| --- | --- | --- | --- |
| Local | `npm run dev`, or `npm run build` + `node dist/server/index.js`; optionally Docker Compose (`docker compose up -d --build`) | `.local/data/gatepass.db` (or the `gatepass-data` volume) | Development, the `backup`/`verify`/`restore` rehearsal |
| CI (GitHub Actions, `.github/workflows/ci.yml`) | `check` (typecheck, unit/integration tests, build, QR smoke, `npm audit`), `e2e` (Playwright per browser project), `docker` (multi-arch build), `docker-run` (boot, persistence across `docker restart`, `verify`, graceful stop) | Temporary files and volumes | Release gate 1 |
| Vercel preview | Static SPA only. `/api/*` and `/p/*` answer 503 with `preview-no-backend.json` unless a separate `GATEPASS_PREVIEW_BACKEND_ORIGIN` is configured (none is today) | None | UI review. Previews never reach production (`vercel.mjs`, INF-01) |
| Production (free demo) | Vercel project `gatepass` (team `tanmay-alphas-projects`) serves `https://gatepass-sandy.vercel.app` and proxies to Render service `gatepass-api` (`srv-dbng57u7bikc73cfc5bg`; Free plan, Docker, Singapore, 1 instance, no disk, health check `/api/health`, auto-deploy after CI checks pass) | **Ephemeral**: the SQLite file is lost on every restart, deploy or idle spin-down | Public demo with `DEMO_MODE=true` |

There is no separate staging environment. Release gate 4 below explains what stands in for it.

## Environment variables (names only)

| Variable | Local | CI | Vercel Production | Vercel Preview | Render (production) |
| --- | --- | --- | --- | --- | --- |
| `ADMIN_TOKEN` (≥ 24 chars, operator break-glass) | `.env` | fixed test value in `playwright.config.ts` / the `docker-run` job | — | — | set |
| `APP_PUBLIC_URL` | `.env` (`http://localhost:3000`) | test URL | — | — | set (`https://gatepass-sandy.vercel.app`; HTTPS turns on the `__Host-` session cookie) |
| `DATABASE_FILE` | `.env` | temp path | — | — | image default `/data/gatepass.db` |
| `HOST`, `PORT`, `CLIENT_DIR` | `.env` | test values | — | — | image defaults (`0.0.0.0`, `3000`, `/app/dist/client`) |
| `NODE_ENV` | — | — | — | — | `production` |
| `TRUST_PROXY` | when behind a proxy | — | — | — | set |
| `ORIGIN_SECRET` (≥ 32 chars) | — | — | **set, Production only** | **not set** | set (same value as on Vercel) |
| `CLIENT_IP_HEADER` | — | — | — | — | `x-vercel-forwarded-for` |
| `DEMO_MODE` | optional | — | — | — | `true` until durable storage is approved |
| `ALLOW_SIGNUP` | optional | `true` (e2e web server) | — | — | `true` (set 2026-11-10 via the Render API; owner decision; the live demo allows self-registration, and deployed e2e signs up fresh accounts) |
| `GATEPASS_BACKEND_ORIGIN` | when running `vercel` locally | — | **set, Production only** | not set (ignored by previews) | — |
| `GATEPASS_PREVIEW_BACKEND_ORIGIN`, `PREVIEW_ORIGIN_SECRET` | — | — | — | optional; must point at a non-production server | — |
| `HTTPS_CERT_FILE`, `HTTPS_KEY_FILE` | optional | — | — | — | — |

The Render env var names above were taken from a read-only inspection on 2026-11-10 (`DEMO_MODE`, `ADMIN_TOKEN`, `CLIENT_IP_HEADER`, `APP_PUBLIC_URL`, `NODE_ENV`, `TRUST_PROXY`, `ORIGIN_SECRET`). `ALLOW_SIGNUP=true` was added on 2026-11-10 through the Render API before the release deploy.

## Release gates

All ten must be ticked before the change counts as released. Record the evidence (command, result, time) in [test-matrix.md](test-matrix.md).

- [ ] **1. All required GitHub checks pass.** On the PR head commit, the `check`, `e2e`, `docker` and `docker-run` jobs are green: `gh pr checks <number>`.
- [ ] **2. Migration and backup verification passes.**
  - Locally: `npx vitest run tests/migration.test.ts tests/recovery.test.ts`. This covers: a populated schema-version-2 database migrates with row counts and hashes preserved; `.pre-v3.bak` is written and stays at version 2; backup → restore → `verify` round trip; a corrupt backup is refused.
  - In CI: the `docker-run` job requires `node dist/server/index.js verify` to exit 0.
- [ ] **3. Frontend and backend revisions are compatible.** Both Vercel and Render must serve the same merge commit (gate 6). The new admin SPA needs `/api/auth/*`, so it cannot work against an older API.
  - Vercel deploys on push. Render waits for CI. In between, the demo's sign-in fails, and this window is accepted for the demo.
  - Check: `curl -fsS https://gatepass-sandy.vercel.app/api/health` must include the `signup` field, which only this branch's server returns.
- [ ] **4. Staging E2E passes.** There is no staging service. As a substitute:
  - (a) CI e2e runs against the built server in Chromium, Firefox and WebKit.
  - (b) After deploying, the same specs run against the demo: `E2E_BASE_URL=https://gatepass-sandy.vercel.app npx playwright test --project=chromium`. This needs `ALLOW_SIGNUP=true` on Render. It creates synthetic data, which the next restart erases.
- [ ] **5. Production deployment is approved and safe.** The owner has approved merging and deploying once the gates pass (decision recorded 2026-11-10). No paid plan changes are made. The demo database is ephemeral, so the migration cannot destroy retained data.
- [ ] **6. Deployed SHA is verified.** See [Verify the deployed SHA](#verify-the-deployed-sha) for both providers.
- [ ] **7. Health checks pass.** See [Health checks](#health-checks).
- [ ] **8. Key application journeys pass.** See [Smoke journey](#smoke-journey).
- [ ] **9. No unexpected errors in logs.**
  - Render: open the service's Logs page in the dashboard for the window since the deploy went live. Expect the "GatePass listening on …" line and no stack traces, "Internal server error" or "database is locked" lines beyond the smoke run's expected 4xx.
  - Vercel: `vercel logs https://gatepass-sandy.vercel.app`.
- [ ] **10. Rollback procedure is documented and tested.** The procedure is [Rollback](#rollback).
  - Tested: database restore (`tests/recovery.test.ts`), and the pre-migration backup being written and kept at the old version (`tests/migration.test.ts`).
  - **Not** tested on the real providers: a Render rollback and a `vercel rollback`. Record that honestly unless an operator performs one.

## Deploy steps

1. Merge the PR into `main` once gates 1, 2 and 4(a) are green.
2. **Before** the Render deploy goes live, add `ALLOW_SIGNUP=true` to the Render service environment: Dashboard → `gatepass-api` → Environment. Leave the other variables unchanged. Saving env vars can trigger a deploy; let it complete.
3. Vercel builds production from `main` automatically (`VERCEL_ENV=production`; the build fails if `GATEPASS_BACKEND_ORIGIN` is missing, which is intended).
4. Render builds the Docker image once CI passes on the merge commit (auto-deploy "after CI checks pass"). If it does not start, use Dashboard → Manual Deploy → "Deploy latest commit".
5. Wait for the Render deploy to show `live`. A failed deploy keeps the **previous** instance and environment serving (production audit, finding 3). Retry until it is live, and confirm with gate 6.
6. Run gates 6–9.
7. Bootstrap accounts on the new, empty database:
   - Sign up an organizer account in the UI (sign-up is open).
   - If a platform admin is needed, create the invitation with the operator token:
     ```sh
     curl -fsS -X POST https://gatepass-sandy.vercel.app/api/platform/invitations \
       -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
       -d '{"email":"<owner email>","role":"platform_admin"}'
     ```
     Open the returned `url` and set a password. Hand the link over in person; no email is sent.

On a server with retained data (the durable setup), events created before migration 3 have no owner and are visible only to the operator. Assign each one with `POST /api/events/<id>/owner {"userId":"<id>"}` using the operator bearer token. The operator may assign an account that is not yet a member.

## Verify the deployed SHA

```sh
# Render: the newest deploys, with status and commit (API key from the operator's local secret store)
curl -fsS -H "Authorization: Bearer $RENDER_API_KEY" \
  "https://api.render.com/v1/services/srv-dbng57u7bikc73cfc5bg/deploys?limit=5" \
  | jq -r '.[].deploy | [.id, .status, .commit.id, .finishedAt] | @tsv'
# The live deploy must show the merge commit SHA (git rev-parse origin/main).

# Vercel: the production deployment behind the alias
vercel inspect https://gatepass-sandy.vercel.app
vercel ls gatepass --prod
# Match the deployment's source commit with git rev-parse origin/main (shown on the deployment's page in the Vercel dashboard).
```

For reference, before this branch the live Render deploy was `dep-dbniivlg1s2s73fj441g` at commit `4ff70f1f` (inspection of 2026-11-10).

## Health checks

```sh
curl -fsS https://gatepass-sandy.vercel.app/api/health
# {"ok":true,"service":"gatepass","signup":true,"demo":true}

curl -fsS https://gatepass-api-mvle.onrender.com/api/health                                   # origin, no secret needed
curl -s -o /dev/null -w '%{http_code}\n' https://gatepass-api-mvle.onrender.com/api/events    # 403: origin-secret gate
curl -sI https://gatepass-sandy.vercel.app/ | grep -iE 'strict-transport|content-security|x-frame|referrer-policy|permissions-policy'
curl -sI https://gatepass-sandy.vercel.app/api/health | grep -i 'cache-control'                # no-store
```

The first request after 15 idle minutes wakes the free instance and takes about 50 s.

## Smoke journey

Automated: `E2E_BASE_URL=https://gatepass-sandy.vercel.app npx playwright test --project=chromium`.

Manual, on a phone where possible:

1. Sign up. The response sets a `__Host-gatepass_session` cookie; check in the browser's dev tools that it is HttpOnly and Secure.
2. Create an event (time zone, capacity), set it active, add a gate, issue two passes, create a scanner.
3. Open the scanner setup link on the phone and tap "Tap to start scanning".
4. Scan pass 1: **Admit**. Scan it again after 12 s out of view: **Already used**, with "on this device".
5. Type pass 2's 8-character reference into manual entry: **Admit**.
6. Revoke the scanner. Its next scan is refused, and the phone returns to setup.
7. Download the attendance CSV as the owner. Sign out.

## Rollback

**Render (backend).** Use one of these:

- Dashboard → `gatepass-api` → Deploys → choose the previous successful deploy → **Rollback**. This also disables auto-deploy until it is re-enabled in Settings.
- API: `POST https://api.render.com/v1/services/srv-dbng57u7bikc73cfc5bg/rollback` with `{"deployId":"<previous deploy id>"}` ([Render API: Roll back deploy](https://api-docs.render.com/reference/rollback-deploy)). This does **not** disable auto-deploy.

Per [Render's rollback documentation](https://render.com/docs/rollbacks):

- A rollback reuses the target deploy's build artifact **and its environment variables**.
- Disks are **not** rolled back.

**Vercel (frontend).**

- `vercel rollback` returns to the previous production deployment. On the Hobby plan only the immediately previous one is allowed ([Vercel CLI: rollback](https://vercel.com/docs/cli/rollback)).
- `vercel promote <deployment-url>` undoes the rollback.
- Roll back both sides together (gate 3).

**Database.** The schema is forward-only:

- A build older than the database refuses to start ("Database schema version 3 is newer than this build supports").
- Rolling code back across migration 3 therefore needs either:
  - the automatic pre-migration backup `<DATABASE_FILE>.pre-v3.bak` (schema version 2), written before migration 3 ran (`db.ts:301-305`), restored with the server stopped; **or**
  - running the newer build (roll forward with a fix). This is preferred whenever data written since the upgrade matters.
- Restoring `.pre-v3.bak` drops every account, session and admission written since the upgrade.
- The older build has no `restore` command. Restore by hand, as in [deployment.md](deployment.md#restore):
  1. Stop the server.
  2. Move `gatepass.db`, `-wal` and `-shm` aside.
  3. Copy `.pre-v3.bak` to `gatepass.db`.
  4. Start the old build.
- Do not use the new build's `restore` for this: it opens the restored file and migrates it to the current schema.

On the free demo none of this applies in practice: the disk is ephemeral, so a rolled-back deploy starts on an empty database at the old schema.

## Backup, verify and restore

The built server has three maintenance commands (`src/server/index.ts`). They use `DATABASE_FILE`.

```sh
# Consistent online copy (VACUUM INTO + integrity_check). Safe while the server runs (separate connection, WAL).
node dist/server/index.js backup /data/backups/gatepass-$(date +%Y%m%d-%H%M%S).db

# Read-only check: integrity_check, foreign_key_check and the admission invariants (exit 0 = ok).
node dist/server/index.js verify                 # the live DATABASE_FILE
node dist/server/index.js verify /data/backups/gatepass-YYYYMMDD-HHMMSS.db

# Restore (server STOPPED). The current files are kept as <file>.replaced-<time>[-wal|-shm];
# the restored file is migrated, verified, and the old files are put back on any failure.
node dist/server/index.js restore /data/backups/gatepass-YYYYMMDD-HHMMSS.db
```

Notes:

- `verify` opens the file read-only and never migrates it. For a file at an older schema version (for example `.pre-v3.bak`) it reports the version mismatch instead of checking the admission invariants, and exits 1.
- A restore drops every admission made after the backup was taken. Back up immediately before and after an event, and never restore while doors are open.
- In Docker: `docker compose exec gatepass node dist/server/index.js backup /data/backup.db`. Then copy it off the host: `docker compose cp gatepass:/data/backup.db ./backups/`.
- On Render with a disk (after approval):
  - Run the same commands from the service's **Shell** page.
  - Copy backups off the instance with SCP over Render SSH, or `magic-wormhole` ([Render disks](https://render.com/docs/disks#transferring-files)).
  - Render also takes a daily disk snapshot, kept for seven days. Render advises against restoring snapshots of disks that back a database, so prefer the `backup`/`restore` commands.

## Secret rotation

| Secret | Steps | Verify |
| --- | --- | --- |
| `ADMIN_TOKEN` | Generate 32 random bytes (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`). Set it on Render (Environment, or `PUT /v1/services/<id>/env-vars/ADMIN_TOKEN`). Store it only in the operator's local secret store. | Deploy reaches `live`. `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer <new>" https://gatepass-sandy.vercel.app/api/events` gives 200, and the old token gives 401. A failed deploy keeps the old token live. |
| `ORIGIN_SECRET` | Generate ≥ 32 characters. Set the same value on Render and on Vercel (**Production** only), then redeploy both: Render first, then `vercel deploy --prod` or a push. | Requests through Vercel succeed. A direct origin request without the header gets 403. Expect 403s through Vercel while only one side has the new value. |
| Scanner key | Admin UI or `POST /api/scanners/:id/rotate`. Give the new setup link to the device. | The old key gets 401 at once. |
| Account password / sessions | The user changes it (ends their other sessions), or a platform admin issues a reset link (ends all sessions). Disable an account to end every session immediately. | `GET /api/auth/session` with the old cookie gives 401. |

## Owner approval path: durable storage

The owner decided on 2026-11-10 to keep SQLite with a single writer on a persistent disk as the target ([ADR 0009](decisions/0009-durable-storage.md)), and to spend nothing yet. Until approval, the live site stays a labelled demo (`DEMO_MODE=true`).

**Cost.** As recorded in [ADR 0007](decisions/0007-hosting.md) from [render.com/pricing](https://render.com/pricing), checked 2026-11-07:

- the smallest paid web service (Starter) is $7/month (0.5 CPU, 512 MB);
- disks cost $0.25 per GB per month;
- so about $7.25/month for a 1 GB disk, before bandwidth or build-minute overage.

Re-check the pricing page before approving.

**Once the owner approves:**

1. Take a backup of anything worth keeping. On the free plan nothing survives the switch anyway.
2. Render Dashboard → `gatepass-api` → Settings → Instance type: change **Free** to **Starter**.
3. Disk page → Add disk:
   - mount path **`/data`** (the image sets `DATABASE_FILE=/data/gatepass.db` and creates `/data` owned by the non-root `node` user);
   - size **1 GB**;
   - save. Render redeploys, and the disk is available once the deploy is live.
4. Environment: set `DEMO_MODE=false` (or delete it) and save; let the deploy finish. `/api/health` must no longer contain `"demo":true`, and the admin banner disappears.
5. Check that the disk is writable and durable:
   - create an event;
   - trigger Manual Deploy → "Deploy latest commit" (a restart);
   - the event is still there;
   - from the Shell, `node dist/server/index.js verify` exits 0.
   If the server cannot write `/data` (for example because of mount ownership), it fails at startup and the deploy does not go live. Check the logs before proceeding. This step has not yet been exercised on Render.
6. Schedule backups (Shell or SSH, `backup` as above) and copy them off Render. Update [deployment-live.md](deployment-live.md) (plan, disk, monthly cost) and the README hosting note.

Consequences to accept:

- One instance only: a disk prevents scaling to several instances.
- Each deploy has a few seconds of downtime, because a disk disables zero-downtime deploys ([Render disks](https://render.com/docs/disks#disk-limitations-and-considerations)).
- Do not deploy while doors are open.
