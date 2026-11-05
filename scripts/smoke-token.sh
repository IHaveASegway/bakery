#!/usr/bin/env bash
# Smoke-tests PR 10's API token on `wrangler dev` against the fake providers and
# scripts/fake-stripe.mjs (docs/roadmap.md, PR 10: "A token works with curl and dies with the
# sandbox", "A rotated token stops working"; docs/security.md, "The API token").
#
# - Issue: a signed-in session issues a token over the console's path (the cookie and the exact
#   Origin): 200, shown once, starting `eyJ`, 24 h; the same key again replays the same token;
#   `GET .../token` shows its version, times and masked form (first 6 and last 4), never the token.
# - Use: `curl` with `Authorization: Bearer` and no cookie and no `Origin` reads the sandbox, the
#   menu and the schedule, reads the token's own info, and places and pays an order through the
#   fake Stripe as scripts/smoke-payments.sh does, each 2xx, with no CORS header and no cookie on
#   any answer, the storefront's `Origin` sent or not.
# - Refusals: a token in a query string 400 `token` (`query`); a token beside the cookie 400
#   (`both`); the token on `/v1/session`, sign-out, issue and rotate 401 `token` (`cookie-only`);
#   another sandbox's path 404; a made-up token 401 (`token`); the session cookie's value as a
#   bearer 401 (`purpose`); a guest cannot issue one or read one (403 `guest-scope`).
# - Rotate, from the console's path: the old token answers 401 `token` naming `rotated` on the next
#   request, the new one works, and `ApiTokenRotated` reaches the activity feed.
# - The per-token limit: within one minute's window, exactly the limit's requests pass and the next
#   is 429 `rate-limit` with `Retry-After`; the cookie's session is not slowed by it.
# - The tour's curl: the copyable command `apps/web/src/lib/tour.ts` builds for the reference
#   page's `get-menu` (its path read from the OpenAPI document) runs as written with the token.
# - The wipe, with the token itself (`DELETE`, no cookie set in the answer): the token then
#   answers 404 (410 while the wipe runs): it dies with the sandbox. scripts/list-objects.mjs
#   exits 0, and the Worker's log holds each token's `tid` and never a token.
#
# It prints ok or FAIL per check as scripts/smoke-crm.sh does, and exits non-zero on any failure.
# A run takes about three minutes, most of it the build and the wait for a fresh rate-limit window.
#
# Usage: scripts/smoke-token.sh   (from anywhere; needs cargo, worker-build, pnpm, node 22 and curl).
#
# Like scripts/smoke-crm.sh it writes a throwaway workers/api/.dev.vars, refuses to run when one
# exists unless SMOKE_TOKEN_OVERWRITE=1, starts the fake providers (Turnstile) on 8790 and the fake
# Stripe on 8791, and keeps the Worker's log in SMOKE_TOKEN_LOG=<file> when set. Every key in the
# .dev.vars is a test-shaped fake.
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

# The children a sandbox has once seeded: 35 through PR 8 and 10, 36 once PR 9's dispatch is
# merged (its `Dispatch` object). The one count here that PR 9 moves.
CHILDREN=35
# TOKEN_LIMIT in workers/api/wrangler.jsonc: requests a minute per token, the session's command
# rate (COMMAND_LIMIT).
TOKEN_LIMIT_PER_MINUTE=60

# The fake's own test-shaped values, as its header lists them. Not secrets.
STRIPE_KEY="rk_test_not_a_key"
WEBHOOK_SECRET="whsec_not_a_secret"
PUBLISHABLE="pk_test_not_a_key"

TMP="$(mktemp -d -t smoke-token.XXXXXX)"
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
  if [[ -n "${SMOKE_TOKEN_LOG:-}" ]]; then cp "$LOG" "$SMOKE_TOKEN_LOG" 2>/dev/null || true; fi
  if (( FAILURES > 0 )); then
    mkdir -p "${TMPDIR:-/tmp}/smoke-token-logs"
    cp "$LOG" "${TMPDIR:-/tmp}/smoke-token-logs/worker.log" 2>/dev/null || true
    echo "logs kept in ${TMPDIR:-/tmp}/smoke-token-logs" >&2
  fi
  rm -rf "$TMP"
}
trap stop EXIT

