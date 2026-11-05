#!/usr/bin/env bash
# Smoke-tests PR 4 on `wrangler dev`: seeding, the menu and its cache, orders and their
# idempotency, the expiry on the business clock, the event relay with the `kitchen` fault, the
# dead-letter list and its redrive, and the wipe of every child. It proves each line of
# docs/roadmap.md's PR 4 "Done when" that can be proven locally, prints ok or FAIL per check as
# scripts/smoke-auth.sh does, and exits non-zero on any failure.
#
# Usage: scripts/smoke-orders.sh   (from anywhere; needs cargo, worker-build, pnpm, node and curl).
#
# Like scripts/smoke-auth.sh it writes a throwaway workers/api/.dev.vars, refuses to run when one
# exists unless SMOKE_ORDERS_OVERWRITE=1, starts the fake provider for Turnstile, and keeps the
# Worker's log in SMOKE_ORDERS_LOG=<file> when set. One Worker run, fresh state in a scratch
# directory. The Kitchen's sockets, the Simulator and the board as a browser sees it are added
# by the next stream of PR 4; until then the board is read from the Kitchen's own SQLite file,
# which `wrangler dev` keeps on disk, never through a route.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SMOKE_PORT:-8788}"
FAKE_PORT="${SMOKE_FAKE_PORT:-8790}"
BASE="http://127.0.0.1:${PORT}"
FAKE="http://127.0.0.1:${FAKE_PORT}"
STOREFRONT="http://127.0.0.1:8787"
STARTUP_TIMEOUT_S="${STARTUP_TIMEOUT_S:-240}"
DEV_VARS="$ROOT/workers/api/.dev.vars"

TMP="$(mktemp -d -t smoke-orders.XXXXXX)"
LOG="$TMP/worker.log"
FAKE_LOG="$TMP/fake.log"
FAILURES=0
PASSES=0
SERVER_PID=""
FAKE_PID=""
WROTE_DEV_VARS=""
BACKUP=""

stop_pid() {
  local pid="$1"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -KILL -- "-$pid" 2>/dev/null || true
  fi
}
stop() {
  stop_pid "$SERVER_PID"
  stop_pid "$FAKE_PID"
  if [[ -n "$WROTE_DEV_VARS" ]]; then rm -f "$DEV_VARS"; fi
  if [[ -n "$BACKUP" && -f "$BACKUP" ]]; then mv "$BACKUP" "$DEV_VARS"; fi
  if [[ -n "${SMOKE_ORDERS_LOG:-}" ]]; then cp "$LOG" "$SMOKE_ORDERS_LOG" 2>/dev/null || true; fi
  if (( FAILURES > 0 )); then
    mkdir -p "${TMPDIR:-/tmp}/smoke-orders-logs"
    cp "$LOG" "${TMPDIR:-/tmp}/smoke-orders-logs/worker.log" 2>/dev/null || true
    echo "logs kept in ${TMPDIR:-/tmp}/smoke-orders-logs" >&2
  fi
  rm -rf "$TMP"
}
trap stop EXIT

