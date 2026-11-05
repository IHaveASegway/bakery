#!/usr/bin/env bash
# Smoke-tests PR 5 on `wrangler dev` against scripts/fake-stripe.mjs: an order paid the way the
# Payment Element pays it and shown confirmed on the board within a second, the same intent
# for a remount, a webhook replayed five times counted once, a body altered by one byte and a
# signature six minutes old refused with 400, a partial and a full refund each issued once with
# the order's ledger netting to zero, an expired order's intent canceled at Stripe, the
# Simulator's orders paid, the wipe's Stripe cleanup, and a second Worker run whose
# STRIPE_SECRET_KEY is a key of the mode the bakery never uses: every payment route answers 503
# `stripe-key` and `stripe_key_refused` is logged once, while health and the menu still work.
# Last, the Worker's log is searched for any client secret, key, signature or body. It prints
# ok or FAIL per check as scripts/smoke-auth.sh does, and exits non-zero on any failure.
#
# Usage: scripts/smoke-payments.sh   (from anywhere; needs cargo, worker-build, pnpm, node 22 and curl).
#
# Like scripts/smoke-auth.sh it writes a throwaway workers/api/.dev.vars, refuses to run when one
# exists unless SMOKE_PAYMENTS_OVERWRITE=1, starts the fake providers (Turnstile) on 8790 and the
# fake Stripe on 8791, and keeps the Worker's log in SMOKE_PAYMENTS_LOG=<file> when set. Every key
# in the .dev.vars is a test-shaped fake. The second run's key is put together from parts when the
# script runs, so no key of that mode is written in this file. A run takes about two minutes.
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

TMP="$(mktemp -d -t smoke-payments.XXXXXX)"
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
  for pid in ${WS_PAY:-} ${WS_SIM:-}; do kill -TERM "$pid" 2>/dev/null || true; done
  stop_pid "$SERVER_PID"
  stop_pid "$FAKE_PID"
  stop_pid "$STRIPE_PID"
  if [[ -n "$WROTE_DEV_VARS" ]]; then rm -f "$DEV_VARS"; fi
  if [[ -n "$BACKUP" && -f "$BACKUP" ]]; then mv "$BACKUP" "$DEV_VARS"; fi
  if [[ -n "${SMOKE_PAYMENTS_LOG:-}" ]]; then cp "$LOG" "$SMOKE_PAYMENTS_LOG" 2>/dev/null || true; fi
  if (( FAILURES > 0 )); then
    mkdir -p "${TMPDIR:-/tmp}/smoke-payments-logs"
    cp "$LOG" "${TMPDIR:-/tmp}/smoke-payments-logs/worker.log" 2>/dev/null || true
    cp "$STRIPE_LOG" "${TMPDIR:-/tmp}/smoke-payments-logs/stripe.log" 2>/dev/null || true
    echo "logs kept in ${TMPDIR:-/tmp}/smoke-payments-logs" >&2
  fi
  rm -rf "$TMP"
}
trap stop EXIT

pass() { printf 'ok    %s\n' "$1"; PASSES=$((PASSES + 1)); }
fail() { printf 'FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }

if [[ -e "$DEV_VARS" ]]; then
  if [[ -z "${SMOKE_PAYMENTS_OVERWRITE:-}" ]]; then
    echo "workers/api/.dev.vars exists; this script would replace it. Move it aside, or set SMOKE_PAYMENTS_OVERWRITE=1 to have it moved and restored." >&2
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

# ---------- helpers (as in scripts/smoke-orders.sh) ----------

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
  for _ in $(seq 1 100); do
    get_as "$name" "$jar_name" "/v1/sandboxes/$id"
    if [[ "$(json_field "$name" b.state)" == live ]]; then return 0; fi
    sleep 0.2
  done
  return 1
}

# wait_order NAME JAR SANDBOX ORDER STATUS [EXPR]: polls the order until it has that status (and
# EXPR holds over it as `b`), up to 10 s, as the storefront polls it after confirmPayment.
wait_order() {
  local name="$1" jar_name="$2" id="$3" oid="$4" want="$5" expr="${6:-true}"
  for _ in $(seq 1 50); do
    get_as "$name" "$jar_name" "/v1/sandboxes/$id/orders/$oid"
    if node -e "const b = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); if (!(b.status === '$want' && ($expr))) process.exit(1)" "$TMP/$name.body" 2>/dev/null; then return 0; fi
    sleep 0.2
  done
  return 1
}

