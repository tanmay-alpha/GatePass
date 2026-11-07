# Production audit — 2026-11-07

Audit of the live deployment (https://gatepass-sandy.vercel.app → Render `gatepass-api`) at commit `0284f73`, followed by fixes deployed at `8c8ff29`. All tests used synthetic events and attendees. Credentials were read from the operator's local secret store and the Render API; none are recorded here.

## Method

- Browser automation (headless Chromium) against the production URL at 390, 820 and 1440 px: sign-in, event creation, every event tab, scanner setup link, attendee pass page.
- API-level door-operator journey against production: duplicate, wrong gate, capacity, expiry, revocation, reissue, invalid code, revoked scanner.
- Render API: service plan, disk, deploy events and logs. Vercel CLI: production deployment and aliases.
- After fixes: local typecheck, 124 unit/integration tests, 4 Playwright specs, build, `npm audit`; GitHub CI (Node 22/24, e2e, amd64+arm64 Docker); the same 4 Playwright specs against production.

## Findings

| # | Severity | Finding | Evidence | Status |
| --- | --- | --- | --- | --- |
| 1 | Critical (for real use) | **Data is not durable.** A redeploy erased every event. | Events present before the 13:07 UTC deploy were absent after it. Render reports `plan: free`, `disk: none`. | **Accepted by owner as demo.** `DEMO_MODE=true` now makes `/api/health` report `demo: true`; the admin UI shows "Demo environment — data is erased whenever the server restarts. Do not use for a real event." Durable options: Render paid instance with a disk, or the Oracle VM guide. |
| 2 | High | **An admin token was disclosed in a chat transcript.** | — | **Rotated** through the Render API; value stored only in the local secret store. |
| 3 | High | **A failed Render deploy kept the old token live.** The first rotation deploy failed with "Port scan timeout reached" while the previous instance kept serving the old environment for ~18 minutes. | Render events: `deploy_ended … failed`; new token returned 401 until a retried deploy went live. | **Mitigated operationally**: rotation is now verified by testing the new token after the deploy; documented in `docs/deployment-live.md`. A Render-side cause; the retried identical deploy succeeded. |
| 4 | High (usability) | **No guided order of operations.** A first-time organiser had to discover Access → Passes → scanner setup across tabs. | before screenshots | **Fixed**: "Set up this event" checklist (`SetupChecklist.tsx`), e2e `e2e/onboarding.spec.ts`. |
| 5 | Medium | **Validation errors exposed API field names** ("endsAt must be after startsAt"). | new-event-invalid screenshot | **Fixed**: plain-language server messages and inline client validation. |
| 6 | Medium | **Mobile admin layout**: tab bar overflowed (Settings, Audit log off-screen); nine full-width tiles; cramped tables; event list above the event. | 390 px screenshot | **Fixed**: event select, compact tiles, scroll-snapping tabs, scrolling tables. |
| 7 | Medium | **No request timeouts.** A sleeping free backend (~50 s wake-up) left sign-in on "Checking…" and could leave a scanner waiting at the door. | free-tier behaviour | **Fixed**: timeouts (sign-in 70 s, default 20 s, redeem 12 s), wake-up notice, offline banner, neutral slow state; failures end in "Not verified". |
| 8 | Low | First scan of an event did not refresh event counts in the admin. | code review during the fix | **Fixed** (`ScanFeed.tsx`). |
| 9 | Low (test only) | Thread-contention test failed intermittently on Windows (EPERM deleting files still open by workers). Redemption results were correct in 480 stress races. | reproduced 4/8 under load | **Fixed** in the test harness. |
| 10 | Info | Repository visibility is **public** (changed by the owner earlier); the audit brief asks for private. | `gh repo view` | **Not changed** — needs the owner's decision. |

Verified working on production without changes: admin auth (scanner keys rejected on admin routes), duplicate → `already_redeemed`, wrong gate, capacity full, expiry, revocation, reissue invalidating the old code, invalid codes, revoked scanner → 401, operations alerts, audit actions, security headers, origin-secret lock, CDN-IP rate limiting.

## Not verified

- Camera scanning on a physical phone (no device available to the auditor).
- Durability across restarts — impossible on the current free plan by design (finding 1).
- Load on the free Render instance (0.1 CPU); benchmarks in `docs/testing.md` were measured on a laptop.
