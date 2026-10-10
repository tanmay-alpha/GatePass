# QR Code Toolkit

A self-hosted QR code generator from CompleteTech LLC, built with React, TypeScript, Express, and Vite. Generate static QR codes, customize SVG designs, and manage editable dynamic destinations with an optional YOURLS integration.

## Quick start

Requires Node.js 22.12 or newer and npm.

```sh
git clone https://github.com/CompleteTech-LLC/qr-code-toolkit.git
cd qr-code-toolkit
npm ci
cp .env.example .env
npm run dev
```

In a second terminal, run `npm run dev:web`, then open **http://localhost:5173**. The API runs at **http://localhost:3000**. No account or external service is required for local QR generation. Both development servers bind to loopback by default.

## Features

- URL, text, email, phone, SMS, vCard, MeCard, map, Wi-Fi, event, social, and cryptocurrency payload builders.
- SVG designs with colors, gradients, module shapes, templates, and built-in or uploaded logos.
- PNG export using standard QR modules and foreground/background colors.
- Saved QR records, editable dynamic destinations, and audit history.
- Landing pages for audio, video, PDFs, social links, app links, galleries, ratings, and feedback.
- Optional YOURLS short URLs and statistics; local redirect fallback works without credentials.
- Light, dark, and system themes.

Samples use example addresses. Supply your own destination, media, contact information, Wi-Fi credentials, or wallet address before using a QR code. Scan-test the final export, especially after changing contrast, shapes, or logos.

## Build and run

```sh
npm run build
npm start
```

Open **http://localhost:3000** to use the built application. Configure `.env` for your deployment; see [deployment](docs/deployment.md) and [security](SECURITY.md).

## Configuration

| Variable | Purpose |
| --- | --- |
| `HOST` / `PORT` | API bind address and port; defaults to `127.0.0.1:3000` |
| `APP_PUBLIC_URL` | Public origin used in dynamic QR links |
| `DATA_FILE` | JSON database path; default `.local/data/db.json` |
| `UPLOAD_DIR` | Upload directory; default `.local/uploads` |
| `ADMIN_TOKEN` | Optional token protecting record management APIs and uploads |
| `YOURLS_API_URL` | Your YOURLS API endpoint |
| `YOURLS_SIGNATURE` | Server-side YOURLS API signature |
| `YOURLS_SHORT_DOMAIN` | Short URL origin for your YOURLS instance |
| `HTTPS_CERT_FILE` / `HTTPS_KEY_FILE` | Optional server TLS certificate and key |

With `ADMIN_TOKEN` set, API clients must send `x-admin-token` on protected routes. The bundled UI does not have a token login screen; for remote browser use, put the application behind an authenticated reverse proxy. See the route guidance in [deployment](docs/deployment.md).

## API example

```sh
curl http://localhost:3000/api/qr/custom \
  -H 'Content-Type: application/json' \
  -d '{"data":"https://example.com","file":"svg","size":300}' \
  --output qr.svg
```

## Development checks

```sh
npm run typecheck
npm test
npm run build
npm run smoke:qr
npm audit
```

Smoke output is written to ignored `.local/smoke/`. [Contributions](CONTRIBUTING.md) are welcome.

## Current limitations

This is a single-user, single-process application, not a multi-tenant hosted service. JSON storage has no transactional or multi-process guarantees. Back up the data file and uploads; use a database before scaling.

PNG exports do not include SVG shape, gradient, or logo styling. PDF/EPS export is not implemented. Uploaded logo references in SVG exports need a reachable asset URL and are not embedded for offline portability. Some shape presets share an underlying rendering style. YOURLS statistics require a configured instance; local fallback statistics report zero. The included YOURLS plugin is an optional integration scaffold.

Google Fonts and user-configured media can cause browser requests to external services. No deployment credentials, private infrastructure configuration, generated data, or source repository history are included.

## License

Released under the [MIT License](LICENSE). Third-party dependencies retain their own licenses. Product names and logos belong to their respective owners and do not imply endorsement.
