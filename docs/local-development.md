# Local development

Use Node.js 22.12 or newer. Run `npm ci`, copy `.env.example` to `.env`, then run `npm run dev` and `npm run dev:web` in separate terminals. Open http://localhost:5173.

The API loads `.env` through Node's environment-file support. Vite proxies API, QR, upload, landing-page, and redirect routes to port 3000. If you change the API port, update the proxy targets in `vite.config.ts` too.

For local development, keep YOURLS credentials blank. Local redirects provide dynamic QR behavior. To scan dynamic QR codes from another device, explicitly configure a reachable `APP_PUBLIC_URL` and an appropriate bind address with network access controls.

Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run smoke:qr` before contributing. Do not commit `.env`, `.local`, uploads, generated QR images, or credentials.
