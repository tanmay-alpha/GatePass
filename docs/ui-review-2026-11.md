# UI/UX and accessibility review, November 2026

Second-pass review of the admin app, the attendee pass page and the scanner landing on branch
`feat/phase4-features`. Screens were captured with `e2e/visual-review.spec.ts` (seeded data: an organizer with
two events, gates, eight passes including a very long name and email, scans, two scanner devices and a pending
manager invitation; a first-time organizer with no events; a platform administrator).

- Widths: 320, 375, 390, 768, 1024, 1280, 1440 px; light and dark (`colorScheme`).
- Screens: sign-in, register, forgot password, reset password, invitation, events first run, events overview,
  every event tab (Operations, Passes, Access, Team, Pass design, Settings, Audit log), event not found, platform
  administration, account menu (open), change-password dialog (with validation errors), confirm dialog, attendee
  pass page, scanner landing.
- Files: `docs/screenshots/review-2026-11/{before,after}/<screen>-<scheme>-<width>.png` (full page). Only the
  screenshots cited below are committed (the full 294 × 2 set is about 52 MB); regenerate the rest with `REVIEW_SHOTS`.

Reproduce (needs `npm run build` first):

```sh
REVIEW_SHOTS=review-2026-11/after npx playwright test e2e/visual-review.spec.ts --project=chromium
npx playwright test e2e/a11y.spec.ts --project=chromium
```

## Automated checks added

| Spec | What it asserts |
| --- | --- |
| `e2e/visual-review.spec.ts` | For each screen × scheme, at every width: `document.documentElement.scrollWidth <= innerWidth` (no sideways page scroll). Optional screenshots with `REVIEW_SHOTS`. |
| `e2e/a11y.spec.ts` | axe-core (`@axe-core/playwright`), tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, on every screen × scheme at 1280 and 375 px: zero violations. |

Both seed through the local operator token and run in Chromium only (skipped in the other projects and against
`E2E_BASE_URL`). The seed is cached per run in `.local/e2e`, so a worker restarted after a failure does not
register again into the per-address sign-up limit. Each test browses from its own client address
(`X-Forwarded-For`, trusted from loopback as in `playwright.config.ts`), because reloading the invitation screen
once per width would otherwise exceed the 20-a-minute limit on invitation previews.

Baseline result: no screen overflowed at any width, and axe reported no violations in either scheme. axe left
"needs review" items: text over the scroll-shadow gradients of the tab bar and card tables (contrast cannot be
computed over a gradient; checked by hand: `--muted` on `--bg`/`--surface` is above 4.5:1 in both schemes), and
`aria-describedby` pointing at hint/error elements that are not rendered (fixed in the auth screens, below).

## Issues and fixes

| # | Issue | Evidence (before → after) | Fix | Why it is better |
| --- | --- | --- | --- | --- |
| 1 | Phone/tablet (≤ 860 px): on short pages the event-picker row stretched to fill the viewport, leaving 100–200 px of empty space above and below "Events [picker] [New event]" and pushing the page content down. | `before/event-not-found-light-375.png`, `before/events-first-run-light-390.png`, `before/events-overview-dark-375.png` → same names in `after/` | `.layout` gets `grid-template-rows: auto 1fr` in the narrow-screen block. | The grid no longer shares spare height between its rows: the picker keeps its natural height, content starts right below it, and the main area still fills the screen. |
| 2 | The narrow event picker cut its value mid-word ("Choose an ever", "Harbou"). | `before/events-overview-dark-375.png`, `before/event-team-light-320.png` → `after/` | `select { text-overflow: ellipsis; }` | Truncation is visible as such ("Choose an ev…"), so the value does not read as a typo. |
| 3 | Read-only fields (invited email on the invitation screen, copy-link fields) were cut without any sign. | `before/invite-light-375.png` → `after/invite-light-375.png` | `input[readonly]` gets `text-overflow: ellipsis`. | Shows that the value continues; focusing the field still scrolls to the rest and copy selects everything. |
| 4 | Dialogs were capped at `100vh`; on phones with dynamic toolbars or an open keyboard the bottom actions could sit under the browser chrome, and scrolling inside a dialog chained to the page. | `before/change-password-dialog-dark-320.png` → `after/change-password-dialog-dark-320.png` | `.dialog` adds `max-height: calc(100dvh - 32px)` (the `vh` value stays as fallback) and `overscroll-behavior: contain`. | The dialog fits the visible viewport, so Cancel/confirm stay reachable; scrolling the dialog no longer moves the page behind it. |
| 5 | Auth forms pointed `aria-describedby` at hint/error ids that were not in the DOM until a validation error appeared (axe "needs review", `aria-valid-attr-value`). | axe output on `change-password-dialog`, `register`, `invite` | `PasswordField`, sign-up name/email and invitation name only reference elements that are rendered. | Screen readers get exactly the hint and the current error, and the markup is valid ARIA. |
| 6 | Dead print-view rules (`.print-*`) left after the badge-sheet rewrite. | — | Removed, keeping the remaining `@media print` rules. | Less CSS to reason about; no behaviour change. |

