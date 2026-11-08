#!/usr/bin/env bash
# Smoke-tests PR 6 on `wrangler dev` against the fake providers and scripts/fake-stripe.mjs: the
# seven seeded Schedule days; a day's schedule and its 404 outside the sandbox's days; the race
# for a slot cut to one place (two sessions in parallel: one 201, one 409 `slot-full` whose
# detail and `next_free` name the next slot); the cake rule (a chocolate layer cake inside 48 h
# refused 409 `lead-time` naming 48 h, the day after placed, paid through the fake Stripe and on
# that day's bake list and the kitchen socket's snapshot); the capacity editor (a cut below the
# places taken keeps them, 422 `unknown-item` and `bad-target`, 403 `guest-scope`); the clock (a
# replayed advance moves an order's expiry timer once; a day expires an unpaid order and frees its
# slot, with `ClockAdvanced` on the console's feed; `next-opening` from a Sunday afternoon lands on
# Tuesday 07:00; the 15th day is refused `offset-cap`); since the hardening after PR 13, a day born
# after the seed (first touched by a read, or by the order that fills an item's cap) capped by the
# published menu, before and after a publish; since 2026-11-06, a place reserved before the kitchen
# socket connects and released while it watches, its frame carrying the day so the page's reserved
# count falls at once; and every child empty after the wipe. It prints ok or FAIL per check as
# scripts/smoke-orders.sh does, and exits non-zero on any failure.
#
# The loop guard's 101st re-arm is proven natively (workers/api/src/objects/stream.rs, its
# tests): no production path re-arms from its own alarm often enough to reach it here. This
# script proves the timer wheel's idempotence over HTTP, by reading the Order's `timers` row from
# the state directory read-only.
#
# Usage: scripts/smoke-schedule.sh   (from anywhere; needs cargo, worker-build, pnpm, node 22 and curl).
#
# Like scripts/smoke-payments.sh it writes a throwaway workers/api/.dev.vars, refuses to run when
# one exists unless SMOKE_SCHEDULE_OVERWRITE=1, starts the fake providers (Turnstile) on 8790 and
# the fake Stripe on 8791, and keeps the Worker's log in SMOKE_SCHEDULE_LOG=<file> when set. Every
# key in the .dev.vars is a test-shaped fake. A run takes about two minutes.
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

# The fake's own test-shaped values, as its header lists them. Not secrets.
STRIPE_KEY="rk_test_not_a_key"
WEBHOOK_SECRET="whsec_not_a_secret"
PUBLISHABLE="pk_test_not_a_key"

TMP="$(mktemp -d -t smoke-schedule.XXXXXX)"
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
  for pid in ${WS_CLOCK:-} ${WS_REL:-}; do kill -TERM "$pid" 2>/dev/null || true; done
  stop_pid "$SERVER_PID"
  stop_pid "$FAKE_PID"
  stop_pid "$STRIPE_PID"
  if [[ -n "$WROTE_DEV_VARS" ]]; then rm -f "$DEV_VARS"; fi
  if [[ -n "$BACKUP" && -f "$BACKUP" ]]; then mv "$BACKUP" "$DEV_VARS"; fi
  if [[ -n "${SMOKE_SCHEDULE_LOG:-}" ]]; then cp "$LOG" "$SMOKE_SCHEDULE_LOG" 2>/dev/null || true; fi
  if (( FAILURES > 0 )); then
    mkdir -p "${TMPDIR:-/tmp}/smoke-schedule-logs"
    cp "$LOG" "${TMPDIR:-/tmp}/smoke-schedule-logs/worker.log" 2>/dev/null || true
    echo "logs kept in ${TMPDIR:-/tmp}/smoke-schedule-logs" >&2
  fi
  rm -rf "$TMP"
}
trap stop EXIT

