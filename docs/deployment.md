# Deployment

Build with `npm ci` and `npm run build`; start with `npm start`. The same Express process serves the built UI and API on loopback port 3000 by default. Use a service manager and set the working directory to the project root.

Set `APP_PUBLIC_URL` to your HTTPS origin (for example `https://qr.example.com`). Keep secrets in the runtime environment or an ignored `.env` file. Terminate HTTPS at a reverse proxy or configure `HTTPS_CERT_FILE` and `HTTPS_KEY_FILE`.

## Access boundaries

This application has no user accounts or tenant isolation. Keep the management UI and `/api/qr-codes*` and upload endpoints behind authenticated access. `ADMIN_TOKEN` adds API token protection to saved-record list/detail/render/stats, mutations, and uploads; clients must supply `x-admin-token`. The bundled browser UI does not send that header automatically. Use authenticated reverse-proxy access for browser management, or configure the proxy to inject the token only after authentication.

If public scanning is required, expose only the needed `/r/*`, `/l/*`, `/uploads/*`, `/samples/*`, and `/api/landing/*/feedback` routes without management authentication. Treat uploaded assets and landing-page content as public. Apply request limits at the proxy. Keep management data, audit history, and feedback responses private.

Do not expose an unauthenticated management application to the internet. Loopback defaults do not replace authentication when using a public proxy or container port mapping.

## Persistence and integration

Persist and back up both `DATA_FILE` and `UPLOAD_DIR`. Run one instance: the file-backed store is not suitable for concurrent workers or multiple replicas.

For YOURLS, set `YOURLS_API_URL`, `YOURLS_SIGNATURE`, and `YOURLS_SHORT_DOMAIN` for your own installation. Dynamic links must continue to reach the toolkit after creation. Never send the YOURLS signature to the browser.

Deployments, TLS issuance, backups, and YOURLS service provisioning are operator responsibilities; this repository contains no organization-specific deployment scripts.