pass() { printf 'ok    %s\n' "$1"; PASSES=$((PASSES + 1)); }
fail() { printf 'FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }

if [[ -e "$DEV_VARS" ]]; then
  if [[ -z "${SMOKE_TOKEN_OVERWRITE:-}" ]]; then
    echo "workers/api/.dev.vars exists; this script would replace it. Move it aside, or set SMOKE_TOKEN_OVERWRITE=1 to have it moved and restored." >&2
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

# ---------- helpers (as in scripts/smoke-crm.sh) ----------

request() {
  local name="$1"; shift
  curl -sS -o "$TMP/$name.body" -D "$TMP/$name.raw" "$@" || true
  tr -d '\r' < "$TMP/$name.raw" | awk 'NR == 1 { print; next } { i = index($0, ":"); if (i) print tolower(substr($0, 1, i - 1)) substr($0, i) }' > "$TMP/$name.headers"
}
status_of() { head -n 1 "$TMP/$1.headers" | awk '{ print $2 }'; }
header_of() { grep -m 1 "^$2:" "$TMP/$1.headers" | cut -d: -f2- | sed 's/^ //' || true; }
has_header() { grep -q "^$2:" "$TMP/$1.headers"; }
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
# expect_token_problem NAME STATUS RULE: problem `token`, its detail naming the rule.
expect_token_problem() {
  expect_problem "$1" "$2" token
  expect_json "$1" "b.detail.endsWith('The rule is $3.')"
}
# no_cors NAME: no CORS header and no cookie on an answer to a request with a token.
no_cors() {
  if grep -q '^access-control-' "$TMP/$1.headers" || has_header "$1" set-cookie; then
    fail "$1: a CORS header or a cookie on a token's answer ($(grep -E '^(access-control-|set-cookie)' "$TMP/$1.headers" | cut -c1-80 | tr '\n' ' '))"
  else
    pass "$1: no CORS header and no cookie"
  fi
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
# bearer_as NAME TOKEN METHOD PATH [JSON] [CURL ARGS...]: `curl` as a visitor's script sends it:
# the token in Authorization, no cookie, no Origin, a fresh Idempotency-Key on POST (or $KEY).
bearer_as() {
  local name="$1" token="$2" method="$3" path="$4" body="${5:-}"; shift 5 || shift $#
  local args=(-X "$method" -H "Authorization: Bearer $token" -H "CF-Connecting-IP: 192.0.2.240")
  if [[ "$method" == POST ]]; then args+=(-H "Idempotency-Key: ${KEY:-$(ulid)}"); fi
  if [[ -n "$body" ]]; then args+=(-H 'Content-Type: application/json' --data "$body"); fi
  request "$name" "${args[@]}" "$@" "$BASE$path"
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
# bearer_until NAME TOKEN PATH EXPR [TRIES]: polls GET PATH with the token until EXPR holds over it
# (`b`), 0.25 s apart. Every poll spends the token's limit, so TRIES stays small.
bearer_until() {
  local name="$1" token="$2" path="$3" expr="$4" tries="${5:-20}"
  for _ in $(seq 1 "$tries"); do
    bearer_as "$name" "$token" GET "$path"
    if node -e "const b = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); if (!($expr)) process.exit(1)" "$TMP/$name.body" 2>/dev/null; then return 0; fi
    sleep 0.25
  done
  return 1
}
log_has() { grep -qF -- "$1" "$LOG"; }

# A token's id, read from its payload (base64url JSON, signed, not encrypted).
tid_of() { node -e "process.stdout.write(JSON.parse(Buffer.from(process.argv[1].split('.')[0], 'base64url').toString()).tid)" "$1"; }

stripe_call() {
  local name="$1" method="$2" path="$3" form="${4:-}"
  local args=(-X "$method" -H "Authorization: Bearer $STRIPE_KEY")
  if [[ -n "$form" ]]; then args+=(-H 'Content-Type: application/x-www-form-urlencoded' --data "$form"); fi
  request "$name" "${args[@]}" "$STRIPE$path"
}
intent_of() { json_field "$1" "b.client_secret.split('_secret_')[0]"; }

# order_json MENU_NAME: a pickup order the menu in MENU_NAME.body sells, at the first slot about
# four hours out that the day's Schedule takes (as scripts/smoke-payments.sh picks it).
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
    const now = Date.now();
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
      console.log(JSON.stringify({ kind: 'pickup', slot: iso(slot), lines: [{ variant: v.slug, qty: 1 }] }));
      process.exit(0);
    }
    process.exit(1);" "$TMP/$1.body"
}
# Today's bakery day in America/Denver: the schedule's first day.
today() { node -e "const o = {}; for (const p of new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())) o[p.type] = p.value; process.stdout.write(o.year + '-' + o.month + '-' + o.day)"; }

write_dev_vars() {
  {
    echo "# Written by scripts/smoke-token.sh for one run; removed when it ends. Never committed."
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

# ---------- a guest's sandbox and a demo account's ----------

command_as guest G 192.0.2.91 POST /v1/sandboxes '{"turnstile_token":"pass-1","replace":false}'
expect_status guest 201
GID="$(json_field guest b.id)"
command_as signup D 192.0.2.92 POST /v1/auth/demo "{\"password\":\"$(random_text 24)\",\"turnstile_token\":\"pass-1\"}"
expect_status signup 201
command_as sandbox D 192.0.2.92 POST /v1/sandboxes '{"replace":false}'
expect_status sandbox 201
DID="$(json_field sandbox b.id)"
check "guest: seeding reaches live" "wait_live guest_live G '$GID'"
check "demo: seeding reaches live" "wait_live demo_live D '$DID'"
expect_json demo_live "b.children >= $CHILDREN && b.token_v === 0"

# ---------- a guest has no token ----------

command_as g_issue G 192.0.2.91 POST "/v1/sandboxes/$GID/token"
expect_problem g_issue 403 guest-scope
get_as g_info G "/v1/sandboxes/$GID/token"
expect_problem g_info 403 guest-scope

# ---------- issue, over the console's path ----------

get_as info_0 D "/v1/sandboxes/$DID/token"
expect_status info_0 200
expect_json info_0 "b.token_v === 0 && b.masked === undefined && b.issued_at === undefined"
ISSUE_KEY="$(ulid)"
KEY="$ISSUE_KEY" command_as issue D 192.0.2.92 POST "/v1/sandboxes/$DID/token"
expect_status issue 200
expect_json issue "/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(b.token) && b.token_v === 0 && Date.parse(b.expires_at) - Date.parse(b.issued_at) === 86400000 && Object.keys(b).sort().join() === 'expires_at,issued_at,token,token_v'"
TOKEN="$(json_field issue b.token)"
TID="$(tid_of "$TOKEN")"
check "the token's id is 128 random bits in hex: $TID" "[[ '$TID' =~ ^[0-9a-f]{32}$ ]]"
KEY="$ISSUE_KEY" command_as issue_again D 192.0.2.92 POST "/v1/sandboxes/$DID/token"
expect_status issue_again 200
expect_header issue_again idempotent-replayed true
check "the same key replays the same token" "[[ '$(json_field issue_again b.token)' == '$TOKEN' ]]"
get_as info_1 D "/v1/sandboxes/$DID/token"
expect_status info_1 200
MASKED="$(node -e "const t = process.argv[1]; process.stdout.write(t.slice(0, 6) + '…' + t.slice(-4))" "$TOKEN")"
expect_json info_1 "b.token_v === 0 && b.masked === '$MASKED' && b.issued_at === '$(json_field issue b.issued_at)' && b.expires_at === '$(json_field issue b.expires_at)'"
check "GET shows the token masked, never whole" "! grep -qF -- '$TOKEN' '$TMP/info_1.body'"

# ---------- curl with the token: no cookie, no Origin ----------

bearer_as b_sandbox "$TOKEN" GET "/v1/sandboxes/$DID"
expect_status b_sandbox 200
expect_json b_sandbox "b.id === '$DID' && b.state === 'live'"
no_cors b_sandbox
bearer_as b_menu "$TOKEN" GET "/v1/sandboxes/$DID/menu"
expect_status b_menu 200
expect_json b_menu "Array.isArray(b.categories) && b.categories.length > 0"
DAY="$(today)"
bearer_as b_schedule "$TOKEN" GET "/v1/sandboxes/$DID/schedule/$DAY"
expect_status b_schedule 200
expect_json b_schedule "b.date === '$DAY' && Array.isArray(b.slots)"
bearer_as b_info "$TOKEN" GET "/v1/sandboxes/$DID/token"
expect_status b_info 200
expect_json b_info "b.token_v === 0 && b.masked === '$MASKED'"
# With the storefront's Origin too: a token's answer carries no CORS header whatever it sends.
bearer_as b_origin "$TOKEN" GET "/v1/sandboxes/$DID/menu" "" -H "Origin: $STOREFRONT"
expect_status b_origin 200
no_cors b_origin
ORDER="$(order_json b_menu)" || ORDER='{}'
bearer_as b_place "$TOKEN" POST "/v1/sandboxes/$DID/orders" "$ORDER"
expect_status b_place 201
no_cors b_place
OID="$(json_field b_place b.id)"
KEY="$OID" bearer_as b_pay "$TOKEN" POST "/v1/sandboxes/$DID/orders/$OID/payment"
expect_status b_pay 200
expect_json b_pay "/^pi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+$/.test(b.client_secret) && b.status === 'created'"
no_cors b_pay
stripe_call confirm POST "/v1/payment_intents/$(intent_of b_pay)/confirm" "payment_method=pm_card_visa"
expect_json confirm "b.status === 'succeeded'"
check "the order the token placed and paid reads confirmed, read with the token" "bearer_until b_paid '$TOKEN' '/v1/sandboxes/$DID/orders/$OID' \"b.status === 'confirmed'\""

# ---------- the request-level refusals ----------

request q_named -H "CF-Connecting-IP: 192.0.2.240" "$BASE/v1/sandboxes/$DID/menu?access_token=$TOKEN"
expect_token_problem q_named 400 query
request q_shaped -H "CF-Connecting-IP: 192.0.2.240" "$BASE/v1/sandboxes/$DID/menu?x=$TOKEN"
expect_token_problem q_shaped 400 query
request q_with_bearer -H "Authorization: Bearer $TOKEN" "$BASE/v1/sandboxes/$DID/menu?token=1"
expect_token_problem q_with_bearer 400 query
get_as both D "/v1/sandboxes/$DID/menu" -H "Authorization: Bearer $TOKEN"
expect_token_problem both 400 both
bearer_as on_session "$TOKEN" GET /v1/session
expect_token_problem on_session 401 cookie-only
bearer_as on_signout "$TOKEN" POST /v1/auth/signout
expect_token_problem on_signout 401 cookie-only
bearer_as on_issue "$TOKEN" POST "/v1/sandboxes/$DID/token"
expect_token_problem on_issue 401 cookie-only
bearer_as on_rotate "$TOKEN" POST "/v1/sandboxes/$DID/token/rotate"
expect_token_problem on_rotate 401 cookie-only
bearer_as other_sandbox "$TOKEN" GET "/v1/sandboxes/$GID"
expect_status other_sandbox 404
bearer_as made_up "eyJ2IjoxfQ.$(random_text 43)" GET "/v1/sandboxes/$DID/menu"
expect_token_problem made_up 401 token
COOKIE_VALUE="$(grep '^__Host-session=' "$TMP/D.jar" | cut -d= -f2-)"
bearer_as cookie_as_bearer "$COOKIE_VALUE" GET "/v1/sandboxes/$DID/menu"
expect_token_problem cookie_as_bearer 401 purpose
get_as info_still D "/v1/sandboxes/$DID/token"
expect_json info_still "b.token_v === 0"
check "the token could not rotate itself: the version is still 0" "[[ '$(json_field info_still b.token_v)' == 0 ]]"

# ---------- rotate, over the console's path ----------

command_as rotate D 192.0.2.92 POST "/v1/sandboxes/$DID/token/rotate"
expect_status rotate 200
expect_json rotate "b.token_v === 1 && /^eyJ/.test(b.token)"
TOKEN2="$(json_field rotate b.token)"
TID2="$(tid_of "$TOKEN2")"
# Compared by id: no check's line prints a token.
check "the rotated token is a new one: $TID2" "[[ '$TID2' != '$TID' && \"\$TOKEN2\" != \"\$TOKEN\" ]]"
bearer_as old_after_rotate "$TOKEN" GET "/v1/sandboxes/$DID/menu"
expect_token_problem old_after_rotate 401 rotated
bearer_as new_after_rotate "$TOKEN2" GET "/v1/sandboxes/$DID/menu"
expect_status new_after_rotate 200
check "ApiTokenRotated reaches the activity feed" "bearer_until b_activity '$TOKEN2' '/v1/sandboxes/$DID/activity?limit=20' \"b.entries.some(e => e.type === 'ApiTokenRotated')\" 20"
get_as info_2 D "/v1/sandboxes/$DID/token"
expect_json info_2 "b.token_v === 1 && b.masked === '$(node -e "const t = process.argv[1]; process.stdout.write(t.slice(0, 6) + '…' + t.slice(-4))" "$TOKEN2")'"

# ---------- the per-token limit ----------

# The local limiter counts in windows aligned to the wall clock's minute, so the flood starts
# just after one begins and is over long before it ends.
node -e "const ms = 60000 - (Date.now() % 60000) + 300; setTimeout(() => {}, ms)"
OK_COUNT=0
LIMITED=""
for n in $(seq 1 $(( TOKEN_LIMIT_PER_MINUTE + 5 ))); do
  bearer_as flood "$TOKEN2" GET "/v1/sandboxes/$DID"
  case "$(status_of flood)" in
    200) OK_COUNT=$((OK_COUNT + 1)) ;;
    429) LIMITED="$n"; break ;;
    *) break ;;
  esac