# ledger_until NAME JAR SANDBOX EXPR: polls the ledger until EXPR holds over it, up to 10 s.
ledger_until() {
  local name="$1" jar_name="$2" id="$3" expr="$4"
  for _ in $(seq 1 50); do
    get_as "$name" "$jar_name" "/v1/sandboxes/$id/billing/ledger"
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
    const evts = frames.filter((f) => f.t === 'evt').map((f) => ({ ...f.env, at_ms: f.at }));
    const v = ($2); process.stdout.write(v === undefined || v === null ? '' : String(v));" "$1"
}
log_has() { grep -qF -- "$1" "$LOG"; }
log_count() { grep -cF -- "$1" "$LOG" || true; }
wait_log() {
  local deadline=$(( $(date +%s) + $2 ))
  until log_has "$1"; do
    if (( $(date +%s) > deadline )); then return 1; fi
    sleep 0.5
  done
}

# ---------- the fake Stripe ----------

# stripe_call NAME METHOD PATH [FORM]: the fake's API, as Stripe.js or Stripe's CLI would call it.
stripe_call() {
  local name="$1" method="$2" path="$3" form="${4:-}"
  local args=(-X "$method" -H "Authorization: Bearer $STRIPE_KEY")
  if [[ -n "$form" ]]; then args+=(-H 'Content-Type: application/x-www-form-urlencoded' --data "$form"); fi
  request "$name" "${args[@]}" "$STRIPE$path"
}
stripe_config() { request stripe_config -X POST -H 'Content-Type: application/json' --data "$1" "$STRIPE/_config"; }
stripe_events() { request "$1" "$STRIPE/_events"; }
# The intent's id, from a client secret `pi_..._secret_...`: what Stripe.js confirms.
intent_of() { json_field "$1" "b.client_secret.split('_secret_')[0]"; }
# stripe_until NAME EXPR: polls the fake's /_events until EXPR holds over it (`b`), up to 10 s.
stripe_until() {
  for _ in $(seq 1 50); do
    stripe_events "$1"
    if node -e "const b = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); if (!($2)) process.exit(1)" "$TMP/$1.body" 2>/dev/null; then return 0; fi
    sleep 0.2
  done
  return 1
}

# signed NAME BODY [T_OFFSET_S]: a webhook posted straight to the Worker, signed as Stripe signs
# it with the fake's secret, `t` that many seconds from now.
signed() {
  local name="$1" body="$2" offset="${3:-0}"
  local header
  header="$(node -e "
    const c = require('crypto');
    const t = Math.floor(Date.now() / 1000) + Number(process.argv[3]);
    const v1 = c.createHmac('sha256', process.argv[1]).update(t + '.' + process.argv[2]).digest('hex');
    process.stdout.write('t=' + t + ',v1=' + v1);" "$WEBHOOK_SECRET" "$body" "$offset")"
  request "$name" -X POST -H 'Content-Type: application/json' -H "Stripe-Signature: $header" \
    -H "CF-Connecting-IP: 192.0.2.99" --data "$body" "$BASE/v1/stripe/webhook"
}

write_dev_vars() {
  {
    echo "# Written by scripts/smoke-payments.sh for one run; removed when it ends. Never committed."
    echo "SESSION_HMAC_KEY=$(random_text 48)"
    echo "ACCOUNT_HMAC_KEY=$(random_text 48)"
    echo "TURNSTILE_SECRET=1x0000000000000000000000000000000AA"
    echo "TURNSTILE_SITEVERIFY_URL=$FAKE/turnstile/siteverify"
    echo "ALLOWED_ORIGIN=$STOREFRONT"
    echo "API_ORIGIN=$BASE"
    echo "STRIPE_API_BASE=$STRIPE"
    echo "STRIPE_WEBHOOK_SECRET=$WEBHOOK_SECRET"
    echo "STRIPE_PUBLISHABLE_KEY=$PUBLISHABLE"
    printf '%s\n' "$@"
  } > "$DEV_VARS"
  WROTE_DEV_VARS=1
}

if [[ -n "${WRANGLER:-}" ]]; then run_wrangler=(npx --yes "$WRANGLER"); else run_wrangler=(pnpm exec wrangler); fi

