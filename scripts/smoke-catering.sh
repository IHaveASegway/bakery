#!/usr/bin/env bash
# Smoke-tests PR 7 on `wrangler dev` against the fake providers and scripts/fake-stripe.mjs: the
# catering saga by alarm (docs/architecture.md, "The catering saga"; docs/roadmap.md, PR 7).
#
# - The inquiry: 201 with Location, the same key replayed (200, Idempotent-Replayed); refused
#   with the rule named (422 `catering`): 6 days out (`catering-lead`, naming the earliest
#   date), a headcount of 9 and of 201, and a brief holding an email, a phone number, a card
#   number passing Luhn or a URL, each naming its class and never echoing the brief.
# - The full saga: quote, accept (the day held), the deposit through the fake Stripe (the same
#   intent on a second deposit call; `confirmed` only after the webhook, delivered twice and
#   recorded once), production, delivered, `InvoiceIssued` and `invoiced` with its due date,
#   pay-balance (202), `closed`, and deposit plus balance equal to the quote's total, in the
#   event and in Billing's ledger.
# - The calendar: a third event on a day holding two is 409 `slot-full` at acceptance, and
#   nothing is recorded; 15 business minutes by the clock lapse an accepted quote back to
#   `quoted` and give the place back.
# - Reminders and cancellations: a quoted event's follow-up fires when the clock passes it; a
#   confirmed event cancelled 8 or more days out has its deposit refunded at the fake and in
#   the ledger, one cancelled 3 days out does not, and a cancelled event keeps no timer row.
# - The quote's expiry after 14 business days, by clock advance, on the seed's quoted event (a
#   fresh quote cannot reach it under the clock's 14-day cap), and the seeded accepted event
#   born with a live deposit hold.
# - Guests read and inquire but cannot quote; another sandbox's event is 404.
# - The wipe voids the open invoice and deletes the Stripe customer at the fake, and
#   scripts/list-objects.mjs exits 0.
#
# It prints ok or FAIL per check as scripts/smoke-schedule.sh does, and exits non-zero on any
# failure. A run takes about three minutes.
#
# Usage: scripts/smoke-catering.sh   (from anywhere; needs cargo, worker-build, pnpm, node 22 and curl).
#
# Like scripts/smoke-schedule.sh it writes a throwaway workers/api/.dev.vars, refuses to run when
# one exists unless SMOKE_CATERING_OVERWRITE=1, starts the fake providers (Turnstile) on 8790 and
# the fake Stripe on 8791, and keeps the Worker's log in SMOKE_CATERING_LOG=<file> when set. Every
# key in the .dev.vars is a test-shaped fake, and every brief is synthetic: example.com is
# reserved and 555-01xx numbers are fictional.
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

TMP="$(mktemp -d -t smoke-catering.XXXXXX)"
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
  if [[ -n "${SMOKE_CATERING_LOG:-}" ]]; then cp "$LOG" "$SMOKE_CATERING_LOG" 2>/dev/null || true; fi
  if (( FAILURES > 0 )); then
    mkdir -p "${TMPDIR:-/tmp}/smoke-catering-logs"
    cp "$LOG" "${TMPDIR:-/tmp}/smoke-catering-logs/worker.log" 2>/dev/null || true
    echo "logs kept in ${TMPDIR:-/tmp}/smoke-catering-logs" >&2
  fi
  rm -rf "$TMP"
}
trap stop EXIT

pass() { printf 'ok    %s\n' "$1"; PASSES=$((PASSES + 1)); }
fail() { printf 'FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }

if [[ -e "$DEV_VARS" ]]; then
  if [[ -z "${SMOKE_CATERING_OVERWRITE:-}" ]]; then
    echo "workers/api/.dev.vars exists; this script would replace it. Move it aside, or set SMOKE_CATERING_OVERWRITE=1 to have it moved and restored." >&2
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
    echo "# Written by scripts/smoke-catering.sh for one run; removed when it ends. Never committed."
    echo "SESSION_HMAC_KEY=$(random_text 48)"
    echo "ACCOUNT_HMAC_KEY=$(random_text 48)"
    echo "TURNSTILE_SECRET=1x0000000000000000000000000000000AA"
    echo "TURNSTILE_SITEVERIFY_URL=$FAKE/turnstile/siteverify"
    echo "ALLOWED_ORIGIN=$STOREFRONT"
    echo "API_ORIGIN=$BASE"
    echo "STRIPE_API_BASE=$STRIPE"
    if [[ -n "${KEY_LINE:-}" ]]; then echo "$KEY_LINE"; fi
    echo "STRIPE_WEBHOOK_SECRET=$WEBHOOK_SECRET"
    echo "STRIPE_PUBLISHABLE_KEY=$PUBLISHABLE"
  } > "$DEV_VARS"
  WROTE_DEV_VARS=1
}

if [[ -n "${WRANGLER:-}" ]]; then run_wrangler=(npx --yes "$WRANGLER"); else run_wrangler=(pnpm exec wrangler); fi

# start_worker [PHASE]: a Worker on a state directory of its own and a .dev.vars whose
# STRIPE_SECRET_KEY line is $KEY_LINE (the fake's sandbox key unless the phase sets another, or
# none), then waits for health.
KEY_LINE="STRIPE_SECRET_KEY=$STRIPE_KEY"
start_worker() {
  local phase="${1:-main}"
  write_dev_vars
  STATE="$TMP/state"
  if [[ "$phase" != main ]]; then STATE="$TMP/state-$phase"; fi
  echo "--- starting ${run_wrangler[*]} dev on $BASE ($phase)"
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
  echo "=== $phase: Worker ready" >> "$LOG"
}
stop_worker() { stop_pid "$SERVER_PID"; SERVER_PID=""; }


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

# The sandbox's business today, from its clock offset.
biz_today() { get_as "offset_$1" "$2" "/v1/sandboxes/$1"; cal 'day(Date.now() + Number(a[0]) * 1000)' "$(json_field "offset_$1" b.clock_offset_s)"; }

