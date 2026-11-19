# UI/UX review, November 2026: third pass (event-day operations)

Third pass over the admin app and the attendee pass page on branch `p5/ui` (from `feat/phase4-features`), from
the point of view of an organizer running doors on the day. The second pass (`docs/ui-review-2026-11.md`) and its
fixes are unchanged; this pass adds screens, safer controls for live events and an event-day summary.

## Method

- Harness: `e2e/visual-review.spec.ts` (no sideways page scroll at any width, optional screenshots) and
  `e2e/a11y.spec.ts` (axe-core, WCAG 2.0/2.1 A and AA, 1280 and 375 px), both over `REVIEW_SCREENS` in
  `e2e/review-fixtures.ts`, light and dark.
- Widths: 320, 375, 390, 768, 1024, 1280, 1440 px. Print media: 1280 px (the sheet is laid out in millimetres).
- Seed (realistic, long content): an organizer with a live event (two gates, a capacity-limited "Crew & suppliers"
  policy with two of three passes admitted, eleven passes including a 50-character name and an 80-character
  email, scans, an enrolled and a pending device, a saved template, a pending invitation), a first-time
  organizer, a platform administrator, and a second organizer whose event takes the passes the issuance and badge
  screens issue (so they change no other screen).
- Screens added in this pass: skip link (first Tab), new-event form with a saved template picked, CSV import
  preview with refused rows, issued passes, badge print preview, badge sheets under print media, scanner setup
  (setup link and camera test code), revoke-device, delete-gate and edit-policy dialogs (capacity below the
  admitted count, and narrowing a policy while the doors are open). Existing screens (sign-in, registration,
  recovery, invitation, overview, every event tab incl. Team and Audit log, platform, menus, pass page) stay in.
- Pass emails: the e2e server runs without an email provider, so the Passes tab shows no email section (it is
  hidden until an event has emails); it was not reviewed visually in this pass.

Reproduce (after `npm run build`):

```sh
REVIEW_SHOTS=review-2026-11-pass3/after E2E_PORT=3414 npx playwright test e2e/visual-review.spec.ts --project=chromium
E2E_PORT=3414 npx playwright test e2e/a11y.spec.ts --project=chromium
```

Screenshots: `docs/screenshots/review-2026-11-pass3/{before,after}/<screen>-<scheme>-<width>.png`. Only the files
cited below are committed; the two `badges-preview` captures are cropped to their first 3200 px (the pass list
below grows with every run). The light 375 px dialog captures and mobile Operations capture were refreshed
after integration using the harness's viewport capture for dialogs; the confirmations are visible in the
committed images. The dialog wording is also asserted in `e2e/live-changes.spec.ts`.

## Findings and fixes