done
check "the limit lets exactly $TOKEN_LIMIT_PER_MINUTE of a token's requests through in a minute: $OK_COUNT" "(( OK_COUNT == TOKEN_LIMIT_PER_MINUTE ))"
check "and refuses the next: request $LIMITED" "[[ '$LIMITED' == $(( TOKEN_LIMIT_PER_MINUTE + 1 )) ]]"
expect_problem flood 429 rate-limit
expect_header flood retry-after 60
no_cors flood
get_as cookie_while_limited D "/v1/sandboxes/$DID/menu"
expect_status cookie_while_limited 200

# ---------- the tour's curl, as written ----------

command_as issue_3 D 192.0.2.92 POST "/v1/sandboxes/$DID/token"
expect_status issue_3 200
expect_json issue_3 "b.token_v === 1"
TOKEN3="$(json_field issue_3 b.token)"
TID3="$(tid_of "$TOKEN3")"
check "a token issued again at the same version has a new id" "[[ '$TID3' != '$TID2' ]]"
TOUR_CURL="$(cd "$ROOT/apps/web" && node --experimental-strip-types --no-warnings --input-type=module -e "
  import { readFileSync } from 'node:fs';
  import { curlText } from './src/lib/tour.ts';
  const doc = JSON.parse(readFileSync('public/docs/api/openapi.json', 'utf8'));
  const [path, item] = Object.entries(doc.paths).find(([, ops]) => ops.get?.operationId === 'get-menu');
  if (!item.get.security.some((s) => 'bearerToken' in s)) process.exit(1);
  process.stdout.write(curlText({ routeId: 'get-menu', method: 'GET', path }, { origin: process.argv[1], sandboxId: process.argv[2], token: process.argv[3], key: process.argv[4] }, 'copy'));