pass() { printf 'ok    %s\n' "$1"; PASSES=$((PASSES + 1)); }
fail() { printf 'FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }

if [[ -e "$DEV_VARS" ]]; then
  if [[ -z "${SMOKE_ORDERS_OVERWRITE:-}" ]]; then
    echo "workers/api/.dev.vars exists; this script would replace it. Move it aside, or set SMOKE_ORDERS_OVERWRITE=1 to have it moved and restored." >&2
    exit 2
  fi
  BACKUP="$TMP/dev.vars.backup"
  mv "$DEV_VARS" "$BACKUP"
fi
for p in "$PORT" "$FAKE_PORT"; do
  if curl -s -o /dev/null "http://127.0.0.1:$p/" 2>/dev/null; then
    echo "something already listens on port $p; stop it or set SMOKE_PORT / SMOKE_FAKE_PORT" >&2
    exit 2
  fi
done

# ---------- helpers (as in scripts/smoke-auth.sh) ----------

request() {
  local name="$1"; shift
  curl -sS -o "$TMP/$name.body" -D "$TMP/$name.raw" "$@" || true
  tr -d '\r' < "$TMP/$name.raw" | awk 'NR == 1 { print; next } { i = index($0, ":"); if (i) print tolower(substr($0, 1, i - 1)) substr($0, i) }' > "$TMP/$name.headers"
}
status_of() { head -n 1 "$TMP/$1.headers" | awk '{ print $2 }'; }
header_of() { grep -m 1 "^$2:" "$TMP/$1.headers" | cut -d: -f2- | sed 's/^ //' || true; }
expect_status() {
  local got; got="$(status_of "$1")"
  if [[ "$got" == "$2" ]]; then pass "$1: status $2"; else fail "$1: status $got, wanted $2 ($(head -c 300 "$TMP/$1.body"))"; fi
}
expect_header() {
  local got; got="$(header_of "$1" "$2")"
  if [[ "$got" == "$3" ]]; then pass "$1: $2: $3"; else fail "$1: $2 is '$got', wanted '$3'"; fi
}
expect_json() {
  if node -e "const b = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); if (!($2)) process.exit(1)" "$TMP/$1.body" 2>/dev/null; then
    pass "$1: body $2"
  else
    fail "$1: body $(head -c 300 "$TMP/$1.body") fails $2"
  fi
}
json_field() { node -e "const b = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); const v = ($2); process.stdout.write(v === undefined || v === null ? '' : String(v))" "$TMP/$1.body"; }
expect_problem() {
  expect_status "$1" "$2"
  expect_json "$1" "b.type === 'https://bakery.ihaveasegway.com/problems/$3' && b.status === $2 && typeof b.title === 'string' && typeof b.detail === 'string'"
}

jar_update() {
  local name="$1" jar="$TMP/$2.jar"
  touch "$jar"
  while IFS= read -r line; do
    local pair="${line#set-cookie: }"; pair="${pair%%;*}"
    local key="${pair%%=*}" value="${pair#*=}"
    grep -v "^$key=" "$jar" > "$jar.new" || true
    if [[ -n "$value" ]] && ! grep -qi 'max-age=0' <<<"$line"; then echo "$key=$value" >> "$jar.new"; fi
    mv "$jar.new" "$jar"
  done < <(grep '^set-cookie: ' "$TMP/$name.headers" || true)
}
jar() { if [[ -f "$TMP/$1.jar" ]]; then paste -sd';' "$TMP/$1.jar" | sed 's/;/; /g'; fi; }

ulid() {
  node -e "const A='0123456789ABCDEFGHJKMNPQRSTVWXYZ';let t=Date.now(),s='';for(let i=0;i<10;i++){s=A[t%32]+s;t=Math.floor(t/32)}const r=require('crypto').randomBytes(16);for(let i=0;i<16;i++)s+=A[r[i]%32];process.stdout.write(s)"
}
random_text() { node -e "process.stdout.write(require('crypto').randomBytes(64).toString('base64').replace(/[^A-Za-z0-9]/g,'').slice(0, $1))"; }

# command_as NAME JAR IP METHOD PATH [JSON] [EXTRA_HEADER]: a browser's command, with Origin, a
# fresh Idempotency-Key on POST (or $KEY), the visitor's cookies and a CF-Connecting-IP.
command_as() {
  local name="$1" jar_name="$2" ip="$3" method="$4" path="$5" body="${6:-}"
  local args=(-X "$method" -H "Origin: $STOREFRONT" -H "CF-Connecting-IP: $ip")
  if [[ "$method" == POST ]]; then args+=(-H "Idempotency-Key: ${KEY:-$(ulid)}"); fi
  if [[ -n "$body" ]]; then args+=(-H 'Content-Type: application/json' --data "$body"); fi
  local cookies; cookies="$(jar "$jar_name")"
  if [[ -n "$cookies" ]]; then args+=(-H "Cookie: $cookies"); fi
  request "$name" "${args[@]}" "$BASE$path"
  jar_update "$name" "$jar_name"
}
# get_as NAME JAR PATH [curl args...]
get_as() {
  local name="$1" jar_name="$2" path="$3"; shift 3
  local cookies; cookies="$(jar "$jar_name")"
  local args=(-H "CF-Connecting-IP: 192.0.2.250" -H "Origin: $STOREFRONT")
  if [[ -n "$cookies" ]]; then args+=(-H "Cookie: $cookies"); fi
  request "$name" "${args[@]}" "$@" "$BASE$path"
  jar_update "$name" "$jar_name"
}
now_ms() { node -e 'console.log(Date.now())'; }

# wait_live NAME JAR ID: polls the sandbox until seeding is done, up to 20 s.
wait_live() {
  local name="$1" jar_name="$2" id="$3"
  for _ in $(seq 1 100); do
    get_as "$name" "$jar_name" "/v1/sandboxes/$id"
    if [[ "$(json_field "$name" b.state)" == live ]]; then return 0; fi
    sleep 0.2
  done
  return 1
}

# Each object a `wrangler dev --persist-to` run keeps on disk (Wrangler 4.157.0, 2026-11-05).
do_dir() { echo "$STATE/v3/do/bakery-api-$1"; }
# kitchen_board: every Kitchen's board row as JSON lines {cards, applied}, read-only.
kitchen_board() {
  node -e "
    process.removeAllListeners('warning');
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('fs'), path = require('path');
    const dir = process.argv[1];
    if (!fs.existsSync(dir)) process.exit(0);
    for (const f of fs.readdirSync(dir).filter((f) => /^[0-9a-f]{64}\.sqlite$/.test(f))) {
      const db = new DatabaseSync(path.join(dir, f), { readOnly: true });
      const has = db.prepare(\"SELECT name FROM sqlite_master WHERE name = 'board'\").get();
      if (has) { const r = db.prepare('SELECT body, applied FROM board').get(); console.log(JSON.stringify({ board: JSON.parse(r.body), applied: r.applied })); }
      db.close();
    }" "$(do_dir Kitchen)"
}

write_dev_vars() {
  {
    echo "# Written by scripts/smoke-orders.sh for one run; removed when it ends. Never committed."
    echo "SESSION_HMAC_KEY=$(random_text 48)"
    echo "ACCOUNT_HMAC_KEY=$(random_text 48)"
    echo "TURNSTILE_SECRET=1x0000000000000000000000000000000AA"
    echo "TURNSTILE_SITEVERIFY_URL=$FAKE/turnstile/siteverify"
    echo "ALLOWED_ORIGIN=$STOREFRONT"
    echo "API_ORIGIN=$BASE"
  } > "$DEV_VARS"
  WROTE_DEV_VARS=1
}

if [[ -n "${WRANGLER:-}" ]]; then run_wrangler=(npx --yes "$WRANGLER"); else run_wrangler=(pnpm exec wrangler); fi

start_worker() {
  write_dev_vars
  STATE="$TMP/state"
  echo "--- starting ${run_wrangler[*]} dev on $BASE"
  local start_ms; start_ms="$(now_ms)"
  set -m
  (cd "$ROOT/workers/api" && exec "${run_wrangler[@]}" dev --local --ip 127.0.0.1 --port "$PORT" \
    --persist-to "$STATE" --show-interactive-dev-session=false >> "$LOG" 2>&1 < /dev/null) &
  SERVER_PID=$!
  set +m
  local deadline=$(( $(date +%s) + STARTUP_TIMEOUT_S ))
  until [[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/health" 2>/dev/null || true)" == "200" ]]; do
    if ! kill -0 "$SERVER_PID" 2>/dev/null || (( $(date +%s) > deadline )); then
      echo "wrangler dev did not answer /v1/health; its log:" >&2
      tail -n 40 "$LOG" >&2
      exit 1
    fi
    sleep 0.2
  done
  echo "first 200 after $(( $(now_ms) - start_ms )) ms"
  echo "=== Worker ready" >> "$LOG"
}

list_objects() {
  set +e
  node "$ROOT/scripts/list-objects.mjs" "$STATE" > "$TMP/$1.out" 2> "$TMP/$1.err"
  LIST_EXIT=$?
  set -e
}

# order_body NAME SLOT_MINUTES [NOTE_JSON] [LINES_JSON]: a pickup order JSON for a variant the
# menu in NAME.body sells at a slot SLOT_MINUTES from now, written to stdout. Picks an
# available item baked on the slot's day, in season, with a lead time the slot meets.
pickable() {
  node -e "
    const menu = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const minutes = Number(process.argv[2]);
    const skip = process.argv[3] || '';
    // Business time at the bakery's Mountain standard offset; the clock offset is 0 here.
    const slot = new Date(Math.ceil((Date.now() + minutes * 60000) / 900000) * 900000);
    const local = new Date(slot.getTime() - 7 * 3600000);
    const day = ['sun','mon','tue','wed','thu','fri','sat'][local.getUTCDay()];
    const md = String(local.getUTCMonth() + 1).padStart(2, '0') + '-' + String(local.getUTCDate()).padStart(2, '0');
    const inSeason = (s) => !s || (s.from <= s.to ? s.from <= md && md <= s.to : md >= s.from || md <= s.to);
    for (const c of menu.categories) for (const i of c.items) {
      if (i.slug === skip || i.status !== 'available' || !i.days_baked.includes(day) || !inSeason(i.season)) continue;
      const v = i.variants.find((v) => v.lead_minutes <= minutes - 30);
      if (!v) continue;
      const iso = local.toISOString().slice(0, 19) + '-07:00';
      console.log(JSON.stringify({ item: i.slug, variant: v.slug, slot: iso }));
      process.exit(0);
    }
    process.exit(1);" "$TMP/$1.body" "$2" "${3:-}"
}

# ---------- start ----------

echo "starting the fake provider on $FAKE"
set -m
node "$ROOT/scripts/fake-providers.mjs" --port "$FAKE_PORT" > "$FAKE_LOG" 2>&1 < /dev/null &
FAKE_PID=$!
set +m
for _ in $(seq 1 100); do curl -s -o /dev/null "$FAKE/_health" && break; sleep 0.1; done

start_worker

# ---------- seeding ----------

command_as guest G 192.0.2.41 POST /v1/sandboxes '{"turnstile_token":"pass-1","replace":false}'
expect_status guest 201
expect_json guest "['seeding', 'live'].includes(b.state) && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(b.persona) && b.faults.kitchen === false"
GID="$(json_field guest b.id)"
check "guest: seeding reaches live within 20 s" "wait_live guest_live G '$GID'"
expect_json guest_live "b.state === 'live' && b.children === 14"

CANARY="$(random_text 24)"
command_as signup D 192.0.2.42 POST /v1/auth/demo "{\"password\":\"$CANARY\",\"turnstile_token\":\"pass-1\"}"
expect_status signup 201
command_as demo D 192.0.2.42 POST /v1/sandboxes '{"replace":false}'
expect_status demo 201
DID="$(json_field demo b.id)"
check "demo: seeding reaches live within 20 s" "wait_live demo_live D '$DID'"
expect_json demo_live "b.state === 'live' && b.children === 14 && b.kind === 'account'"

# ---------- the menu and its cache ----------

get_as menu_1 G "/v1/sandboxes/$GID/menu"
expect_status menu_1 200
expect_header menu_1 etag '"v1"'
expect_header menu_1 bakery-cache miss
expect_header menu_1 cache-control 'private, no-cache'
expect_header menu_1 access-control-expose-headers 'ETag, Location, Retry-After, Bakery-Cache'
expect_json menu_1 "b.version === 1 && b.categories.length === 5 && b.categories.flatMap(c => c.items).length === 24"
get_as menu_2 G "/v1/sandboxes/$GID/menu"
expect_header menu_2 bakery-cache hit
check "menu_2: the hit is the miss's body" "cmp -s '$TMP/menu_1.body' '$TMP/menu_2.body'"
get_as menu_304 G "/v1/sandboxes/$GID/menu" -H 'If-None-Match: "v1"'
expect_status menu_304 304
expect_header menu_304 etag '"v1"'
check "menu_304: no body" "[[ ! -s '$TMP/menu_304.body' ]]"

command_as guest_patch G 192.0.2.41 PATCH "/v1/sandboxes/$GID/menu/items/x" '{"price_cents":500}'
expect_problem guest_patch 403 guest-scope
command_as guest_publish G 192.0.2.41 POST "/v1/sandboxes/$GID/menu/publish"
expect_problem guest_publish 403 guest-scope

get_as dmenu_1 D "/v1/sandboxes/$DID/menu"
expect_header dmenu_1 bakery-cache miss
ITEM="$(json_field dmenu_1 "b.categories[0].items[0].slug")"
command_as price D 192.0.2.42 PATCH "/v1/sandboxes/$DID/menu/items/$ITEM" '{"price_cents":1234}'
expect_status price 200
expect_json price "b.version === 1 && b.pending.includes('$ITEM')"
get_as dmenu_draft D "/v1/sandboxes/$DID/menu"
expect_header dmenu_draft etag '"v1"'
expect_header dmenu_draft bakery-cache hit
command_as unknown_item D 192.0.2.42 PATCH "/v1/sandboxes/$DID/menu/items/no-such-item" '{"price_cents":100}'
expect_status unknown_item 404
command_as publish D 192.0.2.42 POST "/v1/sandboxes/$DID/menu/publish"
expect_status publish 200
expect_json publish "b.version === 2 && b.pending.length === 0"
command_as publish_again D 192.0.2.42 POST "/v1/sandboxes/$DID/menu/publish"
expect_problem publish_again 422 menu
get_as dmenu_v2 D "/v1/sandboxes/$DID/menu"
expect_header dmenu_v2 etag '"v2"'
expect_header dmenu_v2 bakery-cache miss
expect_json dmenu_v2 "b.version === 2 && b.categories[0].items[0].variants.every(v => v.price_cents === 1234)"
get_as dmenu_v2_hit D "/v1/sandboxes/$DID/menu"
expect_header dmenu_v2_hit bakery-cache hit
get_as dmenu_old_tag D "/v1/sandboxes/$DID/menu" -H 'If-None-Match: "v1"'
expect_status dmenu_old_tag 200
get_as dmenu_new_tag D "/v1/sandboxes/$DID/menu" -H 'If-None-Match: "v2"'
expect_status dmenu_new_tag 304

# ---------- orders ----------

PICK="$(pickable menu_1 240)" || { fail "no item on the seeded menu fits a slot 4 h out"; PICK='{}'; }
VARIANT="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).variant || '')" "$PICK")"
SLOT="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).slot || '')" "$PICK")"
ORDER="{\"kind\":\"pickup\",\"slot\":\"$SLOT\",\"lines\":[{\"variant\":\"$VARIANT\",\"qty\":2}],\"note\":\"Two boxes, please\"}"

