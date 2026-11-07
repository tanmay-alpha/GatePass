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

1. **Render Paid Instance with Persistent Disk ($7.25/month):**
   - Upgrade the Render web service from Free to a paid instance tier ($7/month for 0.5 CPU / 512 MB).
   - Attach a 1 GB persistent disk ($0.25/GB/month) mounted at `/data`.
   - The Docker image defaults `DATABASE_FILE=/data/gatepass.db`, so the database automatically persists on the attached volume across restarts and redeploys.
   - Render automatically performs daily disk snapshots that are retained for 7 days.
2. **Single-Host Dedicated VM ($0/month on Oracle Cloud):**
   - Follow the primary deployment guide in [deployment.md](deployment.md) on an Oracle Cloud Always Free Ampere A1 ARM64 VM running Docker and Caddy with automatic Let's Encrypt TLS.

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
- **Environment Variables (names only, configured for Production and Preview):**
  - `GATEPASS_BACKEND_ORIGIN`
  - `ORIGIN_SECRET`

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
  - `ADMIN_TOKEN`
  - `ORIGIN_SECRET`
  - `APP_PUBLIC_URL=https://gatepass-sandy.vercel.app`
  - `NODE_ENV=production`
  - `TRUST_PROXY=2`
  - `CLIENT_IP_HEADER=x-vercel-forwarded-for`

---

## 3. Secret Management & Rotation

- **Zero Secrets in Git:** Secrets are never written to any repository files or commit history.
- **Storage Locations:** Secrets exist solely on the operator's local machine (outside git) and inside the secure dashboard environment settings of Vercel and Render.
- **Rotation Procedures:**
  - `ADMIN_TOKEN`: Update the environment variable in the Render service dashboard and redeploy the service.
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

Result after fix (commit f4b4470, deployed to Render after CI passed): 62 requests with a wrong admin token through `https://gatepass-sandy.vercel.app`, each with a different spoofed `X-Forwarded-For` → the first 60 returned 401, then 429; a valid admin request from the same client right after → 200. The regression test is `rate-limits by the CDN-provided client IP, not by spoofable X-Forwarded-For` in `tests/security-api.test.ts`.

---

## 6. Verification Status

### Verified Against Production
Production verification was executed against `https://gatepass-sandy.vercel.app` on 2026-11-07:

1. **End-to-End Playwright Test Suite:**
   - Command executed:
     ```sh
     E2E_BASE_URL=https://gatepass-sandy.vercel.app E2E_ADMIN_TOKEN=<token> npx playwright test
     ```
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
   - `POST /api/qr/custom` without an admin token returns HTTP 401.
5. **Origin Secret Protection:**
   - Direct requests to backend origin `https://gatepass-api-mvle.onrender.com` without `X-Origin-Secret` or with an invalid secret return HTTP 403 Forbidden.
   - Health check endpoint `/api/health` remains accessible directly without secret (returns HTTP 200 `{"ok":true,"service":"gatepass"}`).

### Not Verified / Out of Scope
- **Physical Phone Camera Scanning:** Browser camera permission prompts were verified over HTTPS, but testing with physical mobile hardware was not performed.
- **Data Persistence:** Persistence across restarts cannot be verified on the Render Free tier as it provides an ephemeral filesystem by design.
