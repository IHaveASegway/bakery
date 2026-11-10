#!/usr/bin/env bash
# Smoke-tests PR 9 on `wrangler dev` against the fake providers and scripts/fake-stripe.mjs:
# dispatch (docs/roadmap.md, PR 9; ADR 0012).
#
# - The seed: today's Dispatch holds one stop per open delivery order of the seed (provisional
#   while unpaid, confirmed once paid) and the server's proposal when one is confirmed; the stops'
#   places are the seed's personas' `p<n>` as matrix indexes, labelled with the map's names.
# - Stops from orders: two delivery orders placed for the open day after the seeded one and paid
#   through the fake Stripe appear as stops, provisional, then confirmed; a third, left unpaid, is
#   removed when the clock passes its 15 minutes (`expired`).
# - Propose with 2 vans of a capacity neither pair fits: every confirmed stop exactly once, no van
#   over capacity, and the minutes are the matrix's (crates/seed/data/salt-lake-city/matrix.json,
#   recomputed here). Its refusals: 422 `dispatch` with `vans`, `capacity`, `no-stops`.
# - The browser's plan: built from the proposal's routes as the page sends it (stop lists,
#   `start` and `end` 0, no totals) is accepted, and the comparison shows both totals; tampered
#   plans are 422 `dispatch` naming the rule: a stop twice (`stop-twice`), a van over capacity
#   (`over-capacity`), a route not ending at the bakery (`route-ends`), a stop left out
#   (`stop-missing`), a van the day lacks (`vans`), a stop that is not the day's (`stop-unknown`);
#   a total sent with it is 400 `body`.
# - Publish twice with one key: one plan (`plan_v` 1), one `RoutePublished` in the Dispatch's log,
#   `Idempotent-Replayed: true` on the second; the stops' Orders (made ready on the kitchen
#   socket) go out for delivery, the day's stops read `out_for_delivery`, and the kitchen board's
#   cards show `van-1` and `van-2` with their stop numbers. Complete a stop: its Order is delivered. A second publish after a van left: 409
#   `dispatch` `published`. 409 `no-plan` before any plan; 422 `stop-unknown` for a stop the plan
#   lacks.
# - The guest reads the day and gets 403 `guest-scope` for every staff command; another sandbox's
#   day is 404; a day outside the sandbox's days is 404 `no-such-day`; a key reused with another
#   body is 422 `idempotency-key`.
# - Delivery windows (the console audit of 2026-11-08, finding 6): every plan's `last_back` is
#   the vans' day worked out door by door from the committed matrix, the vans leaving at 09:00,
#   waiting at a door until its window opens and spending 3 minutes there, and every stop is
#   reached by its window's close.
# - A stop is completed only once its order is ready (finding 7): a delivery paid and planned
#   but not yet made stays confirmed when the plan is published, and its completion is 409
#   `dispatch` `not-ready`; made ready on the kitchen socket, it goes out for delivery at once on
#   van-1, stop 1 (the day's one `StopReady`, since 2026-11-08), the board shows it out on van-1,
#   the day's stops show it out for delivery (one `StopDeparted`, the UI audit's N3), and the plan
#   now stands (409 `published`); its completion then delivers it, and the board clears.
# - The wipe: scripts/list-objects.mjs exits 0, the Dispatch objects included.
#
# It prints ok or FAIL per check as scripts/smoke-crm.sh does, and exits non-zero on any failure.
#
# Usage: scripts/smoke-dispatch.sh   (from anywhere; needs cargo, worker-build, pnpm, node 22 and
# curl).
#
# Like scripts/smoke-crm.sh it writes a throwaway workers/api/.dev.vars, refuses to run when one
# exists unless SMOKE_DISPATCH_OVERWRITE=1, starts the fake providers (Turnstile) on 8790 and the
# fake Stripe on 8791, and keeps the Worker's log in SMOKE_DISPATCH_LOG=<file> when set. Every key
# in the .dev.vars is a test-shaped fake.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SMOKE_PORT:-8788}"
FAKE_PORT="${SMOKE_FAKE_PORT:-8790}"
STRIPE_PORT="${SMOKE_STRIPE_PORT:-8791}"
BASE="http://127.0.0.1:${PORT}"
FAKE="http://127.0.0.1:${FAKE_PORT}"
STRIPE="http://127.0.0.1:${STRIPE_PORT}"
STOREFRONT="http://127.0.0.1:8787"
STARTUP_TIMEOUT_S="${STARTUP_TIMEOUT_S:-240}"
DEV_VARS="$ROOT/workers/api/.dev.vars"

# The fake's own test-shaped values, as its header lists them. Not secrets.
STRIPE_KEY="rk_test_not_a_key"
WEBHOOK_SECRET="whsec_not_a_secret"
PUBLISHABLE="pk_test_not_a_key"

TMP="$(mktemp -d -t smoke-dispatch.XXXXXX)"
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
  stop_pid "$SERVER_PID"
  stop_pid "$FAKE_PID"
  stop_pid "$STRIPE_PID"
  if [[ -n "$WROTE_DEV_VARS" ]]; then rm -f "$DEV_VARS"; fi
  if [[ -n "$BACKUP" && -f "$BACKUP" ]]; then mv "$BACKUP" "$DEV_VARS"; fi
  if [[ -n "${SMOKE_DISPATCH_LOG:-}" ]]; then cp "$LOG" "$SMOKE_DISPATCH_LOG" 2>/dev/null || true; fi
  if (( FAILURES > 0 )); then
    mkdir -p "${TMPDIR:-/tmp}/smoke-dispatch-logs"
    cp "$LOG" "${TMPDIR:-/tmp}/smoke-dispatch-logs/worker.log" 2>/dev/null || true
    echo "logs kept in ${TMPDIR:-/tmp}/smoke-dispatch-logs" >&2
  fi
  rm -rf "$TMP"
}
trap stop EXIT