KEY="$(ulid)"
command_as place_1 G 192.0.2.41 POST "/v1/sandboxes/$GID/orders" "$ORDER"
command_as place_2 G 192.0.2.41 POST "/v1/sandboxes/$GID/orders" "$ORDER"
REUSED_KEY="$KEY"
unset KEY
expect_status place_1 201
expect_json place_1 "b.status === 'placed' && b.kind === 'pickup' && b.lines[0].qty === 2 && b.total_cents === b.subtotal_cents + b.tax_cents && b.events_seq === 1 && b.menu_version === 1 && b.note === 'Two boxes, please'"
check "place_1: Location names the order" "[[ '$(header_of place_1 location)' == /v1/sandboxes/$GID/orders/$(json_field place_1 b.id) ]]"
OID="$(json_field place_1 b.id)"
expect_status place_2 200
expect_header place_2 idempotent-replayed true
expect_json place_2 "b.id === '$OID'"
get_as order_get G "/v1/sandboxes/$GID/orders/$OID"
expect_status order_get 200
expect_json order_get "b.id === '$OID' && b.events_seq === 1"
check "order_get: held 15 minutes" "node -e \"const b = JSON.parse(require('fs').readFileSync('$TMP/order_get.body', 'utf8')); if (Date.parse(b.held_until) - Date.parse(b.placed_at) !== 900000) process.exit(1)\""
KEY="$REUSED_KEY"
command_as place_other G 192.0.2.41 POST "/v1/sandboxes/$GID/orders" "{\"kind\":\"pickup\",\"slot\":\"$SLOT\",\"lines\":[{\"variant\":\"$VARIANT\",\"qty\":3}]}"
unset KEY
expect_problem place_other 422 idempotency-key