# inquiry DATE HEADCOUNT [BRIEF]: an inquiry's body, the brief JSON-escaped.
inquiry() {
  node -e "const [date, headcount, brief] = process.argv.slice(1); const b = { date, headcount: Number(headcount), package: 'breakfast-spread', venue: 'v2' }; if (brief) b.brief = brief; process.stdout.write(JSON.stringify(b))" "$@"
}

# catering_until NAME JAR SANDBOX CID EXPR: polls the event until EXPR holds over it, up to 15 s.
catering_until() {
  local name="$1" jar_name="$2" id="$3" cid="$4" expr="$5"
  for _ in $(seq 1 75); do
    get_as "$name" "$jar_name" "/v1/sandboxes/$id/catering/$cid"
    if node -e "const b = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); if (!($expr)) process.exit(1)" "$TMP/$name.body" 2>/dev/null; then return 0; fi
    sleep 0.2
  done
  return 1
}

# sql_count CLASS NAME SQL: the `n` of a `SELECT count(*) AS n` against one object's file.
sql_count() {
  local out
  out="$(object_sql "$1" "$2" "$3" 2>/dev/null)" || out='[]'
  node -e "const r = JSON.parse(process.argv[1] || '[]'); process.stdout.write(String(r.length ? r[0].n : -1))" "$out" 2>/dev/null || echo -1
}
# events_of SANDBOX CID TYPE: how many TYPE events the CateringEvent's log holds.
events_of() { sql_count CateringEvent "catering:$1:$2" "SELECT count(*) AS n FROM events WHERE type = '$3'"; }
# timers_of SANDBOX CID: the saga's timer rows the CateringEvent holds.
timers_of() { sql_count CateringEvent "catering:$1:$2" "SELECT count(*) AS n FROM timers WHERE purpose = 'catering'"; }
# events_until SANDBOX CID TYPE N: polls until the log holds at least N TYPE events, up to 15 s.
events_until() {
  for _ in $(seq 1 75); do
    if (( $(events_of "$1" "$2" "$3") >= $4 )); then return 0; fi
    sleep 0.2
  done
  return 1
}

stripe_config() { request stripe_config -X POST -H 'Content-Type: application/json' --data "$1" "$STRIPE/_config"; }
stripe_events() { request "$1" "$STRIPE/_events"; }
stripe_requests() { request "$1" "$STRIPE/_requests"; }
# stripe_until NAME EXPR: polls the fake's /_events until EXPR holds over it (`b`), up to 10 s.
stripe_until() {
  for _ in $(seq 1 50); do
    stripe_events "$1"
    if node -e "const b = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); if (!($2)) process.exit(1)" "$TMP/$1.body" 2>/dev/null; then return 0; fi
    sleep 0.2
  done
  return 1
}

# pay_deposit NAME JAR IP SANDBOX CID: the deposit step as the storefront runs it (the catering
# id as the key), then the browser's confirm at Stripe with the test card. Sets PI.
pay_deposit() {
  KEY="$5" command_as "$1" "$2" "$3" POST "/v1/sandboxes/$4/catering/$5/deposit"
  PI="$(intent_of "$1")"
  stripe_call "$1_confirm" POST "/v1/payment_intents/$PI/confirm" "payment_method=pm_card_visa"
}

# saga_to NAME JAR IP SANDBOX DATE STATE: a new inquiry on DATE taken to STATE (quoted,
# accepted or confirmed) by its own steps. Sets CID.
saga_to() {
  local name="$1" jar_name="$2" ip="$3" id="$4" date="$5" want="$6"
  command_as "${name}_inq" "$jar_name" "$ip" POST "/v1/sandboxes/$id/catering" "$(inquiry "$date" 40)"
  CID="$(json_field "${name}_inq" b.catering)"
  command_as "${name}_quote" "$jar_name" "$ip" POST "/v1/sandboxes/$id/catering/$CID/quote" '{}'
  if [[ "$want" == quoted ]]; then return 0; fi
  command_as "${name}_accept" "$jar_name" "$ip" POST "/v1/sandboxes/$id/catering/$CID/accept"
  if [[ "$want" == accepted ]]; then return 0; fi
  pay_deposit "${name}_dep" "$jar_name" "$ip" "$id" "$CID"
  catering_until "${name}_confirmed" "$jar_name" "$id" "$CID" "b.state === 'confirmed'" || true
}

# advance_days JAR IP SANDBOX N: N steps of 1d on the sandbox's clock.
advance_days() {
  local n
  for n in $(seq 1 "$4"); do
    command_as "clock_$3_$n" "$1" "$2" POST "/v1/sandboxes/$3/clock" '{"step":"1d"}'
  done
}

# signup NAME JAR IP: a demo account and its sandbox. Sets SID.
signup() {
  command_as "signup_$1" "$2" "$3" POST /v1/auth/demo "{\"password\":\"$CANARY\",\"turnstile_token\":\"pass-1\"}"
  command_as "sandbox_$1" "$2" "$3" POST /v1/sandboxes '{"replace":false}'
  SID="$(json_field "sandbox_$1" b.id)"
}