# start_worker PHASE [VAR=value...]: a fresh state directory and .dev.vars, then wait for health.
start_worker() {
  local phase="$1"; shift
  write_dev_vars "$@"
  STATE="$TMP/state-$phase"
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

list_objects() {
  set +e
  node "$ROOT/scripts/list-objects.mjs" "$STATE" > "$TMP/$1.out" 2> "$TMP/$1.err"
  LIST_EXIT=$?
  set -e
}

# order_json MENU_NAME SANDBOX_OFFSET_MIN [QTY]: a pickup order the menu in MENU_NAME.body sells,
# at the first slot about four hours out (plus the sandbox's clock offset, in minutes) that the
# day's Schedule takes: 07:00 to 14:45 on the quarter hour, closed Mondays, in America/Denver
# (PR 6 holds the slot before the Order decides).
order_json() {
  node -e "
    const TZ = 'America/Denver';
    const parts = (ms) => { const o = {}; for (const p of new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }).formatToParts(new Date(ms))) o[p.type] = p.value; return o; };
    const offsetMin = (ms) => { const p = parts(ms); return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000) / 60000); };
    const iso = (ms) => { const p = parts(ms), o = offsetMin(ms), a = Math.abs(o); return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute + ':' + p.second + (o < 0 ? '-' : '+') + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0'); };
    const wd = (ms) => parts(ms).weekday.toLowerCase().slice(0, 3);
    const minuteOf = (ms) => { const p = parts(ms); return +p.hour * 60 + +p.minute; };
    const isSlot = (ms) => wd(ms) !== 'mon' && minuteOf(ms) >= 420 && minuteOf(ms) <= 885 && minuteOf(ms) % 15 === 0;
    const menu = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const now = Date.now() + Number(process.argv[2]) * 60000;
    let slot = Math.ceil((now + 240 * 60000) / 900000) * 900000;
    while (!isSlot(slot)) slot += 900000;
    const p = parts(slot);
    const md = p.month + '-' + p.day;
    const inSeason = (s) => !s || (s.from <= s.to ? s.from <= md && md <= s.to : md >= s.from || md <= s.to);
    const lead = Math.floor((slot - now) / 60000) - 30;
    for (const c of menu.categories) for (const i of c.items) {
      if (i.status !== 'available' || !i.days_baked.includes(wd(slot)) || !inSeason(i.season)) continue;
      const v = i.variants.find((v) => v.lead_minutes <= lead);
      if (!v) continue;
      console.log(JSON.stringify({ kind: 'pickup', slot: iso(slot), lines: [{ variant: v.slug, qty: Number(process.argv[3] || 1) }] }));
      process.exit(0);
    }
    process.exit(1);" "$TMP/$1.body" "$2" "${3:-1}"
}

