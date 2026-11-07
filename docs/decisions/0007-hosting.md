# 0007 — Hosting: one host with Docker and Caddy; Vercel only as an optional static front

Status: accepted. Paid hosting is not chosen without the owner's approval.

## Context

GatePass is one Node.js process with one SQLite file (ADR 0001). Whatever hosts it must keep that file on a persistent disk across restarts and deploys, run exactly one instance, provide HTTPS (phone cameras need a secure context), and cost nothing for the expected use. The image is multi-arch (`linux/amd64`, `linux/arm64`).

## Decision

**Recommended: a single host running Docker Compose with Caddy**, for example an Oracle Cloud Always Free VM on the `VM.Standard.A1.Flex` (Ampere A1, ARM64) shape:

- `docker compose --profile proxy up -d --build` runs the app container (published on `127.0.0.1:3000` only, `TRUST_PROXY=1`) and Caddy (ports 80/443, automatic certificates, no access log). Data lives in the `gatepass-data` volume. Steps: [deployment.md](../deployment.md).
- The same compose file runs on any Linux host with Docker; the systemd path in deployment.md covers hosts without Docker.

**Optional: Vercel for the static frontend, with the API on that host.** `vercel.mjs` builds `dist/client`, serves it with the same CSP the server sends, and proxies `/api/*` and `/p/*` to `GATEPASS_BACKEND_ORIGIN`, setting `x-origin-secret` on each proxied request. The server, started with the same `ORIGIN_SECRET` (at least 32 characters), answers 403 to any request without it except `/api/health`, so clients cannot bypass Vercel and spoof forwarding headers. Set `TRUST_PROXY` to the real hop count (2 for Vercel + Caddy).

## Consequences

- One machine is a single point of failure; there is no failover. Backups must be copied off the instance (deployment.md, "Backups and restore").
- Oracle's Always Free terms, as documented on the [Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) page at the time of writing: A1 capacity equivalent to 2 OCPUs and 12 GB of memory per Always Free tenancy, possible "out of host capacity" errors when creating instances, and reclamation of instances that are idle for 7 days (95th-percentile CPU, network and, for A1, memory utilisation all under 20 %). An instance that sits unused between events can meet that definition, which is another reason for off-instance backups.
- The Vercel split adds a hop and a second deployment to keep in sync, and Vercel sees every proxied request, including `/p/<token>` paths, which are credentials. Use it only if the static front adds something the single host does not.
- None of these hosting paths has been exercised on the real provider in this repository ([testing.md](../testing.md#verification-status)).

## Alternatives

- **Run the API on Vercel.** Not possible with this design. Vercel's knowledge-base article [Is SQLite supported in Vercel?](https://vercel.com/kb/guide/is-sqlite-supported-in-vercel) says SQLite cannot be used there: function storage is ephemeral, and concurrent instances do not share a filesystem.
- **Render free web service.** [Render's free tier documentation](https://render.com/docs/free) states that free web services have an ephemeral filesystem (local SQLite databases are lost on every redeploy, restart or spin-down after 15 idle minutes) and cannot attach persistent disks. GatePass on Render therefore needs a paid instance with a persistent disk: per [render.com/pricing](https://render.com/pricing) (checked 2026-11-07) the smallest paid web service is $7/month (0.5 CPU, 512 MB) and disks cost $0.25 per GB per month, so about $7.25/month for a 1 GB disk before any bandwidth or build-minute overage. Attaching a disk also disables zero-downtime deploys. Not chosen without the owner's approval.
- **Managed database (Postgres) on a free tier plus a stateless app host.** Requires replacing SQLite (ADR 0001) and its locking model (ADR 0003). Render's free Postgres, for example, expires 30 days after creation (same Render page).
- **Plain HTTPS in Node without a proxy** (`HTTPS_CERT_FILE`/`HTTPS_KEY_FILE`). Supported, but certificate issuance and renewal become the operator's job. Caddy automates both.
