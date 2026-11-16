#!/usr/bin/env bash
# Off-host backup for the Docker single-host deployment (docker-compose.yml).
#
#   bash scripts/offsite-backup.sh
#
# 1. `backup`: consistent online copy (VACUUM INTO + integrity_check) to
#    /data/backups/gatepass-<UTC time>.db inside the running container.
# 2. `verify`: integrity, foreign keys and admission invariants of that copy.
# 3. `docker cp` it to BACKUP_DIR on the host and check the SHA-256 matches.
# 4. Optional upload hook (BACKUP_UPLOAD_CMD) to move it off the host.
# 5. Retention: keep the newest BACKUP_KEEP copies in the container and on the host.
# Any failure exits non-zero before retention runs, so a bad run never prunes
# a good backup. Safe while doors are open: the server keeps running.
#
# Environment:
#   GATEPASS_CONTAINER  container name (default gatepass-gatepass-1, the compose service)
#   BACKUP_DIR          host directory for the copies (default ./backups)
#   BACKUP_KEEP         copies to keep in each place (default 14)
#   BACKUP_UPLOAD_CMD   optional command run with bash; the local file is $1, e.g.
#                         BACKUP_UPLOAD_CMD='rclone copy "$1" offsite:gatepass-backups/'
#                         BACKUP_UPLOAD_CMD='scp -q "$1" backup@vault.example.com:gatepass/'
#                       Credentials belong in that tool's own config, never in this repo.
#
# Schedule it from cron on the host, for example hourly during event days:
#   15 * * * * cd /srv/gatepass && bash scripts/offsite-backup.sh >> backups/backup.log 2>&1
set -euo pipefail
# Git Bash on Windows would rewrite container paths such as /data/... into host paths.
export MSYS_NO_PATHCONV=1

container=${GATEPASS_CONTAINER:-gatepass-gatepass-1}
backup_dir=${BACKUP_DIR:-./backups}
keep=${BACKUP_KEEP:-14}
[[ "$keep" =~ ^[1-9][0-9]*$ ]] || { echo "BACKUP_KEEP must be a positive integer" >&2; exit 2; }

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "FAILED: $*" >&2; exit 1; }

[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" = true ] || fail "container $container is not running"

name="gatepass-$(date -u +%Y%m%dT%H%M%SZ).db"
remote="/data/backups/$name"
mkdir -p "$backup_dir"
local_file="$backup_dir/$name"

log "backup $container:$remote"
docker exec "$container" mkdir -p /data/backups || fail "cannot create /data/backups"
docker exec "$container" node dist/server/index.js backup "$remote" || fail "backup command failed"

log "verify $remote"
docker exec "$container" node dist/server/index.js verify "$remote" > "$local_file.verify.json" \
  || { cat "$local_file.verify.json" >&2; fail "verify reported problems (report: $local_file.verify.json)"; }

log "copy to $local_file"
docker cp "$container:$remote" "$local_file" || fail "docker cp failed"
remote_sum=$(docker exec "$container" node -e \
  "process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(process.argv[1])).digest('hex'))" \
  "$remote") || fail "cannot hash $remote"
local_sum=$(sha256sum "$local_file" | cut -d' ' -f1)
[ "$remote_sum" = "$local_sum" ] || fail "checksum mismatch after copy ($remote_sum vs $local_sum)"
printf '%s  %s\n' "$local_sum" "$name" > "$local_file.sha256"
log "sha256 $local_sum ($(wc -c < "$local_file" | tr -d ' ') bytes)"

if [ -n "${BACKUP_UPLOAD_CMD:-}" ]; then
  log "upload hook"
  bash -c "$BACKUP_UPLOAD_CMD" upload "$local_file" || fail "upload hook failed"
else
  log "BACKUP_UPLOAD_CMD not set: the copy is only on this host; move it off the host"
fi

# Retention, newest first by the timestamp in the name. Only gatepass-*.db
# files written by this script (and their sidecars) are touched.
log "retention: keep newest $keep"
docker exec "$container" sh -c '
  cd /data/backups && ls -1 gatepass-*.db 2>/dev/null | sort -r | tail -n +$(( $1 + 1 )) | while read -r old; do rm -f -- "$old"; echo "pruned container $old"; done
' prune "$keep" || fail "container retention failed"
(cd "$backup_dir" && ls -1 gatepass-*.db 2>/dev/null || true) | sort -r | tail -n +$(( keep + 1 )) | while read -r old; do
  rm -f -- "$backup_dir/$old" "$backup_dir/$old.sha256" "$backup_dir/$old.verify.json"
  echo "pruned host $old"
done

log "done: $local_file"