# pay NAME JAR SANDBOX ORDER: the payment step as the storefront runs it: no body, the order's own
# ULID as the Idempotency-Key.
pay() {
  KEY="$4" command_as "$1" "$2" 192.0.2.61 POST "/v1/sandboxes/$3/orders/$4/payment"
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

start_worker sandbox "STRIPE_SECRET_KEY=$STRIPE_KEY"

# ---------- a guest pays ----------

command_as guest G 192.0.2.51 POST /v1/sandboxes '{"turnstile_token":"pass-1","replace":false}'
expect_status guest 201
GID="$(json_field guest b.id)"
check "guest: seeding reaches live within 20 s" "wait_live guest_live G '$GID'"
expect_json guest_live "b.state === 'live' && b.children >= 35 && typeof b.persona_name === 'string' && b.persona_name.length > 0 && b.persona_address.line1.endsWith('(synthetic)') && b.persona_address.city === 'Salt Lake City' && b.persona_address.country === 'US'"

get_as menu G "/v1/sandboxes/$GID/menu"
ORDER="$(order_json menu 0 2)" || { fail "no item on the seeded menu fits a slot 4 h out"; ORDER='{}'; }
command_as place G 192.0.2.51 POST "/v1/sandboxes/$GID/orders" "$ORDER"
expect_status place 201
OID="$(json_field place b.id)"
TOTAL="$(json_field place b.total_cents)"

# A socket on the guest's board, open before the payment.
probe_args G "$GID"
node "${PROBE[@]}" --wait-evt OrderPaid --timeout 30 > "$TMP/ws_pay.out" &
WS_PAY=$!
sleep 1

pay pay_1 G "$GID" "$OID"
expect_status pay_1 200
expect_json pay_1 "/^pi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+$/.test(b.client_secret) && b.amount_cents === $TOTAL && b.status === 'created' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(b.payment) && b.publishable_key === '$PUBLISHABLE'"
check "pay_1: the storefront's CORS header" "[[ '$(header_of pay_1 access-control-allow-origin)' == '$STOREFRONT' ]]"
PI="$(intent_of pay_1)"
pay pay_remount G "$GID" "$OID"
expect_status pay_remount 200
check "a remount gets the same payment and the same client secret" "[[ '$(json_field pay_remount b.payment)' == '$(json_field pay_1 b.payment)' && '$(json_field pay_remount b.client_secret)' == '$(json_field pay_1 b.client_secret)' ]]"
request stripe_reqs "$STRIPE/_requests"
expect_json stripe_reqs "b.filter(r => r.path === '/v1/payment_intents').length === 2 && b.every(r => r.auth_scheme === 'Bearer' && (r.method === 'GET' || r.idempotency_key_present)) && b.find(r => r.path === '/v1/payment_intents').body_keys.includes('metadata[sandbox]')"
request pay_no_session -X POST -H "Origin: $STOREFRONT" -H "Idempotency-Key: $OID" "$BASE/v1/sandboxes/$GID/orders/$OID/payment"
expect_problem pay_no_session 401 session
command_as pay_unknown G 192.0.2.51 POST "/v1/sandboxes/$GID/orders/01JC8Z6K3W9QF2N4T7XRB5M0HD/payment"
expect_status pay_unknown 404

# The browser's confirm, as the Payment Element makes it at Stripe with the test card.
CONFIRM_MS="$(now_ms)"
stripe_call confirm POST "/v1/payment_intents/$PI/confirm" "payment_method=pm_card_visa"
expect_json confirm "b.status === 'succeeded'"
wait "$WS_PAY" || true
expect_probe "the webhook's PaymentSucceeded puts the order on the board confirmed within 1 s of the confirm: $(probe_field "$TMP/ws_pay.out" "(evts.find((e) => e.type === 'OrderPaid' && e.stream.endsWith(':$OID')) || {}).at_ms - $CONFIRM_MS") ms" "$TMP/ws_pay.out" "evts.some((e) => e.type === 'OrderPaid' && e.stream.endsWith(':$OID') && e.data.amount_cents === $TOTAL && e.at_ms - $CONFIRM_MS <= 1000)"
check "the order reads confirmed, as the storefront polls it" "wait_order paid G '$GID' '$OID' confirmed"
pay pay_paid G "$GID" "$OID"
expect_problem pay_paid 409 order
expect_json pay_paid "b.detail.includes('not-payable')"
check "the ledger shows the payment" "ledger_until ledger_1 G '$GID' \"b.entries.length === 1 && b.entries[0].kind === 'payment' && b.entries[0].ref === '$OID' && b.entries[0].amount_cents === $TOTAL && b.entries[0].stripe_id === '$PI' && b.net_cents === $TOTAL && b.paid_cents === $TOTAL && b.refunded_cents === 0\""

# ---------- a webhook replayed five times ----------

ORDER_R="$(order_json menu 0 1)" || ORDER_R='{}'
command_as place_r G 192.0.2.51 POST "/v1/sandboxes/$GID/orders" "$ORDER_R"
RID="$(json_field place_r b.id)"
pay pay_r G "$GID" "$RID"
PI_R="$(intent_of pay_r)"
stripe_config '{"replay":5}'
stripe_call confirm_r POST "/v1/payment_intents/$PI_R/confirm" "payment_method=pm_card_visa"
check "the replayed event was delivered 5 times, each answered 200" "stripe_until events_r \"b.some(e => e.type === 'payment_intent.succeeded' && e.intent === '$PI_R' && e.deliveries.length === 5 && e.deliveries.every(d => d.status === 200))\""
EVT_R="$(json_field events_r "b.find(e => e.type === 'payment_intent.succeeded' && e.intent === '$PI_R').id")"
check "the order reads confirmed" "wait_order paid_r G '$GID' '$RID' confirmed"
check "the ledger changed once: one payment line for the order" "ledger_until ledger_r G '$GID' \"b.entries.filter(e => e.ref === '$RID').length === 1 && b.entries.length === 2\""
check "Billing applied it once and replayed it 4 times" "(( $(log_count "\"stripe_event\":\"$EVT_R\",\"outcome\":\"applied\"") == 1 && $(log_count "\"stripe_event\":\"$EVT_R\",\"outcome\":\"replayed\"") == 4 ))"
get_as paid_r_events G "/v1/sandboxes/$GID/orders/$RID"
expect_json paid_r_events "b.events_seq === 2"

# ---------- signatures, timestamps and bodies ----------

