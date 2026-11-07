# 0002 — Hashed random bearer tokens for passes and scanner keys

Status: accepted

## Context

A pass QR code must let exactly one person in, must be revocable and replaceable when a phone is lost, and must not let anyone who reads the database mint working passes. Door devices need their own credential that the organiser can revoke per device. Redemption always has to reach the server anyway, because "used once" is server-side state shared by every gate.

## Decision

- **Pass token**: 32 bytes from `crypto.randomBytes`, base64url (43 characters, 256 bits). The QR encodes `${APP_PUBLIC_URL}/p/<token>`. `src/server/tokens.ts`.
- **Scanner key**: `gps_` + a token of the same kind. Bound to one event and optionally one gate.
- Only `sha256(token)` is stored (`passes.token_hash`, `scanners.key_hash`, both `UNIQUE`). An unsalted fast hash is enough because the input has 256 bits of entropy: a leaked database cannot be brute-forced back into tokens.
- The raw value is returned once, in the issue/reissue or scanner-create response. List endpoints never return it. A lost pass is reissued (new token, same pass ID; the old QR stops working on the next scan); a lost device's key is revoked.
- Lookup is by hash equality in SQL. The admin token, which is not stored in the database, is compared with `safeEqual` (SHA-256 both sides, then `timingSafeEqual`).
- Scanner keys travel in the setup link's URL fragment (`/scan#key=…`), which browsers do not send to servers or proxies.

## Consequences

- Revocation and reissue take effect on the next request; there is no token lifetime to wait out.
- The token carries no data. The pass page and the scanner learn everything from the server, so the QR stays short (a 43-character path) and reveals nothing if photographed.
- Scanning needs a network connection to the server. There is no offline mode (accepted; see [threat-model.md](../threat-model.md)).
- Anyone holding a pass link can open the pass page and present it. The link is the ticket; first presentation wins.
- Tests: `tests/tokens.test.ts` (format, uniqueness, hashing, extraction), `tests/database.test.ts` "never stores raw tokens", `tests/security-api.test.ts` "never returns tokens or token hashes from list endpoints" and "never returns scanner keys after creation", `tests/events-api.test.ts` "reissue invalidates the old token".

## Alternatives

- **Signed tokens (JWT, or a signed payload in the QR) verified offline by the scanner.** A signature proves the server issued the token; it cannot prove the token has not been used or revoked since. Single use needs shared state that every gate sees at the moment of the scan, so the scanner must ask the server anyway, at which point the signature adds nothing over a random lookup key. Revoking a signed token before it expires needs a revocation list, which is again an online check (or a list that is stale on the device). Offline verification would also require the verification key on every door phone and would make every forwarded screenshot valid at every offline gate until the devices sync. JWT payloads are base64, not encrypted, so attendee data in claims would be readable from the QR. Larger payloads also mean denser, slower-to-scan codes.
- **Store tokens in plaintext.** Anyone with a database copy or backup could print working passes. Rejected.
- **Slow password hashing (bcrypt/argon2) for tokens.** Needed only for low-entropy secrets. It would cost milliseconds of CPU on every scan and prevent the indexed equality lookup.