pass() { printf 'ok    %s\n' "$1"; PASSES=$((PASSES + 1)); }
fail() { printf 'FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }

if [[ -e "$DEV_VARS" ]]; then
  if [[ -z "${SMOKE_DISPATCH_OVERWRITE:-}" ]]; then
    echo "workers/api/.dev.vars exists; this script would replace it. Move it aside, or set SMOKE_DISPATCH_OVERWRITE=1 to have it moved and restored." >&2
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
# Idempotency-Key on POST (or $KEY, which a PATCH sends too), the visitor's cookies and a
# CF-Connecting-IP.
command_as() {
  local name="$1" jar_name="$2" ip="$3" method="$4" path="$5" body="${6:-}"
  local args=(-X "$method" -H "Origin: $STOREFRONT" -H "CF-Connecting-IP: $ip")
  if [[ "$method" == POST ]]; then args+=(-H "Idempotency-Key: ${KEY:-$(ulid)}"); fi
  if [[ "$method" == PATCH && -n "${KEY:-}" ]]; then args+=(-H "Idempotency-Key: $KEY"); fi
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

log_has() { grep -qF -- "$1" "$LOG"; }

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
# ---------- the fake Stripe ----------
stripe_call() {
  local name="$1" method="$2" path="$3" form="${4:-}"
  local args=(-X "$method" -H "Authorization: Bearer $STRIPE_KEY")
  if [[ -n "$form" ]]; then args+=(-H 'Content-Type: application/x-www-form-urlencoded' --data "$form"); fi
  request "$name" "${args[@]}" "$STRIPE$path"
}
intent_of() { json_field "$1" "b.client_secret.split('_secret_')[0]"; }
write_dev_vars() {
  {
    echo "# Written by scripts/smoke-dispatch.sh for one run; removed when it ends. Never committed."
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
    echo "SANDBOX_SEED=$SEED"
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


# The bakery's calendar, in Node: America/Denver through Intl, closed Mondays (docs/domain.md,
# "Money and time"). Business days are open days counted from the day after (crates/domain,
# catering.rs).
CAL='
const TZ = "America/Denver";
const parts = (ms) => { const o = {}; for (const p of new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms))) o[p.type] = p.value; return o; };
const day = (ms) => { const p = parts(ms); return `${p.year}-${p.month}-${p.day}`; };
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const isMon = (d) => new Date(d + "T12:00:00Z").getUTCDay() === 1;
const nthOpen = (d, n) => { let x = d; while (n > 0) { x = addDays(x, 1); if (!isMon(x)) n--; } return x; };
const between = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400000);
'
cal() { local expr="$1"; shift; node -e "$CAL; const a = process.argv.slice(1); const v = ($expr); process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v))" "$@" 2>/dev/null || true; }


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

# The bakery's calendar, in Node: America/Denver through Intl, closed Mondays (docs/domain.md,
# "Money and time").
CAL='
const TZ = "America/Denver";
const parts = (ms) => { const o = {}; for (const p of new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms))) o[p.type] = p.value; return o; };
const day = (ms) => { const p = parts(ms); return `${p.year}-${p.month}-${p.day}`; };
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const isMon = (d) => new Date(d + "T12:00:00Z").getUTCDay() === 1;
const nthOpen = (d, n) => { let x = d; while (n > 0) { x = addDays(x, 1); if (!isMon(x)) n--; } return x; };
'
cal() { local expr="$1"; shift; node -e "$CAL; const a = process.argv.slice(1); const v = ($expr); process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v))" "$@" 2>/dev/null || true; }

# ---------- dispatch helpers ----------

MATRIX="$ROOT/crates/seed/data/salt-lake-city/matrix.json"
WS="ws://127.0.0.1:${PORT}"

# sql_count CLASS NAME SQL: the `n` of a `SELECT count(*) AS n` against one object's file.
sql_count() {
  local out
  out="$(object_sql "$1" "$2" "$3" 2>/dev/null)" || out='[]'
  node -e "const r = JSON.parse(process.argv[1] || '[]'); process.stdout.write(String(r.length ? r[0].n : -1))" "$out" 2>/dev/null || echo -1
}
# signup NAME JAR IP: a demo account and its sandbox. Sets SID.
signup() {
  command_as "signup_$1" "$2" "$3" POST /v1/auth/demo "{\"password\":\"$CANARY\",\"turnstile_token\":\"pass-1\"}"
  command_as "sandbox_$1" "$2" "$3" POST /v1/sandboxes '{"replace":false}'
  SID="$(json_field "sandbox_$1" b.id)"
}

# until_json NAME JAR PATH EXPR [TRIES]: polls GET PATH until EXPR holds over it (`b`), 0.2 s apart.
until_json() {
  local name="$1" jar_name="$2" path="$3" expr="$4" tries="${5:-75}"
  for _ in $(seq 1 "$tries"); do
    get_as "$name" "$jar_name" "$path"
    if node -e "const b = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); if (!($expr)) process.exit(1)" "$TMP/$name.body" 2>/dev/null; then return 0; fi
    sleep 0.2
  done
  return 1
}

# delivery_order MENU_NAME DATE QTY: a delivery at DATE's 09:00 window, naming no zone (the server
# derives the persona's, roadmap R69), QTY of one
# item baked that weekday, never pickup-only or seasonal, with a lead time inside 2 hours.
delivery_order() {
  node -e "
    const menu = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const date = process.argv[2], qty = Number(process.argv[3]);
    const wd = ['sun','mon','tue','wed','thu','fri','sat'][new Date(date + 'T12:00:00Z').getUTCDay()];
    const offset = (() => { const ms = Date.parse(date + 'T16:00:00Z'); const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms))) p[x.type] = x.value; const h = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - ms) / 3600000); return (h < 0 ? '-' : '+') + String(Math.abs(h)).padStart(2, '0') + ':00'; })();
    for (const c of menu.categories) for (const i of c.items) {
      if (i.status !== 'available' || i.pickup_only || i.season || !i.days_baked.includes(wd)) continue;
      const v = i.variants.find((v) => v.lead_minutes <= 120);
      if (!v) continue;
      console.log(JSON.stringify({ kind: 'delivery', slot: date + 'T09:00:00' + offset, lines: [{ variant: v.slug, qty }] }));
      process.exit(0);
    }
    process.exit(1);" "$TMP/$1.body" "$2" "$3"
}