pass() { printf 'ok    %s\n' "$1"; PASSES=$((PASSES + 1)); }
fail() { printf 'FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }

if [[ -e "$DEV_VARS" ]]; then
  if [[ -z "${SMOKE_SCHEDULE_OVERWRITE:-}" ]]; then
    echo "workers/api/.dev.vars exists; this script would replace it. Move it aside, or set SMOKE_SCHEDULE_OVERWRITE=1 to have it moved and restored." >&2
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

# ---------- helpers (as in scripts/smoke-payments.sh) ----------

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
    fail "$1: body $(head -c 400 "$TMP/$1.body") fails $2"
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

# command_as NAME JAR IP METHOD PATH [JSON]: a browser's command, with Origin, a fresh
# Idempotency-Key on POST (or $KEY), the visitor's cookies and a CF-Connecting-IP.
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
get_as() {
  local name="$1" jar_name="$2" path="$3"; shift 3
  local cookies; cookies="$(jar "$jar_name")"
  local args=(-H "CF-Connecting-IP: 192.0.2.250" -H "Origin: $STOREFRONT")
  if [[ -n "$cookies" ]]; then args+=(-H "Cookie: $cookies"); fi
  request "$name" "${args[@]}" "$@" "$BASE$path"
  jar_update "$name" "$jar_name"
}
now_ms() { node -e 'console.log(Date.now())'; }

wait_live() {
  local name="$1" jar_name="$2" id="$3"
  for _ in $(seq 1 150); do
    get_as "$name" "$jar_name" "/v1/sandboxes/$id"
    if [[ "$(json_field "$name" b.state)" == live ]]; then return 0; fi
    sleep 0.2
  done
  return 1
}

# wait_order NAME JAR SANDBOX ORDER STATUS: polls the order until it has that status, up to 10 s.
wait_order() {
  local name="$1" jar_name="$2" id="$3" oid="$4" want="$5"
  for _ in $(seq 1 50); do
    get_as "$name" "$jar_name" "/v1/sandboxes/$id/orders/$oid"
    if [[ "$(json_field "$name" b.status)" == "$want" ]]; then return 0; fi
    sleep 0.2
  done
  return 1
}

# schedule_until NAME JAR SANDBOX DATE EXPR: polls the day's schedule until EXPR holds over it
# (`b`), up to 10 s.
schedule_until() {
  local name="$1" jar_name="$2" id="$3" date="$4" expr="$5"
  for _ in $(seq 1 50); do
    get_as "$name" "$jar_name" "/v1/sandboxes/$id/schedule/$date"
    if node -e "const b = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); if (!($expr)) process.exit(1)" "$TMP/$name.body" 2>/dev/null; then return 0; fi
    sleep 0.2
  done
  return 1
}

probe_args() {
  PROBE=("$ROOT/scripts/ws-probe.mjs" --url "$WS/v1/sandboxes/$2/kitchen/ws" --jar "$TMP/$1.jar" --origin "$STOREFRONT")
}
probe_ok() {
  node -e "
    const lines = require('fs').readFileSync(process.argv[1], 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const frames = lines.filter((l) => l.frame).map((l) => ({ ...l.frame, at: l.at }));
    const snapshot = frames.find((f) => f.t === 'snapshot');
    const lists = snapshot ? (snapshot.board.bake_lists || []) : [];
    const evts = frames.filter((f) => f.t === 'evt').map((f) => ({ ...f.env, at_ms: f.at }));
    const folded = (lines.find((l) => l.bake_lists) || {}).bake_lists || {};
    if (!($2)) process.exit(1);" "$1" 2>/dev/null
}
expect_probe() {
  if probe_ok "$2" "$3"; then pass "$1"; else fail "$1 ($(head -c 400 "$2" | tr '\n' ' '))"; fi
}
# snapshot_until NAME JAR SANDBOX EXPR: opens the board's socket until its snapshot satisfies
# EXPR (over `lists`, `snapshot`), up to 10 s. probe_ok's `folded` is the probe's bake lists by
# date as the page holds them: the snapshot's days, each set again from a frame's `bake_list`.
snapshot_until() {
  local name="$1" jar_name="$2" id="$3" expr="$4"
  probe_args "$jar_name" "$id"
  for _ in $(seq 1 20); do
    node "${PROBE[@]}" --until snapshot > "$TMP/$name.out" 2>/dev/null || true
    if probe_ok "$TMP/$name.out" "$expr"; then return 0; fi
    sleep 0.5
  done
  return 1
}
log_has() { grep -qF -- "$1" "$LOG"; }

# The bakery's calendar, in Node: America/Denver through Intl, slots 07:00 to 14:45 on the quarter
# hour, windows at 09:00, 11:00 and 13:00, closed Mondays (docs/domain.md, "Money and time").
CAL='
const TZ = "America/Denver";
const parts = (ms) => { const o = {}; for (const p of new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" }).formatToParts(new Date(ms))) o[p.type] = p.value; return o; };
const offsetMin = (ms) => { const p = parts(ms); return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000) / 60000); };
const iso = (ms) => { const p = parts(ms), o = offsetMin(ms), a = Math.abs(o); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${o < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`; };
const day = (ms) => { const p = parts(ms); return `${p.year}-${p.month}-${p.day}`; };
const md = (ms) => { const p = parts(ms); return `${p.month}-${p.day}`; };
const wd = (ms) => parts(ms).weekday.toLowerCase().slice(0, 3);
const minuteOf = (ms) => { const p = parts(ms); return +p.hour * 60 + +p.minute; };
const isSlot = (ms) => wd(ms) !== "mon" && minuteOf(ms) >= 420 && minuteOf(ms) <= 885 && minuteOf(ms) % 15 === 0;
const nextSlot = (from) => { let t = Math.ceil(from / 900000) * 900000; for (let i = 0; i < 96 * 9; i++, t += 900000) if (isSlot(t)) return t; throw new Error("no slot"); };
const inSeason = (s, ms) => !s || (s.from <= s.to ? s.from <= md(ms) && md(ms) <= s.to : md(ms) >= s.from || md(ms) <= s.to);
const fits = (menu, ms, leadMax, skip) => { for (const c of menu.categories) for (const i of c.items) { if (i.slug === skip || i.status !== "available" || !i.days_baked.includes(wd(ms)) || !inSeason(i.season, ms)) continue; const v = i.variants.find((v) => v.lead_minutes <= leadMax); if (v) return { item: i.slug, variant: v.slug }; } return null; };
'
# cal EXPR [ARGS...]: EXPR evaluated with the calendar above, args as `a`, printed.
cal() { local expr="$1"; shift; node -e "$CAL; const a = process.argv.slice(1); const v = ($expr); process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v))" "$@" 2>/dev/null || true; }

# pickup NAME_OF_MENU BUSINESS_OFFSET_S MINUTES_AHEAD [QTY]: a pickup order for the first slot
# MINUTES_AHEAD or more after business now, of an item baked that day whose lead the slot meets.
pickup() {
  node -e "$CAL
    const menu = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const now = Date.now() + Number(process.argv[2]) * 1000;
    const slot = nextSlot(now + Number(process.argv[3]) * 60000);
    const f = fits(menu, slot, Math.floor((slot - now) / 60000) - 30);
    if (!f) process.exit(1);
    console.log(JSON.stringify({ kind: 'pickup', slot: iso(slot), lines: [{ variant: f.variant, qty: Number(process.argv[4] || 1) }] }));" \
    "$TMP/$1.body" "$2" "$3" "${4:-1}"
}

# object_sql CLASS NAME SQL: one query against an object's SQLite file in the state directory,
# opened read-only while the Worker runs; prints the rows as JSON.
object_sql() {
  node -e "
    process.removeAllListeners('warning');
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('fs'), path = require('path');
    const root = path.join(process.argv[1], 'v3', 'do');
    const dir = fs.readdirSync(root).find((d) => d.endsWith('-' + process.argv[2]));
    for (const f of fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')) {
      const db = new DatabaseSync(path.join(root, dir, f), { readOnly: true });
      try {
        const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type = 'table'\").all().map((t) => t.name);
        if (!tables.includes('__miniflare_do_name')) continue;
        const name = db.prepare('SELECT name FROM __miniflare_do_name LIMIT 1').get()?.name;
        if (name !== process.argv[3]) continue;
        process.stdout.write(JSON.stringify(db.prepare(process.argv[4]).all()));
        process.exit(0);
      } finally { db.close(); }
    }
    process.exit(1);" "$STATE" "$1" "$2" "$3"
}
expiry_wall() {
  object_sql Order "order:$1:$2" "SELECT due_wall FROM timers WHERE id = 'expiry'" | node -e "const r = JSON.parse(require('fs').readFileSync(0, 'utf8')); process.stdout.write(r.length ? String(Date.parse(r[0].due_wall)) : '')"
}

# ---------- the fake Stripe ----------

stripe_call() {
  local name="$1" method="$2" path="$3" form="${4:-}"
  local args=(-X "$method" -H "Authorization: Bearer $STRIPE_KEY")
  if [[ -n "$form" ]]; then args+=(-H 'Content-Type: application/x-www-form-urlencoded' --data "$form"); fi
  request "$name" "${args[@]}" "$STRIPE$path"
}
intent_of() { json_field "$1" "b.client_secret.split('_secret_')[0]"; }
# pay_order NAME JAR IP SANDBOX ORDER: the payment step as the storefront runs it, then the
# browser's confirm at Stripe with the test card.
pay_order() {
  KEY="$5" command_as "$1" "$2" "$3" POST "/v1/sandboxes/$4/orders/$5/payment"
  local pi; pi="$(intent_of "$1")"
  stripe_call "$1_confirm" POST "/v1/payment_intents/$pi/confirm" "payment_method=pm_card_visa"
}

write_dev_vars() {
  {
    echo "# Written by scripts/smoke-schedule.sh for one run; removed when it ends. Never committed."
    echo "SESSION_HMAC_KEY=$(random_text 48)"
    echo "ACCOUNT_HMAC_KEY=$(random_text 48)"
    echo "TURNSTILE_SECRET=1x0000000000000000000000000000000AA"
    echo "TURNSTILE_SITEVERIFY_URL=$FAKE/turnstile/siteverify"
    echo "ALLOWED_ORIGIN=$STOREFRONT"
    echo "API_ORIGIN=$BASE"
    echo "STRIPE_API_BASE=$STRIPE"
    echo "STRIPE_SECRET_KEY=$STRIPE_KEY"
    echo "STRIPE_WEBHOOK_SECRET=$WEBHOOK_SECRET"
    echo "STRIPE_PUBLISHABLE_KEY=$PUBLISHABLE"
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

# ---------- start ----------

echo "starting the fake providers on $FAKE and the fake Stripe on $STRIPE"
set -m
node "$ROOT/scripts/fake-providers.mjs" --port "$FAKE_PORT" > "$FAKE_LOG" 2>&1 < /dev/null &
FAKE_PID=$!
FAKE_STRIPE_WEBHOOK_URL="$BASE/v1/stripe/webhook" node "$ROOT/scripts/fake-stripe.mjs" --port "$STRIPE_PORT" > "$STRIPE_LOG" 2>&1 < /dev/null &
STRIPE_PID=$!
set +m
for _ in $(seq 1 100); do curl -s -o /dev/null "$FAKE/_health" && curl -s -o /dev/null "$STRIPE/_health" && break; sleep 0.1; done

start_worker

# ---------- three sandboxes: a guest, staff, and staff whose clock travels ----------

command_as guest G 192.0.2.81 POST /v1/sandboxes '{"turnstile_token":"pass-1","replace":false}'
expect_status guest 201
GID="$(json_field guest b.id)"
CANARY="$(random_text 24)"
command_as signup D 192.0.2.82 POST /v1/auth/demo "{\"password\":\"$CANARY\",\"turnstile_token\":\"pass-1\"}"
expect_status signup 201
DUSER="$(json_field signup b.username)"
command_as demo D 192.0.2.82 POST /v1/sandboxes '{"replace":false}'
expect_status demo 201
DID="$(json_field demo b.id)"
command_as signup_e E 192.0.2.83 POST /v1/auth/demo "{\"password\":\"$CANARY\",\"turnstile_token\":\"pass-1\"}"
command_as sandbox_e E 192.0.2.83 POST /v1/sandboxes '{"replace":false}'
expect_status sandbox_e 201
EID="$(json_field sandbox_e b.id)"
check "guest: seeding reaches live" "wait_live guest_live G '$GID'"
expect_json guest_live "b.state === 'live' && b.children >= 36"
check "demo: seeding reaches live" "wait_live demo_live D '$DID'"
expect_json demo_live "b.state === 'live' && b.children >= 36 && b.kind === 'account'"
check "e: seeding reaches live" "wait_live e_live E '$EID'"

# ---------- the seeded days and the day's schedule ----------

TODAY="$(cal 'day(Date.now())')"
get_as day_today G "/v1/sandboxes/$GID/schedule/$TODAY"
expect_status day_today 200
expect_json day_today "b.date === '$TODAY' && b.slots.length === 32 && b.zones.length === 3 && b.zones.every(z => z.windows.length === 3) && b.slots.every(s => s.free === Math.max(0, s.capacity - s.taken)) && b.menu_version === 1 && b.items.some(i => i.daily_cap !== null) && typeof b.bake_list.version === 'number'"
seeded_bad=""
SEEDED="$(cal 'Array.from({ length: 8 }, (_, i) => Date.now() + i * 86400000).filter(t => wd(t) !== "mon").slice(0, 7).map(day).join(" ")')"
for d in $SEEDED; do
  get_as "seeded_$d" G "/v1/sandboxes/$GID/schedule/$d"
  node -e "const b = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); if (!(b.menu_version === 1 && b.items.filter(i => i.daily_cap !== null).length === 24)) process.exit(1)" "$TMP/seeded_$d.body" 2>/dev/null || seeded_bad="$seeded_bad $d:$(json_field "seeded_$d" "b.menu_version + '/' + (b.items || []).length")"
done
check "the seven seeded days, the open ones from today, carry the menu's caps (menu_version 1, 24 items)$seeded_bad" "[[ -z '$seeded_bad' ]]"
check "the seed's open orders hold their places: $(json_field day_today "b.slots.reduce((n, s) => n + s.taken, 0) + b.zones.reduce((n, z) => n + z.taken, 0)") taken today" "true"
YESTERDAY="$(cal 'day(Date.now() - 86400000)')"
get_as day_before_birth G "/v1/sandboxes/$GID/schedule/$YESTERDAY"
expect_problem day_before_birth 404 no-such-day
FAR="$(cal 'day(Date.now() + 31 * 86400000)')"
get_as day_far G "/v1/sandboxes/$GID/schedule/$FAR"
expect_problem day_far 404 no-such-day
LAST="$(cal 'day(Date.now() + 30 * 86400000)')"
get_as day_last G "/v1/sandboxes/$GID/schedule/$LAST"
expect_status day_last 200
# Born by this read, after the seed: with the published menu's caps (the hardening after PR 13).
expect_json day_last "b.date === '$LAST' && b.menu_version === 1 && b.items.filter(i => i.daily_cap !== null).length === 24 && b.bake_list.version === 0"
get_as day_bad G "/v1/sandboxes/$GID/schedule/not-a-date"
expect_problem day_bad 404 no-such-day

# ---------- the race for the last place ----------

get_as dmenu D "/v1/sandboxes/$DID/menu"
# The first slot at least 3 h out with no place taken and a free one after it, on its day.
RACE='{}'
for i in 0 1 2 3; do
  RACE_FROM="$(cal 'day(nextSlot(Date.now() + 180 * 60000) + Number(a[0]) * 86400000)' "$i")"
  get_as race_day D "/v1/sandboxes/$DID/schedule/$RACE_FROM"
  if RACE="$(node -e "
    const b = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const from = Date.now() + 180 * 60000;
    for (let i = 0; b.open && i + 1 < b.slots.length; i++) {
      const s = b.slots[i], n = b.slots[i + 1];
      if (Date.parse(s.start) >= from && s.taken === 0 && n.free > 0) { console.log(JSON.stringify({ slot: s.start, next: n.start })); process.exit(0); }
    }
    process.exit(1);" "$TMP/race_day.body")"; then break; fi
  RACE='{}'
done
RACE_SLOT="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).slot || '')" "$RACE")"
RACE_NEXT="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).next || '')" "$RACE")"
RACE_HHMM="${RACE_SLOT:11:5}"
RACE_ITEM="$(cal 'a[1] && JSON.stringify(fits(JSON.parse(require("fs").readFileSync(a[0], "utf8")), Date.parse(a[1]), Math.floor((Date.parse(a[1]) - Date.now()) / 60000) - 30))' "$TMP/dmenu.body" "$RACE_SLOT")"
RACE_VARIANT="$(node -e "process.stdout.write((JSON.parse(process.argv[1]) || {}).variant || '')" "$RACE_ITEM")"
check "a race slot was found: $RACE_SLOT, then $RACE_NEXT, selling $RACE_VARIANT" "[[ -n '$RACE_SLOT' && -n '$RACE_VARIANT' ]]"
command_as cut_to_one D 192.0.2.82 PATCH "/v1/sandboxes/$DID/schedule/$RACE_FROM/capacity" "{\"target\":\"slot:$RACE_HHMM\",\"capacity\":1}"
expect_status cut_to_one 200
expect_json cut_to_one "b.slots.find(s => s.start === '$RACE_SLOT').capacity === 1 && b.slots.find(s => s.start === '$RACE_SLOT').free === 1"
command_as cut_again D 192.0.2.82 PATCH "/v1/sandboxes/$DID/schedule/$RACE_FROM/capacity" "{\"target\":\"slot:$RACE_HHMM\",\"capacity\":1}"
expect_status cut_again 200
# A second session of the same account, signed in on its own.
command_as signin_d2 D2 192.0.2.84 POST /v1/auth/demo/signin "{\"username\":\"$DUSER\",\"password\":\"$CANARY\"}"
expect_status signin_d2 200
RACE_ORDER="{\"kind\":\"pickup\",\"slot\":\"$RACE_SLOT\",\"lines\":[{\"variant\":\"$RACE_VARIANT\",\"qty\":1}]}"
command_as race_a D 192.0.2.82 POST "/v1/sandboxes/$DID/orders" "$RACE_ORDER" &
RACE_A=$!
command_as race_b D2 192.0.2.84 POST "/v1/sandboxes/$DID/orders" "$RACE_ORDER" &
RACE_B=$!
wait "$RACE_A" "$RACE_B" || true
STATUSES="$(printf '%s\n%s\n' "$(status_of race_a)" "$(status_of race_b)" | sort | paste -sd,)"
check "two placements for the last place: one 201 and one 409 ($STATUSES)" "[[ '$STATUSES' == '201,409' ]]"
if [[ "$(status_of race_a)" == 201 ]]; then WIN=race_a; LOSE=race_b; else WIN=race_b; LOSE=race_a; fi
expect_problem "$LOSE" 409 slot-full
expect_json "$LOSE" "b.next_free === '$RACE_NEXT' && b.detail.includes('$RACE_NEXT') && b.detail.includes('The rule is slot-full.')"
WIN_ID="$(json_field "$WIN" b.id)"
check "the race's day counts one place taken in the slot" "schedule_until race_after D '$DID' '$RACE_FROM' \"b.slots.find(s => s.start === '$RACE_SLOT').taken === 1 && b.slots.find(s => s.start === '$RACE_SLOT').free === 0\""

# ---------- the capacity editor ----------

pay_order pay_win D 192.0.2.82 "$DID" "$WIN_ID"
check "the race's winner is paid through the fake Stripe" "wait_order win_paid D '$DID' '$WIN_ID' confirmed"
RACE_ITEM_SLUG="${RACE_VARIANT%%/*}"
check "the winner reaches its day's bake list" "schedule_until bake_win D '$DID' '$RACE_FROM' \"b.bake_list.version >= 1 && b.bake_list.lines.some(l => l.item === '$RACE_ITEM_SLUG' && l.start === '$RACE_SLOT')\""
command_as cut_to_zero D 192.0.2.82 PATCH "/v1/sandboxes/$DID/schedule/$RACE_FROM/capacity" "{\"target\":\"slot:$RACE_HHMM\",\"capacity\":0}"
expect_status cut_to_zero 200
expect_json cut_to_zero "b.slots.find(s => s.start === '$RACE_SLOT').capacity === 0 && b.slots.find(s => s.start === '$RACE_SLOT').taken === 1 && b.slots.find(s => s.start === '$RACE_SLOT').free === 0 && b.bake_list.lines.some(l => l.start === '$RACE_SLOT')"
# An item the day's menu does not list is refused, and the day keeps no cap for it.
command_as unknown_item D 192.0.2.82 PATCH "/v1/sandboxes/$DID/schedule/$RACE_FROM/capacity" '{"target":"item:no-such-thing","capacity":3}'
expect_problem unknown_item 422 unknown-item
check "the day keeps no cap for an item its menu does not list" "schedule_until unknown_after D '$DID' '$RACE_FROM' \"!b.items.some(i => i.item === 'no-such-thing')\""
command_as bad_target D 192.0.2.82 PATCH "/v1/sandboxes/$DID/schedule/$RACE_FROM/capacity" '{"target":"slot:15:00","capacity":1}'
expect_problem bad_target 422 bad-target
command_as bad_target_kind D 192.0.2.82 PATCH "/v1/sandboxes/$DID/schedule/$RACE_FROM/capacity" '{"target":"oven:1","capacity":1}'
expect_problem bad_target_kind 422 bad-target
# The day's seeded open orders may already hold this item, so the count it reads before the cap
# is the truth to compare with: the cap is set to that count (at least the winner's one), and
# `used` must read back unchanged.
get_as item_before D "/v1/sandboxes/$DID/schedule/$RACE_FROM"
ITEM_USED="$(json_field item_before "b.items.find(i => i.item === '$RACE_ITEM_SLUG').used")"
check "$RACE_ITEM_SLUG on $RACE_FROM counts $ITEM_USED used before the cap, the winner's place among them" "[[ '$ITEM_USED' =~ ^[0-9]+$ ]] && (( ${ITEM_USED:-0} >= 1 ))"
command_as item_cap D 192.0.2.82 PATCH "/v1/sandboxes/$DID/schedule/$RACE_FROM/capacity" "{\"target\":\"item:$RACE_ITEM_SLUG\",\"capacity\":${ITEM_USED:-1}}"
expect_status item_cap 200
expect_json item_cap "b.items.find(i => i.item === '$RACE_ITEM_SLUG').daily_cap === ${ITEM_USED:-1} && b.items.find(i => i.item === '$RACE_ITEM_SLUG').used === ${ITEM_USED:-1}"
ITEM_SLOT="$(cal 'iso(nextSlot(Date.parse(a[0]) + 60 * 60000))' "$RACE_SLOT")"
command_as over_cap D 192.0.2.82 POST "/v1/sandboxes/$DID/orders" "{\"kind\":\"pickup\",\"slot\":\"$ITEM_SLOT\",\"lines\":[{\"variant\":\"$RACE_VARIANT\",\"qty\":1}]}"
expect_problem over_cap 409 item-cap
expect_json over_cap "b.detail.includes('$RACE_ITEM_SLUG') && b.detail.includes('The rule is item-cap.')"
command_as guest_cap G 192.0.2.81 PATCH "/v1/sandboxes/$GID/schedule/$TODAY/capacity" '{"target":"slot:10:00","capacity":1}'
expect_problem guest_cap 403 guest-scope
get_as guest_reads G "/v1/sandboxes/$GID/schedule/$TODAY"
expect_status guest_reads 200
get_as cross_day D "/v1/sandboxes/$GID/schedule/$TODAY"
expect_status cross_day 404

# ---------- a day born after the seed is capped (the hardening after PR 13) ----------

# The menu's lowest cap among items baked on two open days no seed touched (10 or more days out),
# in season and available. The menu API edits prices and status, not caps, so the "low cap" is
# the seeded menu's own lowest. Day A is first touched by the order that fills the cap; day B is
# read before a publish, then filled after it.
LATE="$(cal '(() => {
  const menu = JSON.parse(require("fs").readFileSync(a[0], "utf8"));
  const items = menu.categories.flatMap(c => c.items).filter(i => i.status === "available").sort((x, y) => x.daily_cap - y.daily_cap);
  const ten = (i) => Math.floor(Date.now() / 86400000) * 86400000 + i * 86400000 + 17 * 3600000;
  for (const it of items) {
    const days = [];
    for (let i = 10; i <= 25 && days.length < 2; i++) { const t = ten(i); if (wd(t) !== "mon" && it.days_baked.includes(wd(t)) && inSeason(it.season, t)) days.push(t); }
    if (days.length < 2) continue;
    const v = [...it.variants].sort((x, y) => x.lead_minutes - y.lead_minutes)[0];
    const slot = (t, m) => { const p = parts(t); let s = t - ((+p.hour * 60 + +p.minute) - m) * 60000; return iso(Math.floor(s / 60000) * 60000); };
    return { item: it.slug, variant: v.slug, cap: it.daily_cap, a: day(days[0]), b: day(days[1]), a1: slot(days[0], 600), a2: slot(days[0], 615), b1: slot(days[1], 600), b2: slot(days[1], 615) };
  }
  return null;
})()' "$TMP/dmenu.body")"
late() { node -e "const v = (JSON.parse(process.argv[1]) || {})[process.argv[2]]; process.stdout.write(v === undefined ? '' : String(v))" "${LATE:-null}" "$1"; }
LATE_ITEM="$(late item)"; LATE_VARIANT="$(late variant)"; LATE_CAP="$(late cap)"
LATE_A="$(late a)"; LATE_B="$(late b)"
check "two late days were found: $LATE_A and $LATE_B, $LATE_ITEM capped at $LATE_CAP" "[[ -n '$LATE_ITEM' && -n '$LATE_A' && -n '$LATE_B' && '$LATE_A' != '$LATE_B' ]]"
# lines_for QTY: lines of LATE_VARIANT summing to QTY, 24 at most each (the Order's line limit).
lines_for() { node -e "const q = Number(process.argv[1]), out = []; for (let n = q; n > 0; n -= 24) out.push({ variant: process.argv[2], qty: Math.min(24, n) }); process.stdout.write(JSON.stringify(out))" "$1" "$LATE_VARIANT"; }
FILL="$(lines_for "${LATE_CAP:-1}")"
get_as late_b_before D "/v1/sandboxes/$DID/schedule/$LATE_B"
expect_status late_b_before 200
expect_json late_b_before "b.menu_version === 1 && b.items.filter(i => i.daily_cap !== null).length === 24 && b.items.find(i => i.item === '$LATE_ITEM').daily_cap === $LATE_CAP"
# A publish (a price change, so a new version), which the consumer takes to the registered days.
command_as late_price D 192.0.2.82 PATCH "/v1/sandboxes/$DID/menu/items/$LATE_ITEM" '{"price_cents":1111}'
expect_status late_price 200
command_as late_publish D 192.0.2.82 POST "/v1/sandboxes/$DID/menu/publish"
expect_status late_publish 200
LATE_V="$(json_field late_publish b.version)"
# The publish changed a price, not a cap, so day B keeps the caps it was born with, and names the
# new version they now follow (since the console audit of 2026-11-08; before, it stayed on 1).
check "day B, born before the publish, keeps its caps through it and follows version $LATE_V" "schedule_until late_b_after D '$DID' '$LATE_B' \"b.menu_version === $LATE_V && b.items.find(i => i.item === '$LATE_ITEM').daily_cap === $LATE_CAP\""
check "day A was never touched: no Schedule object holds it yet" "! object_sql Schedule 'schedule:$DID:$LATE_A' 'SELECT 1' >/dev/null 2>&1"
command_as late_a_fill D 192.0.2.82 POST "/v1/sandboxes/$DID/orders" "{\"kind\":\"pickup\",\"slot\":\"$(late a1)\",\"lines\":$FILL}"
expect_status late_a_fill 201
get_as late_a_day D "/v1/sandboxes/$DID/schedule/$LATE_A"
expect_json late_a_day "b.menu_version === $LATE_V && b.items.filter(i => i.daily_cap !== null).length === 24 && b.items.find(i => i.item === '$LATE_ITEM').daily_cap === $LATE_CAP && b.items.find(i => i.item === '$LATE_ITEM').used === $LATE_CAP"
check "day A was born by the hold with the caps in its first write: CapsRefreshed before SlotHeld" "[[ \"\$(object_sql Schedule 'schedule:$DID:$LATE_A' 'SELECT type FROM events ORDER BY seq' | node -e \"process.stdout.write(JSON.parse(require('fs').readFileSync(0, 'utf8')).map(r => r.type).slice(0, 2).join(','))\")\" == 'CapsRefreshed,SlotHeld' ]]"
command_as late_a_over D 192.0.2.82 POST "/v1/sandboxes/$DID/orders" "{\"kind\":\"pickup\",\"slot\":\"$(late a2)\",\"lines\":[{\"variant\":\"$LATE_VARIANT\",\"qty\":1}]}"
expect_problem late_a_over 409 item-cap
expect_json late_a_over "b.detail.includes('No more $LATE_ITEM can be made that day.') && b.detail.includes('The rule is item-cap.')"
command_as late_b_fill D 192.0.2.82 POST "/v1/sandboxes/$DID/orders" "{\"kind\":\"pickup\",\"slot\":\"$(late b1)\",\"lines\":$FILL}"
expect_status late_b_fill 201
command_as late_b_over D 192.0.2.82 POST "/v1/sandboxes/$DID/orders" "{\"kind\":\"pickup\",\"slot\":\"$(late b2)\",\"lines\":[{\"variant\":\"$LATE_VARIANT\",\"qty\":1}]}"
expect_problem late_b_over 409 item-cap
expect_json late_b_over "b.detail.includes('No more $LATE_ITEM can be made that day.')"
check "no day was refused its birth for want of caps" "! log_has '\"event\":\"schedule_birth_refused\"'"

# ---------- the cake rule ----------

CAKE="chocolate-layer-cake/6-inch"
# The first slot at least 48 h 30 min out, on a day the cake is baked. The refusal of a cake inside
# its 48 h is checked on sandbox E, after its clock has stepped to a Tuesday 07:00 (below).
CAKE_LATER="$(cal '(() => { const menu = JSON.parse(require("fs").readFileSync(a[0], "utf8")); const cake = menu.categories.flatMap(c => c.items).find(i => i.slug === "chocolate-layer-cake"); let t = nextSlot(Date.now() + (48 * 60 + 30) * 60000); while (!cake.days_baked.includes(wd(t))) t = nextSlot(t + 900000); return iso(t); })()' "$TMP/dmenu.body")"
CAKE_DAY="${CAKE_LATER:0:10}"
command_as cake_later D 192.0.2.82 POST "/v1/sandboxes/$DID/orders" "{\"kind\":\"pickup\",\"slot\":\"$CAKE_LATER\",\"lines\":[{\"variant\":\"$CAKE\",\"qty\":1}]}"
expect_status cake_later 201
CAKE_ID="$(json_field cake_later b.id)"
check "the cake for $CAKE_LATER holds its slot, and is not on the bake list unpaid" "schedule_until cake_held D '$DID' '$CAKE_DAY' \"b.slots.find(s => s.start === '$CAKE_LATER').taken >= 1 && !b.bake_list.lines.some(l => l.item === 'chocolate-layer-cake' && l.start === '$CAKE_LATER')\""
pay_order pay_cake D 192.0.2.82 "$DID" "$CAKE_ID"
check "the cake is paid through the fake Stripe" "wait_order cake_paid D '$DID' '$CAKE_ID' confirmed"
check "the cake is on $CAKE_DAY's bake list" "schedule_until cake_baked D '$DID' '$CAKE_DAY' \"b.bake_list.lines.some(l => l.item === 'chocolate-layer-cake' && l.start === '$CAKE_LATER' && l.qty >= 1)\""
check "the kitchen socket's snapshot carries $CAKE_DAY's bake list with the cake" "snapshot_until snap_cake D '$DID' \"lists.some(l => l.date === '$CAKE_DAY' && l.version >= 1 && l.reserved >= 1 && l.lines.some(x => x.item === 'chocolate-layer-cake' && x.start === '$CAKE_LATER'))\""
expect_probe "the snapshot's bake lists are sorted by date, from today on" "$TMP/snap_cake.out" "lists.every((l, i) => i === 0 || lists[i - 1].date < l.date) && lists.every(l => l.date >= '$TODAY' && Array.isArray(l.lines) && typeof l.reserved === 'number')"

# ---------- a place reserved before the socket, released while it watches (2026-11-06) ----------

# The roadmap's PR 6 reading: the frame carried no count, so a page that never saw the place
# reserved kept its count one too high until the next snapshot. Each Schedule frame now carries
# the day as the board holds it (`bake_list`), and the page sets the day from it.
REL_ORDER="$(node -e "$CAL
  const menu = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  const skip = process.argv.slice(2);
  let t = nextSlot(Date.now() + 180 * 60000);
  for (let i = 0; i < 96 * 9; i++, t = nextSlot(t + 900000)) {
    if (skip.includes(day(t))) continue;
    const f = fits(menu, t, Math.floor((t - Date.now()) / 60000) - 30);
    if (f) { console.log(JSON.stringify({ kind: 'pickup', slot: iso(t), lines: [{ variant: f.variant, qty: 1 }] })); process.exit(0); }
  }
  process.exit(1);" "$TMP/dmenu.body" "$RACE_FROM" "$CAKE_DAY" 2>/dev/null)" || { fail "no item fits a slot 3 h out away from the race's and the cake's days"; REL_ORDER='{}'; }
command_as rel_place D 192.0.2.82 POST "/v1/sandboxes/$DID/orders" "$REL_ORDER"
expect_status rel_place 201
REL_ID="$(json_field rel_place b.id)"
REL_SLOT="$(json_field rel_place b.slot)"
REL_DAY="${REL_SLOT:0:10}"
reserved_on() { echo "(lists.find(l => l.date === '$REL_DAY') || { reserved: 0 }).reserved"; }
snapshot_until rel_before D "$DID" "true" || true
REL_R0="$(node -e "const s = require('fs').readFileSync(process.argv[1], 'utf8').split('\n').filter(Boolean).map(JSON.parse).map(l => l.frame).find(f => f && f.t === 'snapshot'); const d = s && (s.board.bake_lists || []).find(l => l.date === process.argv[2]); process.stdout.write(String(s ? (d ? d.reserved : 0) : ''))" "$TMP/rel_before.out" "$REL_DAY" 2>/dev/null || true)"
check "held, not yet paid: the board counts $REL_DAY's reserved places as ${REL_R0:-unread}" "[[ -n '$REL_R0' ]]"
REL_R0="${REL_R0:-0}"
pay_order pay_rel D 192.0.2.82 "$DID" "$REL_ID"
check "the order is paid through the fake Stripe" "wait_order rel_paid D '$DID' '$REL_ID' confirmed"
check "the reservation reaches the board before any socket watches: $((REL_R0 + 1)) reserved on $REL_DAY" "snapshot_until rel_reserved D '$DID' \"\$(reserved_on) === $((REL_R0 + 1))\""

# The socket connects now, after the reservation, and watches the release.
probe_args D "$DID"
node "${PROBE[@]}" --hold 0 > "$TMP/ws_rel.out" 2>/dev/null &
WS_REL=$!
for _ in $(seq 1 50); do grep -q '"t":"snapshot"' "$TMP/ws_rel.out" 2>/dev/null && break; sleep 0.2; done
command_as rel_cancel D 192.0.2.82 POST "/v1/sandboxes/$DID/orders/$REL_ID/cancel"
expect_status rel_cancel 200
expect_json rel_cancel "['refund_pending', 'cancelled'].includes(b.status)"
for _ in $(seq 1 50); do grep -q "\"type\":\"SlotReleased\".*$REL_ID\|$REL_ID.*\"type\":\"SlotReleased\"" "$TMP/ws_rel.out" 2>/dev/null && break; sleep 0.2; done
sleep 1
kill -TERM "$WS_REL" 2>/dev/null || true
wait "$WS_REL" 2>/dev/null || true
REL_FRAME="frames.find(f => f.t === 'evt' && f.env.type === 'SlotReleased' && f.env.data.ref === '$REL_ID')"
expect_probe "the socket's snapshot, taken after the reservation, counts $((REL_R0 + 1)) on $REL_DAY" "$TMP/ws_rel.out" "$(reserved_on) === $((REL_R0 + 1))"
expect_probe "the release reaches the socket as an evt frame, with no reconnect" "$TMP/ws_rel.out" "frames.filter(f => f.t === 'snapshot').length === 1 && $REL_FRAME !== undefined"
expect_probe "the release's frame carries $REL_DAY as the board now holds it: $REL_R0 reserved" "$TMP/ws_rel.out" "(($REL_FRAME || {}).bake_list || {}).date === '$REL_DAY' && $REL_FRAME.bake_list.reserved === $REL_R0 && Array.isArray($REL_FRAME.bake_list.lines) && typeof $REL_FRAME.bake_list.version === 'number'"
expect_probe "every Schedule frame for $REL_DAY carries its day, and no card's frame carries one" "$TMP/ws_rel.out" "frames.filter(f => f.t === 'evt' && ['BakeListChanged', 'SlotReserved', 'SlotReleased'].includes(f.env.type)).every(f => f.bake_list && f.bake_list.date === f.env.data.date) && frames.filter(f => f.t === 'evt' && f.env.stream.startsWith('order:')).every(f => f.bake_list === undefined)"
expect_probe "the page's count, the snapshot set again from each frame's day, is $REL_R0 without a reconnect" "$TMP/ws_rel.out" "(folded['$REL_DAY'] || {}).reserved === $REL_R0"
# What the page did before: adjust the snapshot's count only for refs this socket saw reserved.
expect_probe "the old rule, an adjusted count, would have kept $((REL_R0 + 1)): the gap this closes" "$TMP/ws_rel.out" "(() => { let n = $(reserved_on); const marks = {}; for (const f of frames.filter(f => f.t === 'evt' && f.env.data.date === '$REL_DAY' && ['SlotReserved', 'SlotReleased'].includes(f.env.type))) { const was = marks[f.env.data.ref]; const r = f.env.type === 'SlotReserved'; n += r ? (was ? 0 : 1) : was ? -1 : 0; marks[f.env.data.ref] = r; } return n === $((REL_R0 + 1)); })()"
check "a new socket's snapshot agrees: $REL_R0 reserved on $REL_DAY" "snapshot_until rel_after D '$DID' \"\$(reserved_on) === $REL_R0\""

# ---------- the clock, on sandbox e ----------

get_as emenu E "/v1/sandboxes/$EID/menu"
UNPAID="$(pickup emenu 0 180)" || { fail "no item on the seeded menu fits a slot 3 h out"; UNPAID='{}'; }
command_as unpaid E 192.0.2.83 POST "/v1/sandboxes/$EID/orders" "$UNPAID"
expect_status unpaid 201
UID_E="$(json_field unpaid b.id)"
U_SLOT="$(json_field unpaid b.slot)"
U_ITEM="$(json_field unpaid "b.lines[0].item")"
U_DAY="${U_SLOT:0:10}"
get_as u_day E "/v1/sandboxes/$EID/schedule/$U_DAY"
U_TAKEN="$(json_field u_day "b.slots.find(s => s.start === '$U_SLOT').taken")"
check "the unpaid order holds its slot ($U_TAKEN taken)" "(( U_TAKEN >= 1 ))"
U_HELD="$(json_field unpaid b.held_until)"
HOLD_DUE="$(object_sql Schedule "schedule:$EID:$U_DAY" "SELECT due_business FROM timers WHERE id = 'hold:$UID_E'" | node -e "const r = JSON.parse(require('fs').readFileSync(0, 'utf8')); process.stdout.write(r.length ? r[0].due_business : '')" 2>/dev/null || true)"
check "the order's held_until ($U_HELD) is its hold's expires_at ($HOLD_DUE), the same instant" "[[ -n '$HOLD_DUE' ]] && (( $(node -e "process.stdout.write(String(Date.parse(process.argv[1]) - Date.parse(process.argv[2])))" "$U_HELD" "${HOLD_DUE:-x}" 2>/dev/null || echo 1) == 0 ))"

# Idempotence: the same advance replayed by its key moves the order's expiry timer once.
W0="$(expiry_wall "$EID" "$UID_E")"
CLOCK_KEY="$(ulid)"
KEY="$CLOCK_KEY" command_as clock_5 E 192.0.2.83 POST "/v1/sandboxes/$EID/clock" '{"minutes":5}'
expect_status clock_5 200
expect_json clock_5 "b.clock_offset_s === 300 && b.step === '5m' && b.clock_v === 1"
W1="$(expiry_wall "$EID" "$UID_E")"
KEY="$CLOCK_KEY" command_as clock_5_again E 192.0.2.83 POST "/v1/sandboxes/$EID/clock" '{"minutes":5}'
expect_status clock_5_again 200
expect_header clock_5_again idempotent-replayed true
expect_json clock_5_again "b.clock_offset_s === 300 && b.clock_v === 1"
W2="$(expiry_wall "$EID" "$UID_E")"
check "the expiry's wall time moved 300 s once: $W0, then $W1, then $W2" "[[ -n '$W0' ]] && (( W0 - W1 == 300000 && W2 == W1 ))"
get_as e_after_5 E "/v1/sandboxes/$EID"
expect_json e_after_5 "b.clock_offset_s === 300 && b.clock_v === 1"

# Both or neither of step and minutes.
command_as clock_both E 192.0.2.83 POST "/v1/sandboxes/$EID/clock" '{"step":"1h","minutes":60}'
expect_problem clock_both 422 clock
command_as clock_none E 192.0.2.83 POST "/v1/sandboxes/$EID/clock" '{}'
expect_problem clock_none 422 clock
command_as clock_zero E 192.0.2.83 POST "/v1/sandboxes/$EID/clock" '{"minutes":0}'
expect_problem clock_zero 422 clock
expect_json clock_zero "b.detail.includes('not-positive')"
command_as guest_clock G 192.0.2.81 POST "/v1/sandboxes/$GID/clock" '{"step":"1d"}'
expect_problem guest_clock 403 guest-scope

# A day: the unpaid order expires, its slot frees, and the console's feed shows the jump.
probe_args E "$EID"
node "${PROBE[@]}" --hold 0 > "$TMP/ws_clock.out" 2>/dev/null &
WS_CLOCK=$!
sleep 1
command_as clock_day E 192.0.2.83 POST "/v1/sandboxes/$EID/clock" '{"step":"1d"}'
expect_status clock_day 200
expect_json clock_day "b.clock_offset_s === 300 + 86400 && b.step === '1d' && b.clock_v === 2"
check "the unpaid order is expired within a few seconds" "wait_order u_expired E '$EID' '$UID_E' expired"
check "its slot is free again" "schedule_until u_freed E '$EID' '$U_DAY' \"b.slots.find(s => s.start === '$U_SLOT').taken === $U_TAKEN - 1\""
expect_json u_freed "!b.bake_list.lines.some(l => l.start === '$U_SLOT' && l.item === '$U_ITEM')"
sleep 2
kill -TERM "$WS_CLOCK" 2>/dev/null || true
wait "$WS_CLOCK" 2>/dev/null || true
expect_probe "ClockAdvanced is on the console's feed, with its step" "$TMP/ws_clock.out" "evts.some(e => e.type === 'ClockAdvanced' && e.data.step === '1d' && e.data.clock_v === 2 && e.stream === 'sandbox:$EID')"
# The Schedule's own log holds the release. The board draws no SlotReleased for a place it never
# saw reserved, so the socket shows none for an unpaid order.
RELEASED="$(object_sql Schedule "schedule:$EID:$U_DAY" "SELECT data FROM events WHERE type = 'SlotReleased'" || echo '[]')"
check "the Schedule released the order's place, as expired or hold_expired" "node -e \"const r = JSON.parse(process.argv[1]).map(x => JSON.parse(x.data)); if (!r.some(d => d.ref === '$UID_E' && ['expired', 'hold_expired'].includes(d.reason))) process.exit(1)\" '$RELEASED'"
NEW_TODAY="$(cal 'day(Date.now() + (300 + 86400) * 1000)')"
check "the board's bake lists move with the clock: none before $NEW_TODAY" "snapshot_until snap_e E '$EID' \"lists.every(l => l.date >= '$NEW_TODAY')\""

# Next opening from a Sunday afternoon: Monday is closed, so Tuesday 07:00.
TO_SUNDAY="$(cal '(() => { const now = Date.now() + (300 + 86400) * 1000; let t = Math.ceil(now / 60000) * 60000; while (!(wd(t) === "sun" && minuteOf(t) === 15 * 60)) t += 60000; return Math.round((t - now) / 60000) + 1; })()')"
command_as clock_sunday E 192.0.2.83 POST "/v1/sandboxes/$EID/clock" "{\"minutes\":$TO_SUNDAY}"
expect_status clock_sunday 200
expect_json clock_sunday "new Date(b.business_now).getTime() > 0 && b.business_now.includes('T15:0')"
SUNDAY_NOW="$(json_field clock_sunday b.business_now)"
command_as clock_open E 192.0.2.83 POST "/v1/sandboxes/$EID/clock" '{"step":"next-opening"}'
expect_status clock_open 200
OPEN_NOW="$(json_field clock_open b.business_now)"
check "next-opening from $SUNDAY_NOW lands on Tuesday 07:00: $OPEN_NOW" "[[ '$(cal 'wd(Date.parse(a[0])) + " " + minuteOf(Date.parse(a[0]))' "$OPEN_NOW")' == 'tue 420' ]] && [[ '$(cal 'wd(Date.parse(a[0]))' "$SUNDAY_NOW")' == sun ]]"
expect_json clock_open "b.step === 'next-opening'"

# The cake rule's refusal, from a business time that is the same on any day: Tuesday 07:00, after
# the step above. The bakery is closed on Mondays and bakes the cake Wednesday to Sunday, so the
# first Wednesday 10:00 is 27 h away, inside the 48 h rule and on a day the cake is baked; the clock runs on
# after the step, so a slow run reads 26 h 59 min. (A slot
# "tomorrow" from wall time is a Monday on a Sunday, which the order refuses as not-baked-that-day.)
CAKE_SOON="$(cal '(() => { let t = Math.ceil(Date.parse(a[0]) / 900000) * 900000; while (!(wd(t) === "wed" && minuteOf(t) === 600)) t += 900000; return iso(t); })()' "$OPEN_NOW")"
command_as cake_soon E 192.0.2.83 POST "/v1/sandboxes/$EID/orders" "{\"kind\":\"pickup\",\"slot\":\"$CAKE_SOON\",\"lines\":[{\"variant\":\"$CAKE\",\"qty\":1}]}"
expect_problem cake_soon 409 lead-time
expect_json cake_soon "b.detail.includes('Chocolate layer cake needs 48 h') && b.detail.includes('The rule is lead-time.') && /the slot is (27 h|26 h 5[0-9] min) away/.test(b.detail)"

# Day by day to the cap: the advance past 14 days is refused.
days_ok=0
for i in $(seq 1 15); do
  command_as "clock_d$i" E 192.0.2.83 POST "/v1/sandboxes/$EID/clock" '{"step":"1d"}'
  if [[ "$(status_of "clock_d$i")" == 200 ]]; then days_ok=$((days_ok + 1)); else break; fi
done
LAST_DAY="clock_d$((days_ok + 1))"
expect_problem "$LAST_DAY" 422 clock
expect_json "$LAST_DAY" "b.detail.includes('offset-cap')"
get_as e_capped E "/v1/sandboxes/$EID"
check "the refused day is the 15th: the offset stays within 14 days ($(json_field e_capped b.clock_offset_s) s after $days_ok more days)" "node -e \"const b = JSON.parse(require('fs').readFileSync('$TMP/e_capped.body', 'utf8')); if (!(b.clock_offset_s <= 1209600 && b.clock_offset_s + 86400 > 1209600)) process.exit(1)\""

# ---------- the wipe ----------

for s in "G:$GID:192.0.2.81" "D:$DID:192.0.2.82" "E:$EID:192.0.2.83"; do
  IFS=: read -r j sid ip <<<"$s"
  command_as "wipe_$j" "$j" "$ip" DELETE "/v1/sandboxes/$sid"
  expect_status "wipe_$j" 200
done
sleep 1
set +e
node "$ROOT/scripts/list-objects.mjs" "$STATE" > "$TMP/list.out" 2> "$TMP/list.err"
LIST_EXIT=$?
set -e
check "list-objects exits 0 after the wipe, the Schedule days included" "(( LIST_EXIT == 0 )) && grep -q '\"class\":\"Schedule\"' '$TMP/list.out'"
check "no alarm_guard was logged" "! log_has '\"event\":\"alarm_guard\"'"

echo
if (( FAILURES > 0 )); then
  echo "$PASSES passed, $FAILURES failed"
  exit 1
fi
echo "all $PASSES checks passed"
