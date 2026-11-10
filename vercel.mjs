// Vercel configuration for the optional split deployment: Vercel serves the
// static React build and proxies /api/* and /p/* to the GatePass server, which
// keeps SQLite on persistent disk elsewhere (see docs/deployment-vercel.md).
// Vercel Functions have no persistent filesystem, so the server never runs here.
//
// Environment policy (VERCEL_ENV is set by Vercel at build time):
//
//   Production (VERCEL_ENV=production)
//     GATEPASS_BACKEND_ORIGIN  HTTPS origin of the GatePass server (required;
//                              the build fails without it), e.g. https://api.gate.example.com
//     ORIGIN_SECRET            same value as the server's ORIGIN_SECRET; sent as
//                              x-origin-secret on every proxied request
//
//   Preview and development (any other VERCEL_ENV, or unset)
//     Production values are NEVER read or used, so a preview build cannot reach
//     production data even if those variables are visible to it.
//     GATEPASS_PREVIEW_BACKEND_ORIGIN  optional HTTPS origin of a separate,
//                                      non-production GatePass server
//     PREVIEW_ORIGIN_SECRET            that server's ORIGIN_SECRET
//     Without a preview origin the build is static-only: the SPA is served and
//     /api/* and /p/* answer 503 with public/preview-no-backend.json.
//
// Written as plain config without @vercel/config, whose current release pulls
// dependencies with open high-severity advisories.

const production = process.env.VERCEL_ENV === 'production';

/** Normalised HTTPS origin, or undefined when the variable is unset/empty. */
function httpsOrigin(name) {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const origin = raw.replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+$/.test(origin)) {
    throw new Error(`${name} must be the HTTPS origin of a GatePass server, e.g. https://api.gate.example.com`);
  }
  return origin;
}

/** Sets x-origin-secret from the named env var; `set` replaces any client-supplied value. */
function originSecret(envName) {
  return [{ type: 'request.headers', op: 'set', target: { key: 'x-origin-secret' }, args: `$${envName}`, env: [envName] }];
}

function proxyRoutes(origin, secretEnv) {
  const transforms = originSecret(secretEnv);
  return [
    { src: '/api/(.*)', dest: `${origin}/api/$1`, transforms },
    { src: '/p/(.*)', dest: `${origin}/p/$1`, transforms }
  ];
}

let backendRoutes;
if (production) {
  const origin = httpsOrigin('GATEPASS_BACKEND_ORIGIN');
  if (!origin) {
    throw new Error('Set GATEPASS_BACKEND_ORIGIN to the HTTPS origin of the GatePass server, e.g. https://api.gate.example.com');
  }
  backendRoutes = proxyRoutes(origin, 'ORIGIN_SECRET');
} else {
  const origin = httpsOrigin('GATEPASS_PREVIEW_BACKEND_ORIGIN');
  // Compared only, never used: a preview must not point at the production server.
  const productionOrigin = process.env.GATEPASS_BACKEND_ORIGIN?.trim().replace(/\/+$/, '');
  if (origin && productionOrigin && origin.toLowerCase() === productionOrigin.toLowerCase()) {
    throw new Error('GATEPASS_PREVIEW_BACKEND_ORIGIN must not be the production GATEPASS_BACKEND_ORIGIN');
  }
  backendRoutes = origin ? proxyRoutes(origin, 'PREVIEW_ORIGIN_SECRET') : [];
}

// Static-only previews: answered after the filesystem phase (no static file
// lives under /api or /p), before the SPA fallback.
const noBackendRoutes = backendRoutes.length
  ? []
  : [
      {
        src: '/(api|p)/(.*)',
        dest: '/preview-no-backend.json',
        status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
      }
    ];

// Same policy the server sends with the SPA (src/server/app.ts), plus HSTS
// because Vercel serves the static files directly.
const securityHeaders = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
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
    ...backendRoutes,
    { src: '/(.*)', headers: securityHeaders, continue: true },
    { handle: 'filesystem' },
    ...noBackendRoutes,
    { src: '/(.*)', dest: '/index.html' }
  ]
};
