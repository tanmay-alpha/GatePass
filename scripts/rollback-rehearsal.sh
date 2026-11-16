#!/usr/bin/env bash
# Rollback rehearsal across a schema migration, on a throwaway Docker volume.
#
#   OLD_IMAGE=gatepass:old NEW_IMAGE=gatepass:new bash scripts/rollback-rehearsal.sh
#
# 1. OLD starts on an empty volume; synthetic data is seeded and one pass is admitted.
# 2. OLD stops gracefully. NEW starts on the same volume: it migrates the
#    database and writes <db>.pre-v<N>.bak first. The first admission must
#    survive the migration; a second pass is admitted on NEW with the scanner
#    key enrolled on OLD.
# 3. NEW stops. The .pre-v<N>.bak is verified and restored with OLD's own
#    `restore` (it is at OLD's schema, so nothing is migrated).
#    Control: restoring the same file with NEW's `restore` migrates it to
#    NEW's schema, and OLD must refuse to start on that copy. This is why a
#    rollback restores with the OLD build (or by hand), never with the NEW one.
# 4. OLD starts on the restored file: it must become healthy, the first
#    admission must still be redeemed, the pass admitted on NEW must be gone,
#    and `verify` must pass.
#
# Nothing outside the throwaway volume and containers is touched; both are
# removed at the end (KEEP=1 keeps them for inspection). All data is synthetic.
# Requires: docker, bash. No host Node.js, curl or jq.
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash: keep /data/... container paths intact

: "${OLD_IMAGE:?set OLD_IMAGE, e.g. gatepass:old (built from the release being rolled back to)}"
: "${NEW_IMAGE:?set NEW_IMAGE, e.g. gatepass:new (the release being rolled back)}"
run_id="rr-$(date +%s)-$$"
volume="$run_id-data"
old_c="$run_id-old"
new_c="$run_id-new"
admin_token="rehearsal-operator-token-$(date +%s)-0123456789"
db=/data/gatepass.db
report=()

step() { printf '\n== %s\n' "$*"; }
ok() { report+=("PASS  $*"); printf 'PASS  %s\n' "$*"; }
die() { report+=("FAIL  $*"); printf 'FAIL  %s\n' "$*" >&2; exit 1; }

