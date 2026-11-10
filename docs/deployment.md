# Deployment

GatePass is one Node.js process that serves the API, the built web UI (`/` for admins, `/scan` for door staff) and attendee pass pages (`/p/<token>`). State lives in a single SQLite database (WAL mode). Run exactly one instance per database.

This guide covers:

1. [Configuration](#configuration)
2. [Oracle Cloud ARM64 with Docker](#oracle-cloud-arm64-ampere-a1-with-docker) (recommended path)
3. [Building an arm64 image on an x86 machine](#building-an-arm64-image-on-an-x86-machine)
4. [Backups and restore](#backups-and-restore)
5. [Upgrades](#upgrades)
6. [Running without Docker (systemd)](#running-without-docker-systemd)
7. [Access boundaries](#access-boundaries)

## Configuration

All configuration is environment variables (see `.env.example`). The server refuses to start if a value is invalid.

| Variable | Default | Notes |
| --- | --- | --- |
| `ADMIN_TOKEN` | — (required) | At least 24 characters. Operator break-glass bearer credential for the API only (not a UI login); requests are audited as `operator`. Used to bootstrap the first platform admin. |
| `ALLOW_SIGNUP` | `false` | `true` lets anyone create an organizer account at `/`. Otherwise accounts come only from invitations. |
| `APP_PUBLIC_URL` | `http://localhost:3000` | Public origin. Pass QR codes encode `${APP_PUBLIC_URL}/p/<token>`. Must be the public `https://` origin in production. |
| `DATABASE_FILE` | `.local/data/gatepass.db` | The directory must be writable; SQLite creates `-wal` and `-shm` files next to the database. The container uses `/data/gatepass.db`. |
| `HOST` | `127.0.0.1` | Bind address. The image sets `0.0.0.0` so published ports work. |
| `PORT` | `3000` | Listen port. |
| `TRUST_PROXY` | unset (trust nothing) | Express `trust proxy`: hop count (`1`) or `loopback`/subnet list. Set it when a reverse proxy is in front, otherwise every client shares the proxy's IP for rate limiting. |
| `CLIENT_DIR` | `dist/client` | Built UI; served only if it contains `index.html`. |
| `HTTPS_CERT_FILE`, `HTTPS_KEY_FILE` | unset | Optional TLS in Node. Normally TLS terminates at the proxy. |
| `GATEPASS_DOMAIN` | unset | Read only by the compose `proxy` profile (Caddy site address). |

Health check: `GET /api/health` returns `200 {"ok":true,"service":"gatepass","signup":false}` (`signup` mirrors `ALLOW_SIGNUP`), or `503` when the database is unusable.

Camera scanning on `/scan` needs a secure context: HTTPS, or `http://localhost` on the same machine. Over plain HTTP from another device the browser blocks the camera.

`APP_PUBLIC_URL` is baked into every pass link you send. Changing it later breaks links already sent to the old host; scanners still accept old QR codes because redemption only uses the token at the end of the URL.

## Oracle Cloud ARM64 (Ampere A1) with Docker

The image is built from `node:22-bookworm-slim`, which is published for `linux/arm64`, so building directly on the VM produces a native arm64 image. The runtime image contains only the prebuilt `dist/` output (client and bundled server) and production dependencies; there are no native addons.

What you end up with:

- `gatepass` container: app on `127.0.0.1:3000` (loopback only), database in the named volume `gatepass_gatepass-data`.
- `caddy` container (compose profile `proxy`): ports 80/443, automatic Let's Encrypt certificate, reverse proxy to `gatepass:3000`.

### 1. Create the instance

- Shape: `VM.Standard.A1.Flex` (1 OCPU / 6 GB is plenty for one event).
- Image: Canonical Ubuntu 22.04 or 24.04 (the aarch64 build is selected automatically for A1 shapes).
- Assign a public IPv4 address. A reserved public IP avoids having to change DNS if the VNIC is ever recreated.
- SSH in as `ubuntu` and confirm the architecture:

```sh
uname -m
# aarch64
```

### 2. Open ports 80 and 443

Oracle filters traffic in two independent places; both must allow it.

**a. VCN security list or network security group (OCI console).** On the subnet's security list (or an NSG attached to the instance VNIC), add stateful ingress rules:

| Source CIDR | Protocol | Destination port | Purpose |
| --- | --- | --- | --- |
| `0.0.0.0/0` | TCP | 80 | ACME HTTP-01 challenge, redirect to HTTPS |
| `0.0.0.0/0` | TCP | 443 | HTTPS |
| `0.0.0.0/0` | UDP | 443 | HTTP/3 (optional) |

Do not add a rule for port 3000. Restrict port 22 to your own address range if you can.

**b. Instance firewall (iptables).** Oracle's Ubuntu images ship `/etc/iptables/rules.v4`, loaded at boot by `netfilter-persistent`. Its `INPUT` chain accepts SSH and ends with `REJECT --reject-with icmp-host-prohibited`; new rules must be inserted *before* that REJECT. Do this **before installing Docker**, so that `netfilter-persistent save` does not write Docker's runtime rules into `rules.v4`.

```sh
sudo iptables -L INPUT -n --line-numbers
# Find the line number of the final REJECT rule (usually 6) and insert above it.
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p udp --dport 443 -j ACCEPT
sudo netfilter-persistent save
sudo iptables -L INPUT -n --line-numbers   # the ACCEPT rules must precede the REJECT
```

Do not enable `ufw` on OCI images; Oracle advises against it and it conflicts with the shipped rules.

Note on Docker: traffic to ports *published by containers* is DNATed and traverses the `FORWARD` chain, where Docker inserts its own rules ahead of the image's `FORWARD ... REJECT`. The `INPUT` rules above are what admit traffic to processes listening on the host itself (the [systemd setup](#running-without-docker-systemd), or a reverse proxy installed on the host). Keep them in either case. Because Docker-published ports bypass `INPUT`, compose binds the app to `127.0.0.1:3000` so it is never reachable from outside, regardless of host firewall rules.

### 3. Install Docker Engine

Use Docker's apt repository (the Ubuntu `docker.io` package works too but lags behind and lacks the compose v2 plugin on 22.04):

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo docker run --rm hello-world
```

Optionally `sudo usermod -aG docker "$USER"` and log in again to run `docker` without `sudo`. Membership in the `docker` group is equivalent to root on the host; only grant it to administrators. The commands below assume it.

### 4. DNS

Create an `A` record for the host name you will use (for example `gate.example.com`) pointing at the instance's public IPv4 address. Add an `AAAA` record only if you configured IPv6 on the VCN and instance. Wait until it resolves before starting Caddy, otherwise certificate issuance fails and Let's Encrypt rate limits may kick in after repeated attempts:

```sh
dig +short gate.example.com
```

### 5. Get the code and create `.env`

```sh
git clone git@github.com:<owner>/GatePass.git gatepass   # private repo: use a read-only deploy key
cd gatepass

umask 077
cat > .env <<EOF
ADMIN_TOKEN=$(openssl rand -base64 32)
APP_PUBLIC_URL=https://gate.example.com
GATEPASS_DOMAIN=gate.example.com
EOF
chmod 600 .env
grep ADMIN_TOKEN .env   # store this value in your password manager
```

`openssl rand -base64 32` gives 44 characters; `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` works too. Everything else uses defaults: compose sets `HOST=0.0.0.0`, `PORT=3000`, `DATABASE_FILE=/data/gatepass.db` and `TRUST_PROXY=1` inside the container, overriding `.env`.

To avoid typing `--profile proxy` on every command, add `COMPOSE_PROFILES=proxy` to `.env`.

### 6. Build and start

```sh
docker compose --profile proxy up -d --build
```

The first build on an A1 instance takes a few minutes (`npm ci` and the Vite build). Compose starts Caddy only after the app reports healthy.

### 7. Verify

```sh
docker compose --profile proxy ps
# gatepass ... Up (healthy)   127.0.0.1:3000->3000/tcp
# caddy    ... Up             0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp, ...

curl -fsS http://127.0.0.1:3000/api/health
# {"ok":true,"service":"gatepass"}

docker image inspect --format '{{.Architecture}}' gatepass:local
# arm64

docker compose logs gatepass     # "GatePass listening on http://0.0.0.0:3000 (public URL https://gate.example.com)"
docker compose logs caddy        # look for "certificate obtained successfully"

curl -fsS https://gate.example.com/api/health      # from your own machine
curl -sI https://gate.example.com/ | grep -i strict-transport-security
```

Then create the first account: with `ALLOW_SIGNUP=true`, sign up at `https://gate.example.com/`; otherwise create a platform-admin invitation with `ADMIN_TOKEN` (`POST /api/platform/invitations`, see [deployment-runbook.md](deployment-runbook.md)) and open the returned link. Sign in, create an event, issue a test pass and redeem it on a phone via `/scan`.

If Caddy cannot obtain a certificate, check, in order: DNS resolves to this instance, the security list/NSG rules, `curl http://gate.example.com` from outside reaches Caddy (a redirect response), and `GATEPASS_DOMAIN` is set in `.env`.

### Using the app without Caddy

`docker compose up -d --build` (no profile) runs only the app on `127.0.0.1:3000`. Put your own reverse proxy on the host in front of it (TLS, one hop, so `TRUST_PROXY=1` stays correct), or use an SSH tunnel for admin access: `ssh -L 3000:127.0.0.1:3000 ubuntu@<ip>` and open `http://localhost:3000`.

## Building an arm64 image on an x86 machine

Building natively on the VM (above) is the simplest option. To build elsewhere, use Buildx with QEMU emulation. Docker Desktop includes QEMU; on Linux install the binfmt handlers first:

```sh
docker run --privileged --rm tonistiigi/binfmt --install arm64
docker buildx build --platform linux/arm64 -t gatepass:arm64 --load .
docker image inspect --format '{{.Architecture}}' gatepass:arm64   # arm64
```

The Dockerfile builds the web UI on the build machine's native platform (`--platform=$BUILDPLATFORM`; the output is static files), so only the production `npm ci` runs under emulation.

Transfer the image without a registry and run it with compose:

```sh
docker save gatepass:arm64 | gzip > gatepass-arm64.tar.gz
scp gatepass-arm64.tar.gz ubuntu@<ip>:
# on the VM:
gunzip -c gatepass-arm64.tar.gz | docker load
docker tag gatepass:arm64 gatepass:local
docker compose --profile proxy up -d --no-build
```

CI builds the image for `linux/amd64` and `linux/arm64` on every push (without publishing it).

## Backups and restore

The database holds events, attendee names and email addresses, scanner metadata, redemption history and the audit log. Pass tokens and scanner keys are stored only as SHA-256 hashes, so a backup cannot be turned into working passes, but it is personal data: keep backups encrypted or access-controlled, and keep a copy off the instance (for example in OCI Object Storage).

Restoring a backup rolls back redemptions made after it was taken: those passes become redeemable again. Back up immediately before and after an event, and avoid restoring during doors-open.

### Online backup (app keeps running)

`VACUUM INTO` writes a consistent, compacted copy while the app is serving traffic. The image has no `sqlite3` CLI; Node's built-in `node:sqlite` does the job:

```sh
mkdir -p backups
docker compose exec gatepass rm -f /tmp/gatepass-backup.db
docker compose exec gatepass node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.env.DATABASE_FILE); db.exec(\"VACUUM INTO '/tmp/gatepass-backup.db'\"); db.close();"
docker compose exec gatepass node -e "const { DatabaseSync } = require('node:sqlite'); console.log(new DatabaseSync('/tmp/gatepass-backup.db', { readOnly: true }).prepare('PRAGMA integrity_check').get());"
# [Object: null prototype] { integrity_check: 'ok' }
docker compose cp gatepass:/tmp/gatepass-backup.db "backups/gatepass-$(date +%Y%m%d-%H%M%S).db"
docker compose exec gatepass rm /tmp/gatepass-backup.db
```

Put these lines in a script and run it from cron (as a user in the `docker` group) for scheduled backups.

### Offline backup (copy the volume)

Stopping the app first makes it close the database cleanly. The archive includes any `-wal`/`-shm` files, so it is consistent either way.

```sh
docker compose stop gatepass
docker run --rm --user root -v gatepass_gatepass-data:/data:ro -v "$PWD/backups:/backup" gatepass:local \
  tar -C /data -czf "/backup/gatepass-data-$(date +%Y%m%d-%H%M%S).tar.gz" .
docker compose start gatepass
```

`docker volume ls` shows the exact volume name (`<project>_gatepass-data`; the project name is `gatepass`).

### Restore

Stop the app and replace the database. Always delete stale `-wal` and `-shm` files: SQLite would otherwise apply an old write-ahead log to the restored file.

The server also has CLI commands for this: `node dist/server/index.js verify [file]` runs `integrity_check`, `foreign_key_check` and the admission invariant checks, and `node dist/server/index.js restore <backup>` verifies the backup, keeps the old files as `.replaced-<timestamp>`, then opens, migrates and verifies the restored file, rolling back on failure. Run them with the app stopped and `DATABASE_FILE` set. See [deployment-runbook.md](deployment-runbook.md). The manual steps below remain valid.

From an online (`VACUUM INTO`) backup:

```sh
docker compose stop gatepass
docker run --rm --user root -v gatepass_gatepass-data:/data -v "$PWD/backups:/backup:ro" gatepass:local \
  sh -c 'rm -f /data/gatepass.db /data/gatepass.db-wal /data/gatepass.db-shm \
    && cp /backup/gatepass-YYYYMMDD-HHMMSS.db /data/gatepass.db \
    && chown node:node /data/gatepass.db'
docker compose start gatepass
curl -fsS http://127.0.0.1:3000/api/health
```

From an offline (`tar`) backup:

```sh
docker compose stop gatepass
docker run --rm --user root -v gatepass_gatepass-data:/data -v "$PWD/backups:/backup:ro" gatepass:local \
  sh -c 'rm -f /data/gatepass.db /data/gatepass.db-wal /data/gatepass.db-shm \
    && tar -C /data -xzf /backup/gatepass-data-YYYYMMDD-HHMMSS.tar.gz \
    && chown -R node:node /data'
docker compose start gatepass
```

## Upgrades

```sh
# 1. Take an online backup (see above).
# 2. Update the code and rebuild; --pull also refreshes the node base image.
git pull
docker compose --profile proxy build --pull
docker compose --profile proxy up -d
docker compose --profile proxy ps          # wait for gatepass (healthy)
curl -fsS http://127.0.0.1:3000/api/health
# 3. Remove superseded images.
docker image prune -f
```

Database migrations run automatically at startup and are tracked with `PRAGMA user_version`. A newer schema is not guaranteed to work with older code, so to roll back: check out the previous commit, rebuild, and restore the backup taken before the upgrade.

`docker compose pull caddy` followed by `docker compose --profile proxy up -d` updates Caddy. Restarting the app container drops in-flight requests for a moment; scanners retry, but avoid upgrading during doors-open.

## Running without Docker (systemd)

Same host preparation (instance, both firewall layers, DNS), then:

### Node.js 22 from NodeSource

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x -o nodesource_setup.sh
sudo -E bash nodesource_setup.sh
sudo apt-get install -y nodejs git
node --version   # must be v22.13.0 or newer (built-in node:sqlite)
```

### Build

```sh
sudo useradd --system --home-dir /var/lib/gatepass --shell /usr/sbin/nologin gatepass
sudo mkdir -p /opt/gatepass && sudo chown "$USER" /opt/gatepass
git clone git@github.com:<owner>/GatePass.git /opt/gatepass
cd /opt/gatepass
npm ci
npm run build
npm prune --omit=dev
```

The code stays owned by your deploy user; the service account can read it but not modify it.

### Environment file

```sh
sudo install -d -m 0755 /etc/gatepass
sudo install -m 0600 /dev/null /etc/gatepass/gatepass.env
sudo tee /etc/gatepass/gatepass.env > /dev/null <<EOF
ADMIN_TOKEN=$(openssl rand -base64 32)
APP_PUBLIC_URL=https://gate.example.com
DATABASE_FILE=/var/lib/gatepass/gatepass.db
HOST=127.0.0.1
PORT=3000
TRUST_PROXY=loopback
CLIENT_DIR=/opt/gatepass/dist/client
EOF
```

systemd reads the file as root before dropping privileges, so it can stay `root:root 0600`.

### Unit: `/etc/systemd/system/gatepass.service`

```ini
[Unit]
Description=GatePass event entry
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=gatepass
Group=gatepass
WorkingDirectory=/opt/gatepass
EnvironmentFile=/etc/gatepass/gatepass.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning dist/server/index.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=15

# Creates /var/lib/gatepass owned by the service user.
StateDirectory=gatepass
StateDirectoryMode=0700
UMask=0077

# Hardening. MemoryDenyWriteExecute is deliberately omitted: V8's JIT needs it off.
NoNewPrivileges=yes
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now gatepass
systemctl status gatepass
curl -fsS http://127.0.0.1:3000/api/health
systemd-analyze security gatepass   # review the remaining exposure
```

`ProtectSystem=strict` leaves only `/var/lib/gatepass` and the private `/tmp` writable. If you move `DATABASE_FILE`, add its directory to `ReadWritePaths=`.

`npm run build` bundles the server into `dist/server/index.js`, so production runs plain JavaScript with no TypeScript transpiler at runtime. The QR render endpoint `/api/qr/custom` requires a signed-in account; it is not public.

### Reverse proxy on the host

Install Caddy from its official apt repository (https://caddyserver.com/docs/install#debian-ubuntu-raspbian) and use `/etc/caddy/Caddyfile`:

```caddyfile
gate.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
	header -Server
}
```

`sudo systemctl reload caddy`. Here the `INPUT` iptables rules for 80/443 are what admit traffic, since Caddy listens on the host.

### Backups, upgrades

```sh
# Online backup
sudo -u gatepass node --disable-warning=ExperimentalWarning -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync('/var/lib/gatepass/gatepass.db'); db.exec(\"VACUUM INTO '/var/lib/gatepass/backup.db'\"); db.close();"
sudo mv /var/lib/gatepass/backup.db "/var/backups/gatepass-$(date +%Y%m%d-%H%M%S).db"

# Restore
sudo systemctl stop gatepass
sudo rm -f /var/lib/gatepass/gatepass.db-wal /var/lib/gatepass/gatepass.db-shm
sudo install -o gatepass -g gatepass -m 0600 /var/backups/gatepass-YYYYMMDD-HHMMSS.db /var/lib/gatepass/gatepass.db
sudo systemctl start gatepass

# Upgrade (after a backup)
cd /opt/gatepass && git pull && npm ci && npm run build && npm prune --omit=dev
sudo systemctl restart gatepass
```

## Access boundaries

| Credential / route | Grants | Notes |
| --- | --- | --- |
| Account session (`__Host-gatepass_session` cookie) | `/api/events*`, `/api/passes*`, `/api/scanners*` for events where the user is owner or manager (non-members get 404); `/api/platform/*` for platform admins. | Email and password (scrypt), HttpOnly cookie, 7-day absolute and 24-hour idle limit; writes need `X-GatePass-CSRF: 1`. Accounts come from sign-up (`ALLOW_SIGNUP=true`) or invitations. |
| `ADMIN_TOKEN` (`Authorization: Bearer`) | Operator break-glass access to the whole API; not accepted by the UI. | One shared secret, compared in constant time, audited as `operator`. To rotate: change `.env`, then `docker compose up -d` (or `systemctl restart gatepass`). See [security-and-threat-model.md](security-and-threat-model.md). |
| Scanner key (`gps_…`) | `/api/scanner/session` and `/api/scanner/redeem` for **one event only**. | Created by an admin, shown once as a `/scan#key=…` setup link (the fragment is never sent to the server), stored hashed. Kept in the device's `localStorage`. Revoke a lost or departed device in the admin UI. |
| Pass link `/p/<token>` | Viewing that pass and its QR code. | A bearer credential: anyone with the link can show the QR. Viewing never redeems. Revoke or reissue from the admin UI. Pages are `no-store` and `noindex`. |
| Public | `/api/health`, `/api/auth/login`, `/api/auth/register` (when `ALLOW_SIGNUP=true`), `/api/invitations/preview` and `/accept`, the static UI. | No event data access. |

- **Single instance.** Rate limits are kept in process memory and SQLite allows one writer. Do not run replicas, `docker compose up --scale`, or two containers on the same volume. Redemption is still atomic within one process (a database constraint guarantees at most one redemption per pass).
- **Local disk only for the database.** WAL mode coordinates readers and the writer through the memory-mapped `-shm` file and POSIX file locks. Network filesystems (NFS, SMB, OCI File Storage) do not provide reliable locking or shared memory across hosts and can corrupt the database. Use the boot volume or an attached OCI block volume (a local block device) for `/data`.
- **Network exposure.** Only the reverse proxy should be reachable from the internet. Port 3000 is bound to loopback; do not open it in the security list. HTTPS is required for camera scanning and to keep tokens off the wire in plain text.
- **Logs.** Do not enable proxy access logs that record full URLs: `/p/<token>` paths are pass credentials.
- **Host access.** Anyone with root or `docker` group access on the VM can read the database and `.env`. Keep SSH keys and that group limited to administrators.
- **Container healthcheck** probes `http://127.0.0.1:$PORT/api/health`. If you enable `HTTPS_CERT_FILE`/`HTTPS_KEY_FILE` inside the container, the built-in healthcheck will fail; terminate TLS at the proxy instead.