## Reviewed and kept as is

- Touch targets: every control is at least 44 px tall at ≤ 860 px or on coarse pointers (existing rule); inline
  links inside sentences are exempt (WCAG 2.5.8).
- Tables: wide tables stack into labelled rows below 760 px container width, or scroll inside their card with
  edge shadows; nothing widens the page.
- Modal behaviour: native `<dialog>` (focus trap, Escape, inert page, focus returns to the trigger).
- Permission-aware controls: covered by `e2e/accounts.spec.ts` (manager sees the team read-only, no exports).
- Pass page: script-free, 44 px directions link, valid in light and dark at 320 px.

## Found in files owned by other workstreams (fixed in a follow-up pass)

Reported during the review, fixed once those workstreams had finished.

| File | Observation | Fix |
| --- | --- | --- |
| `OperationsPanel.tsx` | After a "Share" column was added, the "Admissions by gate" table got the five-column `min-width: 600px` at ≤ 860 px and scrolled sideways inside a div that could not be focused: axe `scrollable-region-focusable` (serious) at 375 px, light and dark. | Fixed by the orchestrator: `tabIndex={0} role="region" aria-labelledby="gates-ops-title"`, as in `ImportPasses.tsx`. |
| `OperationsPanel.tsx`, `operations.css` | At ≥ 1181 px the empty "Alerts" card stretched to the height of the scan chart beside it, leaving a large blank card (`before/event-operations-light-1440.png`). Admissions made through "Find attendee" were counted by the server but not shown. | Fixed: with no alerts the card gets `align-self: start` (`.ops-alerts-empty`) and keeps its own height; a fifth KPI tile "Assisted admissions" shows `summary.assistedAdmissions` (`after/event-operations-light-1440.png`). |
| `PassesPanel.tsx` | The pass list card had no visible heading; it started with the search box (`before/event-passes-dark-768.png`). | Fixed: a "Passes" section head, and the card is labelled by it (`aria-labelledby="pass-list-title"`) (`after/event-passes-dark-768.png`). |
| `ScannersSection.tsx` | In stacked device rows "Revoke" was a bordered button while "New setup link"/"Rotate key" were ghost buttons (`before/event-access-light-390.png`). | Fixed: Revoke is a ghost button in the danger colour, like "Disable" on the platform page; it stays red with a ban icon and still asks for confirmation (`after/event-access-light-390.png`). |
| `EventForm.tsx`, `IssueForm.tsx`, `ImportPasses.tsx`, `SettingsPanel.tsx`, `SaveTemplateSection.tsx`, `PoliciesSection.tsx` | Same `aria-describedby` pattern as issue 5: ids of error messages that are only rendered after validation. | Fixed with one helper, `describedBy()` in `ui.tsx`, which keeps only the ids of rendered hints and errors; `AuthScreens.tsx` uses it too. `TemplatePicker.tsx` and the policy picker always render their hint, so they needed no change. |

Third pass (event-day operations, safer live changes, event-day strip): `docs/ui-review-2026-11-pass3.md`.