" "$BASE" "$DID" "$TOKEN3" "$(ulid)")" || TOUR_CURL=""
check "the tour builds get-menu's curl from the document's path, with the token" "[[ \"\$TOUR_CURL\" == *'/v1/sandboxes/$DID/menu'* && \"\$TOUR_CURL\" == *\"Authorization: Bearer \$TOKEN3\"* ]]"
(eval "$TOUR_CURL") > "$TMP/tour.body" 2> "$TMP/tour.err" || true
check "the tour's curl runs as written and answers the menu" "node -e \"const b = JSON.parse(require('fs').readFileSync('$TMP/tour.body', 'utf8')); process.exit(Array.isArray(b.categories) && b.categories.length > 0 ? 0 : 1)\""

# ---------- the wipe, with the token itself ----------

bearer_as b_wipe "$TOKEN3" DELETE "/v1/sandboxes/$DID"
expect_status b_wipe 200
expect_json b_wipe "b.id === '$DID' && b.state === 'wiped'"
no_cors b_wipe
bearer_as dead_sandbox "$TOKEN3" GET "/v1/sandboxes/$DID"
check "after the wipe the token answers 404 (410 while wiping): $(status_of dead_sandbox)" "[[ '$(status_of dead_sandbox)' == 404 || '$(status_of dead_sandbox)' == 410 ]]"
bearer_as dead_menu "$TOKEN3" GET "/v1/sandboxes/$DID/menu"
check "and on the menu: $(status_of dead_menu)" "[[ '$(status_of dead_menu)' == 404 || '$(status_of dead_menu)' == 410 ]]"
bearer_as dead_order "$TOKEN3" POST "/v1/sandboxes/$DID/orders" "$ORDER"
check "and on an order: $(status_of dead_order)" "[[ '$(status_of dead_order)' == 404 || '$(status_of dead_order)' == 410 ]]"
# The token's wipe set no cookie, so the console's cookie still names the sandbox: it reads 410.
get_as cookie_after D "/v1/sandboxes/$DID"
expect_problem cookie_after 410 wiped
command_as wipe_g G 192.0.2.91 DELETE "/v1/sandboxes/$GID"
expect_status wipe_g 200
sleep 1
set +e
node "$ROOT/scripts/list-objects.mjs" "$STATE" > "$TMP/list.out" 2> "$TMP/list.err"
LIST_EXIT=$?
set -e
check "list-objects exits 0 after the wipe" "(( LIST_EXIT == 0 )) && grep -q '\"class\":\"Sandbox\"' '$TMP/list.out'"