cleanup() {
  status=$?
  printf '\n==== Rollback rehearsal report (%s -> %s -> %s)\n' "$OLD_IMAGE" "$NEW_IMAGE" "$OLD_IMAGE"
  printf '%s\n' "${report[@]}"
  if [ "$status" -eq 0 ]; then echo "RESULT: rollback rehearsal passed"; else echo "RESULT: rollback rehearsal FAILED (exit $status)"; fi
  if [ "${KEEP:-0}" = 1 ]; then
    echo "KEEP=1: containers $old_c/$new_c and volume $volume left in place"
  else
    docker rm -f "$old_c" "$new_c" >/dev/null 2>&1 || true
    docker volume rm "$volume" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# One-off container on the volume (no server started).
oneoff() { local image=$1; shift; docker run --rm -v "$volume:/data" "$image" "$@"; }
schema_of() { # schema_of IMAGE FILE -> PRAGMA user_version (read-only)
  oneoff "$1" node -e "const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    console.log(db.prepare('PRAGMA user_version').get().user_version); db.close();" "$2"
}

start() { # start NAME IMAGE: run the server and wait until healthy
  docker run -d --name "$1" -v "$volume:/data" -e ADMIN_TOKEN="$admin_token" \
    -e APP_PUBLIC_URL=http://localhost:3000 "$2" >/dev/null
  for _ in $(seq 1 60); do
    case "$(docker inspect -f '{{.State.Status}}/{{.State.Health.Status}}' "$1")" in
      running/healthy) return 0 ;;
      exited/*|dead/*) docker logs "$1" 2>&1 | tail -n 20 >&2; return 1 ;;
    esac
    sleep 1
  done
  docker logs "$1" 2>&1 | tail -n 20 >&2
  return 1
}

stop() { # stop NAME: graceful stop, exit code 0, container removed
  docker stop -t 15 "$1" >/dev/null
  [ "$(docker inspect -f '{{.State.ExitCode}}' "$1")" = 0 ] || die "$1 did not exit cleanly on SIGTERM"
  docker rm "$1" >/dev/null
}

# API calls run inside the container with its own Node.js (no published port).
# ACTION: seed | admit | status. Prints one flat JSON line of string values.
client_js=$(cat <<'JS'
const base = 'http://127.0.0.1:3000';
const env = process.env;
async function call(method, path, body, auth = `Bearer ${env.ADMIN_TOKEN}`) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(auth ? { authorization: auth } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> HTTP ${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
async function admit(eventId, scannerKey, requestId) {
  const [pass] = await call('POST', `/api/events/${eventId}/passes`, { count: 1 });
  const result = await call('POST', '/api/scanner/redeem', { code: pass.token, requestId }, `Bearer ${scannerKey}`);
  return { passId: pass.id, outcome: result.outcome };
}
let out;
if (env.ACTION === 'seed') {
  const now = Date.now();
  const event = await call('POST', '/api/events', {
    name: 'Rollback rehearsal (synthetic)',
    startsAt: new Date(now - 3600e3).toISOString().replace(/\.\d+Z$/, 'Z'),
    endsAt: new Date(now + 86400e3).toISOString().replace(/\.\d+Z$/, 'Z'),
    status: 'active'
  });
  const created = await call('POST', `/api/events/${event.id}/scanners`, { label: 'Rehearsal door' });
  let scannerKey = created.key; // builds before one-time enrollment return the key directly
  if (!scannerKey) {
    const code = String(created.enrollment.url).split('#enroll=')[1];
    scannerKey = (await call('POST', '/api/scanner/enroll', { code }, '')).key;
  }
  out = { eventId: event.id, scannerKey, ...(await admit(event.id, scannerKey, 'rehearsal-scan-0001')) };
} else if (env.ACTION === 'admit') {
  out = await admit(env.EVENT_ID, env.SCANNER_KEY, 'rehearsal-scan-0002');
} else if (env.ACTION === 'status') {
  const passes = await call('GET', `/api/events/${env.EVENT_ID}/passes`);
  out = Object.fromEntries(env.PASS_IDS.split(',').map((id) => [id, passes.find((pass) => pass.id === id)?.status ?? 'absent']));
} else {
  throw new Error(`unknown ACTION ${env.ACTION}`);
}
console.log(JSON.stringify(out));
JS
)
client() { # client CONTAINER ACTION [VAR=value ...]
  local container=$1 action=$2; shift 2
  local args=(-e "ACTION=$action")
  for pair in "$@"; do args+=(-e "$pair"); done
  printf '%s' "$client_js" | docker exec -i "${args[@]}" "$container" node --input-type=module -
}
field() { # field JSON KEY: a string value from client_js's flat JSON output
  [[ $1 =~ \"$2\":\"([^\"]*)\" ]] || return 1
  printf '%s\n' "${BASH_REMATCH[1]}"
}

docker image inspect "$OLD_IMAGE" >/dev/null 2>&1 || die "image $OLD_IMAGE not found"
docker image inspect "$NEW_IMAGE" >/dev/null 2>&1 || die "image $NEW_IMAGE not found"
docker volume create "$volume" >/dev/null

step "1. OLD ($OLD_IMAGE): seed synthetic data and admit pass 1"
start "$old_c" "$OLD_IMAGE" || die "OLD did not become healthy on an empty volume"
seed=$(client "$old_c" seed) || die "seeding on OLD failed"
event_id=$(field "$seed" eventId)
scanner_key=$(field "$seed" scannerKey)
pass1=$(field "$seed" passId)
[ "$(field "$seed" outcome)" = admitted ] || die "pass 1 was not admitted on OLD"
ok "OLD healthy; event $event_id; pass 1 ($pass1) admitted"
stop "$old_c"
old_schema=$(schema_of "$OLD_IMAGE" "$db")
ok "OLD stopped cleanly; database at schema v$old_schema"

step "2. NEW ($NEW_IMAGE): migrate, keep pass 1, admit pass 2"
start "$new_c" "$NEW_IMAGE" || die "NEW did not start on OLD's database (migration failed?)"
status=$(client "$new_c" status EVENT_ID="$event_id" PASS_IDS="$pass1")
[ "$(field "$status" "$pass1")" = redeemed ] || die "pass 1 is not redeemed after the migration ($status)"
admit2=$(client "$new_c" admit EVENT_ID="$event_id" SCANNER_KEY="$scanner_key") || die "admission on NEW failed"
pass2=$(field "$admit2" passId)
[ "$(field "$admit2" outcome)" = admitted ] || die "pass 2 was not admitted on NEW ($admit2)"
ok "NEW healthy after migration; pass 1 still redeemed; pass 2 ($pass2) admitted with the key enrolled on OLD"
stop "$new_c"
new_schema=$(schema_of "$NEW_IMAGE" "$db")
[ "$new_schema" -gt "$old_schema" ] || die "NEW did not migrate (schema v$old_schema -> v$new_schema); nothing to roll back across"
bak="$db.pre-v$new_schema.bak"
oneoff "$NEW_IMAGE" test -f "$bak" || die "NEW did not write $bak"
bak_schema=$(schema_of "$OLD_IMAGE" "$bak")
[ "$bak_schema" = "$old_schema" ] || die "$bak is at schema v$bak_schema, expected v$old_schema"
ok "NEW stopped cleanly; database v$old_schema -> v$new_schema; $bak kept at v$bak_schema"

step "3. Restore $bak"
oneoff "$OLD_IMAGE" node dist/server/index.js verify "$bak" >/dev/null || die "OLD's verify rejects $bak"
ok "OLD's verify accepts $bak"
# Control on a scratch copy: NEW's restore migrates, and OLD must then refuse it.
oneoff "$NEW_IMAGE" sh -c "DATABASE_FILE=/data/control.db node dist/server/index.js restore '$bak' >/dev/null" \
  || die "control: NEW's restore of $bak failed"
control_schema=$(schema_of "$NEW_IMAGE" /data/control.db)
control_rc=0
control_out=$(docker run --rm -v "$volume:/data" -e DATABASE_FILE=/data/control.db -e ADMIN_TOKEN="$admin_token" \
  -e APP_PUBLIC_URL=http://localhost:3000 "$OLD_IMAGE" timeout 20 node dist/server/index.js 2>&1) || control_rc=$?
# 124: still running when the timeout hit, i.e. OLD accepted the newer schema.
if [ "$control_rc" = 0 ] || [ "$control_rc" = 124 ] || ! grep -q 'newer than this build' <<<"$control_out"; then
  die "control: OLD did not refuse a v$control_schema database (exit $control_rc): $(tail -n 3 <<<"$control_out")"
fi
ok "control: NEW's restore migrates the backup to v$control_schema and OLD refuses to start on it (use OLD's restore to roll back)"
restore_out=$(oneoff "$OLD_IMAGE" node dist/server/index.js restore "$bak") || die "OLD's restore of $bak failed: $restore_out"
[ "$(schema_of "$OLD_IMAGE" "$db")" = "$old_schema" ] || die "restored database is not at v$old_schema"
ok "OLD's restore put $bak in place at v$old_schema (replaced files kept as .replaced-*)"

step "4. OLD on the restored database"
start "$old_c" "$OLD_IMAGE" || die "OLD did not start on the restored database"
status=$(client "$old_c" status EVENT_ID="$event_id" PASS_IDS="$pass1,$pass2")
[ "$(field "$status" "$pass1")" = redeemed ] || die "pass 1 is not redeemed after the rollback ($status)"
[ "$(field "$status" "$pass2")" = absent ] || die "pass 2 (written on NEW) survived the rollback ($status)"
docker exec "$old_c" node dist/server/index.js verify >/dev/null || die "verify fails on the rolled-back database"
ok "OLD healthy on the restored file; pass 1 redeemed; pass 2 (written after the upgrade) gone, as expected; verify ok"
stop "$old_c"
ok "OLD stopped cleanly"