# minutes_of BODY_NAME PLAN: every van of the response's PLAN (`proposed`, `submitted` or
# `published`) recomputed from the committed matrix: the bakery to each stop's place in turn and
# back. Prints "ok" when each van's minutes and the total agree with the API's.
minutes_of() {
  node -e "
    const m = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const b = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
    const plan = b[process.argv[3]];
    const place = Object.fromEntries(b.stops.map((s) => [s.order, s.place]));
    const route = (stops) => { let at = m.depot, t = 0; for (const p of [...stops.map((o) => place[o]), m.depot]) { t += m.minutes[at][p]; at = p; } return stops.length ? t : 0; };
    const vans = plan.vans.map((v) => route(v.stops));
    const ok = plan.vans.every((v, i) => v.minutes === vans[i]) && plan.minutes === vans.reduce((a, x) => a + x, 0);
    process.stdout.write(ok ? 'ok' : 'got ' + JSON.stringify(plan.vans.map((v) => v.minutes)) + ' ' + plan.minutes + ', the matrix gives ' + JSON.stringify(vans));" "$MATRIX" "$TMP/$1.body" "$2"
}

# last_back_of BODY_NAME PLAN: the vans' day of the response's PLAN worked out from the committed
# matrix: they leave at 09:00, start serving a stop when they reach it or when its window opens,
# whichever is later, spend 3 minutes there and drive on. Prints "ok" when the plan's `last_back`
# is the latest van's return and every stop is served by its window's close (120 minutes after
# its start).
last_back_of() {
  node -e "
    const m = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const b = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
    const plan = b[process.argv[3]];
    const stop = Object.fromEntries(b.stops.map((s) => [s.order, s]));
    const dep = Date.parse(b.date + 'T09:00:00' + b.stops[0].window.slice(19));
    let latest = 0, late = [];
    for (const v of plan.vans) {
      let t = 0, at = m.depot;
      for (const o of v.stops) {
        const s = stop[o], open = (Date.parse(s.window) - dep) / 60000;
        const start = Math.max(t + m.minutes[at][s.place], open);
        if (start > open + 120) late.push(o);
        t = start + 3; at = s.place;
      }
      if (v.stops.length) latest = Math.max(latest, t + m.minutes[at][m.depot]);
    }
    const ok = late.length === 0 && Date.parse(plan.last_back) === dep + latest * 60000;
    process.stdout.write(ok ? 'ok' : 'late ' + JSON.stringify(late) + ', last_back ' + plan.last_back + ', the matrix gives ' + new Date(dep + latest * 60000).toISOString());" "$MATRIX" "$TMP/$1.body" "$2"
}

# dispatch_post NAME JAR IP DATE STEP JSON: a staff command on a day of sandbox $SANDBOX.
dispatch_post() { command_as "$1" "$2" "$3" POST "/v1/sandboxes/$SANDBOX/dispatch/$4/$5" "$6"; }
expect_rule() {
  expect_problem "$1" "$2" dispatch
  expect_json "$1" "new RegExp('(^|[^a-z-])$3(\$|[^a-z-])').test(b.detail)"
}

# ---------- a seed with at least two open deliveries today, one of them paid ----------

TODAY="$(cal 'day(Date.now())')"
echo "picking a seed whose sandbox born $TODAY has two open delivery orders, one paid"
SEED=""
(cd "$ROOT" && cargo build -q --locked -p bakery-seed) || { echo "cannot build the seed generator" >&2; exit 1; }
for s in $(seq 1 80); do
  if (cd "$ROOT" && cargo run -q --locked -p bakery-seed -- "$s" "$TODAY" 2>/dev/null) > "$TMP/seed.json" && node -e "
    const g = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const d = g.open_orders.filter((o) => o.kind === 'delivery');
    process.exit(d.length >= 2 && d.some((o) => o.state !== 'placed') ? 0 : 1);" "$TMP/seed.json" 2>/dev/null; then SEED="$s"; break; fi
done
if [[ -z "$SEED" ]]; then echo "no seed from 1 to 80 fits today" >&2; exit 1; fi
SEEDED_DAY="$(node -e "const g = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); process.stdout.write(g.open_orders.find((o) => o.kind === 'delivery').slot_start.slice(0, 10))" "$TMP/seed.json")"
echo "seed $SEED; its deliveries are on $SEEDED_DAY"

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

CANARY="$(random_text 24)"
command_as guest G 192.0.2.91 POST /v1/sandboxes '{"turnstile_token":"pass-1","replace":false}'
expect_status guest 201
GID="$(json_field guest b.id)"
signup a D 192.0.2.92
expect_status sandbox_a 201
AID="$SID"
SANDBOX="$AID"
check "guest: seeding reaches live" "wait_live guest_live G '$GID'"
expect_json guest_live "b.state === 'live' && b.children >= 37 && b.seed === $SEED"
check "a: seeding reaches live" "wait_live a_live D '$AID'"
expect_json a_live "b.children >= 37 && b.seed === $SEED"
# The seed as sandbox a holds it: its open orders placed and paid before its birth, and an order
# only placed whose slot was too near paid instead (Generated::born_at).
BORN_A="$(json_field a_live b.born)"
(cd "$ROOT" && cargo run -q --locked -p bakery-seed -- "$SEED" "$TODAY" "$BORN_A") > "$TMP/seed.json"
check "the seed as born at $BORN_A: nothing placed or paid after it, nothing pending at a slot under 15 minutes away" "node -e \"
  const g = JSON.parse(require('fs').readFileSync('$TMP/seed.json', 'utf8'));
  const born = Date.parse('$BORN_A');
  process.exit(g.open_orders.every((o) => Date.parse(o.placed_at) < born && (o.state !== 'placed' || Date.parse(o.slot_start) - born >= 15 * 60000)) ? 0 : 1);\""
check "the Dispatch was seeded with the rest (sandbox_seeded with 37 children, the Recorder's since 2026-11-09)" "log_has '\"event\":\"sandbox_seeded\",\"children\":37'"

# ---------- today's seeded day ----------

