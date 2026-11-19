# 0013: Scanner readiness check, camera test code, door assistance and the scanner PWA

Status: accepted (2026-11-17)

## Context

Door staff set up phones minutes before doors open. Failures found then (wrong
event or gate, camera blocked, server unreachable, entry window not yet open)
are cheap to fix; found at the first attendee they hold up the queue. Attendees
also arrive with lost, cracked or unreadable QR codes, and staff need a safe way
to find and admit them without an override that bypasses the admission rules.
Finally, a door phone should be able to open the scanner app itself on a weak
connection, without ever implying that a pass can be verified offline.

The invariants from 0002 (hashed bearer tokens), 0003 (redemption atomicity) and
0008 (event isolation) must hold unchanged, and the scanner must stay fail closed.

## Decision

### Readiness checklist (client only)

`src/client/scanner/readiness.ts` turns facts the station already has into six
items with plain-language guidance: device set up (the key was accepted),
event and gate to confirm, server verification (a timed `GET
/api/scanner/session`), camera (secure context, permission state, start errors),
entry window (event status and window judged by the **server** clock) and the
camera test code. It opens with the station and from the header button "Before
you scan". It is advisory: staff may start anyway; the server still judges every
pass and scanning stays paused offline.

`ScannerSession` gained one additive field, `serverTime`; older clients ignore
it and the checklist treats a missing value as "no skew".

### Camera test code (never sent)

A test code is the QR payload `gatepass:diagnostic:v1:<nonce>` (nonce 8–64
base64url characters, `src/shared/diagnostic.ts`). The organiser shows it under
Event → Scanners → "Camera test code" (rendered by the signed-in QR endpoint) on
a second screen or prints it.

- While the checklist is open, the camera loop only looks for the test code and
  never calls redeem; anything else read is ignored with a hint.
- During scanning, a test code read by the camera or typed into manual entry is
  answered locally ("not a pass, nothing was sent"); `submit()` refuses any
  `gatepass:diagnostic:` payload before the network, whatever path it came from.
- Defence in depth: the server's `findScannedPass` treats any payload with that
  prefix (case-insensitive, any suffix, including a crafted suffix containing a
  real `/p/<token>` link) as no pass, so redeem answers `invalid` and admits
  nothing (`tests/assist.test.ts`).

### Door assistance: `GET /api/scanner/attendees?q=`

- Scanner bearer key only (revoked or unknown key → 401); the device's own event
  only (passes of other events are invisible by name, email or reference).
- `q` is trimmed, 3–100 characters. Matches: names by word start (every word of
  the query must start a word of the name; hyphens count as word breaks, LIKE
  wildcards are escaped, case folding is ASCII only as in SQLite's LIKE), exact
  email (case-insensitive; an email fragment matches nothing, so addresses
  cannot be enumerated), or reference prefix (3–8 hex characters). A search
  matching more than 10 passes returns none of them, only `more: true` ("add
  the surname, or search by email or reference").
- Each match carries the printed reference, name, masked email (`a***@e***.org`),
  pass state with admission time and gate, policy name, the advisory result of
  the same pure `evaluateAdmission` rules a scan would apply at this device now
  (wrong gate, too early, used…), and `ambiguous` when two passes share the
  8-character reference. Never a token, token hash, pass id or full email.
- Rate limits: 30 searches per device per minute (per device, not per IP: gates
  share NAT), and 300 searches per device in any 24 hours, counted from the
  audit log so a restart does not reset it (429 with `Retry-After` and a door
  message; scanning and typing a reference keep working). The request log names
  only the route pattern, never the query.
- Each search writes an audit entry `scanner.attendee_lookup` (actor: the
  device) with the result count and references, never the query text, which may
  be a person's name. The search itself reads without the write lock; only the
  audit row is written, in its own short transaction, so a search never delays
  a redemption on another connection.
- Why these limits (Phase 5 review): a stolen door-phone key could page through
  the guest list at 10 names a request. Word-start matching and "too broad →
  nothing" mean each answer names at most 10 people who match something
  specific; the daily budget caps a stolen key at 300 searches (and leaves each
  in the audit log for the organiser, who revokes the device). A door that
  admits a few thousand people with a few per cent lost QR codes needs well under
  300 searches; a device that runs out still admits by scan or reference.
- There is no admit endpoint. "Admit" in the UI sends the reference through
  `POST /api/scanner/redeem` with a fresh requestId: the same transaction,
  capacity claims, policy and gate checks, scan row and feed entry as any scan.
  A second admit is `already_redeemed`.

### How a code reached the server: `scans.method`

Migration 5 (unreleased when this was added, so no migration 6) adds
`scans.method TEXT CHECK (method IS NULL OR method IN ('camera', 'manual',
'lookup'))`. `POST /api/scanner/redeem` accepts an optional `method` with those
values (anything else is 400; the schema stays strict). The scanner sends
`camera` for decoded frames, `manual` for typed or pasted codes and `lookup` for
"Find attendee" admits; a retry sends the method of the first attempt. The value
is written on the scan row only and never reaches the admission decision. A
replayed requestId returns the stored scan and keeps its original method. NULL
means an older client or a direct API call. The scan feed shows it next to the
device, the scans CSV export has a trailing `method` column, and the operations
summary counts `assistedAdmissions` (admitted scans with `method = 'lookup'`).
The method is self-reported by an authenticated device: it labels door work for
the organiser and is not a security control.

### Installable scanner (PWA)

- `public/manifest.webmanifest`: id, start URL and scope `/scan`, standalone,
  PNG icons 192/512 plus a maskable 512.
- `public/sw.js`, hand-written, registered by the scanner in production builds
  with scope `/scan`. Navigations are network first (5 s), falling back to the
  last good `/scan` page; `/assets/*` (content-hashed) are cache first, capped at
  60 entries; everything else, in particular `/api/*` and `/p/*`, is not handled
  by the worker at all (network only). No verdict, session or pass page can come
  from a cache.
- Since Phase 5 the admin and the scanner are separate chunks (`main.tsx`
  imports one or the other), and the QR decoder is a third, loaded when a camera
  first starts. The shell page names only the shared entry, so the build
  (`vite.config.ts`, `scannerPrecache`) writes the scanner's chunks, its CSS, the
  fonts and the WebAssembly decoder into `dist/client/sw.js` as `PRECACHE`; the
  worker caches them on install and on every good navigation. The list changes
  with every release that changes those files, so the browser installs the new
  worker. Cache version `v2`: activation drops the `v1` caches of the
  single-bundle app.
- Session freshness: the station re-checks `GET /api/scanner/session` when the
  app comes back on screen (`visibilitychange`, `pageshow` from the
  back/forward cache) and when the connection returns, besides the one-minute
  heartbeat, so a device revoked or moved while the phone was locked is signed
  out or updated at once rather than at its next scan.
- The UI separates the two states: "App: Loaded (offline copy)" versus "Server
  verification: Available / Unavailable — do not admit anyone"; the offline
  banner says the app is loaded but passes need the server.
- Express serves `sw.js` and the manifest with `Cache-Control: no-cache`; the
  existing CSP (`default-src 'self'`) already allows a same-origin worker and
  manifest. The Vercel config sets the same headers for the static deployment.

## Consequences

- One additive column (`scans.method`, in unreleased migration 5); no new dependency.
- The checklist depends on browser support: the Permissions API does not report
  the camera state everywhere ("not allowed yet" until the camera test), and the
  camera test needs a second screen or paper.
- Verified with unit tests, API tests and Playwright with Chromium's fake camera
  (desktop and Pixel 7 emulation). That is not a test on a physical phone.