ORDER_F="$(order_json menu 0 1)" || ORDER_F='{}'
command_as place_f G 192.0.2.51 POST "/v1/sandboxes/$GID/orders" "$ORDER_F"
FID="$(json_field place_f b.id)"
pay pay_f G "$GID" "$FID"
PI_F="$(intent_of pay_f)"
stripe_config '{"faults":{"tamper_body":true}}'
stripe_call confirm_f POST "/v1/payment_intents/$PI_F/confirm" "payment_method=pm_card_visa"
check "a body altered by one byte after signing: every delivery answered 400" "stripe_until events_f \"b.some(e => e.intent === '$PI_F' && e.fault.includes('tamper_body') && e.deliveries.length === 3 && e.deliveries.every(d => d.status === 400))\""
EVT_F="$(json_field events_f "b.find(e => e.intent === '$PI_F').id")"
stripe_config '{"faults":{"tamper_body":false,"old_timestamp":true}}'
request resend_old -X POST -H 'Content-Type: application/json' --data "{\"event_id\":\"$EVT_F\"}" "$STRIPE/_send_event"
expect_json resend_old "b.deliveries.filter(d => d.fault.includes('old_timestamp')).length === 3 && b.deliveries.filter(d => d.fault.includes('old_timestamp')).every(d => d.status === 400)"
stripe_config '{"faults":{"old_timestamp":false,"bad_signature":true}}'
request resend_bad -X POST -H 'Content-Type: application/json' --data "{\"event_id\":\"$EVT_F\"}" "$STRIPE/_send_event"
expect_json resend_bad "b.deliveries.filter(d => d.fault.includes('bad_signature')).every(d => d.status === 400)"
stripe_config '{"faults":{"bad_signature":false,"livemode":true}}'
request resend_live -X POST -H 'Content-Type: application/json' --data "{\"event_id\":\"$EVT_F\"}" "$STRIPE/_send_event"
expect_json resend_live "b.deliveries.filter(d => d.fault.includes('livemode')).every(d => d.status === 400)"
stripe_config '{"faults":{"livemode":false}}'
get_as unpaid_f G "/v1/sandboxes/$GID/orders/$FID"
expect_json unpaid_f "b.status === 'placed'"
check "the refusals are logged by reason: body (the tampered id breaks the signature), timestamp, signature, livemode" \
  "grep -q '\"route\":\"/v1/stripe/webhook\".*\"status\":400.*\"reason\":\"timestamp\"' '$LOG' && grep -q '\"route\":\"/v1/stripe/webhook\".*\"status\":400.*\"reason\":\"signature\"' '$LOG' && grep -q '\"route\":\"/v1/stripe/webhook\".*\"status\":400.*\"reason\":\"livemode\"' '$LOG'"
request resend_clean -X POST -H 'Content-Type: application/json' --data "{\"event_id\":\"$EVT_F\"}" "$STRIPE/_send_event"
expect_json resend_clean "b.deliveries[b.deliveries.length - 1].status === 200 && b.deliveries[b.deliveries.length - 1].fault.length === 0"
check "the same event, sent clean, pays the order" "wait_order paid_f G '$GID' '$FID' confirmed"

# Straight to the route, signed here.
request hook_unsigned -X POST -H 'Content-Type: application/json' --data '{"id":"evt_fake_x"}' "$BASE/v1/stripe/webhook"
expect_problem hook_unsigned 400 signature
NOW_S="$(node -e 'process.stdout.write(String(Math.floor(Date.now() / 1000)))')"
STRANGER="$(ulid)"
UNKNOWN_BODY="{\"id\":\"evt_fake_unknown_sandbox\",\"object\":\"event\",\"type\":\"payment_intent.succeeded\",\"livemode\":false,\"created\":$NOW_S,\"data\":{\"object\":{\"id\":\"pi_fakeunknown\",\"object\":\"payment_intent\",\"amount\":100,\"currency\":\"usd\",\"status\":\"succeeded\",\"livemode\":false,\"metadata\":{\"sandbox\":\"$STRANGER\"}}}}"
signed hook_unknown "$UNKNOWN_BODY"
expect_status hook_unknown 200
check "an event for a sandbox that never was is answered 200, logged wiped" "grep -q '\"route\":\"/v1/stripe/webhook\".*\"status\":200.*\"reason\":\"wiped\"' '$LOG'"
signed hook_old "$UNKNOWN_BODY" -360
expect_problem hook_old 400 timestamp
signed hook_four "$UNKNOWN_BODY" -240
expect_status hook_four 200
signed hook_not_json 'not json'
expect_problem hook_not_json 400 body
signed hook_other "{\"id\":\"evt_fake_other\",\"object\":\"event\",\"type\":\"customer.created\",\"livemode\":false,\"created\":$NOW_S,\"data\":{\"object\":{\"object\":\"customer\",\"id\":\"cus_fake_1\"}}}"
expect_status hook_other 200
request hook_cors -X POST -H "Origin: $STOREFRONT" -H 'Content-Type: application/json' --data '{}' "$BASE/v1/stripe/webhook"
expect_problem hook_cors 400 signature
check "the webhook answers the storefront's Origin with no CORS header" "[[ -z '$(header_of hook_cors access-control-allow-origin)' ]]"
request hook_options -X OPTIONS -H "Origin: $STOREFRONT" -H 'Access-Control-Request-Method: POST' "$BASE/v1/stripe/webhook"
expect_status hook_options 405
check "no preflight for the webhook: Allow is POST alone, and no CORS header" "[[ '$(header_of hook_options allow)' == 'POST' && -z '$(header_of hook_options access-control-allow-origin)' ]]"

# ---------- refunds ----------