# ---------- what the log holds ----------

runtime_log="$TMP/runtime.log"
awk '/^=== Worker ready/ { on = 1 } on' "$LOG" > "$runtime_log"
check "the Worker's log holds no token" "! grep -qF -- '$TOKEN' '$runtime_log' && ! grep -qF -- '$TOKEN2' '$runtime_log' && ! grep -qF -- '$TOKEN3' '$runtime_log' && ! grep -q 'eyJ2Ij' '$runtime_log' && ! grep -qF 'Bearer' '$runtime_log'"
check "it names each token by its id" "grep -qF '\"tid\":\"$TID\"' '$runtime_log' && grep -qF '\"tid\":\"$TID2\"' '$runtime_log' && grep -qF '\"tid\":\"$TID3\"' '$runtime_log'"
check "with the refusals' reason codes" "grep -q '\"status\":401.*\"reason\":\"rotated\"' '$runtime_log' && grep -q '\"status\":400.*\"reason\":\"query\"' '$runtime_log' && grep -q '\"status\":429.*\"reason\":\"token-limit\"' '$runtime_log'"
check "no delivery dead-lettered" "! log_has '\"event\":\"dlq\"'"

echo
if (( FAILURES > 0 )); then
  echo "$PASSES passed, $FAILURES failed"
  exit 1
fi
echo "all $PASSES checks passed"