| # | Issue | Evidence (before → after) | Fix | Why it is better |
| --- | --- | --- | --- | --- |
| 1 | Badge print preview scrolled the whole page sideways at 320–390 px (document 419 px wide): four "N per page" buttons in one row and a 302 px preview sheet. Found by the new `badges-preview` screen. | `before/badges-preview-light-320.png` → `after/badges-preview-light-320.png` | One visible label "Passes per page" with number buttons (`aria-label` stays "N per page"); preview scale 0.3 at ≤ 400 px; 44 px buttons on touch. | The print controls and sheet fit a phone; the radios keep their accessible names, so `e2e/badges.spec.ts` is unchanged. |
| 2 | No skip link: a keyboard user crossed the top bar and every event in the sidebar before reaching the page. | `before/skip-link-light-1280.png` (first Tab lands on "GatePass") → `after/skip-link-light-1280.png` | "Skip to content" as the first focusable element; it moves focus to `<main id="main-content" tabindex="-1">` instead of following the fragment (the hash is the app's route). | WCAG 2.4.1 bypass blocks; one key press to the content. |
| 3 | Deleting a gate that a device, policy or check-in uses offered a red "Delete gate" that the server then refused, and advised "rebind its devices", which the UI cannot do. Same for policies with passes. | `before/delete-gate-dialog-light-375.png` → `after/delete-gate-dialog-light-375.png` | The dialog lists what keeps the gate (active and other bound devices, policies, admissions) and only offers OK; an unused gate gets the plain delete confirmation. Policies: same pattern (pass count, admissions). Server rules unchanged. | The organizer learns why before trying, and is not invited to a destructive action that cannot succeed. |
| 4 | Changes that turn people away while the doors are open (policy capacity down to the admitted count, window closing now or later, gates removed; event end earlier, later start, capacity filling the event; revoking or re-keying a working device; ending or archiving the event) used the same generic confirmation as on a draft event, or none at all (policy and event edits saved at once). | `before/confirm-dialog-light-375.png`, `before/revoke-scanner-dialog-light-375.png` (generic text, full-page captures) → `after/confirm-dialog-light-375.png`, `after/revoke-scanner-dialog-light-375.png`, `after/policy-change-confirm-light-375.png` | `src/client/admin/live-impact.ts` works out the consequence from data the tab already has (doors open = Active and inside the event window widened by policy windows, as the server's `phase`); the dialog lists it ("No other active device can admit at North", "its 1 pass not yet admitted is refused as Capacity full", "The 5 admissions so far stay recorded") and the confirm button stays disabled until "I understand …" is ticked. Outside opening hours the plain confirmation stays. | The consequence is stated in door terms before it happens and cannot be confirmed by a reflexive Enter; nothing is bypassed and history is untouched (the e2e checks the admitted scan is still there after ending). |
| 5 | Operations tab on a phone opened with three export buttons; the door state (are we open, are scanners alive, when did someone last get in, how much room is left, are emails failing) was spread over the KPI tiles and four cards; "Capacity used" appeared in a tile and in the Passes card. | `before/event-operations-light-375.png`, `before/event-operations-dark-1440.png` → `after/event-operations-light-375.png`, `after/event-operations-dark-1440.png` | Event-day strip under the refresh bar: Doors (open until / opens at, policy windows included), Scanners (in use / idle / never used), Last admission (5-minute bucket while live, exact once finished), Capacity left, Pass emails (only when the event has any; waiting / failed / accepted by provider). Rows needing action link to the tab (Access, Settings, Passes). Exports moved below the scan feed; the "Capacity used" tile removed (the strip and the Passes card show it). | The first screen answers the door manager's questions with a next step, without repeating the dashboard below. |
| 6 | Opening a link to an event created after the list loaded (another tab, an API-created event) showed "Event not found" until a full reload. | `e2e/operations-dashboard.spec.ts` failed on this before the fix | The dashboard fetches the event list once more for an unknown event id before showing "Event not found" ("Loading event…" meanwhile). | Deep links work without a manual reload. |
| 7 | Phone: "Add device" / "New setup link" opened the setup panel below the device list and the camera test code, out of sight of the button. | `before/scanner-setup-light-768.png` (panel at the bottom) | The panel scrolls into view (`block: 'nearest'`, no jump on desktop where it sits beside the list) and takes focus. Asserted with `toBeInViewport` in `e2e/onboarding.spec.ts` (also on `mobile-chrome`). | The one-time link and its Copy button are where the organizer is looking. |

## Data freshness (reviewed, kept)

The operations refresh bar already showed "Updated hh:mm:ss · every 5 s", a Stale badge after three missed polls
and "Could not refresh: … Showing data from hh:mm:ss" with Retry. It had no test; `e2e/operations-dashboard.spec.ts`
now fails the operations request and checks the message, the Stale badge, that the last figures (and the strip)
stay, and that Retry clears it.

## Event-day strip: integration follow-up

The initial review used a 5-minute bucket while the event was live. Integration added
`OperationsSummary.lastAdmissionAt: string | null`, and the strip now shows the exact last-admission time.
Pass email counts come from `GET /api/events/:id/deliveries?limit=1`, polled every 30 seconds while visible;
`unconfirmed` emails now count as requiring action rather than accepted. Owners can download the concise
report using "Event summary CSV" alongside the other exports (`e2e/operations-dashboard.spec.ts`).

## Reviewed and kept as is

- Templates (picker with a saved template, save form in Settings, "Your templates" on the overview), CSV import
  preview with refused rows, issued passes, team, audit log, settings, pass page: no overflow at any width, no axe
  violations; no change justified by the screenshots.
- Print: badge sheets are A4 (`@page { size: A4 }`); US Letter output was not verified (no printer; Chrome's
  scaling of a CSS A4 page onto Letter paper is UNVERIFIED). A paper-size option would need
  `BadgeSheetLayout.ts` to take the page size; left for a decision.
- Escape closes every dialog (native `<dialog>`); the live-change e2e presses Escape on the revoke dialog.

## Results

- `e2e/visual-review.spec.ts`, chromium: 64 passed (32 screens × 2 schemes, 7 widths; print at 1280).
- `e2e/a11y.spec.ts`, chromium: 64 passed, zero violations.
- These two runs used the build before fix 7, the "Capacity used" tile removal and the `delete-policy-dialog`
  screen; the specs that cover those (onboarding, operations-dashboard) were run on the final build.

After integration: the complete local Playwright run passed 227 tests (272 browser-gated skips), including
all visual and axe screens on the final application code. The light Operations and four dialog screens were
also re-captured at all seven widths: 5/5 visual tests passed. The 375 px captures replace the stale
full-page dialog images cited above.
