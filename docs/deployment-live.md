# Live Demo Deployment (Vercel + Render Free Tier)

**Live Demo URL:** [https://gatepass-sandy.vercel.app](https://gatepass-sandy.vercel.app)  
**Backend Origin URL:** `https://gatepass-api-mvle.onrender.com`  
**Date Deployed:** 2026-11-07  
**Monthly Cost:** $0

This document records the architecture, hosting configuration, operational runbook, security boundaries, and production verification for the public GatePass live demo deployment.

---

## 1. Demo Only: Non-Persistent Storage Warning

> **CRITICAL — DO NOT USE FOR REAL EVENTS:**  
> Render free web services use an ephemeral container filesystem (`render.com/docs/free`). The SQLite database is lost on every redeploy, restart, or automatic spin-down after 15 minutes of idle traffic. The first request after an idle period experiences a cold start taking ~50 seconds. This deployment exists strictly for demonstration and evaluation.

### How to Make Persistence Permanent (Owner Decision)

To make GatePass persistent for production, two paths are available:

1. **Render Starter instance with a persistent disk (about $7.25/month, owner approval required):**
   - Starter instance ($7/month for 0.5 CPU / 512 MB) plus a 1 GB persistent disk ($0.25/GB/month) mounted at `/data` (prices from render.com/pricing as of 2026-11-07; re-check before approving).
   - The Docker image defaults `DATABASE_FILE=/data/gatepass.db`, so the database persists on the disk across restarts and redeploys. A disk means one instance and a few seconds of downtime per deploy.
   - Render takes daily disk snapshots kept for 7 days; they are a last resort, not a backup plan.
   - Steps: [deployment-runbook.md, "Durable switch-over"](deployment-runbook.md#durable-switch-over) (`render.yaml` Blueprint, or upgrading the existing service in place).
2. **Single Docker host with Caddy ($0 on an Oracle Cloud Always Free Ampere A1 VM within its free allowance; otherwise the cost of a small VM and a domain):**
   - Follow [deployment.md](deployment.md) (Docker Compose, `proxy` profile, automatic Let's Encrypt TLS, database in a named volume on local disk, `scripts/offsite-backup.sh` for off-host copies).

Nothing above has been applied: on 2026-11-17 the live services are still the free demo (below).

**Email:** `RESEND_API_KEY`, `MAIL_FROM` and `PASS_DELIVERY_KEY` are not set on the demo (`/api/health` → `"email":false`). Invitation, reset and attendee pass emails stay disabled until the owner provides a Resend API key, a sending domain verified in Resend, and a generated delivery key; links are handed over by hand meanwhile.

---

## 2. Infrastructure & Hosting Topology

The live demo runs in a split topology across two free-tier hosting providers:

```
[Browser / Scanner]
        │
        ▼ HTTPS
Vercel Edge Network (https://gatepass-sandy.vercel.app)
  • Static client assets (dist/client)
  • Security headers (CSP, HSTS, frame deny, etc.)
  • Proxies /api/* and /p/* rewrites
  • Overwrites x-vercel-forwarded-for with client IP
  • Injects x-origin-secret header
        │
        ▼ HTTPS
Render Web Service (https://gatepass-api-mvle.onrender.com)
  • Service: gatepass-api (Free instance, Singapore region)
  • Docker runtime (repo Dockerfile)
  • Refuses non-health traffic lacking valid X-Origin-Secret (HTTP 403)
  • Rate limiting keyed by CLIENT_IP_HEADER=x-vercel-forwarded-for
  • Ephemeral SQLite database in /data/gatepass.db
```

### Frontend: Vercel

- **Project:** `gatepass` in team `tanmay-alphas-projects` (Hobby / free plan).
- **Public URL:** `https://gatepass-sandy.vercel.app`
- **GitHub Integration:** Connected to `tanmay-alpha/GatePass` branch `main`. Production deploys automatically on every push.
- **Build Configuration:**
  - Build Command: `npx vite build`
  - Output Directory: `dist/client`
  - Routing & Rewrites Configuration: [`vercel.mjs`](../vercel.mjs)
- **Environment Variables (names only, configured for Production only; confirmed 2026-11-10):**
  - `GATEPASS_BACKEND_ORIGIN`
  - `ORIGIN_SECRET`
- **Preview deployments:** static-only. No preview backend is configured, so `/api/*` and `/p/*` answer 503 on previews unless `GATEPASS_PREVIEW_BACKEND_ORIGIN` and `PREVIEW_ORIGIN_SECRET` are set for the Preview environment (see the header of [`vercel.mjs`](../vercel.mjs)).

### Backend: Render

- **Service Name:** `gatepass-api`
- **Service ID:** `srv-dbng57u7bikc73cfc5bg`
- **Instance Type:** FREE instance ($0/month)
- **Runtime:** Docker runtime built from repository `Dockerfile`
- **Region:** Singapore
- **Branch:** `main`
- **Auto-Deploy:** Set to "After CI checks pass"
- **Health Check Path:** `/api/health`
- **Origin URL:** `https://gatepass-api-mvle.onrender.com` (refuses all requests without the `X-Origin-Secret` header, returning HTTP 403, with the sole exception of `/api/health`)
- **Environment Variables (names only):**
  - `ADMIN_TOKEN` (operator break-glass API credential; not a UI login)
  - `ORIGIN_SECRET`
  - `APP_PUBLIC_URL=https://gatepass-sandy.vercel.app`
  - `NODE_ENV=production`
  - `TRUST_PROXY=2`
  - `CLIENT_IP_HEADER=x-vercel-forwarded-for`
  - `DEMO_MODE=true` (makes `/api/health` report `demo: true`; the admin UI then shows a "data is erased whenever the server restarts" banner)
  - `ALLOW_SIGNUP` is not in the variable list as inspected on 2026-11-10. The release steps in [deployment-runbook.md](deployment-runbook.md) add `ALLOW_SIGNUP=true` before the accounts release goes live.

---

## 3. Secret Management & Rotation

- **Zero Secrets in Git:** Secrets are never written to any repository files or commit history.
- **Storage Locations:** Secrets exist solely on the operator's local machine (outside git) and inside the secure dashboard environment settings of Vercel and Render.
- **Rotation Procedures:**
  - `ADMIN_TOKEN`: Update the environment variable in the Render service dashboard (or `PUT /v1/services/<id>/env-vars/ADMIN_TOKEN` with the Render API) and redeploy the service. **Then verify the rotation**: the deploy must reach `live`, and an operator request such as `GET /api/events` with `Authorization: Bearer <new token>` must return 200. If a Render deploy fails (on 2026-11-07 one failed with "Port scan timeout reached"), the previous instance keeps running with the **old** token, so retry the deploy until it is live. Last rotated 2026-11-07 after the token appeared in a chat transcript.
  - `ORIGIN_SECRET`: Must be rotated simultaneously in both the Render dashboard (`ORIGIN_SECRET`) and the Vercel dashboard (`ORIGIN_SECRET`), followed by redeploying both services.

---

## 4. Redeployment & CI/CD Workflows

### Automatic Deployments
- Pushing to branch `main`:
  1. GitHub Actions CI pipeline triggers on GitHub.
  2. Vercel builds and deploys the frontend immediately upon push.
  3. Render waits for CI checks to pass before automatically building and deploying the Docker container.

### Manual Deployments
- **Render Backend:**
  - Trigger via the Render Dashboard by clicking **Manual Deploy** > **Deploy latest commit**, or invoke the Render Deploy Hook / API.
- **Vercel Frontend:**
  - Deploy from a local linked clone using the Vercel CLI:
    ```sh
    GATEPASS_BACKEND_ORIGIN=https://gatepass-api-mvle.onrender.com vercel deploy --prod
    ```
    *Note: `GATEPASS_BACKEND_ORIGIN` must be present in the local shell environment during CLI invocation because `vercel.mjs` executes locally to generate the build configuration.*

---

## 5. Deployment Finding: Rate Limiting & Proxy Hops

### Issue Observed
During production deployment testing, the per-IP failed-authentication throttle did not trigger as expected through Vercel + Render. When 62 consecutive bad-token requests were sent with spoofed `X-Forwarded-For` headers, all 62 attempts returned HTTP 401 instead of triggering rate-limit blocking (HTTP 429).

### Root Cause
Hop counting via `TRUST_PROXY=2` proved fragile in a multi-provider chain. Render introduces its own internal reverse proxies in front of Docker containers. Combined with Vercel's edge proxy hops, static hop counting (`TRUST_PROXY=2`) led Express to inspect an intermediate Vercel edge IP address rather than the actual client IP.

### Solution
Configured `CLIENT_IP_HEADER=x-vercel-forwarded-for` on the Render backend:
- Vercel's edge network overwrites the `x-vercel-forwarded-for` header with the verified visitor IP.
- GatePass inspects `CLIENT_IP_HEADER` to extract the true client IP directly.
- The server strictly enforces that `CLIENT_IP_HEADER` is only permitted when `ORIGIN_SECRET` is configured and validated, ensuring untrusted external clients cannot bypass Vercel to forge the header directly against the backend.

Result after fix (commit f4b4470, deployed to Render after CI passed): 62 requests with a wrong `ADMIN_TOKEN` bearer (at that time the admin credential; now the operator token) through `https://gatepass-sandy.vercel.app`, each with a different spoofed `X-Forwarded-For` → the first 60 returned 401, then 429; a valid request from the same client right after → 200. The regression test is `rate-limits by the CDN-provided client IP, not by spoofable X-Forwarded-For` in `tests/security-api.test.ts`.

---

## 6. Verification Status

### Verified Against Production
Production verification was executed against `https://gatepass-sandy.vercel.app` on 2026-11-07:

1. **End-to-End Playwright Test Suite:**
   - Command executed:
     ```sh
     E2E_BASE_URL=https://gatepass-sandy.vercel.app E2E_ADMIN_TOKEN=<token> npx playwright test
     ```
     This was the pre-accounts suite. The current E2E suite signs up its own organizer accounts instead of using `E2E_ADMIN_TOKEN`, so running it against a deployment needs `ALLOW_SIGNUP=true` on that server: `E2E_BASE_URL=<url> npx playwright test`.
   - Results: **3/3 test suites passed.**
     - **Organiser flow:** Event creation, gate creation, pass policy configuration, scanner provisioning, ticket redemption, duplicate/already-used pass rejection, wrong gate rejection, event capacity limit enforcement, and invalid QR token rejection.
     - **Revocation flow:** Immediate denial for revoked passes and revoked scanner devices.
     - **Pass expiration flow:** Automatic rejection of expired passes according to policy.
2. **Security Headers on Vercel Frontend:**
   - `Content-Security-Policy` verified present.
   - `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` verified present.
   - `X-Frame-Options: DENY` verified present.
   - `Referrer-Policy: no-referrer` verified present.
   - `Permissions-Policy: camera=(self)` verified present.
   - `X-Content-Type-Options: nosniff` verified present.
3. **Cache Control:**
   - `/api/*` and `/p/*` responses verified to return `Cache-Control: no-store`.
4. **Endpoint Authentication:**
   - `POST /api/qr/custom` without credentials returns HTTP 401.
5. **Origin Secret Protection:**
   - Direct requests to backend origin `https://gatepass-api-mvle.onrender.com` without `X-Origin-Secret` or with an invalid secret return HTTP 403 Forbidden.
   - Health check endpoint `/api/health` remains accessible directly without secret (returns HTTP 200 `{"ok":true,"service":"gatepass"}`).

### Not Verified / Out of Scope
- **Physical Phone Camera Scanning:** Browser camera permission prompts were verified over HTTPS, but testing with physical mobile hardware was not performed.
- **Data Persistence:** Persistence across restarts cannot be verified on the Render Free tier as it provides an ephemeral filesystem by design.

## 7. Release record — 2026-11-10 (PR #11)

| Gate | Evidence |
| --- | --- |
| GitHub checks | PR #11: all 20 checks passed (check on ubuntu Node 22/24 and windows Node 24, e2e chromium/firefox/webkit/mobile-chrome, docker multi-arch build, docker-run restart persistence, Vercel). One PR-triggered WebKit job hung in the queue and passed on rerun; the push-triggered run on the same SHA passed first time. |
| Migration / backup | `tests/migration.test.ts` (populated v2 → v3, row counts and hashes preserved, `.pre-v3.bak` written) and `tests/recovery.test.ts` (CLI backup/restore). The live database is ephemeral, so no production data was migrated. |
| Frontend/backend compatibility | Both built from merge commit `234ba8802ca5b0b17474432ad1c7d8830dc29535`. |
| Staging E2E | No separate staging service exists; the e2e suite ran against the built server locally and in CI, and the preview deployment was checked to be static-only. |
| Approval | Owner chose "merge and deploy" on 2026-11-10; `ALLOW_SIGNUP=true` added to Render through the API before the merge. |
| Deployed SHA | Render deploy for `234ba88` live at 13:24:47 UTC; Vercel production deployment `gatepass-o191u68h5` (commit `234ba88`) aliased to `gatepass-sandy.vercel.app`. |
| Health | `GET /api/health` via Vercel and on the origin: `{"ok":true,"service":"gatepass","signup":true,"demo":true}`. HSTS and CSP present on the Vercel front. |
| Key journeys | `E2E_BASE_URL=https://gatepass-sandy.vercel.app npx playwright test --project=chromium`: 6/6 passed (sign-up, onboarding, invite manager, roles, CSV import, attendance export, admit/duplicate/wrong gate/full, revocation, expiry). Probes: `/api/events` without a session 401; cookie-less login without the CSRF header 403; origin without `X-Origin-Secret` 403; removed `/api/admin/session` 404. |
| Logs | 100 Render log lines after the deploy contained no error, exception or failure lines. |
| Rollback | Documented in [deployment-runbook.md](deployment-runbook.md#rollback). Not exercised on production. Its parts are covered by tests: an older build refuses a newer schema (`tests/database.test.ts`), and `.pre-v3.bak` / `restore` bring back a version 2 file (`tests/migration.test.ts`, `tests/recovery.test.ts`). On this demo the disk is ephemeral, so redeploying `4ff70f1` would start from an empty database. |

Still demo-only: Render free plan, no persistent disk, `DEMO_MODE=true`.

## 8. Status check — 2026-11-17 (read-only)

| Item | Observation |
| --- | --- |
| Frontend | `GET /version.json` → `{"commit":"8b86114ff1352777abb03d67ff5b0f038311c932"}`. Vercel production deployment `gatepass-htcvi5cjk` (Ready, created 2026-11-16), read with `vercel ls gatepass` / `vercel inspect` (CLI logged in as `tanmay-alpha`). |
| Backend | `GET /api/health` (via Vercel and on the origin) → `{"ok":true,"service":"gatepass","signup":true,"demo":true,"email":false,"build":{"commit":"8b86114…","schema":4}}`. Origin `GET /api/events` without the secret → 403. |
| Preview | Newest preview `gatepass-8n8btykmi` (Ready, 2026-11-17; `vercel inspect --json` shows no Git metadata, so it is not proven to be PR #15's). `/api/health` answers 302 to `vercel.com/sso-api` (Vercel Deployment Protection), so it reaches no backend for anonymous clients. |
| Release check | `FRONTEND_URL=https://gatepass-sandy.vercel.app BACKEND_URL=https://gatepass-api-mvle.onrender.com EXPECTED_COMMIT=8b86114 PREVIEW_URL=<that preview> npx tsx scripts/release-check.ts` → 12/12 passed (after teaching the check that a redirect to `vercel.com/sso-api` is protection; before that fix: 11/12, the preview check failed on the 302). This verifies current `main`, not PR #15. |
| Render plan / disk | Not read: the `render` command on the laptop is an unrelated npm package and no `RENDER_API_KEY` is available. Last known (2026-11-15 API read): Free plan, no disk. |
| Branch protection | `main` not protected (`gh api …/branches/main/protection` → "Branch not protected"). Proposal: [branch-protection.md](branch-protection.md). |
