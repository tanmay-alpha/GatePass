# Architecture decision records

Each record states the context, the decision, its consequences and the alternatives considered. Records are not rewritten after acceptance; a later record supersedes an earlier one.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-sqlite-single-process.md) | SQLite through `node:sqlite`, one process | accepted |
| [0002](0002-hashed-bearer-tokens.md) | Hashed random bearer tokens for passes and scanner keys, shown once | accepted |
| [0003](0003-redemption-atomicity.md) | Redemption atomicity: `BEGIN IMMEDIATE` plus database constraints | accepted |
| [0004](0004-admission-policy-engine.md) | Admission policy engine: gates, entry windows, capacity | accepted |
| [0005](0005-bundle-server-with-vite-ssr.md) | Bundle the server with Vite SSR; no TypeScript transpiler in production | accepted |
| [0006](0006-qr-decoding-barcode-detector.md) | QR decoding in the browser with `barcode-detector` | accepted |
| [0007](0007-hosting.md) | Hosting: one host with Docker and Caddy; Vercel only as an optional static front | accepted |
| [0008](0008-accounts-and-event-roles.md) | Accounts with cookie sessions and per-event roles; operator token as break glass | accepted |
| [0009](0009-durable-storage.md) | Durable storage: SQLite single writer on a persistent disk (not PostgreSQL) | accepted; durable hosting awaits owner approval |

Related: [architecture.md](../architecture.md), [threat-model.md](../threat-model.md), [testing.md](../testing.md).