NOTE_CANARY="write-to-me-$(random_text 8)@example.com"
command_as bad_note G 192.0.2.41 POST "/v1/sandboxes/$GID/orders" "{\"kind\":\"pickup\",\"slot\":\"$SLOT\",\"lines\":[{\"variant\":\"$VARIANT\",\"qty\":1}],\"note\":\"$NOTE_CANARY\"}"
expect_problem bad_note 422 order
expect_json bad_note "b.detail.includes('note-email') && !JSON.stringify(b).includes('example.com')"
LINES="$(node -e "console.log(JSON.stringify(Array.from({ length: 21 }, () => ({ variant: process.argv[1], qty: 1 }))))" "$VARIANT")"
command_as too_many G 192.0.2.41 POST "/v1/sandboxes/$GID/orders" "{\"kind\":\"pickup\",\"slot\":\"$SLOT\",\"lines\":$LINES}"
expect_problem too_many 422 order
expect_json too_many "b.detail.includes('too-many-lines')"
command_as unknown_variant G 192.0.2.41 POST "/v1/sandboxes/$GID/orders" "{\"kind\":\"pickup\",\"slot\":\"$SLOT\",\"lines\":[{\"variant\":\"no-such/thing\",\"qty\":1}]}"
expect_problem unknown_variant 422 order
expect_json unknown_variant "b.detail.includes('not-on-menu')"
get_as order_missing G "/v1/sandboxes/$GID/orders/01JC8Z6K3W9QF2N4T7XRB5M0HD"
expect_status order_missing 404
get_as order_cross D "/v1/sandboxes/$GID/orders/$OID"
expect_status order_cross 404

