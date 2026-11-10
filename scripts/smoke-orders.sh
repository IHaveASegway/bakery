#!/usr/bin/env bash
# Smoke-tests PR 4 on `wrangler dev`: seeding, the menu and its cache, orders and their
# idempotency, the expiry on the business clock, the event relay with the `kitchen` fault, the
# dead-letter list and its redrive, the kitchen board's socket (snapshot, events, commands,
# presence, its limits and its hibernation), the console's heartbeat, simulated traffic and
# Control's minute ledger, and the wipe of every child. Since PR 5 the Simulator pays each order
# it places, so the script also starts scripts/fake-stripe.mjs and points the Worker at it; the
# payment paths themselves are scripts/smoke-payments.sh's. Since the hardening after PR 13 it also
# drives a retried placement whose place was given back: 409 `hold-lost` with no room, and with
# room the place held again and the order placed on it. Since 2026-11-08 it reads the menu's
# drafts route after a price edit and after the publish. Since 2026-11-09 it places for a time
# that is not a slot (422 `no-such-slot`) and for a Monday (422 `order`, not baked that day). It
# proves each line of docs/roadmap.md's PR 4 "Done when" that can be proven locally, prints ok or
# FAIL per check as scripts/smoke-auth.sh does, and exits non-zero on any failure.
#
# Usage: scripts/smoke-orders.sh   (from anywhere; needs cargo, worker-build, pnpm, node 22 and curl).
#
# Like scripts/smoke-auth.sh it writes a throwaway workers/api/.dev.vars, refuses to run when one
# exists unless SMOKE_ORDERS_OVERWRITE=1, starts the fake provider for Turnstile, and keeps the
# Worker's log in SMOKE_ORDERS_LOG=<file> when set. One Worker run, fresh state in a scratch
# directory. The board is read as a browser reads it, through scripts/ws-probe.mjs on the socket.
# The .dev.vars lowers TRAFFIC_MINUTES_CAP to 2, so the day's cap is reached in two minutes by the
# same code path as 30. One check waits out the Simulator's 90 s console window, so a run takes
# about four minutes. Before the Simulator runs, the business clock moves to the next opening so the
# slots it asks for have room at any hour (SMOKE_ORDERS_SIM_CLOCK=off skips that step).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SMOKE_PORT:-8788}"
FAKE_PORT="${SMOKE_FAKE_PORT:-8790}"
STRIPE_PORT="${SMOKE_STRIPE_PORT:-8791}"
BASE="http://127.0.0.1:${PORT}"
WS="ws://127.0.0.1:${PORT}"
FAKE="http://127.0.0.1:${FAKE_PORT}"
STRIPE="http://127.0.0.1:${STRIPE_PORT}"
STOREFRONT="http://127.0.0.1:8787"
STARTUP_TIMEOUT_S="${STARTUP_TIMEOUT_S:-240}"
DEV_VARS="$ROOT/workers/api/.dev.vars"

TMP="$(mktemp -d -t smoke-orders.XXXXXX)"
LOG="$TMP/worker.log"
FAKE_LOG="$TMP/fake.log"
STRIPE_LOG="$TMP/stripe.log"
FAILURES=0
PASSES=0
SERVER_PID=""
FAKE_PID=""
STRIPE_PID=""
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
  for pid in ${WS_A:-} ${WS_B:-} ${WS_G:-} ${WS_L[@]:-} ${REDRIVE_PROBE:-}; do kill -TERM "$pid" 2>/dev/null || true; done
  stop_pid "$SERVER_PID"
  stop_pid "$FAKE_PID"
  stop_pid "$STRIPE_PID"
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
for p in "$PORT" "$FAKE_PORT" "$STRIPE_PORT"; do
  if curl -s -o /dev/null "http://127.0.0.1:$p/" 2>/dev/null; then
    echo "something already listens on port $p; stop it or set SMOKE_PORT / SMOKE_FAKE_PORT / SMOKE_STRIPE_PORT" >&2
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