get_as a_today D "/v1/sandboxes/$AID/dispatch/$SEEDED_DAY"
expect_status a_today 200
check "today's stops are the seed's open delivery orders, provisional exactly while unpaid" "node -e \"
  const g = JSON.parse(require('fs').readFileSync('$TMP/seed.json', 'utf8'));
  const b = JSON.parse(require('fs').readFileSync('$TMP/a_today.body', 'utf8'));
  const m = JSON.parse(require('fs').readFileSync('$MATRIX', 'utf8'));
  const want = g.open_orders.filter((o) => o.kind === 'delivery');
  const place = (c) => Number(g.customers.find((x) => x.id === c).place.slice(1)) - 1;
  const units = (o) => o.lines.reduce((n, l) => n + l.qty, 0);
  const ok = b.date === '$SEEDED_DAY' && b.stops.length === want.length && want.every((o) => {
    const s = b.stops.find((s) => s.order === o.id);
    return s && s.customer === o.customer && s.place === place(o.customer) && s.place_label === m.places[s.place].label
      && s.units === units(o) && s.window === o.slot_start && s.zone === o.zone
      && s.status === (o.state === 'placed' ? 'provisional' : 'confirmed') && s.stop === null && s.van === null;
  });
  process.exit(ok ? 0 : 1);\""
expect_json a_today "b.proposed !== null && b.proposed.source === 'server' && b.proposed.unassigned.length === 0 && b.published === null && b.submitted === null && b.plan_v === 0 && b.comparison === null"
expect_json a_today "b.capacity === 250 && b.vans === (new Date('$SEEDED_DAY' + 'T12:00:00Z').getUTCDay() === 6 ? 4 : 1)"
expect_json a_today "(() => { const z = new Map(); return b.stops.every((s) => (z.has(s.place) ? z.get(s.place) === s.zone : (z.set(s.place, s.zone), true))); })()"
SHARED="$(node -e "const g = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); const by = new Map(); for (const c of g.customers) by.set(c.place, [...(by.get(c.place) || []), c.home_zone]); const shared = [...by.values()].filter((z) => z.length > 1); process.stdout.write(shared.every((z) => new Set(z).size === 1) ? String(shared.length) : 'split')" "$TMP/seed.json")"
check "one place, one zone in the seed: every persona at a place has its zone ($SHARED places hold two or more personas)" "[[ '$SHARED' =~ ^[0-9]+$ ]]"
check "the seeded proposal carries every confirmed stop once" "node -e \"
  const b = JSON.parse(require('fs').readFileSync('$TMP/a_today.body', 'utf8'));
  const planned = b.proposed.vans.flatMap((v) => v.stops);
  const confirmed = b.stops.filter((s) => s.status === 'confirmed').map((s) => s.order).sort();
  process.exit(JSON.stringify([...planned].sort()) === JSON.stringify(confirmed) && new Set(planned).size === planned.length ? 0 : 1);\""
M="$(minutes_of a_today proposed)"
check "the seeded proposal's minutes are the matrix's ($M)" "[[ '$M' == ok ]]"
W="$(last_back_of a_today proposed)"
check "the seeded proposal reaches every stop in its window, and its last_back counts the waits ($W)" "[[ '$W' == ok ]]"
get_as g_today G "/v1/sandboxes/$GID/dispatch/$SEEDED_DAY"
expect_status g_today 200
expect_json g_today "b.stops.length >= 2"

# ---------- the day's refusals before anything is planned ----------

# The script's days come after the seeded day, not after today: on a Monday, when the bakery is
# closed, the seed puts its open orders on Tuesday, and the first open day after today is that
# same Tuesday, whose seeded stops would then share the vans with the script's own.
DAY="$(cal 'nthOpen(a[0], 1)' "$SEEDED_DAY")"
EMPTY="$(cal 'nthOpen(a[0], 2)' "$SEEDED_DAY")"
FAR="$(cal 'addDays(day(Date.now()), 40)')"
echo "orders go to $DAY; $EMPTY stays empty"
get_as a_far D "/v1/sandboxes/$AID/dispatch/$FAR"
expect_problem a_far 404 no-such-day
get_as a_bad_day D "/v1/sandboxes/$AID/dispatch/someday"
expect_problem a_bad_day 404 no-such-day
get_as cross G "/v1/sandboxes/$AID/dispatch/$DAY"
expect_status cross 404
get_as a_empty D "/v1/sandboxes/$AID/dispatch/$EMPTY"
expect_status a_empty 200
expect_json a_empty "b.date === '$EMPTY' && b.stops.length === 0 && b.proposed === null && b.vans === 4 && b.capacity === 250"
dispatch_post e_propose D 192.0.2.92 "$EMPTY" propose '{"vans":2,"capacity":250}'
expect_rule e_propose 422 no-stops
dispatch_post e_publish D 192.0.2.92 "$EMPTY" publish '{"plan":"proposed"}'
expect_rule e_publish 409 no-plan
dispatch_post e_complete D 192.0.2.92 "$EMPTY" complete '{"stop":1}'
expect_rule e_complete 409 no-plan
dispatch_post e_vans D 192.0.2.92 "$EMPTY" propose '{"vans":5,"capacity":250}'
expect_rule e_vans 422 vans
dispatch_post e_capacity D 192.0.2.92 "$EMPTY" propose '{"vans":2,"capacity":0}'
expect_rule e_capacity 422 capacity
dispatch_post e_body D 192.0.2.92 "$EMPTY" propose '{"vans":"two"}'
expect_problem e_body 400 body

# ---------- the guest reads, and is refused every staff command ----------

for step in "propose:{\"vans\":1,\"capacity\":250}" "plan:{\"vans\":[]}" "publish:{\"plan\":\"proposed\"}" "complete:{\"stop\":1}"; do
  command_as "g_${step%%:*}" G 192.0.2.91 POST "/v1/sandboxes/$GID/dispatch/$SEEDED_DAY/${step%%:*}" "${step#*:}"
  expect_problem "g_${step%%:*}" 403 guest-scope
done

# ---------- three delivery orders for $DAY: two paid, one left to expire ----------