# A paused item, on the demo sandbox: Pause publishes that item at once.
DPICK="$(pickable dmenu_v2 240 "$ITEM")" || DPICK='{}'
DITEM="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).item || '')" "$DPICK")"
DVARIANT="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).variant || '')" "$DPICK")"
DSLOT="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).slot || '')" "$DPICK")"
command_as pause D 192.0.2.42 PATCH "/v1/sandboxes/$DID/menu/items/$DITEM" '{"status":"paused"}'
expect_status pause 200
expect_json pause "b.version === 3"
command_as paused_order D 192.0.2.42 POST "/v1/sandboxes/$DID/orders" "{\"kind\":\"pickup\",\"slot\":\"$DSLOT\",\"lines\":[{\"variant\":\"$DVARIANT\",\"qty\":1}]}"
expect_problem paused_order 422 order
expect_json paused_order "b.detail.includes('item-paused')"
command_as resume D 192.0.2.42 PATCH "/v1/sandboxes/$DID/menu/items/$DITEM" '{"status":"available"}'
expect_json resume "b.version === 4"

# Cancel, before payment.
command_as to_cancel G 192.0.2.41 POST "/v1/sandboxes/$GID/orders" "{\"kind\":\"pickup\",\"slot\":\"$SLOT\",\"lines\":[{\"variant\":\"$VARIANT\",\"qty\":1}]}"
CID="$(json_field to_cancel b.id)"
command_as cancel G 192.0.2.41 POST "/v1/sandboxes/$GID/orders/$CID/cancel"
expect_status cancel 200
expect_json cancel "b.status === 'cancelled' && b.events_seq === 2"