command_as signup D 192.0.2.52 POST /v1/auth/demo "{\"password\":\"$(random_text 24)\",\"turnstile_token\":\"pass-1\"}"
expect_status signup 201
command_as demo D 192.0.2.52 POST /v1/sandboxes '{"replace":false}'
expect_status demo 201
DID="$(json_field demo b.id)"
check "demo: seeding reaches live within 20 s" "wait_live demo_live D '$DID'"
get_as dmenu D "/v1/sandboxes/$DID/menu"
ORDER_D="$(order_json dmenu 0 3)" || ORDER_D='{}'
command_as place_d D 192.0.2.52 POST "/v1/sandboxes/$DID/orders" "$ORDER_D"
DOID="$(json_field place_d b.id)"
DTOTAL="$(json_field place_d b.total_cents)"
pay pay_d D "$DID" "$DOID"
expect_status pay_d 200
stripe_call confirm_d POST "/v1/payment_intents/$(intent_of pay_d)/confirm" "payment_method=pm_card_visa"
check "the demo order reads confirmed" "wait_order paid_d D '$DID' '$DOID' confirmed"

command_as refund_guest G 192.0.2.51 POST "/v1/sandboxes/$GID/orders/$OID/refund" '{"reason":"goodwill"}'
expect_problem refund_guest 403 guest-scope
command_as refund_over D 192.0.2.52 POST "/v1/sandboxes/$DID/orders/$DOID/refund" "{\"amount_cents\":$((DTOTAL + 1)),\"reason\":\"quality\"}"
expect_problem refund_over 422 order
expect_json refund_over "b.detail.includes('refund-exceeds-paid')"
command_as refund_bad D 192.0.2.52 POST "/v1/sandboxes/$DID/orders/$DOID/refund" '{"reason":"requested_by_customer"}'
expect_problem refund_bad 400 body

PART=$(( DTOTAL / 4 ))
KEY="$(ulid)"
command_as refund_part D 192.0.2.52 POST "/v1/sandboxes/$DID/orders/$DOID/refund" "{\"amount_cents\":$PART,\"reason\":\"missing_item\"}"
command_as refund_part_again D 192.0.2.52 POST "/v1/sandboxes/$DID/orders/$DOID/refund" "{\"amount_cents\":$PART,\"reason\":\"missing_item\"}"
unset KEY
expect_status refund_part 200
expect_json refund_part "/^[0-9A-HJKMNP-TV-Z]{26}$/.test(b.refund) && b.amount_cents === $PART && b.status === 'confirmed'"
expect_header refund_part_again idempotent-replayed true
check "the replayed refund names the same refund" "[[ '$(json_field refund_part_again b.refund)' == '$(json_field refund_part b.refund)' ]]"
REFUND_1="$(json_field refund_part b.refund)"
check "the partial refund reaches the ledger once" "ledger_until ledger_part D '$DID' \"b.entries.filter(e => e.ref === '$DOID' && e.kind === 'refund').length === 1 && b.entries.find(e => e.ref === '$DOID' && e.kind === 'refund').amount_cents === -$PART && /^re_/.test(b.entries.find(e => e.kind === 'refund').stripe_id)\""
check "the order recorded it: OrderRefunded, still confirmed" "wait_order part_d D '$DID' '$DOID' confirmed 'b.events_seq === 4'"

command_as refund_full D 192.0.2.52 POST "/v1/sandboxes/$DID/orders/$DOID/refund" '{"reason":"goodwill"}'
expect_status refund_full 200
expect_json refund_full "b.amount_cents === $((DTOTAL - PART)) && b.status === 'refund_pending' && b.refund !== '$REFUND_1'"
check "the full refund reaches the ledger once, and the order's lines net to zero" "ledger_until ledger_full D '$DID' \"b.entries.filter(e => e.ref === '$DOID' && e.kind === 'refund').length === 2 && b.entries.filter(e => e.ref === '$DOID').reduce((n, e) => n + e.amount_cents, 0) === 0 && b.net_cents === 0 && b.paid_cents === $DTOTAL && b.refunded_cents === $DTOTAL\""
check "the order ends cancelled once the whole refund is issued" "wait_order full_d D '$DID' '$DOID' cancelled"
check "Billing issued each refund once at Stripe: two refunds requested at the fake" "request reqs_refund '$STRIPE/_requests' && node -e \"process.exit(JSON.parse(require('fs').readFileSync('$TMP/reqs_refund.body','utf8')).filter(r => r.path === '/v1/refunds' && r.status === 200).length === 2 ? 0 : 1)\""
command_as refund_after D 192.0.2.52 POST "/v1/sandboxes/$DID/orders/$DOID/refund" '{"reason":"goodwill"}'
expect_problem refund_after 422 order