# refused NAME JAR IP SANDBOX CID PATH BODY STATUS RULE: a command the event's state refuses.
# The answer is the catering problem naming RULE, and the event read after is byte for byte the
# one read before, its log holding as many events as before.
refused() {
  local name="$1" jar_name="$2" ip="$3" id="$4" cid="$5" path="$6" body="$7" status="$8" rule="$9"
  local object="catering:$id:$cid" before after
  get_as "${name}_before" "$jar_name" "/v1/sandboxes/$id/catering/$cid"
  before="$(sql_count CateringEvent "$object" "SELECT count(*) AS n FROM events")"
  command_as "$name" "$jar_name" "$ip" POST "/v1/sandboxes/$id/catering/$cid/$path" "$body"
  expect_problem "$name" "$status" catering
  expect_json "$name" "new RegExp('\\\\b$rule\\\\b').test(b.detail)"
  get_as "${name}_after" "$jar_name" "/v1/sandboxes/$id/catering/$cid"
  after="$(sql_count CateringEvent "$object" "SELECT count(*) AS n FROM events")"
  check "$name: the event, $(json_field "${name}_before" b.state), reads byte for byte as before and its log holds the same $before events" "cmp -s '$TMP/${name}_before.body' '$TMP/${name}_after.body' && (( $before == $after && $before > 0 ))"
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

# ---------- a guest, and two staff sandboxes ----------

CANARY="$(random_text 24)"
command_as guest G 192.0.2.91 POST /v1/sandboxes '{"turnstile_token":"pass-1","replace":false}'
expect_status guest 201
GID="$(json_field guest b.id)"
signup a D 192.0.2.92
expect_status sandbox_a 201
AID="$SID"
signup b E 192.0.2.93
expect_status sandbox_b 201
BID="$SID"
check "guest: seeding reaches live" "wait_live guest_live G '$GID'"
expect_json guest_live "b.state === 'live' && b.children >= 36"
check "a: seeding reaches live" "wait_live a_live D '$AID'"
expect_json a_live "b.children >= 36 && b.kind === 'account'"
check "b: seeding reaches live" "wait_live b_live E '$BID'"

# ---------- the seed's eight events, and a guest's reach ----------

get_as g_list G "/v1/sandboxes/$GID/catering"
expect_status g_list 200
expect_json g_list "b.events.length === 8 && ['inquiry','quoted','accepted','confirmed','invoiced','closed','declined'].every(s => b.events.some(e => e.state === s)) && b.events.every((e, i) => i === 0 || Date.parse(b.events[i - 1].created_at) >= Date.parse(e.created_at))"
G_INQ="$(json_field g_list "b.events.find(e => e.state === 'inquiry').catering")"
command_as g_quote G 192.0.2.91 POST "/v1/sandboxes/$GID/catering/$G_INQ/quote" '{}'
expect_problem g_quote 403 guest-scope
get_as cross D "/v1/sandboxes/$GID/catering/$G_INQ"
expect_status cross 404
get_as cross_a D "/v1/sandboxes/$AID/catering/$G_INQ"
expect_status cross_a 404
get_as g_one G "/v1/sandboxes/$GID/catering/$G_INQ"
expect_json g_one "b.catering === '$G_INQ' && b.state === 'inquiry' && Array.isArray(b.reminders)"

# ---------- the inquiry and its refusals ----------

TODAY_A="$(biz_today "$AID" D)"
EARLIEST="$(cal 'nthOpen(a[0], 7)' "$TODAY_A")"
# Six days out, or five if that is a Monday: an open day inside the lead.
SIX="$(cal 'isMon(addDays(a[0], 6)) ? addDays(a[0], 5) : addDays(a[0], 6)' "$TODAY_A")"
command_as too_soon D 192.0.2.92 POST "/v1/sandboxes/$AID/catering" "$(inquiry "$SIX" 40)"
expect_problem too_soon 422 catering
expect_json too_soon "/\\bcatering-lead\\b/.test(b.detail) && b.detail.includes('$EARLIEST') && b.detail.includes('7 business days')"
for hc in 9 201; do
  command_as "headcount_$hc" D 192.0.2.92 POST "/v1/sandboxes/$AID/catering" "$(inquiry "$EARLIEST" "$hc")"
  expect_problem "headcount_$hc" 422 catering
  expect_json "headcount_$hc" "/\\bheadcount\\b/.test(b.detail)"
done
# A date that is not a day: right in shape but not on the calendar, and not a date at all.
get_as list_before_date D "/v1/sandboxes/$AID/catering"
for bad in 2026-02-30 tomorrow; do
  command_as "date_$bad" D 192.0.2.92 POST "/v1/sandboxes/$AID/catering" "$(inquiry "$bad" 40)"
  expect_problem "date_$bad" 422 catering
  expect_json "date_$bad" "b.detail === 'The date is not a day such as 2026-11-21. The rule is date.' && !b.detail.includes('$bad')"
done
get_as list_after_date D "/v1/sandboxes/$AID/catering"
check "the two refused dates registered no event: the list is as it was" "cmp -s '$TMP/list_before_date.body' '$TMP/list_after_date.body'"
BRIEF_EMAIL="Questions to planner.mx7q@example.com please"
BRIEF_PHONE="Call the venue on 801-555-0142 first"
BRIEF_CARD="Bill card 4242 4242 4242 4242 for it"
BRIEF_URL="Floor plan at https://example.com/plan-q7"
for pair in "brief-email:$BRIEF_EMAIL" "brief-phone:$BRIEF_PHONE" "brief-card-number:$BRIEF_CARD" "brief-url:$BRIEF_URL"; do
  rule="${pair%%:*}"; text="${pair#*:}"
  command_as "$rule" D 192.0.2.92 POST "/v1/sandboxes/$AID/catering" "$(inquiry "$EARLIEST" 40 "$text")"
  expect_problem "$rule" 422 catering
  expect_json "$rule" "new RegExp('\\\\b$rule\\\\b').test(b.detail)"
  check "$rule: the brief is not echoed" "! grep -qF -- '${text:0:18}' '$TMP/$rule.body' && ! grep -qE 'example\\.com|555-0142|4242 4242' '$TMP/$rule.body'"
done
BRIEF_OK="Gluten-free options for six of the guests"
INQ_KEY="$(ulid)"
KEY="$INQ_KEY" command_as inquiry_x D 192.0.2.92 POST "/v1/sandboxes/$AID/catering" "$(inquiry "$EARLIEST" 40 "$BRIEF_OK")"
expect_status inquiry_x 201
X="$(json_field inquiry_x b.catering)"
expect_header inquiry_x location "/v1/sandboxes/$AID/catering/$X"
expect_json inquiry_x "b.state === 'inquiry' && b.date === '$EARLIEST' && b.headcount === 40 && b.brief === '$BRIEF_OK' && b.reminders.length === 0"
KEY="$INQ_KEY" command_as inquiry_x_again D 192.0.2.92 POST "/v1/sandboxes/$AID/catering" "$(inquiry "$EARLIEST" 40 "$BRIEF_OK")"
expect_status inquiry_x_again 200
expect_header inquiry_x_again idempotent-replayed true
expect_json inquiry_x_again "b.catering === '$X'"
KEY="$INQ_KEY" command_as inquiry_x_other D 192.0.2.92 POST "/v1/sandboxes/$AID/catering" "$(inquiry "$EARLIEST" 41 "$BRIEF_OK")"
expect_problem inquiry_x_other 422 idempotency-key

# ---------- the full saga ----------

command_as accept_early D 192.0.2.92 POST "/v1/sandboxes/$AID/catering/$X/accept"
expect_problem accept_early 409 catering
expect_json accept_early "/\\bout-of-order\\b/.test(b.detail)"
command_as quote_x D 192.0.2.92 POST "/v1/sandboxes/$AID/catering/$X/quote" '{}'
expect_status quote_x 200
expect_json quote_x "b.state === 'quoted' && b.total_cents === 58000 && b.deposit_cents === 14500 && b.balance_cents === 43500 && typeof b.valid_until === 'string' && b.reminders.length === 1 && b.reminders[0].kind === 'follow_up'"
TOTAL_X="$(json_field quote_x b.total_cents)"
# The event is 7 open days out, so its production day (the day before) comes before 14 business
# days: the quote is valid until midnight starting it (since the console audit of 2026-11-08).
PROD_X="$(cal 'addDays(a[0], -1)' "$EARLIEST")"
expect_json quote_x "b.valid_until.startsWith('${PROD_X}T00:00:00')"
command_as quote_x_again D 192.0.2.92 POST "/v1/sandboxes/$AID/catering/$X/quote" '{}'
expect_problem quote_x_again 409 catering
command_as deposit_early D 192.0.2.92 POST "/v1/sandboxes/$AID/catering/$X/deposit"
expect_problem deposit_early 409 catering
command_as accept_x D 192.0.2.92 POST "/v1/sandboxes/$AID/catering/$X/accept"
expect_status accept_x 200
expect_json accept_x "b.state === 'accepted'"
check "the day holds the accepted event's place" "schedule_until day_x D '$AID' '$EARLIEST' 'b.catering.taken === 1 && b.catering.capacity === 2'"
KEY="$X" command_as deposit_x D 192.0.2.92 POST "/v1/sandboxes/$AID/catering/$X/deposit"
expect_status deposit_x 200
expect_json deposit_x "b.amount_cents === 14500 && b.client_secret.includes('_secret_') && b.status === 'created'"
KEY="$X" command_as deposit_x_again D 192.0.2.92 POST "/v1/sandboxes/$AID/catering/$X/deposit"
expect_status deposit_x_again 200
check "a second deposit call gets the same intent and payment" "[[ '$(json_field deposit_x b.client_secret)' == '$(json_field deposit_x_again b.client_secret)' && '$(json_field deposit_x b.payment)' == '$(json_field deposit_x_again b.payment)' ]]"
get_as x_before D "/v1/sandboxes/$AID/catering/$X"
expect_json x_before "b.state === 'accepted'"
PI_X="$(intent_of deposit_x)"
stripe_config '{"replay":2}'
stripe_call confirm_x POST "/v1/payment_intents/$PI_X/confirm" "payment_method=pm_card_visa"
expect_status confirm_x 200
check "the deposit's webhook was delivered twice, each answered 200" "stripe_until ev_x \"b.some(e => e.type === 'payment_intent.succeeded' && e.intent === '$PI_X' && e.deliveries.length === 2 && e.deliveries.every(d => d.status === 200))\""
check "the event is confirmed after the webhook" "catering_until x_confirmed D '$AID' '$X' \"b.state === 'confirmed' && b.deposit_payment === '$(json_field deposit_x b.payment)'\""
sleep 1
check "two deliveries, one CateringDepositPaid in the event's log" "(( $(events_of "$AID" "$X" CateringDepositPaid) == 1 ))"
get_as ledger_x D "/v1/sandboxes/$AID/billing/ledger"
expect_json ledger_x "b.entries.filter(e => e.ref === '$X' && e.kind === 'payment' && e.purpose === 'deposit').length === 1"
check "the confirmed day puts 40 breakfast-spread on its bake list" "schedule_until bake_x D '$AID' '$EARLIEST' \"b.catering.taken === 1 && b.bake_list.lines.some(l => l.item === 'breakfast-spread' && l.qty === 40)\""
expect_json x_confirmed "b.reminders.length === 1 && b.reminders[0].kind === 'event_soon'"
# Production is refused before the day before the event, and nothing changes (since the console
# audit of 2026-11-08, which started it 8 days early). The rest of X's saga runs once the clock
# has moved to its days, below.
refused prod_x_early D 192.0.2.92 "$AID" "$X" start-production "" 409 too-early
expect_json prod_x_early "b.detail.includes('$PROD_X')"
command_as pay_early G 192.0.2.91 POST "/v1/sandboxes/$GID/catering/$G_INQ/pay-balance"
expect_problem pay_early 409 catering

# ---------- a full day, and a lapsed hold ----------

saga_to y D 192.0.2.92 "$AID" "$EARLIEST" accepted
Y="$CID"
expect_status y_accept 200
saga_to z D 192.0.2.92 "$AID" "$EARLIEST" quoted
Z="$CID"
command_as z_accept D 192.0.2.92 POST "/v1/sandboxes/$AID/catering/$Z/accept"
expect_problem z_accept 409 slot-full
expect_json z_accept "b.detail.includes('two catering places') && b.detail.includes('slot-full')"
get_as z_after D "/v1/sandboxes/$AID/catering/$Z"
expect_json z_after "b.state === 'quoted'"
check "the refused acceptance recorded nothing" "(( $(events_of "$AID" "$Z" CateringQuoteAccepted) == 0 ))"
command_as clock_15 D 192.0.2.92 POST "/v1/sandboxes/$AID/clock" '{"step":"15m"}'
expect_status clock_15 200
check "15 business minutes lapse the accepted quote back to quoted" "catering_until y_lapsed D '$AID' '$Y' \"b.state === 'quoted'\""
check "CateringDepositLapsed is in its log" "(( $(events_of "$AID" "$Y" CateringDepositLapsed) == 1 ))"
check "and the day's place is released" "schedule_until day_lapse D '$AID' '$EARLIEST' 'b.catering.taken === 1'"
command_as z_accept_again D 192.0.2.92 POST "/v1/sandboxes/$AID/catering/$Z/accept"
expect_status z_accept_again 200

# ---------- an invoice left open for the wipe ----------

TODAY_A2="$(biz_today "$AID" D)"
LATER="$(cal 'nthOpen(a[0], 8)' "$TODAY_A2")"
saga_to w D 192.0.2.92 "$AID" "$LATER" confirmed
W="$CID"
check "w: confirmed" "[[ '$(json_field w_confirmed b.state)' == confirmed ]]"

# ---------- reminders and cancellations, on sandbox b ----------

TODAY_B="$(biz_today "$BID" E)"
EARLY_B="$(cal 'nthOpen(a[0], 7)' "$TODAY_B")"
AHEAD_B="$(cal 'between(a[0], a[1])' "$TODAY_B" "$EARLY_B")"
saga_to r E 192.0.2.93 "$BID" "$EARLY_B" quoted
R="$CID"
expect_json r_quote "b.reminders.length === 1 && b.reminders[0].kind === 'follow_up'"
FOLLOW_UP="$(json_field r_quote "b.reminders[0].at")"
saga_to p E 192.0.2.93 "$BID" "$EARLY_B" confirmed
P="$CID"
PI_P="$PI"
check "p: confirmed" "[[ '$(json_field p_confirmed b.state)' == confirmed ]]"
saga_to q E 192.0.2.93 "$BID" "$EARLY_B" confirmed
Q="$CID"
PI_Q="$PI"
check "q: confirmed" "[[ '$(json_field q_confirmed b.state)' == confirmed ]]"
check "p and q hold the day's two places" "schedule_until day_b E '$BID' '$EARLY_B' 'b.catering.taken === 2'"
check "a confirmed event keeps its event_soon timer row" "(( $(timers_of "$BID" "$P") == 1 ))"
command_as cancel_p E 192.0.2.93 POST "/v1/sandboxes/$BID/catering/$P/cancel" '{"reason":"customer_change"}'
expect_status cancel_p 200
expect_json cancel_p "b.state === 'cancelled' && b.refund_deposit === true && b.reminders.length === 0"
check "cancelled $AHEAD_B days out (more than 7): the deposit refunded at the fake" "stripe_until ev_p \"b.some(e => e.type === 'refund.created' && e.intent === '$PI_P' && e.deliveries.some(d => d.status === 200))\""
check "and in the ledger" "for _ in \$(seq 1 50); do get_as ledger_p E '/v1/sandboxes/$BID/billing/ledger'; node -e \"const b = JSON.parse(require('fs').readFileSync('$TMP/ledger_p.body', 'utf8')); if (!b.entries.some(e => e.ref === '$P' && e.kind === 'refund' && e.purpose === 'deposit' && e.amount_cents === -14500)) process.exit(1)\" 2>/dev/null && break; sleep 0.2; done; node -e \"const b = JSON.parse(require('fs').readFileSync('$TMP/ledger_p.body', 'utf8')); if (!b.entries.some(e => e.ref === '$P' && e.kind === 'refund')) process.exit(1)\""
check "the cancelled event has no timer row left" "(( $(timers_of "$BID" "$P") == 0 ))"
check "and logged timers_cleared" "log_has '\"event\":\"timers_cleared\",\"object\":\"CateringEvent\",\"catering\":\"$P\"'"
check "the day gives p's place back" "schedule_until day_b2 E '$BID' '$EARLY_B' 'b.catering.taken === 1'"
DAYS_B=$(( AHEAD_B - 3 ))
advance_days E 192.0.2.93 "$BID" "$DAYS_B"
expect_status "clock_${BID}_${DAYS_B}" 200
check "the clock passed the follow-up ($FOLLOW_UP): CateringReminderDue { follow_up } in r's log" "events_until '$BID' '$R' CateringReminderDue 1"
check "it names follow_up" "[[ \"\$(object_sql CateringEvent 'catering:$BID:$R' \"SELECT data FROM events WHERE type = 'CateringReminderDue'\")\" == *follow_up* ]]"
get_as r_after E "/v1/sandboxes/$BID/catering/$R"
expect_json r_after "b.state === 'quoted' && !b.reminders.some(x => x.kind === 'follow_up')"
command_as cancel_q E 192.0.2.93 POST "/v1/sandboxes/$BID/catering/$Q/staff-cancel" '{"reason":"venue_lost"}'
expect_status cancel_q 200
expect_json cancel_q "b.state === 'cancelled' && b.refund_deposit === false && b.reminders.length === 0"
sleep 2
stripe_events ev_q
expect_json ev_q "!b.some(e => e.type === 'refund.created' && e.intent === '$PI_Q')"
get_as ledger_q E "/v1/sandboxes/$BID/billing/ledger"
expect_json ledger_q "!b.entries.some(e => e.ref === '$Q' && e.kind === 'refund')"
check "q, cancelled 3 days out, has no timer row left" "(( $(timers_of "$BID" "$Q") == 0 ))"

# ---------- the refusals of the staff steps and a quote's total, on sandbox a ----------

# Each step the event's state refuses is driven here with the event in a state that does not
# take it: Y was lapsed back to quoted above, and the seed's confirmed event has not started
# production; X closed and W invoiced, once the clock has moved below. A refusal changes nothing
# (see `refused`). These run before the clock moves, while Y's quote is still valid.
get_as a_list D "/v1/sandboxes/$AID/catering"
SEED_INQ="$(json_field a_list "b.events.find(e => e.state === 'inquiry').catering")"
SEED_CONF="$(json_field a_list "b.events.find(e => e.state === 'confirmed').catering")"
get_as y_now D "/v1/sandboxes/$AID/catering/$Y"
check "the states the first refusals rely on: Y quoted, a seeded event confirmed and one an inquiry" "[[ '$(json_field y_now b.state)' == quoted && -n '$SEED_CONF' && -n '$SEED_INQ' ]]"
DECLINE='{"reason":"other"}'
CANCEL='{"reason":"other"}'
refused decline_quoted D 192.0.2.92 "$AID" "$Y" decline "$DECLINE" 409 out-of-order
refused production_quoted D 192.0.2.92 "$AID" "$Y" start-production "" 409 out-of-order
refused delivered_confirmed D 192.0.2.92 "$AID" "$SEED_CONF" delivered "" 409 out-of-order
refused delivered_quoted D 192.0.2.92 "$AID" "$Y" delivered "" 409 out-of-order
refused cancel_quoted D 192.0.2.92 "$AID" "$Y" cancel "$CANCEL" 409 out-of-order
refused staff_cancel_quoted D 192.0.2.92 "$AID" "$Y" staff-cancel "$CANCEL" 409 out-of-order
# A quote's total of 0 or less is refused on an event that is still an inquiry (any other state
# is out of order first), naming the rule and nothing else of the request.
for total in 0 -500; do
  refused "quote_total_$total" D 192.0.2.92 "$AID" "$SEED_INQ" quote "{\"total_cents\":$total}" 422 quote-total
  expect_json "quote_total_$total" "b.detail === \"A quote's total is at least 1 cent. The rule is quote-total.\""
done
get_as seed_inq_after D "/v1/sandboxes/$AID/catering/$SEED_INQ"
expect_json seed_inq_after "b.state === 'inquiry' && !b.total_cents"

# ---------- X and W on their own days: production, delivery, the invoice and the balance ----------

# The clock moves to X's production day (the day before the event), where production starts and
# delivery is still refused; then to the event day, where X is delivered, its balance falling due
# 7 days after the event's date; then to W's day, so W is delivered and its invoice left open for
# the wipe. The whole move is under the clock's 14-day cap: W is 8 open days out, 10 days at most.
TODAY_A3="$(biz_today "$AID" D)"
advance_days D 192.0.2.92 "$AID" "$(cal 'between(a[0], a[1])' "$TODAY_A3" "$PROD_X")"
check "a's business day is X's production day, $PROD_X" "[[ '$(biz_today "$AID" D)' == '$PROD_X' ]]"
command_as prod_x D 192.0.2.92 POST "/v1/sandboxes/$AID/catering/$X/start-production"
expect_status prod_x 200
expect_json prod_x "b.state === 'in_production'"
refused delivered_x_early D 192.0.2.92 "$AID" "$X" delivered "" 409 too-early
expect_json delivered_x_early "b.detail.includes('$EARLIEST')"
advance_days D 192.0.2.92 "$AID" 1
command_as delivered_x D 192.0.2.92 POST "/v1/sandboxes/$AID/catering/$X/delivered"
expect_status delivered_x 200
expect_json delivered_x "b.state === 'delivered'"
DUE_X="$(cal 'addDays(a[0], 7)' "$EARLIEST")"
check "InvoiceIssued comes back: invoiced, due $DUE_X" "catering_until x_invoiced D '$AID' '$X' \"b.state === 'invoiced' && typeof b.invoice === 'string' && b.invoice_due === '$DUE_X' && b.reminders.some(r => r.kind === 'invoice_due')\""
check "one CateringBalanceInvoiced in the event's log" "(( $(events_of "$AID" "$X" CateringBalanceInvoiced) == 1 ))"
KEY="$X" command_as pay_x D 192.0.2.92 POST "/v1/sandboxes/$AID/catering/$X/pay-balance"
expect_status pay_x 202
expect_json pay_x "['invoiced', 'paid', 'closed'].includes(b.state)"
check "the balance's invoice.paid closes the event" "catering_until x_closed D '$AID' '$X' \"b.state === 'closed' && b.reminders.length === 0\""
expect_json x_closed "b.deposit_cents + b.balance_cents === b.total_cents && b.total_cents === $TOTAL_X"
get_as ledger_x2 D "/v1/sandboxes/$AID/billing/ledger"
expect_json ledger_x2 "b.entries.filter(e => e.ref === '$X' && e.kind === 'payment').reduce((n, e) => n + e.amount_cents, 0) === $TOTAL_X && b.entries.some(e => e.ref === '$X' && e.purpose === 'balance')"
check "the closed event keeps no timer row" "(( $(timers_of "$AID" "$X") == 0 ))"
check "the closed event's place is fulfilled: still counted" "schedule_until day_x2 D '$AID' '$EARLIEST' 'b.catering.taken === 1'"
advance_days D 192.0.2.92 "$AID" "$(cal 'between(a[0], a[1])' "$EARLIEST" "$LATER")"
command_as w_prod D 192.0.2.92 POST "/v1/sandboxes/$AID/catering/$W/start-production"
command_as w_delivered D 192.0.2.92 POST "/v1/sandboxes/$AID/catering/$W/delivered"
expect_status w_delivered 200
check "w: invoiced" "catering_until w_invoiced D '$AID' '$W' \"b.state === 'invoiced'\""
stripe_requests reqs_w
W_IN="$(json_field reqs_w "b.filter(r => r.method === 'POST' && /^\\/v1\\/invoices\\/[^/]+\\/finalize$/.test(r.path) && r.status === 200).map(r => r.path.split('/')[3]).pop()")"
expect_json reqs_w "b.filter(r => r.method === 'POST' && r.path === '/v1/customers' && r.status === 200).length === 1"
stripe_call w_invoice GET "/v1/invoices/$W_IN"
expect_json w_invoice "b.status === 'open' && b.amount_due === 43500 && b.collection_method === 'send_invoice'"
W_CUS="$(json_field w_invoice b.customer)"
get_as x_now D "/v1/sandboxes/$AID/catering/$X"
get_as w_now D "/v1/sandboxes/$AID/catering/$W"
check "the states the last refusals rely on: X closed, W invoiced" "[[ '$(json_field x_now b.state)' == closed && '$(json_field w_now b.state)' == invoiced ]]"
refused decline_closed D 192.0.2.92 "$AID" "$X" decline "$DECLINE" 409 out-of-order
refused production_closed D 192.0.2.92 "$AID" "$X" start-production "" 409 out-of-order
refused cancel_invoiced D 192.0.2.92 "$AID" "$W" cancel "$CANCEL" 409 out-of-order
refused staff_cancel_closed D 192.0.2.92 "$AID" "$X" staff-cancel "$CANCEL" 409 out-of-order

# ---------- the seed's quote expires after 14 business days ----------

# A fresh quote cannot expire under the clock's 14-day cap (14 business days are 16 or more
# calendar days), so this runs on the seed's quoted event, quoted 1 to 6 days before birth.
# Up to three sandboxes are made, and the first whose quoted and accepted events both expire
# within 14 days is used, so the accepted event's late deposit takes the refund path
# (decision 2 of PR 7); failing that, the first whose quoted event does, where the late deposit
# lands on a quote still valid and confirms.
days_to() { node -e "process.stdout.write(String(Math.ceil((Date.parse(process.argv[1]) - Date.now()) / 86400000)))" "$1"; }
C_SANDBOXES=""
PICK=""
for try in 1 2 3; do
  signup "c$try" "C$try" "192.0.2.9$((3 + try))"
  C_SANDBOXES="$C_SANDBOXES C$try:$SID:192.0.2.9$((3 + try))"
  wait_live "c${try}_live" "C$try" "$SID" || true
  get_as "c${try}_list" "C$try" "/v1/sandboxes/$SID/catering"
  NEED="$(days_to "$(json_field "c${try}_list" "b.events.find(e => e.state === 'quoted').valid_until")")"
  NEED_SA="$(days_to "$(json_field "c${try}_list" "(b.events.find(e => e.state === 'accepted') || {}).valid_until || '9999-01-01T00:00:00Z'")")"
  echo "    (sandbox c$try: the seeded quote expires in $NEED days, the accepted one's in $NEED_SA)"
  if (( NEED <= 14 && NEED_SA <= 14 )); then PICK="$try"; break; fi
  if (( NEED <= 14 )) && [[ -z "$PICK" ]]; then PICK="$try"; fi
done
check "a seeded quote is reachable within the clock's 14 days" "[[ -n '$PICK' ]]"
if [[ -n "$PICK" ]]; then
  J="C$PICK"
  IP_C="192.0.2.9$((3 + PICK))"
  CSB="$(json_field "sandbox_c$PICK" b.id)"
  L="c${PICK}_list"
  SQ="$(json_field "$L" "b.events.find(e => e.state === 'quoted').catering")"
  SA="$(json_field "$L" "b.events.find(e => e.state === 'accepted').catering")"
  VALID="$(json_field "$L" "b.events.find(e => e.state === 'quoted').valid_until")"
  NEED="$(days_to "$VALID")"
  NEED_SA="$(days_to "$(json_field "$L" "b.events.find(e => e.state === 'accepted').valid_until")")"
  ADVANCE="$NEED"
  if (( NEED_SA > ADVANCE && NEED_SA <= 14 )); then ADVANCE="$NEED_SA"; fi
  expect_json "c${PICK}_live" "b.children >= 36"
  expect_json "$L" "b.events.some(e => e.state === 'accepted' && e.deposit_cents > 0)"
  check "the seeded quoted event's follow-up is to come, or fired on the first alarm" "events_until '$CSB' '$SQ' CateringReminderDue 1 || [[ \"\$(json_field $L \"b.events.find(e => e.state === 'quoted').reminders.length\")\" == 1 ]]"
  # The seeded accepted event's deposit intent, asked for while its hold is live (it is born
  # accepted, decision 1 of PR 7) and paid only after the clock has moved.
  KEY="$SA" command_as sa_deposit "$J" "$IP_C" POST "/v1/sandboxes/$CSB/catering/$SA/deposit"
  expect_status sa_deposit 200
  PI_SA="$(intent_of sa_deposit)"
  # One day first: the 15-minute hold lapses, the quote still valid.
  advance_days "$J" "$IP_C" "$CSB" 1
  check "the seeded accepted event lapses back to quoted when the clock moves" "catering_until sa_lapsed $J '$CSB' '$SA' \"b.state === 'quoted'\""
  advance_days "$J" "$IP_C" "$CSB" "$((ADVANCE - 1))"
  check "after $ADVANCE days the seeded quote ($VALID) is expired" "catering_until sq_expired $J '$CSB' '$SQ' \"b.state === 'expired' && b.reminders.length === 0\""
  # A seeded event close enough has its quote capped by its production day (since 2026-11-08).
  check "CateringQuoteExpired names the 14 business days or the day before the event" "[[ \"\$(object_sql CateringEvent 'catering:$CSB:$SQ' \"SELECT data FROM events WHERE type = 'CateringQuoteExpired'\")\" == *'14 business days'* || \"\$(object_sql CateringEvent 'catering:$CSB:$SQ' \"SELECT data FROM events WHERE type = 'CateringQuoteExpired'\")\" == *'the day before the event'* ]]"
  check "the expired event has no timer row left" "(( $(timers_of "$CSB" "$SQ") == 0 ))"
  command_as sq_accept "$J" "$IP_C" POST "/v1/sandboxes/$CSB/catering/$SQ/accept"
  expect_problem sq_accept 409 catering
  expect_json sq_accept "/\\bquote-expired\\b/.test(b.detail)"
  get_as sa_now "$J" "/v1/sandboxes/$CSB/catering/$SA"
  SA_STATE="$(json_field sa_now b.state)"
  stripe_call sa_confirm POST "/v1/payment_intents/$PI_SA/confirm" "payment_method=pm_card_visa"
  expect_status sa_confirm 200
  if [[ "$SA_STATE" == expired ]]; then
    check "a deposit landing after its quote expired is refunded in full at the fake" "stripe_until ev_sa \"b.some(e => e.type === 'refund.created' && e.intent === '$PI_SA')\""
    check "logged deposit_late, and the event stays expired" "log_has '\"event\":\"deposit_late\"' && catering_until sa_late $J '$CSB' '$SA' \"b.state === 'expired'\""
    get_as ledger_sa "$J" "/v1/sandboxes/$CSB/billing/ledger"
    expect_json ledger_sa "b.entries.some(e => e.ref === '$SA' && e.kind === 'refund' && e.purpose === 'deposit')"
  else
    check "a deposit landing after the hold lapsed, its quote still valid, confirms ($SA_STATE)" "catering_until sa_late $J '$CSB' '$SA' \"b.state === 'confirmed'\""
  fi
fi

# ---------- the wipe ----------

for s in "G:$GID:192.0.2.91" "D:$AID:192.0.2.92" "E:$BID:192.0.2.93"; do
  IFS=: read -r j sid ip <<<"$s"
  command_as "wipe_$j" "$j" "$ip" DELETE "/v1/sandboxes/$sid"
  expect_status "wipe_$j" 200
done
for s in $C_SANDBOXES; do
  IFS=: read -r j sid ip <<<"$s"
  command_as "wipe_$j" "$j" "$ip" DELETE "/v1/sandboxes/$sid"
  expect_status "wipe_$j" 200
done
stripe_call w_voided GET "/v1/invoices/$W_IN"
expect_json w_voided "b.status === 'void'"
stripe_requests reqs_wipe
expect_json reqs_wipe "b.some(r => r.method === 'DELETE' && r.path === '/v1/customers/$W_CUS' && r.status === 200)"
check "Billing's wipe logged its Stripe cleanup" "log_has '\"event\":\"stripe_wipe\"' && log_has '\"invoices_voided\":1,\"customers_deleted\":1,\"failed\":0'"
sleep 1
set +e
node "$ROOT/scripts/list-objects.mjs" "$STATE" > "$TMP/list.out" 2> "$TMP/list.err"
LIST_EXIT=$?
set -e
check "list-objects exits 0 after the wipe, the CateringEvents included" "(( LIST_EXIT == 0 )) && grep -q '\"class\":\"CateringEvent\"' '$TMP/list.out'"
check "no alarm_guard was logged" "! log_has '\"event\":\"alarm_guard\"'"
check "no brief's text reached the Worker's log" "! grep -qE 'Gluten-free|example\\.com|555-0142|4242 4242' '$LOG'"

# ---------- a key of the other mode, and no key: the catering payment routes ----------

# Two more Workers, each on a state of its own, with the fake Stripe still up. The guard is the
# first thing `deposit` and `pay-balance` run after the session, so a seeded accepted event and a
# seeded invoiced event are enough: neither moves, and nothing reaches the fake.
# Put together here, so the prefix is in no file: Stripe's secret-key prefix with the mode word
# the bakery never uses (as scripts/smoke-payments.sh does).
MODE="$(printf '%s%s' li ve)"
OTHER_KEY="sk_${MODE}_fake000000000000000000000000"
stripe_phase() {
  local phase="$1" want_type="$2"
  LOG_FROM="$(wc -l < "$LOG")"
  stop_worker
  start_worker "$phase"
  request "health_$phase" "$BASE/v1/health"
  expect_status "health_$phase" 200
  command_as "guest_$phase" "K$phase" 192.0.2.97 POST /v1/sandboxes '{"turnstile_token":"pass-1","replace":false}'
  expect_status "guest_$phase" 201
  local sid; sid="$(json_field "guest_$phase" b.id)"
  check "$phase: seeding reaches live" "wait_live ${phase}_live 'K$phase' '$sid'"
  get_as "${phase}_list" "K$phase" "/v1/sandboxes/$sid/catering"
  expect_status "${phase}_list" 200
  local acc inv
  acc="$(json_field "${phase}_list" "b.events.find(e => e.state === 'accepted').catering")"
  inv="$(json_field "${phase}_list" "b.events.find(e => e.state === 'invoiced').catering")"
  check "$phase: the seed's accepted and invoiced events are there" "[[ -n '$acc' && -n '$inv' ]]"
  get_as "${phase}_acc_before" "K$phase" "/v1/sandboxes/$sid/catering/$acc"
  get_as "${phase}_inv_before" "K$phase" "/v1/sandboxes/$sid/catering/$inv"
  stripe_requests "${phase}_reqs_before"
  KEY="$acc" command_as "deposit_$phase" "K$phase" 192.0.2.97 POST "/v1/sandboxes/$sid/catering/$acc/deposit"
  expect_problem "deposit_$phase" 503 "$want_type"
  KEY="$inv" command_as "balance_$phase" "K$phase" 192.0.2.97 POST "/v1/sandboxes/$sid/catering/$inv/pay-balance"
  expect_problem "balance_$phase" 503 "$want_type"
  KEY="$(ulid)" command_as "deposit_unknown_$phase" "K$phase" 192.0.2.97 POST "/v1/sandboxes/$sid/catering/01JC8Z6K3W9QF2N4T7XRB5M0HD/deposit"
  expect_problem "deposit_unknown_$phase" 503 "$want_type"
  get_as "${phase}_acc_after" "K$phase" "/v1/sandboxes/$sid/catering/$acc"
  get_as "${phase}_inv_after" "K$phase" "/v1/sandboxes/$sid/catering/$inv"
  check "$phase: the accepted and the invoiced event read as they did, and the guard ran before the event was looked up" "cmp -s '$TMP/${phase}_acc_before.body' '$TMP/${phase}_acc_after.body' && cmp -s '$TMP/${phase}_inv_before.body' '$TMP/${phase}_inv_after.body'"
  stripe_requests "${phase}_reqs_after"
  check "$phase: no request reached the fake Stripe" "cmp -s '$TMP/${phase}_reqs_before.body' '$TMP/${phase}_reqs_after.body'"
  tail -n "+$((LOG_FROM + 1))" "$LOG" > "$TMP/$phase.log"
}

KEY_LINE="STRIPE_SECRET_KEY=$OTHER_KEY"
stripe_phase other-mode stripe-key
REFUSED="$(grep -c '"event":"stripe_key_refused"' "$TMP/other-mode.log" || true)"
check "other-mode: stripe_key_refused is logged once, naming the key's kind and never the key" "(( REFUSED == 1 )) && grep -q '\"event\":\"stripe_key_refused\",\"kind\":\"other-mode\"' '$TMP/other-mode.log' && ! grep -qF -- '$OTHER_KEY' '$TMP/other-mode.log'"

KEY_LINE=""
stripe_phase absent config
expect_json deposit_absent "b.detail.includes('STRIPE_SECRET_KEY')"
expect_json balance_absent "b.detail.includes('STRIPE_SECRET_KEY')"

echo
if (( FAILURES > 0 )); then
  echo "$PASSES passed, $FAILURES failed"
  exit 1
fi
echo "all $PASSES checks passed"