get_as a_menu D "/v1/sandboxes/$AID/menu"
# A delivery's zone is the persona's place's (roadmap R69, 2026-11-10): the sandbox says which, the
# seed agrees, and an order that names another zone is refused with the rule and holds nothing.
PZONE="$(json_field a_live b.persona_zone)"
check "the sandbox names the persona's zone, $PZONE, the seed's home zone for their place" "node -e \"const g = JSON.parse(require('fs').readFileSync('$TMP/seed.json', 'utf8')); const c = g.customers.find((c) => c.id === '$(json_field a_live b.persona)'); process.exit(c && c.home_zone === '$PZONE' && /^z[123]\$/.test('$PZONE') ? 0 : 1)\""
OTHER_ZONE="$( [[ "$PZONE" == z1 ]] && echo z2 || echo z1 )"
WRONG="$(delivery_order a_menu "$DAY" 1 | node -e "const b = JSON.parse(require('fs').readFileSync(0, 'utf8')); b.zone = process.argv[1]; process.stdout.write(JSON.stringify(b))" "$OTHER_ZONE")" || WRONG='{}'
command_as a_wrong_zone D 192.0.2.92 POST "/v1/sandboxes/$AID/orders" "$WRONG"
expect_problem a_wrong_zone 422 order
expect_json a_wrong_zone "b.detail.includes('The rule is wrong-zone.')"
ORDER_A="$(delivery_order a_menu "$DAY" 3)" || { fail "no item fits a delivery on $DAY"; ORDER_A='{}'; }
ORDER_B="$(delivery_order a_menu "$DAY" 4)" || ORDER_B='{}'
ORDER_C="$(delivery_order a_menu "$DAY" 2)" || ORDER_C='{}'
command_as a_place_a D 192.0.2.92 POST "/v1/sandboxes/$AID/orders" "$ORDER_A"
expect_status a_place_a 201
OA="$(json_field a_place_a b.id)"
command_as a_place_b D 192.0.2.92 POST "/v1/sandboxes/$AID/orders" "$ORDER_B"
expect_status a_place_b 201
OB="$(json_field a_place_b b.id)"
command_as a_place_c D 192.0.2.92 POST "/v1/sandboxes/$AID/orders" "$ORDER_C"
expect_status a_place_c 201
OC="$(json_field a_place_c b.id)"
check "the three orders are stops of $DAY, provisional" "until_json a_prov D '/v1/sandboxes/$AID/dispatch/$DAY' \"['$OA', '$OB', '$OC'].every((o) => b.stops.some((s) => s.order === o && s.status === 'provisional' && s.zone === '$PZONE' && s.window.startsWith('$DAY' + 'T09:00:00')))\""
expect_json a_prov "b.stops.find((s) => s.order === '$OA').units === 3 && b.stops.find((s) => s.order === '$OB').units === 4"
PERSONA="$(json_field a_live b.persona)"
PLACE="$(node -e "const g = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); process.stdout.write(String(Number(g.customers.find((c) => c.id === process.argv[2]).place.slice(1)) - 1))" "$TMP/seed.json" "$PERSONA")"
expect_json a_prov "b.stops.filter((s) => s.customer === '$PERSONA').every((s) => s.place === $PLACE)"
expect_json a_prov "(() => { const z = new Map(); return b.stops.every((s) => (z.has(s.place) ? z.get(s.place) === s.zone : (z.set(s.place, s.zone), true))); })()"
check "one place, one zone: $(json_field a_prov "new Set(b.stops.map((s) => s.place)).size") places among $(json_field a_prov "b.stops.length") stops of $DAY, each in one zone" "true"
for o in A B; do
  oid="O$o"; oid="${!oid}"
  KEY="$oid" command_as "a_pay_$o" D 192.0.2.92 POST "/v1/sandboxes/$AID/orders/$oid/payment"
  expect_status "a_pay_$o" 200
  stripe_call "a_confirm_$o" POST "/v1/payment_intents/$(intent_of "a_pay_$o")/confirm" "payment_method=pm_card_visa"
  expect_json "a_confirm_$o" "b.status === 'succeeded'"
done
check "paid, A and B are confirmed stops; C stays provisional" "until_json a_conf D '/v1/sandboxes/$AID/dispatch/$DAY' \"b.stops.find((s) => s.order === '$OA').status === 'confirmed' && b.stops.find((s) => s.order === '$OB').status === 'confirmed' && b.stops.find((s) => s.order === '$OC').status === 'provisional'\""

# ---------- propose: 2 vans of 5 units, so neither pair fits one van ----------

dispatch_post propose D 192.0.2.92 "$DAY" propose '{"vans":2,"capacity":5}'
expect_status propose 200
expect_json propose "b.vans === 2 && b.capacity === 5 && b.proposed.source === 'server' && b.proposed.plan_v === 1 && b.proposed.unassigned.length === 0"
expect_json propose "(() => { const all = b.proposed.vans.flatMap((v) => v.stops); const conf = b.stops.filter((s) => s.status === 'confirmed').map((s) => s.order); return all.length === conf.length && new Set(all).size === all.length && conf.every((o) => all.includes(o)); })()"
expect_json propose "b.proposed.vans.length === 2 && b.proposed.vans.every((v) => v.units <= 5 && v.van >= 1 && v.van <= 2)"
M="$(minutes_of propose proposed)"
check "the proposal's minutes are the matrix's ($M)" "[[ '$M' == ok ]]"
W="$(last_back_of propose proposed)"
check "the proposal reaches every stop in its window, and its last_back counts the waits ($W)" "[[ '$W' == ok ]]"

# ---------- the browser's plan, as the page sends it, and tampered ones ----------

# The page's plan: the proposal's routes with the vans swapped, each from and to the bakery.
PLAN="$(json_field propose "JSON.stringify({ vans: b.proposed.vans.map((v) => ({ van: 3 - v.van, stops: v.stops, start: 0, end: 0 })) })")"
FIRST="$(json_field propose "b.proposed.vans[0].stops[0]")"
SECOND="$(json_field propose "b.proposed.vans[1].stops[0]")"
dispatch_post t_twice D 192.0.2.92 "$DAY" plan "{\"vans\":[{\"van\":1,\"stops\":[\"$FIRST\",\"$FIRST\"]},{\"van\":2,\"stops\":[\"$SECOND\"]}]}"
expect_rule t_twice 422 stop-twice
dispatch_post t_capacity D 192.0.2.92 "$DAY" plan "{\"vans\":[{\"van\":1,\"stops\":[\"$FIRST\",\"$SECOND\"],\"start\":0,\"end\":0}]}"
expect_rule t_capacity 422 over-capacity
dispatch_post t_ends D 192.0.2.92 "$DAY" plan "{\"vans\":[{\"van\":1,\"stops\":[\"$FIRST\"],\"start\":0,\"end\":5},{\"van\":2,\"stops\":[\"$SECOND\"]}]}"
expect_rule t_ends 422 route-ends
dispatch_post t_missing D 192.0.2.92 "$DAY" plan "{\"vans\":[{\"van\":1,\"stops\":[\"$FIRST\"]}]}"
expect_rule t_missing 422 stop-missing
dispatch_post t_vans D 192.0.2.92 "$DAY" plan "{\"vans\":[{\"van\":1,\"stops\":[\"$FIRST\"]},{\"van\":3,\"stops\":[\"$SECOND\"]}]}"
expect_rule t_vans 422 vans
dispatch_post t_unknown D 192.0.2.92 "$DAY" plan "{\"vans\":[{\"van\":1,\"stops\":[\"$FIRST\"]},{\"van\":2,\"stops\":[\"$SECOND\",\"$OC\"]}]}"
expect_rule t_unknown 422 stop-unknown
dispatch_post t_label D 192.0.2.92 "$DAY" plan '{"vans":[{"van":1,"stops":["p17"]}]}'
expect_rule t_label 422 stop-unknown
dispatch_post t_total D 192.0.2.92 "$DAY" plan "{\"vans\":[{\"van\":1,\"stops\":[\"$FIRST\"]},{\"van\":2,\"stops\":[\"$SECOND\"]}],\"minutes\":1}"
expect_problem t_total 400 body
get_as a_after_tamper D "/v1/sandboxes/$AID/dispatch/$DAY"
expect_json a_after_tamper "b.submitted === null && b.comparison === null"