# probe JAR ID [ws-probe options]: a socket on sandbox ID's board as the storefront opens it, with
# the jar's cookies and the storefront's Origin. Prints the probe's JSON lines. In the background,
# run `node "${PROBE[@]}" ...` after `probe_args`, so $! is the probe's own process.
probe_args() {
  PROBE=("$ROOT/scripts/ws-probe.mjs" --url "$WS/v1/sandboxes/$2/kitchen/ws" --jar "$TMP/$1.jar" --origin "$STOREFRONT")
}
probe() {
  probe_args "$1" "$2"; shift 2
  node "${PROBE[@]}" "$@"
}
# probe_ok FILE EXPR: EXPR holds over a probe's output, read as `frames` (each with its `at`),
# `closed` ({code, reason} or undefined) and `board` ({order: state}, as the probe folded it).
probe_ok() {
  node -e "
    const lines = require('fs').readFileSync(process.argv[1], 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const frames = lines.filter((l) => l.frame).map((l) => ({ ...l.frame, at: l.at }));
    const closed = (lines.find((l) => l.closed) || {}).closed;
    const board = (lines.find((l) => l.board) || {}).board || {};
    const snapshot = frames.find((f) => f.t === 'snapshot');
    const cards = snapshot ? snapshot.board.cards : [];
    const evts = frames.filter((f) => f.t === 'evt').map((f) => ({ ...f.env, at_ms: f.at }));
    if (!($2)) process.exit(1);" "$1" 2>/dev/null
}
expect_probe() {
  if probe_ok "$2" "$3"; then pass "$1"; else fail "$1 ($(head -c 300 "$2" | tr '\n' ' '))"; fi
}
probe_field() {
  node -e "
    const lines = require('fs').readFileSync(process.argv[1], 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const frames = lines.filter((l) => l.frame).map((l) => ({ ...l.frame, at: l.at }));
    const snapshot = frames.find((f) => f.t === 'snapshot');
    const cards = snapshot ? snapshot.board.cards : [];
    const v = ($2); process.stdout.write(v === undefined || v === null ? '' : String(v));" "$1"
}
# upgrade NAME JAR ID [curl args]: an upgrade request with curl, which shows the status a WebSocket
# client hides. A 101 is cut off after a second.
upgrade() {
  local name="$1" jar_name="$2" id="$3"; shift 3
  local cookies; cookies="$(jar "$jar_name")"
  # The handshake nonce is any 16 bytes in base64 (RFC 6455); it is made here so that no
  # base64 literal sits in the script for a secret scanner to wonder about.
  local nonce; nonce="$(printf 'smoke-orders-prob' | base64)"
  local args=(--max-time 2 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13'
    -H "Sec-WebSocket-Key: $nonce" -H "CF-Connecting-IP: 192.0.2.251")
  if [[ -n "$cookies" ]]; then args+=(-H "Cookie: $cookies"); fi
  request "$name" "${args[@]}" "$@" "$BASE/v1/sandboxes/$id/kitchen/ws"
}
# log_has PATTERN: the Worker's log holds a line with this fixed text.
log_has() { grep -qF -- "$1" "$LOG"; }
# wait_log PATTERN SECONDS: polls the log for a fixed text.
wait_log() {
  local deadline=$(( $(date +%s) + $2 ))
  until log_has "$1"; do
    if (( $(date +%s) > deadline )); then return 1; fi
    sleep 0.5
  done
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
    echo "TRAFFIC_MINUTES_CAP=2"
    # The fake Stripe's own test-shaped values (scripts/fake-stripe.mjs), not secrets.
    echo "STRIPE_API_BASE=$STRIPE"
    echo "STRIPE_SECRET_KEY=rk_test_not_a_key"
    echo "STRIPE_WEBHOOK_SECRET=whsec_not_a_secret"
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

# pickable NAME SLOT_MINUTES [SKIP]: the item and variant the menu in NAME.body sells at the first
# slot SLOT_MINUTES or more from now that the day's Schedule takes (07:00 to 14:45 on the quarter
# hour, closed Mondays, in America/Denver: PR 6 holds the slot first), and the slot, as JSON on
# stdout. Picks an available item baked on the slot's day, in season, with a lead time the slot
# meets. The clock offset is 0 here.
pickable() {
  node -e "
    const TZ = 'America/Denver';
    const parts = (ms) => { const o = {}; for (const p of new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }).formatToParts(new Date(ms))) o[p.type] = p.value; return o; };
    const offsetMin = (ms) => { const p = parts(ms); return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000) / 60000); };
    const iso = (ms) => { const p = parts(ms), o = offsetMin(ms), a = Math.abs(o); return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute + ':' + p.second + (o < 0 ? '-' : '+') + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0'); };
    const wd = (ms) => parts(ms).weekday.toLowerCase().slice(0, 3);
    const minuteOf = (ms) => { const p = parts(ms); return +p.hour * 60 + +p.minute; };
    const isSlot = (ms) => wd(ms) !== 'mon' && minuteOf(ms) >= 420 && minuteOf(ms) <= 885 && minuteOf(ms) % 15 === 0;
    const menu = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const minutes = Number(process.argv[2]);
    const skip = process.argv[3] || '';
    let slot = Math.ceil((Date.now() + minutes * 60000) / 900000) * 900000;
    while (!isSlot(slot)) slot += 900000;
    const p = parts(slot);
    const md = p.month + '-' + p.day;
    const inSeason = (s) => !s || (s.from <= s.to ? s.from <= md && md <= s.to : md >= s.from || md <= s.to);
    const lead = Math.floor((slot - Date.now()) / 60000) - 30;
    for (const c of menu.categories) for (const i of c.items) {
      if (i.slug === skip || i.status !== 'available' || !i.days_baked.includes(wd(slot)) || !inSeason(i.season)) continue;
      const v = i.variants.find((v) => v.lead_minutes <= lead);
      if (!v) continue;
      console.log(JSON.stringify({ item: i.slug, variant: v.slug, slot: iso(slot) }));
      process.exit(0);
    }
    process.exit(1);" "$TMP/$1.body" "$2" "${3:-}"
}

# ---------- start ----------

echo "starting the fake provider on $FAKE and the fake Stripe on $STRIPE"
set -m
node "$ROOT/scripts/fake-providers.mjs" --port "$FAKE_PORT" > "$FAKE_LOG" 2>&1 < /dev/null &
FAKE_PID=$!
FAKE_STRIPE_WEBHOOK_URL="$BASE/v1/stripe/webhook" node "$ROOT/scripts/fake-stripe.mjs" --port "$STRIPE_PORT" > "$STRIPE_LOG" 2>&1 < /dev/null &
STRIPE_PID=$!
set +m
for _ in $(seq 1 100); do curl -s -o /dev/null "$FAKE/_health" && curl -s -o /dev/null "$STRIPE/_health" && break; sleep 0.1; done

start_worker

# ---------- seeding ----------

command_as guest G 192.0.2.41 POST /v1/sandboxes '{"turnstile_token":"pass-1","replace":false}'
expect_status guest 201
expect_json guest "['seeding', 'live'].includes(b.state) && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(b.persona) && b.faults.kitchen === false"
GID="$(json_field guest b.id)"
check "guest: seeding reaches live within 20 s" "wait_live guest_live G '$GID'"
expect_json guest_live "b.state === 'live' && b.children >= 36"

CANARY="$(random_text 24)"
command_as signup D 192.0.2.42 POST /v1/auth/demo "{\"password\":\"$CANARY\",\"turnstile_token\":\"pass-1\"}"
expect_status signup 201
command_as demo D 192.0.2.42 POST /v1/sandboxes '{"replace":false}'
expect_status demo 201
DID="$(json_field demo b.id)"
check "demo: seeding reaches live within 20 s" "wait_live demo_live D '$DID'"
expect_json demo_live "b.state === 'live' && b.children >= 36 && b.kind === 'account'"
DUSER="$(json_field signup b.username)"

# A second demo account whose traffic runs with no console at all: no socket, no heartbeat. Its
# Simulator must stop by itself, `console_closed`, once 90 s pass; the rest of the script runs
# meanwhile, and the check waits for whatever is left of the window.
command_as signup_e E 192.0.2.43 POST /v1/auth/demo "{\"password\":\"$CANARY\",\"turnstile_token\":\"pass-1\"}"
command_as sandbox_e E 192.0.2.43 POST /v1/sandboxes '{"replace":false}'
SID_E="$(json_field sandbox_e b.id)"
check "e: seeding reaches live within 20 s" "wait_live e_live E '$SID_E'"
command_as traffic_e E 192.0.2.43 POST "/v1/sandboxes/$SID_E/traffic" '{"rate":1}'
expect_status traffic_e 200
expect_json traffic_e "b.running === true && b.rate === 1 && b.minutes_left === 2"
E_STARTED="$(date +%s)"

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
get_as guest_drafts G "/v1/sandboxes/$GID/menu/drafts"
expect_problem guest_drafts 403 guest-scope

