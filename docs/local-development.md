# Local development

## Prerequisites

- Node.js 22.13 or newer. The `node:sqlite` module must be available without a flag.
- npm (bundled with Node).

`node:sqlite` is built into Node, so no native modules are compiled. Node prints an `ExperimentalWarning` for it at startup. That is expected.

## First run

```sh
npm ci
cp .env.example .env
```

Edit `.env`: set `ADMIN_TOKEN` (the operator break-glass API credential, not a UI login) to a random value of at least 24 characters, and set `ALLOW_SIGNUP=true` so you can create a local account in the UI:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

The server loads `.env` itself (`--env-file-if-exists`), so no extra tooling is needed on Windows, macOS or Linux.

## Development servers

Run each in its own terminal:

```sh
npm run dev       # tsx watch src/server/index.ts -> http://127.0.0.1:3000
npm run dev:web   # vite on http://localhost:5173 (port from WEB_PORT), proxies /api to 127.0.0.1:3000
```

- **Admin UI**: http://localhost:5173. Create an account with **Sign up** (needs `ALLOW_SIGNUP=true`), then sign in with email and password.
- **Scanner UI**: http://localhost:5173/scan. Open a scanner setup link from an event's **Scanners** tab, or paste a key.
- **Pass pages**: issued pass links use `APP_PUBLIC_URL` (default `http://localhost:3000`), so they open `/p/<token>` on the API server.

The database is created at `.local/data/gatepass.db` (with `-wal` and `-shm` files) on first start. Delete the `.local/data` directory to start over. If you change `PORT`, also update the proxy target in `vite.config.ts`.

## Production build locally

```sh
npm run build   # tsc --noEmit, then vite build -> dist/client
npm start       # node --import tsx src/server/index.ts; serves dist/client and the API on :3000
```

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `ADMIN_TOKEN` | required | At least 24 characters. Operator bearer credential for the API only. |
| `ALLOW_SIGNUP` | `false` | `true` allows self-registration of organizer accounts. Otherwise accounts come from invitations. |
| `APP_PUBLIC_URL` | `http://localhost:3000` | Origin encoded in pass QR codes. A trailing slash is removed. |
| `DATABASE_FILE` | `.local/data/gatepass.db` | The parent directory is created if missing. |
| `HOST` | `127.0.0.1` | Set `0.0.0.0` to accept connections from other devices. |
| `PORT` | `3000` | |
| `TRUST_PROXY` | unset | Express `trust proxy` value (`1`, `loopback`, subnet list, `true`/`false`). |
| `CLIENT_DIR` | `dist/client` | Served only if it contains `index.html`. |
| `HTTPS_CERT_FILE`, `HTTPS_KEY_FILE` | unset | When both are set, Node serves HTTPS directly. |

Empty values in `.env` count as unset.

## Testing the scanner with a phone

Browsers allow camera access only in a secure context: HTTPS, or `http://localhost` on the same device. On plain HTTP to a LAN address, the scanner offers manual entry only.

To use a phone camera on your local network:

1. Create a certificate the phone trusts for your machine's LAN address. One way is a local CA tool such as `mkcert`, with its root certificate installed on the phone.
2. In `.env`, set `HOST=0.0.0.0`, `HTTPS_CERT_FILE`, `HTTPS_KEY_FILE`, and `APP_PUBLIC_URL=https://<lan-address>:3000`.
3. Run `npm run build` and `npm start`. The Vite dev server binds to 127.0.0.1 only.
4. Open the admin UI at `https://<lan-address>:3000`, create a scanner, and scan its setup QR code with the phone.

Restrict access with your firewall while the server is bound to `0.0.0.0`.

## Checks

```sh
npm run typecheck
npm test
npm run build
npm run smoke:qr
```

`npm test` uses temporary file-backed SQLite databases and does not touch `.local/`. `npm run smoke:qr` writes sample SVG/PNG pass codes to `.local/smoke/`.

Never commit `.env`, `.local/`, `dist/` or credentials.