K_PLAN="$(ulid)"
KEY="$K_PLAN" dispatch_post plan D 192.0.2.92 "$DAY" plan "$PLAN"
expect_status plan 200
expect_json plan "b.submitted.source === 'browser' && b.submitted.vans.length === 2 && b.submitted.unassigned.length === 0"
M="$(minutes_of plan submitted)"
check "the browser's plan's minutes are the matrix's, not the page's ($M)" "[[ '$M' == ok ]]"
expect_json plan "b.comparison !== null && b.comparison.server_minutes === b.proposed.minutes && b.comparison.browser_minutes === b.submitted.minutes && b.comparison.gap_percent === 0"
KEY="$K_PLAN" dispatch_post plan_reused D 192.0.2.92 "$DAY" plan "{\"vans\":[{\"van\":1,\"stops\":[\"$FIRST\"]},{\"van\":2,\"stops\":[\"$SECOND\"]}]}"
expect_problem plan_reused 422 idempotency-key

# ---------- ready on the kitchen socket, then publish twice with one key ----------

probe_args() {
  PROBE=("$ROOT/scripts/ws-probe.mjs" --url "$WS/v1/sandboxes/$2/kitchen/ws" --jar "$TMP/$1.jar" --origin "$STOREFRONT")
}
probe_args D "$AID"
node "${PROBE[@]}" --cmd "$(ulid):$OA:start_production" --cmd "$(ulid):$OA:mark_ready" \
  --cmd "$(ulid):$OB:start_production" --cmd "$(ulid):$OB:mark_ready" --wait-evt OrderReady:2 --timeout 20 > "$TMP/ws_ready.out" 2>&1 || true
check "A is ready" "until_json a_ready_a D '/v1/sandboxes/$AID/orders/$OA' \"b.status === 'ready'\""
check "B is ready" "until_json a_ready_b D '/v1/sandboxes/$AID/orders/$OB' \"b.status === 'ready'\""