# A seeded order was made paid by the seed, not through Stripe.
probe_args D "$DID"
node "${PROBE[@]}" --until snapshot > "$TMP/board_d.out" || true
SEEDED="$(probe_field "$TMP/board_d.out" "(frames.find((f) => f.t === 'snapshot').board.cards.find((c) => c.state === 'confirmed' && c.order !== '$DOID') || {}).order")"
command_as refund_seeded D 192.0.2.52 POST "/v1/sandboxes/$DID/orders/$SEEDED/refund" '{"reason":"goodwill"}'
expect_problem refund_seeded 409 order
expect_json refund_seeded "b.detail.includes('no-stripe-payment')"

# ---------- an expired order's intent is canceled ----------

ORDER_X="$(order_json dmenu 0 1)" || ORDER_X='{}'
command_as place_x D 192.0.2.52 POST "/v1/sandboxes/$DID/orders" "$ORDER_X"
XID="$(json_field place_x b.id)"
pay pay_x D "$DID" "$XID"
expect_status pay_x 200
PI_X="$(intent_of pay_x)"
command_as clock_15 D 192.0.2.52 POST "/v1/sandboxes/$DID/clock" '{"minutes":15}'
expect_status clock_15 200
check "the unpaid order expires on the business clock" "wait_order expired_x D '$DID' '$XID' expired"
check "Billing canceled its intent at Stripe" "stripe_until events_x \"b.some(e => e.type === 'payment_intent.canceled' && e.intent === '$PI_X' && e.deliveries.every(d => d.status === 200))\""
stripe_call intent_x GET "/v1/payment_intents/$PI_X"
expect_json intent_x "b.status === 'canceled' && b.cancellation_reason === 'abandoned'"
pay pay_expired D "$DID" "$XID"
expect_problem pay_expired 409 order

# ---------- the Simulator pays its orders ----------

probe_args D "$DID"
node "${PROBE[@]}" --hold 0 > "$TMP/ws_sim.out" &
WS_SIM=$!
sleep 1
SIM_FROM_MS="$(now_ms)"
command_as traffic D 192.0.2.52 POST "/v1/sandboxes/$DID/traffic" '{"rate":6}'
expect_status traffic 200
for _ in $(seq 1 60); do
  probe_ok "$TMP/ws_sim.out" "evts.filter((e) => e.type === 'OrderPaid' && e.at_ms >= $SIM_FROM_MS).length >= 1" && \
    (( $(log_count '"event":"sim_pay"' ) >= 6 )) && break
  sleep 0.25
done
sleep 2
command_as traffic_stop D 192.0.2.52 DELETE "/v1/sandboxes/$DID/traffic"
SIM_PLACED="$(probe_field "$TMP/ws_sim.out" "evts.filter((e) => e.type === 'OrderPlaced' && e.at_ms >= $SIM_FROM_MS && /^sim:/.test(e.cause)).length")"
SIM_PAID="$(probe_field "$TMP/ws_sim.out" "evts.filter((e) => e.type === 'OrderPaid' && e.at_ms >= $SIM_FROM_MS).length")"
VISA="$(grep -c '"event":"sim_pay".*"step":"confirm","card":"visa","status":200' "$LOG" || true)"
DECLINED="$(grep -c '"event":"sim_pay".*"step":"confirm","card":"declined","status":200' "$LOG" || true)"
check "the Simulator's orders are paid: $SIM_PLACED placed, $SIM_PAID confirmed on the board, $VISA visa and $DECLINED declined confirms" "(( SIM_PLACED >= 1 && SIM_PAID >= 1 && SIM_PAID == VISA && VISA + DECLINED == SIM_PLACED ))"
check "a declined simulated card is a PaymentFailed, not a payment" "(( DECLINED == 0 )) || stripe_until events_sim \"b.filter(e => e.type === 'payment_intent.payment_failed').length === $DECLINED\""
check "the ledger holds the Simulator's payments" "ledger_until ledger_sim D '$DID' \"b.entries.filter(e => e.kind === 'payment').length === 1 + $SIM_PAID\""

# ---------- the wipe's Stripe cleanup ----------

ORDER_W="$(order_json menu 0 1)" || ORDER_W='{}'
command_as place_w G 192.0.2.51 POST "/v1/sandboxes/$GID/orders" "$ORDER_W"
WID="$(json_field place_w b.id)"
pay pay_w G "$GID" "$WID"
PI_W="$(intent_of pay_w)"
kill -TERM "$WS_SIM" 2>/dev/null || true
command_as wipe_g G 192.0.2.51 DELETE "/v1/sandboxes/$GID"
expect_status wipe_g 200
command_as wipe_d D 192.0.2.52 DELETE "/v1/sandboxes/$DID"
expect_status wipe_d 200
check "the wipe canceled the open intent at Stripe" "stripe_until events_w \"b.some(e => e.type === 'payment_intent.canceled' && e.intent === '$PI_W')\""
check "its webhook, arriving as the sandbox goes, is answered 200" "stripe_until events_w2 \"b.find(e => e.type === 'payment_intent.canceled' && e.intent === '$PI_W').deliveries.every(d => d.status === 200)\""
sleep 1
list_objects list_wiped
check "list-objects: every child is empty after the wipes, Billing too" "(( LIST_EXIT == 0 )) && grep -q '\"class\":\"Billing\"' '$TMP/list_wiped.out'"

