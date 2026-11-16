# 0011 — Event templates and the live operations dashboard

Status: accepted (branch `feat/phase4-features`, schema version 5; no new migration).

## Context

Organizers set up similar events again and again: a seminar series, a monthly workshop, a yearly conference. Cloning (`POST /api/events/:id/clone`) copies one concrete event, but needs a past event to start from and cannot express a generic shape ("Speakers may enter 90 minutes early"). New organizers start with an empty form and have to discover gates and policies on their own.

During an event the operations tab showed totals, a 15-minute timeline and suspicious-pattern alerts, but not attendance against what was expected, the pace of the last hour, silent door devices, or a wrap-up once the doors closed. A failed refresh replaced nothing and said little.

## Decision

### Templates

- **Built-in templates live in code** (`src/server/templates.ts`, `BUILTIN_TEMPLATES`): College seminar, Workshop, Conference, Campus event, Private gathering. Ids are `builtin:<slug>`. Each sets a duration, a suggested capacity, gates, policy shapes and a pass-design preset from `src/qr/design.ts`. They fix no time zone or venue: the form uses the organizer's browser zone.
- **Saved templates** are rows in `event_templates` (migration 5), **private to the account** that saved them (`owner_id`). Another account's template answers 404, exactly like a missing one, for list, use and delete. Names are unique per owner. At most 50 per account.
- **What a template holds** (`EventTemplateConfig`, version 1): duration, time zone, venue, capacity, design (normalized) or design preset, gate names, and policy shapes whose windows are **minutes from the event start** (`null` = event start/end). Nothing else: never passes, attendees, scanners, setup codes, keys, team members, invitations or tokens. `POST /api/events/:eventId/save-template` (needs `edit` on the event) reads only the event row, its gates and its policies.
- **Strict validation on write and on read.** A zod `strictObject` schema rejects unknown keys at every level (a `passes`, `token` or `scannerKey` field is a 400, not silently dropped), checks that policy gates are listed gates, that windows close after they open, that names are unique, the time zone is an IANA zone and the design passes `normalizeDesignConfig`. Serialized config is capped at 16 KiB. Stored rows are re-parsed on every read; a row that no longer validates is skipped in the list (logged as a structured warning with the template id only) and refused with 409 on use.
- **Creating an event from a template** (`POST /api/templates/:templateId/events`) follows the clone pattern: event, gates, policies and policy-gate links are written in one `BEGIN IMMEDIATE` transaction, and the caller becomes owner in the same transaction. It is gated by `requireEventCreation` (`users.can_create_events`), like `POST /api/events` and clone. Form values (name, venue, zone, start, end, capacity, status) override the template's suggestions; the end defaults to start + duration; the status defaults to `draft`. A policy window that would close before it opens with the chosen event window is refused with 400.
- **Audit.** `template.created` (with `sourceEventId` when saved from an event) and `template.deleted` are platform-level rows (`event_id` NULL), because templates belong to an account, not an event. `event.created` carries `templateId` and `templateName`.
- The operator token has no account: it sees the built-ins and may create events from them (ownerless, like operator-created events) but cannot save or delete templates (400).

### Operations dashboard

`GET /api/events/:eventId/operations` keeps every existing field and adds:

- `phase`: `upcoming | live | paused | finished`, from status and the **entry window** (event window widened by policy windows, so early-entry policies count as open doors).
- `attendance`: admitted against **expected** passes (issued minus passes revoked before entry).
- `recent`: the last hour in clock-aligned 5-minute buckets, zero-filled.
- `completion` once finished: attendance, no-shows, first and last admission, busiest 5 minutes, denials with the top reason, devices and gates used.
- `device_idle` alerts: a device that was in contact and has been silent (no scan, no heartbeat) for `SCANNER_IDLE_MINUTES` (10) **while the doors are open**. A device never set up is shown in the device list, not raised as an alert.

Invalid-code bursts keep the existing rule (5 invalid or wrong-event codes from one device within 10 minutes).

Every query reads the existing indexes; no index was added. The recent-activity query names every stored outcome so SQLite seeks `scans_alerts_idx (event_id, outcome, created_at)` once per outcome instead of reading the event's whole scan history. `tests/operations.test.ts` asserts with `EXPLAIN QUERY PLAN` that no dashboard statement scans `scans`, `passes`, `redemptions` or `audit_log` without an index on a synthetic event with 10 000 passes and 10 000 scans, and records the timing.

The admin panel keeps the 5-second visible-tab polling and adds a status bar: door phase, the server time of the data, a stale marker after three missed polls, the error with the last good data left on screen, and a refresh/retry button. The scan feed offers a retry and never overlaps a manual retry with a scheduled poll.

## Consequences

- Templates add no attack surface for credentials: the schema cannot carry them and the save path never reads them. Isolation is by `owner_id` in every query, tested for list, use, delete and save.
- A template saved by a manager belongs to the manager, not to the event owner.
- Built-ins change with the code; saved templates are versioned (`version: 1`) so a later format can migrate or refuse them explicitly.
- The dashboard does more work per poll (four more small queries; three more once finished). Measured median on the 10k-pass synthetic event: see the test output (`operations timing`).

## Alternatives considered

- **Templates as events with a `template` status.** Rejected: they would show in event lists, carry ids that permissions treat as events, and invite copying passes or teams by mistake.
- **Sharing templates across a team or platform.** Out of scope; private templates keep the authorization rule trivial. Sharing would need its own permission model.
- **Storing policy windows as absolute times.** Rejected: a template is reused on other dates; offsets from the start are what organizers mean.