K_PUB="$(ulid)"
KEY="$K_PUB" dispatch_post publish D 192.0.2.92 "$DAY" publish '{"plan":"submitted"}'
expect_status publish 200
expect_json publish "b.plan_v === 1 && b.published.plan_v === 1 && b.published.source === 'browser' && b.published.vans.length === 2"
expect_json publish "b.stops.filter((s) => s.status === 'confirmed').every((s) => [1, 2].includes(s.stop) && [1, 2].includes(s.van)) && b.stops.find((s) => s.order === '$OC').stop === null"
KEY="$K_PUB" dispatch_post publish_again D 192.0.2.92 "$DAY" publish '{"plan":"submitted"}'
expect_status publish_again 200
expect_header publish_again idempotent-replayed true
expect_json publish_again "b.plan_v === 1"
check "one RoutePublished in the Dispatch's log" "(( $(sql_count Dispatch "dispatch:$AID:$DAY" "SELECT count(*) AS n FROM events WHERE type = 'RoutePublished'") == 1 ))"
check "and one key remembered for it" "(( $(sql_count Dispatch "dispatch:$AID:$DAY" "SELECT count(*) AS n FROM commands_seen WHERE key = 'publish:$K_PUB'") == 1 ))"
VAN_A="$(json_field publish "'van-' + b.stops.find((s) => s.order === '$OA').van")"
STOP_A="$(json_field publish "b.stops.find((s) => s.order === '$OA').stop")"
VAN_B="$(json_field publish "'van-' + b.stops.find((s) => s.order === '$OB').van")"
STOP_B="$(json_field publish "b.stops.find((s) => s.order === '$OB').stop")"
echo "published: A is $VAN_A stop $STOP_A, B is $VAN_B stop $STOP_B"
check "the two orders ride different vans, van-1 and van-2" "[[ '$VAN_A $VAN_B' == 'van-1 van-2' || '$VAN_A $VAN_B' == 'van-2 van-1' ]]"
check "A goes out for delivery" "until_json a_out_a D '/v1/sandboxes/$AID/orders/$OA' \"b.status === 'out_for_delivery'\""
check "B goes out for delivery" "until_json a_out_b D '/v1/sandboxes/$AID/orders/$OB' \"b.status === 'out_for_delivery'\""
check "A's own log says $VAN_A, stop $STOP_A" "(( $(sql_count Order "order:$AID:$OA" "SELECT count(*) AS n FROM events WHERE type = 'OrderOutForDelivery' AND json_extract(data, '\$.route') = '$VAN_A' AND json_extract(data, '\$.stop') = $STOP_A") == 1 ))"
check "the day's stops show A and B out for delivery, still on their vans" "until_json a_day_out D '/v1/sandboxes/$AID/dispatch/$DAY' \"['$OA', '$OB'].every((o) => { const s = b.stops.find((x) => x.order === o); return s && s.status === 'out_for_delivery' && s.van !== null && s.stop !== null; })\""
check "B's own log says $VAN_B, stop $STOP_B" "(( $(sql_count Order "order:$AID:$OB" "SELECT count(*) AS n FROM events WHERE type = 'OrderOutForDelivery' AND json_extract(data, '\$.route') = '$VAN_B' AND json_extract(data, '\$.stop') = $STOP_B") == 1 ))"
sleep 1
node "${PROBE[@]}" --until snapshot --timeout 15 > "$TMP/ws_board.out" 2>&1 || true
check "the kitchen board's cards show the vans and stop numbers" "node -e \"
  const lines = require('fs').readFileSync('$TMP/ws_board.out', 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const snap = lines.map((l) => l.frame).find((f) => f && f.t === 'snapshot');
  const card = (o) => snap.board.cards.find((c) => c.order === o);
  const ok = card('$OA').van === '$VAN_A' && card('$OA').stop === $STOP_A && card('$OA').state === 'out_for_delivery'
    && card('$OB').van === '$VAN_B' && card('$OB').stop === $STOP_B && card('$OB').state === 'out_for_delivery'
    && (card('$OC') === undefined || card('$OC').van === undefined);
  process.exit(snap && ok ? 0 : 1);\""
check "the on-its-way notices name the stops (the Inbox)" "until_json a_way D '/v1/sandboxes/$AID/inbox?kind=on_its_way&to=$PERSONA' \"['$OA', '$OB'].every((o) => b.messages.some((m) => m.ref === o))\""

# ---------- a van has left: the plan stands; complete a stop ----------

dispatch_post republish D 192.0.2.92 "$DAY" publish '{"plan":"proposed"}'
expect_rule republish 409 published
check "still one RoutePublished" "(( $(sql_count Dispatch "dispatch:$AID:$DAY" "SELECT count(*) AS n FROM events WHERE type = 'RoutePublished'") == 1 ))"
dispatch_post complete_99 D 192.0.2.92 "$DAY" complete '{"stop":99}'
expect_rule complete_99 422 stop-unknown
dispatch_post complete D 192.0.2.92 "$DAY" complete "{\"stop\":$STOP_A}"
expect_status complete 200
expect_json complete "b.stops.find((s) => s.order === '$OA').status === 'completed' && b.stops.find((s) => s.order === '$OB').status === 'out_for_delivery'"
check "A, completed, is delivered" "until_json a_delivered D '/v1/sandboxes/$AID/orders/$OA' \"b.status === 'delivered'\""
dispatch_post complete_again D 192.0.2.92 "$DAY" complete "{\"stop\":$STOP_A}"
expect_status complete_again 200
check "one StopCompleted for it" "(( $(sql_count Dispatch "dispatch:$AID:$DAY" "SELECT count(*) AS n FROM events WHERE type = 'StopCompleted'") == 1 ))"
get_as a_b_still D "/v1/sandboxes/$AID/orders/$OB"
expect_json a_b_still "b.status === 'out_for_delivery'"

# ---------- a stop is completed only once its order is ready ----------

DAY2="$(cal 'nthOpen(a[0], 3)' "$SEEDED_DAY")"
ORDER_E="$(delivery_order a_menu "$DAY2" 2)" || { fail "no item fits a delivery on $DAY2"; ORDER_E='{}'; }
command_as a_place_e D 192.0.2.92 POST "/v1/sandboxes/$AID/orders" "$ORDER_E"
expect_status a_place_e 201
OE="$(json_field a_place_e b.id)"
KEY="$OE" command_as a_pay_E D 192.0.2.92 POST "/v1/sandboxes/$AID/orders/$OE/payment"
expect_status a_pay_E 200
stripe_call a_confirm_E POST "/v1/payment_intents/$(intent_of a_pay_E)/confirm" "payment_method=pm_card_visa"
expect_json a_confirm_E "b.status === 'succeeded'"
check "E is a confirmed stop of $DAY2" "until_json e2_conf D '/v1/sandboxes/$AID/dispatch/$DAY2' \"b.stops.length === 1 && b.stops[0].order === '$OE' && b.stops[0].status === 'confirmed'\""
check "E's order is confirmed, not yet made" "until_json e2_order D '/v1/sandboxes/$AID/orders/$OE' \"b.status === 'confirmed'\""
dispatch_post e2_propose D 192.0.2.92 "$DAY2" propose '{"vans":1,"capacity":250}'
expect_status e2_propose 200
dispatch_post e2_publish D 192.0.2.92 "$DAY2" publish '{"plan":"proposed"}'
expect_status e2_publish 200
expect_json e2_publish "b.published.plan_v === 1 && b.stops[0].stop === 1 && b.stops[0].van === 1"
sleep 2
get_as e2_after_publish D "/v1/sandboxes/$AID/orders/$OE"
expect_json e2_after_publish "b.status === 'confirmed'"
dispatch_post e2_early D 192.0.2.92 "$DAY2" complete '{"stop":1}'
expect_rule e2_early 409 not-ready
get_as e2_day D "/v1/sandboxes/$AID/dispatch/$DAY2"
expect_json e2_day "b.stops[0].status === 'confirmed'"
check "no StopCompleted was written for it" "(( $(sql_count Dispatch "dispatch:$AID:$DAY2" "SELECT count(*) AS n FROM events WHERE type = 'StopCompleted'") == 0 ))"
node "${PROBE[@]}" --until snapshot --timeout 15 > "$TMP/ws_e_before.out" 2>&1 || true
check "the kitchen board shows E confirmed" "node -e \"
  const lines = require('fs').readFileSync('$TMP/ws_e_before.out', 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const snap = lines.map((l) => l.frame).find((f) => f && f.t === 'snapshot');
  const card = snap && snap.board.cards.find((c) => c.order === '$OE');
  process.exit(card && card.state === 'confirmed' ? 0 : 1);\""
node "${PROBE[@]}" --cmd "$(ulid):$OE:start_production" --cmd "$(ulid):$OE:mark_ready" --wait-evt OrderReady:1 --timeout 20 > "$TMP/ws_e_ready.out" 2>&1 || true
check "E, made after the plan was published, goes out for delivery when it is ready" "until_json e2_out D '/v1/sandboxes/$AID/orders/$OE' \"b.status === 'out_for_delivery'\""
check "the day sent E out once: one StopReady, van-1, stop 1" "(( $(sql_count Dispatch "dispatch:$AID:$DAY2" "SELECT count(*) AS n FROM events WHERE type = 'StopReady'") == 1 )) && (( $(sql_count Dispatch "dispatch:$AID:$DAY2" "SELECT count(*) AS n FROM events WHERE type = 'StopReady' AND json_extract(data, '\$.order') = '$OE' AND json_extract(data, '\$.route') = 'van-1' AND json_extract(data, '\$.stop') = 1") == 1 ))"
check "the day's stops show E out for delivery on van 1, stop 1" "until_json e2_day_out D '/v1/sandboxes/$AID/dispatch/$DAY2' \"b.stops[0].order === '$OE' && b.stops[0].status === 'out_for_delivery' && b.stops[0].van === 1 && b.stops[0].stop === 1\""
check "the day marked E's stop out once: one StopDeparted, van-1, stop 1" "(( $(sql_count Dispatch "dispatch:$AID:$DAY2" "SELECT count(*) AS n FROM events WHERE type = 'StopDeparted'") == 1 )) && (( $(sql_count Dispatch "dispatch:$AID:$DAY2" "SELECT count(*) AS n FROM events WHERE type = 'StopDeparted' AND json_extract(data, '\$.order') = '$OE' AND json_extract(data, '\$.route') = 'van-1' AND json_extract(data, '\$.stop') = 1") == 1 ))"
check "E's own log went out on van-1, stop 1, before its stop was completed" "(( $(sql_count Order "order:$AID:$OE" "SELECT count(*) AS n FROM events WHERE type = 'OrderOutForDelivery' AND json_extract(data, '\$.route') = 'van-1' AND json_extract(data, '\$.stop') = 1") == 1 )) && (( $(sql_count Order "order:$AID:$OE" "SELECT count(*) AS n FROM events WHERE type = 'OrderDelivered'") == 0 ))"
sleep 1
node "${PROBE[@]}" --until snapshot --timeout 15 > "$TMP/ws_e_out.out" 2>&1 || true
check "the kitchen board shows E out for delivery on van-1, stop 1" "node -e \"
  const lines = require('fs').readFileSync('$TMP/ws_e_out.out', 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const snap = lines.map((l) => l.frame).find((f) => f && f.t === 'snapshot');
  const card = snap && snap.board.cards.find((c) => c.order === '$OE');
  process.exit(card && card.state === 'out_for_delivery' && card.van === 'van-1' && card.stop === 1 ? 0 : 1);\""
dispatch_post e2_republish D 192.0.2.92 "$DAY2" publish '{"plan":"proposed"}'
expect_rule e2_republish 409 published
dispatch_post e2_complete D 192.0.2.92 "$DAY2" complete '{"stop":1}'
expect_status e2_complete 200
expect_json e2_complete "b.stops[0].status === 'completed'"
check "E, completed, is delivered" "until_json e2_delivered D '/v1/sandboxes/$AID/orders/$OE' \"b.status === 'delivered'\""
check "StopCompleted names E's route, van-1" "(( $(sql_count Dispatch "dispatch:$AID:$DAY2" "SELECT count(*) AS n FROM events WHERE type = 'StopCompleted' AND json_extract(data, '\$.route') = 'van-1'") == 1 ))"
check "E's own log went out for delivery on van-1, stop 1, then was delivered" "(( $(sql_count Order "order:$AID:$OE" "SELECT count(*) AS n FROM events WHERE type = 'OrderOutForDelivery' AND json_extract(data, '\$.route') = 'van-1' AND json_extract(data, '\$.stop') = 1") == 1 )) && (( $(sql_count Order "order:$AID:$OE" "SELECT count(*) AS n FROM events WHERE type = 'OrderDelivered'") == 1 ))"
sleep 1
node "${PROBE[@]}" --until snapshot --timeout 15 > "$TMP/ws_e_after.out" 2>&1 || true
check "the kitchen board no longer shows E waiting" "node -e \"
  const lines = require('fs').readFileSync('$TMP/ws_e_after.out', 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const snap = lines.map((l) => l.frame).find((f) => f && f.t === 'snapshot');
  const card = snap && snap.board.cards.find((c) => c.order === '$OE');
  process.exit(snap && (card === undefined || card.state === 'delivered') ? 0 : 1);\""

# ---------- the unpaid order expires: its stop is removed ----------

command_as clock D 192.0.2.92 POST "/v1/sandboxes/$AID/clock" '{"step":"1h"}'
expect_status clock 200
check "C expires" "until_json a_expired D '/v1/sandboxes/$AID/orders/$OC' \"b.status === 'expired'\""
check "C's stop is removed" "until_json a_removed D '/v1/sandboxes/$AID/dispatch/$DAY' \"b.stops.find((s) => s.order === '$OC').status === 'removed'\""
check "StopRemoved names it expired" "(( $(sql_count Dispatch "dispatch:$AID:$DAY" "SELECT count(*) AS n FROM events WHERE type = 'StopRemoved' AND json_extract(data, '\$.order') = '$OC' AND json_extract(data, '\$.reason') = 'expired'") == 1 ))"
check "the Dispatch consumed the three orders' six events (placed three times, paid twice, expired once)" "(( $(sql_count Dispatch "dispatch:$AID:$DAY" "SELECT count(*) AS n FROM seen") >= 6 ))"

# ---------- the wipe ----------

for s in "G:$GID:192.0.2.91" "D:$AID:192.0.2.92"; do
  IFS=: read -r j sid ip <<<"$s"
  command_as "wipe_$j" "$j" "$ip" DELETE "/v1/sandboxes/$sid"
  expect_status "wipe_$j" 200
done
sleep 1
set +e
node "$ROOT/scripts/list-objects.mjs" "$STATE" > "$TMP/list.out" 2> "$TMP/list.err"
LIST_EXIT=$?
set -e
check "list-objects exits 0 after the wipe, the Dispatch objects included" "(( LIST_EXIT == 0 )) && (( $(grep -c '\"class\":\"Dispatch\"' "$TMP/list.out") >= 4 ))"
check "no alarm_guard was logged" "! log_has '\"event\":\"alarm_guard\"'"
check "no delivery dead-lettered" "! log_has '\"event\":\"dlq\"'"
check "no delivery failed" "! log_has '\"event\":\"delivery_failed\"'"

echo
if (( FAILURES > 0 )); then
  echo "$PASSES passed, $FAILURES failed"
  exit 1
fi
echo "all $PASSES checks passed"