stop_worker

# ---------- a key of the other mode ----------

# Put together here, so the prefix is in no file: Stripe's secret-key prefix with the mode word
# the bakery never uses.
MODE="$(printf '%s%s' li ve)"
OTHER_KEY="sk_${MODE}_fake000000000000000000000000"
LOG_FROM="$(wc -l < "$LOG")"
start_worker other-mode "STRIPE_SECRET_KEY=$OTHER_KEY"
request health_other "$BASE/v1/health"
expect_status health_other 200
command_as guest_o O 192.0.2.71 POST /v1/sandboxes '{"turnstile_token":"pass-1","replace":false}'
expect_status guest_o 201
OSID="$(json_field guest_o b.id)"
check "other mode: seeding reaches live" "wait_live o_live O '$OSID'"
get_as menu_o O "/v1/sandboxes/$OSID/menu"
expect_status menu_o 200
ORDER_O="$(order_json menu_o 0 1)" || ORDER_O='{}'
command_as place_o O 192.0.2.71 POST "/v1/sandboxes/$OSID/orders" "$ORDER_O"
expect_status place_o 201
OOID="$(json_field place_o b.id)"
pay pay_o O "$OSID" "$OOID"
expect_problem pay_o 503 stripe-key
pay pay_o2 O "$OSID" "$OOID"
expect_problem pay_o2 503 stripe-key
get_as ledger_o O "/v1/sandboxes/$OSID/billing/ledger"
expect_problem ledger_o 503 stripe-key
command_as signup_o P 192.0.2.72 POST /v1/auth/demo "{\"password\":\"$(random_text 24)\",\"turnstile_token\":\"pass-1\"}"
command_as demo_o P 192.0.2.72 POST /v1/sandboxes '{"replace":false}'
PSID="$(json_field demo_o b.id)"
check "other mode: the demo sandbox reaches live" "wait_live p_live P '$PSID'"
command_as refund_o P 192.0.2.72 POST "/v1/sandboxes/$PSID/orders/$OOID/refund" '{"reason":"goodwill"}'
expect_problem refund_o 503 stripe-key
signed hook_o "$UNKNOWN_BODY"
expect_problem hook_o 503 stripe-key
request reqs_o "$STRIPE/_requests"
check "no request reached the fake Stripe with that key" "node -e \"const b = JSON.parse(require('fs').readFileSync('$TMP/reqs_o.body','utf8')); process.exit(b.filter(r => r.status === 401).length === 0 ? 0 : 1)\""
stop_worker
tail -n "+$LOG_FROM" "$LOG" > "$TMP/other.log"
REFUSED="$(grep -c '"event":"stripe_key_refused"' "$TMP/other.log" || true)"
check "stripe_key_refused is logged once in the run: $REFUSED" "(( REFUSED == 1 ))"
check "the refusal names the key's kind, never the key" "grep -q '\"event\":\"stripe_key_refused\",\"kind\":\"other-mode\"' '$TMP/other.log' && ! grep -qF -- '$OTHER_KEY' '$TMP/other.log'"

# ---------- what the log holds ----------

runtime_log="$TMP/runtime.log"
awk '/^=== .*: Worker ready/ { on = 1 } on' "$LOG" > "$runtime_log"
check "the Worker's log holds no client secret" "! grep -q '_secret_' '$runtime_log'"
check "the Worker's log holds no Stripe key or webhook secret" "! grep -qF -- '$STRIPE_KEY' '$runtime_log' && ! grep -qF -- '$WEBHOOK_SECRET' '$runtime_log' && ! grep -qF -- 'Bearer' '$runtime_log'"
check "the Worker's log holds no signature header and no webhook body" "! grep -q 'v1=' '$runtime_log' && ! grep -q '\"object\":\"event\"' '$runtime_log' && ! grep -q 'pending_webhooks' '$runtime_log'"
check "the Worker's log names Stripe's events by id and outcome" "grep -q '\"event\":\"webhook_applied\",\"stripe_event\":\"evt_fake[0-9a-f]*\",\"outcome\":\"applied\"}' '$runtime_log'"

echo
if (( FAILURES > 0 )); then
  echo "$PASSES passed, $FAILURES failed"
  exit 1
fi
echo "all $PASSES checks passed"