# ---------- the expiry on the business clock ----------

command_as guest_clock G 192.0.2.41 POST "/v1/sandboxes/$GID/clock" '{"minutes":15}'
expect_problem guest_clock 403 guest-scope
command_as to_expire D 192.0.2.42 POST "/v1/sandboxes/$DID/orders" "{\"kind\":\"pickup\",\"slot\":\"$DSLOT\",\"lines\":[{\"variant\":\"$DVARIANT\",\"qty\":1}]}"
expect_status to_expire 201
EID="$(json_field to_expire b.id)"
command_as clock_15 D 192.0.2.42 POST "/v1/sandboxes/$DID/clock" '{"minutes":15}'
expect_status clock_15 200
expect_json clock_15 "b.clock_offset_s === 900 && b.clock_v === 1"
expired=0
for _ in $(seq 1 50); do
  get_as expired_poll D "/v1/sandboxes/$DID/orders/$EID"
  if [[ "$(json_field expired_poll b.status)" == expired ]]; then expired=1; break; fi
  sleep 0.2
done
check "an unpaid order expires after 15 minutes of business time" "(( expired == 1 ))"
expect_json expired_poll "b.events_seq === 2"
# The second advance re-arms the order's timers; the expiry already ran, so nothing changes.
command_as clock_1 D 192.0.2.42 POST "/v1/sandboxes/$DID/clock" '{"minutes":1}'
expect_json clock_1 "b.clock_offset_s === 960 && b.clock_v === 2"
sleep 1
get_as expired_again D "/v1/sandboxes/$DID/orders/$EID"
expect_json expired_again "b.status === 'expired' && b.events_seq === 2"
command_as clock_far D 192.0.2.42 POST "/v1/sandboxes/$DID/clock" '{"minutes":20160}'
expect_problem clock_far 422 clock
get_as demo_clock D "/v1/sandboxes/$DID"
expect_json demo_clock "b.clock_offset_s === 960 && b.clock_v === 2"

