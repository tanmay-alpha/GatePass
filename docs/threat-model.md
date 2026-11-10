# Threat model (superseded)

This file described the earlier model, in which one shared `ADMIN_TOKEN` was the only admin credential. That model was replaced by organizer accounts with event roles on branch `feat/accounts-durability-operations`. The current threat model, role matrix, token inventory, security review findings and outstanding risks are in [security-and-threat-model.md](security-and-threat-model.md). Findings and their status are tracked in [engineering-audit.md](engineering-audit.md).

## Record of the 2026-11-07 review (single-token model)

The review of the single-token model fixed the following. All of these controls are still in the code:

1. Passes with no policy are admitted only inside the event window (start inclusive, end exclusive). Before the fix they were admitted at any time before expiry, including before the event started.
2. The redeem rate limit (240/min) is counted per scanner device after authentication, and `/api/scanner/*` is exempt from the per-IP `/api` limit, so gates behind one venue NAT do not throttle or lock out each other.
3. `/api/qr/custom`, which is CPU-heavy, requires a credential and is limited to 120/min. It was public before.
4. `TRUST_PROXY=true` is refused at startup; a hop count is required.
5. Failed authentication is throttled per IP (60 failures in 5 minutes); only further invalid attempts get 429.
6. CSV cells that start with `=`, `+`, `-`, `@`, tab or carriage return are prefixed with `'`.
7. `redeem` reads only the event window and status, not per-event aggregates.
8. A verified `<file>.pre-v<N>.bak` is written before each migration, and a database with a newer schema is refused.

That review also accepted these risks, which still apply: the pass page shows the event and attendee name to anyone holding the link (the link is the ticket); rate-limit counters live in process memory; there is no offline scanning. The single shared token it accepted has since been replaced by accounts (SEC-01). The `ADMIN_TOKEN` remains only as the operator's break-glass credential.