get_as dmenu_1 D "/v1/sandboxes/$DID/menu"
expect_header dmenu_1 bakery-cache miss
ITEM="$(json_field dmenu_1 "b.categories[0].items[0].slug")"
command_as price D 192.0.2.42 PATCH "/v1/sandboxes/$DID/menu/items/$ITEM" '{"price_cents":1234}'
expect_status price 200
expect_json price "b.version === 1 && b.pending.includes('$ITEM')"
# The drafts route lists what waits, so the console's editor shows it after a reload.
get_as drafts_1 D "/v1/sandboxes/$DID/menu/drafts"
expect_status drafts_1 200
expect_header drafts_1 cache-control no-store
expect_json drafts_1 "b.version === 1 && b.pending.length === 1 && b.pending[0].slug === '$ITEM' && b.pending[0].variants.length > 0 && b.pending[0].variants.every(v => v.price_cents === 1234)"
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
get_as drafts_2 D "/v1/sandboxes/$DID/menu/drafts"
expect_status drafts_2 200
expect_json drafts_2 "b.version === 2 && b.pending.length === 0"
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
# Five minutes after the picked slot: the right day and later, so the order's own rules pass,
# but not one of the day's quarter-hour starts. The day's Schedule refuses it (PR 6).
NO_SLOT="${SLOT:0:14}$(printf '%02d' $((10#${SLOT:14:2} + 5)))${SLOT:16}"
command_as no_slot G 192.0.2.41 POST "/v1/sandboxes/$GID/orders" "{\"kind\":\"pickup\",\"slot\":\"$NO_SLOT\",\"lines\":[{\"variant\":\"$VARIANT\",\"qty\":1}]}"
expect_problem no_slot 422 no-such-slot
# A Monday at 10:00, the first after today: the Schedule's `closed-day` stands behind the order's
# own rule, since the menu bakes nothing on a Monday (the catalog refuses `mon`), so the order
# names the item not baked that day and holds no place. scripts/smoke-catering.sh drives
# `closed-day` itself, on a catering inquiry.
MONDAY_SLOT="$(node -e "
  const TZ = 'America/Denver';
  const parts = (ms) => { const o = {}; for (const p of new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(new Date(ms))) o[p.type] = p.value; return o; };
  let ms = Date.now() + 86400000;
  while (parts(ms).weekday !== 'Mon') ms += 86400000;
  const p = parts(ms);
  const noonUtc = Date.UTC(+p.year, +p.month - 1, +p.day, 12);
  const q = parts(noonUtc);
  const off = (+q.hour * 60 + +q.minute) - 720;
  const a = Math.abs(off);
  process.stdout.write(p.year + '-' + p.month + '-' + p.day + 'T10:00:00' + (off < 0 ? '-' : '+') + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0'));")"
command_as monday_order G 192.0.2.41 POST "/v1/sandboxes/$GID/orders" "{\"kind\":\"pickup\",\"slot\":\"$MONDAY_SLOT\",\"lines\":[{\"variant\":\"$VARIANT\",\"qty\":1}]}"
expect_problem monday_order 422 order
expect_json monday_order "b.detail.includes('not-baked-that-day')"
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

# A retried placement whose place was given back (the hardening after PR 13). While the item is
# paused, a key's first attempt is refused before any hold; its retry is not decided first, so the
# day holds the place and the Order refuses: the place is given back and no Order exists. A later
# retry with the key must not place the order on that released hold: with no room it is 409
# `hold-lost`, with room the place is held again and the order placed on it.
LOST_DAY="${DSLOT:0:10}"
LOST_HHMM="${DSLOT:11:5}"
LOST_ORDER="{\"kind\":\"pickup\",\"slot\":\"$DSLOT\",\"lines\":[{\"variant\":\"$DVARIANT\",\"qty\":1}]}"
slot_taken() { json_field "$1" "b.slots.find(s => s.start === '$DSLOT').$2"; }
get_as lost_day_0 D "/v1/sandboxes/$DID/schedule/$LOST_DAY"
LOST_TAKEN="$(slot_taken lost_day_0 taken)"
LOST_CAP="$(slot_taken lost_day_0 capacity)"
LOST_KEY="$(ulid)"
FULL_KEY="$(ulid)"
for k in LOST FULL; do
  key_var="${k}_KEY"
  KEY="${!key_var}" command_as "${k,,}_first" D 192.0.2.42 POST "/v1/sandboxes/$DID/orders" "$LOST_ORDER"
  KEY="${!key_var}" command_as "${k,,}_retry" D 192.0.2.42 POST "/v1/sandboxes/$DID/orders" "$LOST_ORDER"
  expect_problem "${k,,}_first" 422 order
  expect_problem "${k,,}_retry" 422 order
  expect_json "${k,,}_retry" "b.detail.includes('item-paused')"
done
get_as lost_day_1 D "/v1/sandboxes/$DID/schedule/$LOST_DAY"
check "the two retries' places were given back: $DSLOT still has $LOST_TAKEN taken" "[[ '$(slot_taken lost_day_1 taken)' == '$LOST_TAKEN' ]]"
command_as resume D 192.0.2.42 PATCH "/v1/sandboxes/$DID/menu/items/$DITEM" '{"status":"available"}'
expect_json resume "b.version === 4"
# No room: the slot cut to the places it holds, and the retry is refused naming the lost hold.
command_as lost_cut D 192.0.2.42 PATCH "/v1/sandboxes/$DID/schedule/$LOST_DAY/capacity" "{\"target\":\"slot:$LOST_HHMM\",\"capacity\":$LOST_TAKEN}"
expect_status lost_cut 200
KEY="$FULL_KEY" command_as full_lost D 192.0.2.42 POST "/v1/sandboxes/$DID/orders" "$LOST_ORDER"
expect_problem full_lost 409 hold-lost
# The refusal names the first later start that had room on the day as read before the cut, and
# none when $DSLOT is the day's last slot (a run 4 h before closing picks 14:45).
LOST_NEXT="$(json_field lost_day_0 "(b.slots.find(s => Date.parse(s.start) > Date.parse('$DSLOT') && s.taken < s.capacity) || {}).start")"
expect_json full_lost "b.detail.includes('given back') && b.detail.includes('The rule is hold-lost.')"
if [[ -n "$LOST_NEXT" ]]; then
  expect_json full_lost "b.next_free === '$LOST_NEXT' && b.detail.includes(b.next_free)"
else
  expect_json full_lost "b.next_free === undefined"
fi
get_as full_day D "/v1/sandboxes/$DID/schedule/$LOST_DAY"
check "the refused retry held nothing: $DSLOT still has $LOST_TAKEN taken" "[[ '$(slot_taken full_day taken)' == '$LOST_TAKEN' ]]"
command_as lost_uncut D 192.0.2.42 PATCH "/v1/sandboxes/$DID/schedule/$LOST_DAY/capacity" "{\"target\":\"slot:$LOST_HHMM\",\"capacity\":$LOST_CAP}"
expect_status lost_uncut 200
# Room again: the retry holds the place anew and the Order is placed on that live hold.
KEY="$LOST_KEY" command_as lost_placed D 192.0.2.42 POST "/v1/sandboxes/$DID/orders" "$LOST_ORDER"
expect_status lost_placed 201
expect_json lost_placed "b.status === 'placed' && Date.parse(b.held_until) - Date.parse(b.placed_at) === 900000 && Date.parse(b.held_until) > Date.now()"
get_as lost_day_2 D "/v1/sandboxes/$DID/schedule/$LOST_DAY"
check "the placed retry holds a live place: $DSLOT taken $LOST_TAKEN to $(slot_taken lost_day_2 taken)" "[[ '$(slot_taken lost_day_2 taken)' == '$((LOST_TAKEN + 1))' ]]"
KEY="$LOST_KEY" command_as lost_again D 192.0.2.42 POST "/v1/sandboxes/$DID/orders" "$LOST_ORDER"
expect_status lost_again 200
expect_header lost_again idempotent-replayed true
expect_json lost_again "b.id === '$(json_field lost_placed b.id)'"
get_as lost_day_3 D "/v1/sandboxes/$DID/schedule/$LOST_DAY"
check "the replay asked for no second place" "[[ '$(slot_taken lost_day_3 taken)' == '$((LOST_TAKEN + 1))' ]]"
check "the Schedule logged the place taken again" "log_has '\"event\":\"hold_retaken\"'"

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
# The paused-item check's slot: a start the day's Schedule takes (PR 6), still about four hours
# ahead of a business clock 16 minutes on.
FSLOT="$DSLOT"
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
probe D "$DID" --until snapshot > "$TMP/board_faulted.out" || true
expect_probe "the board, read on the socket, lacks the faulted order" "$TMP/board_faulted.out" "cards.length > 0 && !cards.some((c) => c.order === '$FID')"
# A socket waits for the redriven event while the fault is cleared and the letter redriven.
probe_args D "$DID"
node "${PROBE[@]}" --wait-evt OrderPlaced --timeout 30 > "$TMP/board_redrive.out" &
REDRIVE_PROBE=$!
sleep 1

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
wait "$REDRIVE_PROBE" || true
expect_probe "the redriven OrderPlaced reaches an open socket as an evt" "$TMP/board_redrive.out" "evts.some((e) => e.type === 'OrderPlaced' && e.stream.endsWith(':$FID'))"
probe D "$DID" --until snapshot > "$TMP/board_redriven.out" || true
expect_probe "the redriven OrderPlaced is on the board once" "$TMP/board_redriven.out" "cards.filter((c) => c.order === '$FID').length === 1"
get_as faulted_get D "/v1/sandboxes/$DID/orders/$FID"
expect_json faulted_get "b.id === '$FID' && b.events_seq === 1"
probe G "$GID" --until snapshot > "$TMP/board_guest.out" || true
cards_g="$(probe_field "$TMP/board_guest.out" cards.length)"
cards_d="$(probe_field "$TMP/board_redriven.out" cards.length)"
check "every seeded order reached a board: $cards_g and $cards_d cards, 24 or more across two sandboxes" "(( ${cards_g:-0} + ${cards_d:-0} >= 24 ))"

# ---------- the kitchen socket ----------

# Two more sessions on the demo sandbox (a second and third sign-in of its account), so no
# session passes the 6 upgrades a minute it is allowed while the checks below open sockets.
command_as signin_d2 D2 192.0.2.44 POST /v1/auth/demo/signin "{\"username\":\"$DUSER\",\"password\":\"$CANARY\"}"
expect_status signin_d2 200
command_as signin_d3 D3 192.0.2.45 POST /v1/auth/demo/signin "{\"username\":\"$DUSER\",\"password\":\"$CANARY\"}"
expect_status signin_d3 200

# The upgrade's checks, with curl, which shows the status a WebSocket client hides.
upgrade ws_no_origin D "$DID"
expect_problem ws_no_origin 403 origin
upgrade ws_bad_origin D "$DID" -H 'Origin: https://bakery.ihaveasegway.com.example.com'
expect_problem ws_bad_origin 403 origin
upgrade ws_no_cookie NOBODY "$DID" -H "Origin: $STOREFRONT"
expect_problem ws_no_cookie 401 session
upgrade ws_other D3 "$GID" -H "Origin: $STOREFRONT"
expect_status ws_other 404
get_as ws_plain D3 "/v1/sandboxes/$DID/kitchen/ws"
expect_problem ws_plain 426 upgrade

# Two consoles on the demo sandbox's board.
probe_args D "$DID"
node "${PROBE[@]}" --hold 0 > "$TMP/ws_a.out" &
WS_A=$!
node "${PROBE[@]}" --hold 0 > "$TMP/ws_b.out" &
WS_B=$!
for _ in $(seq 1 40); do
  probe_ok "$TMP/ws_a.out" "frames.some((f) => f.t === 'presence' && f.sockets === 2)" && probe_ok "$TMP/ws_b.out" "snapshot" && break
  sleep 0.25
done
expect_probe "socket a: protocol v1, the snapshot first, then presence 2" "$TMP/ws_a.out" "frames[0].t === 'snapshot' && frames.every((f) => f.v === 1) && typeof frames[0].seq === 'number' && frames.some((f) => f.t === 'presence' && f.sockets === 2)"
expect_probe "socket a: each card has its order, state, lines, note, slot, kind and updated_seq" "$TMP/ws_a.out" "cards.length > 0 && cards.every((c) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(c.order) && ['pending', 'confirmed', 'in_production', 'ready', 'out_for_delivery'].includes(c.state) && c.lines.every((l) => typeof l.variant === 'string' && l.qty > 0) && 'note' in c && typeof c.slot === 'string' && ['pickup', 'delivery'].includes(c.kind) && c.updated_seq > 0)"

# A board change reaches both sockets within one second of the order being sent: the clock starts
# before the POST, so the time includes the placement itself.
PLACED_MS="$(now_ms)"
command_as ws_order D 192.0.2.42 POST "/v1/sandboxes/$DID/orders" "{\"kind\":\"pickup\",\"slot\":\"$FSLOT\",\"lines\":[{\"variant\":\"$DVARIANT\",\"qty\":1}],\"note\":\"Two boxes, please\"}"
expect_status ws_order 201
WOID="$(json_field ws_order b.id)"
for _ in $(seq 1 20); do
  probe_ok "$TMP/ws_b.out" "evts.some((e) => e.stream.endsWith(':$WOID'))" && probe_ok "$TMP/ws_a.out" "evts.some((e) => e.stream.endsWith(':$WOID'))" && break
  sleep 0.25
done
for s in a b; do
  expect_probe "socket $s: the new order's OrderPlaced within 1 s of the POST: $(probe_field "$TMP/ws_$s.out" "(frames.find((f) => f.t === 'evt' && f.env.stream.endsWith(':$WOID')) || {}).at - $PLACED_MS") ms" "$TMP/ws_$s.out" "evts.some((e) => e.type === 'OrderPlaced' && e.stream.endsWith(':$WOID') && e.at_ms - $PLACED_MS <= 1000)"
done
expect_probe "socket a: the evt carries the envelope, the note with it (the board owns the note)" "$TMP/ws_a.out" "evts.some((e) => e.stream.endsWith(':$WOID') && e.data.note === 'Two boxes, please' && e.seq === 1 && e.cause !== null && e.sandbox === '$DID')"

# Staff commands from a third socket: a confirmed pickup is started, made ready and picked up.
CONF="$(probe_field "$TMP/ws_a.out" "(cards.find((c) => c.state === 'confirmed' && c.kind === 'pickup') || {}).order")"
C1="$(ulid)"; C2="$(ulid)"; C3="$(ulid)"; C4="$(ulid)"; C5="$(ulid)"
probe D2 "$DID" --cmd "$C1:$CONF:start_production" --cmd "$C1:$CONF:start_production" --cmd "$C2:$CONF:mark_ready" \
  --cmd "$C3:$CONF:mark_picked_up" --cmd "$C4:$WOID:start_production" --cmd "$C5:01JC8Z6K3W9QF2N4T7XRB5M0HD:mark_ready" \
  --timeout 4 > "$TMP/ws_cmd.out" || true
expect_probe "a staff cmd is acked, and the same id again is acked again" "$TMP/ws_cmd.out" "frames.filter((f) => f.t === 'ack' && f.id === '$C1').length === 2"
expect_probe "mark_ready and mark_picked_up are acked" "$TMP/ws_cmd.out" "['$C2', '$C3'].every((id) => frames.some((f) => f.t === 'ack' && f.id === id))"
expect_probe "a cmd the order's rules refuse is nacked with the rule" "$TMP/ws_cmd.out" "frames.some((f) => f.t === 'nack' && f.id === '$C4' && f.rule === 'out-of-order')"
expect_probe "a cmd for an order not on the board is nacked unknown-order" "$TMP/ws_cmd.out" "frames.some((f) => f.t === 'nack' && f.id === '$C5' && f.rule === 'unknown-order')"
sleep 2
expect_probe "the repeated id made one event: one OrderProductionStarted, its cause the frame id" "$TMP/ws_a.out" "evts.filter((e) => e.stream.endsWith(':$CONF') && e.type === 'OrderProductionStarted').length === 1 && evts.find((e) => e.type === 'OrderProductionStarted' && e.stream.endsWith(':$CONF')).cause === '$C1'"
expect_probe "socket a saw the card become ready and leave the board" "$TMP/ws_a.out" "evts.some((e) => e.stream.endsWith(':$CONF') && e.type === 'OrderReady' && e.cause === '$C2') && evts.some((e) => e.stream.endsWith(':$CONF') && e.type === 'OrderPickedUp' && e.cause === '$C3')"
check "the Kitchen logged each cmd with its id and outcome, nothing more" "grep -q '\"event\":\"kitchen_cmd\",\"instance\":\"[0-9a-f]*\",\"id\":\"$C4\",\"outcome\":\"nack\",\"rule\":\"out-of-order\"}' '$LOG'"

# Hibernation: both sockets stay idle for 12 s. A guest's socket, accepted before the idle spell,
# sends its cmd after it: the frame wakes the guest's Kitchen, which must still know the socket
# is a guest's from its attachment alone.
GCARD="$(probe_field "$TMP/board_guest.out" "cards[0].order")"
GC="$(ulid)"
probe_args G "$GID"
# wrangler dev evicts an idle hibernatable object after about 10 s of quiet, but an alarm or a
# delivery that lands in the window keeps it awake, so the idle spell is tried up to five times:
# each try waits 12 s and then touches the staff Kitchen with a fresh socket, which is what wakes
# an evicted object. The guest's frame goes out after the first spell either way.
node "${PROBE[@]}" --delay 13 --cmd "$GC:$GCARD:mark_ready" --until nack --timeout 80 > "$TMP/ws_guest.out" &
WS_G=$!
sleep 1
WAKE_FROM="$(wc -l < "$LOG")"
D_BEFORE="$( (head -n "$WAKE_FROM" "$LOG" | grep '"event":"kitchen_socket_open"' | grep '"sockets":2}' | tail -n 1 | sed -E 's/.*"instance":"([0-9a-f]+)".*/\1/') || true)"
D_AFTER=""
IDLE_TRIES=0
while [[ -z "$D_AFTER" && "$IDLE_TRIES" -lt 5 ]]; do
  IDLE_TRIES=$((IDLE_TRIES + 1))
  sleep 12
  probe D2 "$DID" --until snapshot > "$TMP/ws_r.out" || true
  tail -n "+$WAKE_FROM" "$LOG" > "$TMP/wake.log"
  D_AFTER="$( (grep '"event":"kitchen_wake"' "$TMP/wake.log" | grep '"sockets":2}' | head -n 1 | sed -E 's/.*"instance":"([0-9a-f]+)".*/\1/') || true)"
done
wait "$WS_G" || true
tail -n "+$WAKE_FROM" "$LOG" > "$TMP/wake.log"
check "an idle board hibernates: after an idle spell (try $IDLE_TRIES of 5, 12 s each) the Kitchen with 2 sockets open woke (kitchen_wake)" "[[ -n '$D_AFTER' ]]"
check "the woken Kitchen is a new instance ($D_BEFORE, then $D_AFTER): memory did not survive, the sockets did" "[[ -n '$D_BEFORE' && -n '$D_AFTER' && '$D_BEFORE' != '$D_AFTER' ]]"
expect_probe "after a wake, a guest's cmd is nacked guest-scope from the socket's attachment" "$TMP/ws_guest.out" "frames.some((f) => f.t === 'nack' && f.id === '$GC' && f.rule === 'guest-scope')"
check "the guest's Kitchen woke for that frame" "grep '\"event\":\"kitchen_wake\"' '$TMP/wake.log' | grep -q '\"sockets\":1}'"

# A reconnect gets a snapshot equal to the board a socket that stayed open holds.
kill -TERM "$WS_B" 2>/dev/null || true
wait "$WS_B" || true
B_BOARD="$(node -e "const l = require('fs').readFileSync(process.argv[1], 'utf8').trim().split('\n').map(JSON.parse).find((x) => x.board); console.log(l ? JSON.stringify(Object.entries(l.board).sort()) : '')" "$TMP/ws_b.out" || true)"
R_BOARD="$(probe_field "$TMP/ws_r.out" "JSON.stringify(cards.map((c) => [c.order, c.state]).sort())")"
check "a reconnect's snapshot equals the board socket b folded from its snapshot and events" "[[ -n '$R_BOARD' && '$R_BOARD' == '$B_BOARD' ]]"

# Four sockets a sandbox: a is open; three more fill it, and a fifth is told `bye` and closed.
WS_L=()
probe_args D3 "$DID"
for n in 1 2 3; do
  node "${PROBE[@]}" --hold 0 > "$TMP/ws_l$n.out" &
  WS_L+=($!)
done
for _ in $(seq 1 40); do probe_ok "$TMP/ws_a.out" "frames.some((f) => f.t === 'presence' && f.sockets === 4)" && break; sleep 0.25; done
probe D3 "$DID" --timeout 5 > "$TMP/ws_fifth.out" || true
expect_probe "the 5th socket gets no snapshot, bye limit, and close 1008" "$TMP/ws_fifth.out" "!snapshot && frames.some((f) => f.t === 'bye' && f.reason === 'limit') && closed && closed.code === 1008"
check "the refusal is logged too-many-sockets" "log_has '\"reason\":\"too-many-sockets\"'"
check "socket a was told each change in presence: 3, then 1 after a close, then 4" "probe_ok '$TMP/ws_a.out' \"frames.some((f) => f.t === 'presence' && f.sockets === 3) && frames.some((f) => f.t === 'presence' && f.sockets === 1) && frames.some((f) => f.t === 'presence' && f.sockets === 4)\""
# UPGRADE_LIMIT allows 6 upgrades a minute per session. The attempts above can straddle a
# window, so the limit is proven inside one: plain GETs count too, since the limiter runs before
# the Upgrade check, and within seven of them one answers 429.
for _ in $(seq 1 7); do
  get_as ws_limited D3 "/v1/sandboxes/$DID/kitchen/ws"
  [[ "$(status_of ws_limited)" == "429" ]] && break
done
expect_problem ws_limited 429 rate-limit
for pid in "${WS_L[@]}"; do kill -TERM "$pid" 2>/dev/null || true; wait "$pid" || true; done

# A frame's limits, on the guest's board: 10 frames a second, 4 KB a frame, text only. The Kitchen
# counts frames by calendar second (the wall clock's, workers/api/src/objects/kitchen.rs), so the
# probe sends the eleven just after a second begins: sent near a second's end they could be split
# across two seconds, neither over 10, and no bye would come (one run in two on 2026-11-09).
probe G "$GID" --flood 11 --at-second-start --timeout 5 > "$TMP/ws_flood.out" || true
expect_probe "11 frames in a second: 10 answered, then bye limit and close 1008" "$TMP/ws_flood.out" "frames.filter((f) => f.t === 'nack' && f.rule === 'id').length === 10 && frames.some((f) => f.t === 'bye' && f.reason === 'limit') && closed && closed.code === 1008"
BIG="$(node -e "process.stdout.write(JSON.stringify({ t: 'cmd', v: 1, id: '', pad: 'x'.repeat(5000) }))")"
probe G "$GID" --raw "$BIG" --timeout 5 > "$TMP/ws_big.out" || true
expect_probe "a frame over 4 KB: bye limit and close 1009" "$TMP/ws_big.out" "frames.some((f) => f.t === 'bye' && f.reason === 'limit') && closed && closed.code === 1009"

# The console's heartbeat, for a console with no socket open.
command_as hb_d D 192.0.2.42 POST "/v1/sandboxes/$DID/heartbeat"
expect_status hb_d 204
command_as hb_g G 192.0.2.41 POST "/v1/sandboxes/$GID/heartbeat"
expect_status hb_g 204
command_as hb_other G 192.0.2.41 POST "/v1/sandboxes/$DID/heartbeat"
expect_status hb_other 404

# ---------- simulated traffic ----------

command_as traffic_guest G 192.0.2.41 POST "/v1/sandboxes/$GID/traffic" '{"rate":1}'
expect_problem traffic_guest 403 guest-scope
get_as traffic_guest_get G "/v1/sandboxes/$GID/traffic"
expect_json traffic_guest_get "b.running === false && b.rate === 0 && b.minutes_left === 2 && b.orders === 0"
get_as traffic_before D "/v1/sandboxes/$DID/traffic"
expect_json traffic_before "b.running === false && b.minutes_used === 0 && b.minutes_left === 2"
command_as traffic_7 D 192.0.2.42 POST "/v1/sandboxes/$DID/traffic" '{"rate":7}'
expect_problem traffic_7 422 traffic
expect_json traffic_7 "b.detail.includes('The rule is rate')"
command_as traffic_0 D 192.0.2.42 POST "/v1/sandboxes/$DID/traffic" '{"rate":0}'
expect_problem traffic_0 422 traffic

# The Simulator asks for slots about four hours past the business time of its minute, spread over
# the next 16 quarter hours. From late morning through the night in Denver (business time) those
# slots fall past 15:00 or before 07:00 and pile onto the next opening's first slots, 6 places
# each, so slot-full refusals keep the Simulator below the 7th
# order of the minute and the sim_rate check below is never reached. A check may not depend on the
# hour the smoke runs at, so the business clock is moved to the next opening (07:00 on an open
# day), where every slot the Simulator asks for, 11:00 to 14:45, has room. SMOKE_ORDERS_SIM_CLOCK=off
# leaves the clock where it is, as this script did before, to reproduce the old dependence.
if [[ "${SMOKE_ORDERS_SIM_CLOCK:-}" != off ]]; then
  command_as sim_clock D 192.0.2.42 POST "/v1/sandboxes/$DID/clock" '{"step":"next-opening"}'
  expect_status sim_clock 200
  expect_json sim_clock "b.step === 'next-opening' && b.business_now.includes('T07:00:00')"
fi

# Both runs below must fall in one wall-time minute: start early in a minute.
sec="$(date +%S)"
if (( 10#$sec > 30 )); then sleep $(( 61 - 10#$sec )); fi
SIM_FROM_MS="$(now_ms)"
KEY="$(ulid)"
command_as traffic_start D 192.0.2.42 POST "/v1/sandboxes/$DID/traffic" '{"rate":6}'
command_as traffic_replay D 192.0.2.42 POST "/v1/sandboxes/$DID/traffic" '{"rate":6}'
unset KEY
expect_status traffic_start 200
expect_json traffic_start "b.running === true && b.rate === 6 && b.minutes_left === 2"
expect_header traffic_replay idempotent-replayed true
command_as traffic_twice D 192.0.2.42 POST "/v1/sandboxes/$DID/traffic" '{"rate":3}'
expect_problem traffic_twice 409 traffic-running
for _ in $(seq 1 40); do
  probe_ok "$TMP/ws_a.out" "evts.filter((e) => e.type === 'OrderPlaced' && e.at_ms >= $SIM_FROM_MS).length >= 6" && break
  sleep 0.25
done
sleep 1
SIM_ORDERS="$(probe_field "$TMP/ws_a.out" "frames.filter((f) => f.t === 'evt' && f.env.type === 'OrderPlaced' && f.at >= $SIM_FROM_MS).length")"
check "rate 6 with a console socket open: $SIM_ORDERS orders on the board in the first minute, 1 to 6" "(( SIM_ORDERS >= 1 && SIM_ORDERS <= 6 ))"
# Since PR 5 a simulated order's OrderPaid follows its OrderPlaced; its cause is Billing's
# PaymentSucceeded, the event that paid it, so the check reads the placements.
expect_probe "every order the Simulator placed carries cause sim:<ulid>" "$TMP/ws_a.out" "evts.filter((e) => e.at_ms >= $SIM_FROM_MS && e.type === 'OrderPlaced').length > 0 && evts.filter((e) => e.at_ms >= $SIM_FROM_MS && e.type === 'OrderPlaced').every((e) => /^sim:[0-9A-HJKMNP-TV-Z]{26}$/.test(e.cause))"
expect_probe "the Simulator's orders are paid: OrderPaid reaches the board, caused by Billing's event" "$TMP/ws_a.out" "evts.some((e) => e.at_ms >= $SIM_FROM_MS && e.type === 'OrderPaid' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(e.cause))"
get_as traffic_running D "/v1/sandboxes/$DID/traffic"
expect_json traffic_running "b.running === true && b.minutes_used === 1 && b.minutes_left === 1 && b.orders === $SIM_ORDERS"
command_as traffic_stop D 192.0.2.42 DELETE "/v1/sandboxes/$DID/traffic"
expect_status traffic_stop 200
expect_json traffic_stop "b.running === false && b.minutes_used === 1"
check "DELETE stopped it with reason stop" "log_has '\"event\":\"sim_stopped\",\"sandbox\":\"$DID\",\"reason\":\"stop\",\"minutes\":1,\"orders\":$SIM_ORDERS}'"
command_as traffic_stop_again D 192.0.2.42 DELETE "/v1/sandboxes/$DID/traffic"
expect_json traffic_stop_again "b.running === false && b.minutes_used === 1"
# A second run in the same minute: its orders would be the minute's 7th and later.
command_as traffic_restart D 192.0.2.42 POST "/v1/sandboxes/$DID/traffic" '{"rate":6}'
expect_status traffic_restart 200
expect_json traffic_restart "b.running === true && b.minutes_left === 1"
check "a 7th order in a minute is refused and logged sim_rate" "wait_log '\"event\":\"sim_rate\",\"sandbox\":\"$DID\"' 10"
if [[ "${SMOKE_ORDERS_SIM_CLOCK:-}" != off ]]; then
  # With the clock at the opening every slot has room, so the refusal above is the rate cap's alone.
  check "no simulated order was refused by a full slot: sim_rate is the rate cap's, not the day's" "! log_has '\"event\":\"sim_slot_full\",\"sandbox\":\"$DID\"'"
  check "the first run placed all 6 orders of the minute: $SIM_ORDERS" "(( SIM_ORDERS == 6 ))"
fi
expect_probe "the minute's orders stayed at $SIM_ORDERS: the second run placed none past 6" "$TMP/ws_a.out" "evts.filter((e) => e.type === 'OrderPlaced' && e.at_ms >= $SIM_FROM_MS).length <= 6"

# ---------- the wipe empties every child ----------

list_objects list_live
check "list-objects: exits 1 while sandboxes hold data" "(( LIST_EXIT == 1 ))"
check "list-objects: lists Catalog, Kitchen, Order and Simulator objects" "grep -q '\"class\":\"Catalog\"' '$TMP/list_live.out' && grep -q '\"class\":\"Kitchen\"' '$TMP/list_live.out' && grep -q '\"class\":\"Order\"' '$TMP/list_live.out' && grep -q '\"class\":\"Simulator\"' '$TMP/list_live.out'"
get_as demo_children D "/v1/sandboxes/$DID"
expect_json demo_children "b.children > 15"
# The demo sandbox goes while its traffic runs and socket a is open.
command_as wipe_demo D 192.0.2.42 DELETE "/v1/sandboxes/$DID"
expect_status wipe_demo 200
wait "$WS_A" || true
expect_probe "the wipe says bye wiped to the open socket and closes it with 1001" "$TMP/ws_a.out" "frames.some((f) => f.t === 'bye' && f.reason === 'wiped') && closed && closed.code === 1001"
check "the wipe stopped the Simulator with reason wipe" "log_has '\"event\":\"sim_stopped\",\"sandbox\":\"$DID\",\"reason\":\"wipe\"'"
get_as wiped_menu D "/v1/sandboxes/$DID/menu"
expect_status wiped_menu 404

# The console-less traffic of sandbox e: no socket and no heartbeat for 90 s stops it.
left=$(( E_STARTED + 150 - $(date +%s) ))
echo "--- waiting up to ${left} s for sandbox e's Simulator to find its console closed"
check "no socket and no heartbeat for 90 s: stopped console_closed" "wait_log '\"event\":\"sim_stopped\",\"sandbox\":\"$SID_E\",\"reason\":\"console_closed\"' $(( left > 0 ? left : 1 ))"
check "and not before 90 s had passed: $(( $(date +%s) - E_STARTED )) s" "(( $(date +%s) - E_STARTED >= 90 ))"
get_as traffic_e_after E "/v1/sandboxes/$SID_E/traffic"
expect_json traffic_e_after "b.running === false && b.minutes_used === 2 && b.minutes_left === 0 && b.orders >= 1"
command_as traffic_e_cap E 192.0.2.43 POST "/v1/sandboxes/$SID_E/traffic" '{"rate":1}'
expect_problem traffic_e_cap 503 traffic-cap
check "traffic-cap: Retry-After counts to 00:00 UTC" "[[ '$(header_of traffic_e_cap retry-after)' =~ ^[0-9]+$ ]] && (( $(header_of traffic_e_cap retry-after) <= 86400 ))"
check "the minute past the day's cap is refused and logged sim_cap" "log_has '\"event\":\"sim_cap\",\"sandbox\":\"$SID_E\",\"used\":2,\"cap\":2}'"

command_as wipe_e E 192.0.2.43 DELETE "/v1/sandboxes/$SID_E"
expect_status wipe_e 200
command_as wipe_guest G 192.0.2.41 DELETE "/v1/sandboxes/$GID"
expect_status wipe_guest 200
sleep 1
list_objects list_wiped
check "list-objects: exits 0 after the wipes: every child is empty, the Simulators too" "(( LIST_EXIT == 0 ))"

# ---------- the tax rate (2026-11-09) ----------
# The rate is published with the menu: set it, see the menu carry it, place an order and see the
# tax at that rate, refuse 3,001 bp, and set it back. A fresh sandbox, after the wipes above.

command_as tax_sandbox D 192.0.2.44 POST /v1/sandboxes '{"replace":false}'
expect_status tax_sandbox 201
TID="$(json_field tax_sandbox b.id)"
check "tax: seeding reaches live within 20 s" "wait_live tax_live D '$TID'"
get_as tax_menu_1 D "/v1/sandboxes/$TID/menu"
expect_json tax_menu_1 "b.version === 1 && b.tax_bp === 1000"
command_as tax_set D 192.0.2.44 PATCH "/v1/sandboxes/$TID/menu/tax-rate" '{"tax_bp":850}'
expect_status tax_set 200
expect_json tax_set "b.version === 2 && b.pending.length === 0"
command_as tax_same D 192.0.2.44 PATCH "/v1/sandboxes/$TID/menu/tax-rate" '{"tax_bp":850}'
expect_json tax_same "b.version === 2"
get_as tax_menu_2 D "/v1/sandboxes/$TID/menu"
expect_header tax_menu_2 etag '"v2"'
expect_json tax_menu_2 "b.version === 2 && b.tax_bp === 850"
TPICK="$(pickable tax_menu_2 240)" || { fail "tax: no item on the menu fits a slot 4 h out"; TPICK='{}'; }
TVARIANT="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).variant || '')" "$TPICK")"
TSLOT="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).slot || '')" "$TPICK")"
QUEUE_BEFORE="$(grep -c 'QUEUE bakery-events' "$LOG" || true)"
command_as tax_order D 192.0.2.44 POST "/v1/sandboxes/$TID/orders" "{\"kind\":\"pickup\",\"slot\":\"$TSLOT\",\"lines\":[{\"variant\":\"$TVARIANT\",\"qty\":3}]}"
expect_status tax_order 201
# The Queue still consumes after the wipes above, the demo sandbox's with its traffic running:
# before 2026-11-09 the consumer left a wiped object's answer unread and its batch never finished
# on `wrangler dev`, so nothing was consumed after the first wipe (fix/consumer-after-wipe).
queue_moved() { (( $(grep -c 'QUEUE bakery-events' "$LOG" || true) > QUEUE_BEFORE )); }
for _ in $(seq 1 40); do queue_moved && break; sleep 0.25; done
check "the Queue's consumer still finishes batches after the wipes: the tax order's events" "queue_moved"
expect_json tax_order "b.menu_version === 2 && b.tax_cents === Math.floor((b.subtotal_cents * 850 + 5000) / 10000) && b.total_cents === b.subtotal_cents + b.tax_cents && b.tax_cents !== Math.floor((b.subtotal_cents * 1000 + 5000) / 10000)"
command_as tax_high D 192.0.2.44 PATCH "/v1/sandboxes/$TID/menu/tax-rate" '{"tax_bp":3001}'
expect_problem tax_high 422 menu
expect_json tax_high "b.detail.includes('tax-rate-range')"
command_as tax_guest G 192.0.2.41 PATCH "/v1/sandboxes/$TID/menu/tax-rate" '{"tax_bp":900}'
check "tax: a guest's cookie cannot set another sandbox's rate: $(status_of tax_guest)" "[[ '$(status_of tax_guest)' =~ ^(401|403|404)$ ]]"
command_as tax_back D 192.0.2.44 PATCH "/v1/sandboxes/$TID/menu/tax-rate" '{"tax_bp":1000}'
expect_json tax_back "b.version === 3"
get_as tax_menu_3 D "/v1/sandboxes/$TID/menu"
expect_json tax_menu_3 "b.version === 3 && b.tax_bp === 1000"
get_as tax_order_get D "/v1/sandboxes/$TID/orders/$(json_field tax_order b.id)"
expect_json tax_order_get "b.menu_version === 2 && b.tax_cents === $(json_field tax_order b.tax_cents)"
command_as tax_wipe D 192.0.2.44 DELETE "/v1/sandboxes/$TID"
expect_status tax_wipe 200

# ---------- end of the tax rate ----------

stop_pid "$SERVER_PID"; SERVER_PID=""

# ---------- what the log holds ----------

runtime_log="$TMP/runtime.log"
awk '/^=== Worker ready/ { on = 1 } on' "$LOG" > "$runtime_log"
check "the Worker's log holds no order note" "! grep -q 'Two boxes' '$runtime_log'"
check "the Worker's log holds no refused note" "! grep -qF -- '$NOTE_CANARY' '$runtime_log'"
check "the Worker's log holds no password" "! grep -qF -- '$CANARY' '$runtime_log'"
check "the relay logged its sends" "grep -q '\"event\":\"relay\",\"object\":\"Order\"' '$runtime_log'"
check "the Simulator's events went through its outbox" "grep -q '\"event\":\"relay\",\"object\":\"Simulator\"' '$runtime_log'"

echo
if (( FAILURES > 0 )); then
  echo "$PASSES passed, $FAILURES failed"
  exit 1
fi
echo "all $PASSES checks passed"
