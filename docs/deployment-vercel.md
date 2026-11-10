# Optional Split Deployment: Vercel Frontend + VM Backend

GatePass can optionally run in a split deployment where Vercel serves the static frontend assets while the Node.js API and SQLite database run on a dedicated VM behind Docker and Caddy.

## Recommendation: Single Host Preferred

For most deployments, running everything on a **single host** (Caddy and GatePass on a single VM, as described in [deployment.md](deployment.md)) is strongly recommended:

- **Simpler architecture:** A single origin handles both static assets and API requests.
- **Single security header configuration:** No need to synchronize security header changes between `src/server/app.ts` and `vercel.mjs`.
- **No shared secret:** Eliminates the operational overhead and rotation risk of `ORIGIN_SECRET`.
- **Fewer failure domains:** Eliminates an extra network hop and avoids relying on two hosting providers.

Use the split deployment only if your organization specifically requires hosting frontend assets on Vercel's edge network.

## Why the Split Architecture is Necessary

Vercel cannot run the GatePass API or host its SQLite database. As explained in the Vercel knowledge base article [Is SQLite supported in Vercel?](https://vercel.com/kb/guide/is-sqlite-supported-in-vercel), SQLite is not supported on Vercel because Serverless Functions provide ephemeral storage, and concurrent function invocations do not share a filesystem. GatePass relies on a single persistent SQLite database in WAL mode (see [ADR 0001](decisions/0001-sqlite-single-process.md) and [ADR 0007](decisions/0007-hosting.md)).

In this split topology:
- **Vercel** builds and serves only the static single-page application (`dist/client`).
- **Vercel Rewrites** proxy all `/api/*` and `/p/*` requests across the internet to the backend GatePass server.
- **The backend server** (Docker + Caddy on a VM) manages persistence, business logic, authentication, and database access.

## Architecture and Request Flow

```
Browsers / Mobile Scanners
         │
         ▼
Vercel Edge (static assets in dist/client, SPA fallback to index.html)
         │
         │ Proxies /api/* and /p/*
         │ Adds header: x-origin-secret: $ORIGIN_SECRET
         ▼
Caddy Reverse Proxy (HTTPS termination, proxy hop 1)
         │
         ▼
GatePass Node.js Server (binds 127.0.0.1:3000, proxy hop 2)
         │ Validates x-origin-secret (refuses requests without it)
         │ Resolves client IP via CLIENT_IP_HEADER=x-vercel-forwarded-for
         ▼
SQLite Database (persistent volume / disk)
```

## Setup Steps

### 1. Deploy the Backend Server

Follow the instructions in [deployment.md](deployment.md) to set up GatePass with Docker and Caddy on your VM under its own public HTTPS hostname (for example, `api.gate.example.com`).

Configure the server's `.env` with the following variables:

- `APP_PUBLIC_URL`: Set this to the **Vercel public origin** (for example, `https://gate.example.com` or `https://<project>.vercel.app`), *not* the backend API hostname. Pass QR codes and redemption links encode `${APP_PUBLIC_URL}/p/<token>`. Users and scanners must open these links on the public Vercel frontend, which proxies `/p/*` requests back to the backend.
- `ORIGIN_SECRET`: Generate a random secret of at least 32 characters (e.g. `openssl rand -hex 32`). The server middleware in `src/server/app.ts` rejects any request lacking this header with HTTP 403 (with the sole exception of `/api/health`), preventing clients from bypassing Vercel to forge headers or flood the origin directly.
- `CLIENT_IP_HEADER=x-vercel-forwarded-for`: Set this together with `ORIGIN_SECRET`. Relying on hop counting (`TRUST_PROXY=2`) is fragile because hosting platforms (e.g. Render, or cloud load balancers/reverse proxies) add their own proxy hops, causing Express to pick an intermediate proxy or edge IP rather than the true client IP. Per Vercel edge documentation, Vercel overwrites `x-vercel-forwarded-for` with the genuine visitor IP. Setting `CLIENT_IP_HEADER=x-vercel-forwarded-for` instructs GatePass to extract the client IP directly from this header for rate limiting. Note that `CLIENT_IP_HEADER` strictly requires `ORIGIN_SECRET`; without origin validation, an untrusted client reaching the backend directly could spoof this header to select its own rate-limit bucket.

### 2. Create the Vercel Project

Import the repository into Vercel using the Vercel CLI (`vercel link`) or through the Vercel Web Dashboard:

1. Import your GitHub repository.
2. Under **Framework Preset**, select **Other** / **None** (do not choose Vite or any framework preset; `vercel.mjs` configures the build directly).
3. The configuration in `vercel.mjs` defines:
   - **Install Command:** `npm ci`
   - **Build Command:** `npx vite build`
   - **Output Directory:** `dist/client`

### 3. Set Vercel Environment Variables

In the Vercel Project Settings (under **Settings** > **Environment Variables**), add two variables for the **Production** environment only:

| Variable | Description |
| --- | --- |
| `GATEPASS_BACKEND_ORIGIN` | The full HTTPS origin of your backend server, without a trailing slash (e.g. `https://api.gate.example.com`). `vercel.mjs` checks this during the build and fails if it is missing or not HTTPS. |
| `ORIGIN_SECRET` | The identical secret string configured on the backend server in step 1. `vercel.mjs` injects this as the `x-origin-secret` header on all proxied `/api/*` and `/p/*` requests. |

Do not give Preview deployments these values. Preview builds never use `GATEPASS_BACKEND_ORIGIN`: without a preview origin they are static-only, serving the SPA and answering `/api/*` and `/p/*` with 503. To give previews a backend, set `GATEPASS_PREVIEW_BACKEND_ORIGIN` (HTTPS origin of a separate, non-production server; the build refuses the production origin) and `PREVIEW_ORIGIN_SECRET` (that server's `ORIGIN_SECRET`) for the Preview environment. See the header of [`vercel.mjs`](../vercel.mjs).

### 4. Deploy and Configure CI Checks

1. Trigger a deployment using Git integration (push to `main`) or the CLI:
   ```sh
   vercel deploy --prod
   ```
2. In Vercel Project Settings under **Git**, enable **Require checks to pass** so that production deployments only trigger after GitHub Actions CI checks complete successfully.

### 5. Verification

Run these verification steps to ensure the split configuration is functioning:

1. **Vercel health check proxy:**
   ```sh
   curl -i https://<vercel-domain>/api/health
   ```
   Must return HTTP `200` with `{"ok":true,"service":"gatepass",...}` (the body also carries `signup`, and `demo` in demo mode).

2. **Direct backend access blocked:**
   Attempt to access an API endpoint directly on the backend server without the secret header:
   ```sh
   curl -i -H "Authorization: Bearer <ADMIN_TOKEN>" https://<api-host>/api/events   # operator token
   ```
   Must return HTTP `403` with `{"error":"Forbidden"}`.

3. **Camera scanning over HTTPS:**
   Open `https://<vercel-domain>/scan` on a mobile device or desktop browser. Verify that the browser displays the camera permission prompt over HTTPS.

4. **Pass links use the Vercel origin:**
   Create an event and issue a pass via the admin dashboard or API. Confirm that the generated pass URL starts with your Vercel public origin (`https://<vercel-domain>/p/...`).

## Caching and Headers

- **No-store on dynamic routes:** GatePass sets `Cache-Control: no-store` on all `/api/*` and `/p/*` responses (`src/server/app.ts`). Because Vercel honours upstream caching headers on external rewrites, dynamic API responses and attendee pass pages are not cached at the edge.
- **Static asset security headers:** `vercel.mjs` configures the same Content Security Policy (CSP), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Permissions-Policy` headers on Vercel-served static assets as the Node.js server sends directly.

## CORS

No Cross-Origin Resource Sharing (CORS) configuration is required. The browser communicates exclusively with the Vercel domain; all requests to `/api/*` and `/p/*` are proxied server-to-side by Vercel's edge network.

## Limitations

- **Latency:** An extra network hop occurs between the Vercel edge and the backend VM on every scan redemption and pass view.
- **Origin secret rotation:** GatePass currently validates against a single `ORIGIN_SECRET` value. Rotating the secret requires updating both the backend server `.env` and Vercel project environment variables, followed by restarting/redeploying both in quick succession. A brief window of HTTP 403 errors may occur while deployments propagate.
- **Verification status:** `vercel.mjs` and the server's origin-secret check are in place (the check is covered by `tests/security-api.test.ts`), but this split has not been deployed to a real Vercel account; see [testing.md](testing.md#verification-status).