# ---------- the kitchen fault, the DLQ and the redrive ----------

command_as fault_on D 192.0.2.42 POST "/v1/sandboxes/$DID/faults" '{"fault":"kitchen","on":true}'
expect_status fault_on 200
expect_json fault_on "b.faults.kitchen === true"
FSLOT="$(node -e "const t = new Date(Math.ceil((Date.now() + 960000 + 240 * 60000) / 900000) * 900000 - 7 * 3600000); process.stdout.write(t.toISOString().slice(0, 19) + '-07:00')")"
command_as faulted D 192.0.2.42 POST "/v1/sandboxes/$DID/orders" "{\"kind\":\"pickup\",\"slot\":\"$FSLOT\",\"lines\":[{\"variant\":\"$DVARIANT\",\"qty\":1}]}"
expect_status faulted 201
FID="$(json_field faulted b.id)"
dead=0
for _ in $(seq 1 120); do
  get_as dead_poll D "/v1/sandboxes/$DID/dead-letters"
  if node -e "const b = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); process.exit(b.some(d => d.type === 'OrderPlaced' && d.stream.endsWith(':$FID')) ? 0 : 1)" "$TMP/dead_poll.body" 2>/dev/null; then dead=1; break; fi
  sleep 0.5
done
check "the faulted OrderPlaced reaches the dead-letter list" "(( dead == 1 ))"
expect_json dead_poll "b.every(d => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(d.id) && typeof d.seq === 'number' && typeof d.at === 'string') && b.find(d => d.stream.endsWith(':$FID')).error === 'Kitchen answered 503'"
EVENT="$(json_field dead_poll "b.find(d => d.stream.endsWith(':$FID')).id")"
tries="$(grep -c "\"delivery_failed\",\"id\":\"$EVENT\"" "$LOG" || true)"
check "the delivery failed 4 times (1 and 3 retries) before the DLQ: $tries" "(( tries == 4 ))"
check "the DLQ writer logged it" "grep -q '\"event\":\"dlq\",\"outcome\":\"kept\",\"id\":\"$EVENT\"' '$LOG'"
get_as guest_dead G "/v1/sandboxes/$GID/dead-letters"
expect_json guest_dead "Array.isArray(b) && b.length === 0"
command_as guest_redrive G 192.0.2.41 POST "/v1/sandboxes/$GID/dead-letters/$EVENT/redrive"
expect_problem guest_redrive 403 guest-scope
check "the board lacks the faulted order" "! kitchen_board | grep -q '$FID'"

