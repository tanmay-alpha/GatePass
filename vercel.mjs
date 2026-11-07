// Vercel configuration for the optional split deployment: Vercel serves the
// static React build and proxies /api/* and /p/* to the GatePass server, which
// keeps SQLite on persistent disk elsewhere (see docs/deployment-vercel.md).
// Vercel Functions have no persistent filesystem, so the server never runs here.
//
// Build-time environment (Vercel project settings):
//   GATEPASS_BACKEND_ORIGIN  e.g. https://api.gate.example.com (required)
//   ORIGIN_SECRET            same value as the server's ORIGIN_SECRET (required)
// Written as plain config without @vercel/config, whose current release pulls
// dependencies with open high-severity advisories.

const backend = process.env.GATEPASS_BACKEND_ORIGIN?.replace(/\/+$/, '');
if (!backend || !/^https:\/\/[^/]+$/.test(backend)) {
  throw new Error('Set GATEPASS_BACKEND_ORIGIN to the HTTPS origin of the GatePass server, e.g. https://api.gate.example.com');
}

// Set on every proxied request; `set` replaces any client-supplied value.
const originSecret = [{ type: 'request.headers', op: 'set', target: { key: 'x-origin-secret' }, args: '$ORIGIN_SECRET', env: ['ORIGIN_SECRET'] }];

// Same policy the server sends with the SPA (src/server/app.ts).
const securityHeaders = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()'
};

export const config = {
  framework: null,
  installCommand: 'npm ci',
  buildCommand: 'npx vite build',
  outputDirectory: 'dist/client',
  routes: [
    { src: '/api/(.*)', dest: `${backend}/api/$1`, transforms: originSecret },
    { src: '/p/(.*)', dest: `${backend}/p/$1`, transforms: originSecret },
    { src: '/(.*)', headers: securityHeaders, continue: true },
    { handle: 'filesystem' },
    { src: '/(.*)', dest: '/index.html' }
  ]
};