command_as fault_off D 192.0.2.42 POST "/v1/sandboxes/$DID/faults" '{"fault":"kitchen","on":false}'
expect_json fault_off "b.faults.kitchen === false"
KEY="$(ulid)"
command_as redrive D 192.0.2.42 POST "/v1/sandboxes/$DID/dead-letters/$EVENT/redrive"
command_as redrive_again D 192.0.2.42 POST "/v1/sandboxes/$DID/dead-letters/$EVENT/redrive"
unset KEY
expect_status redrive 200
expect_json redrive "b.id === '$EVENT'"
expect_header redrive_again idempotent-replayed true
command_as redrive_unknown D 192.0.2.42 POST "/v1/sandboxes/$DID/dead-letters/01JC8Z6K3W9QF2N4T7XRB5M0HD/redrive"
expect_status redrive_unknown 404
get_as dead_after D "/v1/sandboxes/$DID/dead-letters"
expect_json dead_after "!b.some(d => d.id === '$EVENT')"
applied=0
for _ in $(seq 1 60); do
  if kitchen_board | node -e "let n = 0; for (const l of require('fs').readFileSync(0, 'utf8').split('\n').filter(Boolean)) { const b = JSON.parse(l).board; n += Object.keys(b.cards).filter(k => k === '$FID').length; } process.exit(n === 1 ? 0 : 1)"; then applied=1; break; fi
  sleep 0.5
done
check "the redriven OrderPlaced is on the board once" "(( applied == 1 ))"
get_as faulted_get D "/v1/sandboxes/$DID/orders/$FID"
expect_json faulted_get "b.id === '$FID' && b.events_seq === 1"
check "every seeded order reached a board: 24 cards across two sandboxes" "[[ \$(kitchen_board | node -e \"let n = 0; for (const l of require('fs').readFileSync(0, 'utf8').split('\\\\n').filter(Boolean)) n += Object.keys(JSON.parse(l).board.cards).length; console.log(n)\") -ge 24 ]]"

# ---------- the wipe empties every child ----------

list_objects list_live
check "list-objects: exits 1 while sandboxes hold data" "(( LIST_EXIT == 1 ))"
check "list-objects: lists Catalog, Kitchen and Order objects" "grep -q '\"class\":\"Catalog\"' '$TMP/list_live.out' && grep -q '\"class\":\"Kitchen\"' '$TMP/list_live.out' && grep -q '\"class\":\"Order\"' '$TMP/list_live.out'"
command_as wipe_demo D 192.0.2.42 DELETE "/v1/sandboxes/$DID"
expect_status wipe_demo 200
command_as wipe_guest G 192.0.2.41 DELETE "/v1/sandboxes/$GID"
expect_status wipe_guest 200
sleep 1
list_objects list_wiped
check "list-objects: exits 0 after both wipes: every child is empty" "(( LIST_EXIT == 0 ))"
get_as wiped_menu D "/v1/sandboxes/$DID/menu"
expect_status wiped_menu 404

stop_pid "$SERVER_PID"; SERVER_PID=""

# ---------- what the log holds ----------

runtime_log="$TMP/runtime.log"
awk '/^=== Worker ready/ { on = 1 } on' "$LOG" > "$runtime_log"
check "the Worker's log holds no order note" "! grep -q 'Two boxes' '$runtime_log'"
check "the Worker's log holds no refused note" "! grep -qF -- '$NOTE_CANARY' '$runtime_log'"
check "the Worker's log holds no password" "! grep -qF -- '$CANARY' '$runtime_log'"
check "the relay logged its sends" "grep -q '\"event\":\"relay\",\"object\":\"Order\"' '$runtime_log'"

echo
if (( FAILURES > 0 )); then
  echo "$PASSES passed, $FAILURES failed"
  exit 1
fi
echo "all $PASSES checks passed"
