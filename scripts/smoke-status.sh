#!/usr/bin/env bash
# Smoke-tests PR 13's API half on `wrangler dev` against scripts/fake-analytics.mjs: the status
# page's counters (docs/roadmap.md, PR 13; docs/operations.md, "Observability").
#
# On `wrangler dev` the METRICS binding accepts a point and stores nothing a script can read, so
# this proves the snapshot path, not the points:
#
# - No token: `GET /v1/status` answers `counters: null`, `counters_as_of: null` and
#   `counters_state: "unavailable"`; the 15-minute cron logs `analytics_unconfigured` naming
#   ANALYTICS_API_TOKEN and sends the fake nothing. A guest sandbox is still admitted (the
#   `sandbox_created` point never fails the request) and the 10:00 UTC wipe logs `wipe_point`
#   with that sandbox, so both point writes ran without `metrics_error`.
# - A refresh against the fake, through /cdn-cgi/local/scheduled as the other smokes trigger
#   crons: the counters are the fake's rows, `counters_as_of` is an RFC 3339 UTC time of the run,
#   the state is `live`, and new rows show at the next refresh.
# - The fake's request log: two kept queries per refresh (counts_24h, then last_wipe), each a
#   POST of SQL over bakery_events to the
#   account's path with `Authorization: Bearer` and the expected token; the Worker's log holds
#   neither the token nor the account id nor a query's text.
# - A failing fake (500) and a slow one (past the 5 s timeout): the old counters and
#   `counters_as_of` stay, the state is `stale`, and `analytics_failed` names the status or
#   `timeout`; a good refresh after makes it `live` again.
# - The route: public, no session needed; the storefront's origin gets the credentialed CORS
#   headers and a preflight, as every public route; `Cache-Control: no-store` and the API's other
#   headers, so neither the browser nor Cloudflare keeps an answer older than the snapshot's own
#   `counters_as_of` says.
#
# It prints ok or FAIL per check as scripts/smoke-crm.sh does, and exits non-zero on any failure.
# Usage: scripts/smoke-status.sh   (from anywhere; needs cargo, worker-build, pnpm, node 22, curl).
#
# Like the other smokes it writes a throwaway workers/api/.dev.vars, refuses to run when one exists
# unless SMOKE_STATUS_OVERWRITE=1, starts the fake providers (Turnstile) on 8790 and the fake
# Analytics Engine on 8792, and keeps the Worker's log in SMOKE_STATUS_LOG=<file> when set. The
# token and account id are the fake's own fakes, not secrets.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SMOKE_PORT:-8788}"
FAKE_PORT="${SMOKE_FAKE_PORT:-8790}"
AE_PORT="${SMOKE_AE_PORT:-8792}"
BASE="http://127.0.0.1:${PORT}"
FAKE="http://127.0.0.1:${FAKE_PORT}"
AE="http://127.0.0.1:${AE_PORT}"
STOREFRONT="http://127.0.0.1:8787"
STARTUP_TIMEOUT_S="${STARTUP_TIMEOUT_S:-240}"
DEV_VARS="$ROOT/workers/api/.dev.vars"
SWEEP_CRON="$BASE/cdn-cgi/local/scheduled?cron=*/15+*+*+*+*"
WIPE_CRON="$BASE/cdn-cgi/local/scheduled?cron=0+10+*+*+*"

# The fake's own values (scripts/fake-analytics.mjs), not secrets.
AE_TOKEN="fake-analytics-token"
AE_ACCOUNT="0000000000000000000000000000fake"

TMP="$(mktemp -d -t smoke-status.XXXXXX)"
LOG="$TMP/worker.log"
FAKE_LOG="$TMP/fake.log"
AE_LOG="$TMP/ae.log"
STATE="$TMP/state"
FAILURES=0
PASSES=0
SERVER_PID=""
FAKE_PID=""
AE_PID=""
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
  stop_pid "$AE_PID"
  if [[ -n "$WROTE_DEV_VARS" ]]; then rm -f "$DEV_VARS"; fi
  if [[ -n "$BACKUP" && -f "$BACKUP" ]]; then mv "$BACKUP" "$DEV_VARS"; fi
  if [[ -n "${SMOKE_STATUS_LOG:-}" ]]; then cp "$LOG" "$SMOKE_STATUS_LOG" 2>/dev/null || true; fi
  if (( FAILURES > 0 )); then
    mkdir -p "${TMPDIR:-/tmp}/smoke-status-logs"
    cp "$LOG" "$AE_LOG" "${TMPDIR:-/tmp}/smoke-status-logs/" 2>/dev/null || true
    echo "logs kept in ${TMPDIR:-/tmp}/smoke-status-logs" >&2
  fi
  rm -rf "$TMP"
}
trap stop EXIT

pass() { printf 'ok    %s\n' "$1"; PASSES=$((PASSES + 1)); }
fail() { printf 'FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }

if [[ -e "$DEV_VARS" ]]; then
  if [[ -z "${SMOKE_STATUS_OVERWRITE:-}" ]]; then
    echo "workers/api/.dev.vars exists; this script would replace it. Move it aside, or set SMOKE_STATUS_OVERWRITE=1 to have it moved and restored." >&2
    exit 2
  fi
  BACKUP="$TMP/dev.vars.backup"
  mv "$DEV_VARS" "$BACKUP"
fi
for p in "$PORT" "$FAKE_PORT" "$AE_PORT"; do
  if curl -s -o /dev/null "http://127.0.0.1:$p/" 2>/dev/null; then
    echo "something already listens on port $p; stop it or set SMOKE_PORT / SMOKE_FAKE_PORT / SMOKE_AE_PORT" >&2
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
json_field() { node -e "const b = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); const v = ($2); process.stdout.write(v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v))" "$TMP/$1.body"; }
log_has() { grep -qF -- "$1" "$LOG"; }
log_count() { grep -cF -- "$1" "$LOG" || true; }
# wait_log TEXT: up to 10 s for a line holding TEXT, since workerd's lines reach the file late.
wait_log() { for _ in $(seq 1 50); do log_has "$1" && return 0; sleep 0.2; done; return 0; }
random_text() { node -e "process.stdout.write(require('crypto').randomBytes(64).toString('base64').replace(/[^A-Za-z0-9]/g,'').slice(0, $1))"; }
ulid() {
  node -e "const A='0123456789ABCDEFGHJKMNPQRSTVWXYZ';let t=Date.now(),s='';for(let i=0;i<10;i++){s=A[t%32]+s;t=Math.floor(t/32)}const r=require('crypto').randomBytes(16);for(let i=0;i<16;i++)s+=A[r[i]%32];process.stdout.write(s)"
}
now_ms() { node -e 'console.log(Date.now())'; }

# The status route as the storefront's page reads it: GET with the storefront's Origin and no
# cookie, so it proves the route needs no session.
status() { request "$1" -H "Origin: $STOREFRONT" -H "CF-Connecting-IP: 192.0.2.90" "$BASE/v1/status"; }
# One run of the 15-minute cron; the request returns when the handler has finished.
sweep() { request "$1" "$SWEEP_CRON"; }
# ae NAME METHOD BODY PATH: one call to the fake's controls.
ae() {
  local args=(-sS -o "$TMP/$1.body" -X "$2")
  if [[ -n "$3" ]]; then args+=(-H 'Content-Type: application/json' --data "$3"); fi
  curl "${args[@]}" "$AE$4"
}

# The API's headers on every answer (scripts/smoke-api.sh), and the storefront's CORS.
expect_public_headers() {
  local name="$1"
  expect_header "$name" content-type "application/json"
  expect_header "$name" cache-control "no-store"
  expect_header "$name" x-content-type-options "nosniff"
  expect_header "$name" vary "Origin"
  expect_header "$name" access-control-allow-origin "$STOREFRONT"
  expect_header "$name" access-control-allow-credentials "true"
}

write_dev_vars() {
  {
    echo "# Written by scripts/smoke-status.sh for one run; removed when it ends. Never committed."
    echo "SESSION_HMAC_KEY=$(random_text 48)"
    echo "ACCOUNT_HMAC_KEY=$(random_text 48)"
    echo "TURNSTILE_SECRET=1x0000000000000000000000000000000AA"
    echo "TURNSTILE_SITEVERIFY_URL=$FAKE/turnstile/siteverify"
    echo "ALLOWED_ORIGIN=$STOREFRONT"
    echo "API_ORIGIN=$BASE"
    if [[ "${1:-}" == analytics ]]; then
      echo "ANALYTICS_API_BASE=$AE"
      echo "ANALYTICS_API_TOKEN=$AE_TOKEN"
      echo "ANALYTICS_ACCOUNT_ID=$AE_ACCOUNT"
    fi
  } > "$DEV_VARS"
  WROTE_DEV_VARS=1
}

if [[ -n "${WRANGLER:-}" ]]; then run_wrangler=(npx --yes "$WRANGLER"); else run_wrangler=(pnpm exec wrangler); fi

# start_worker [analytics]: the Worker on the same state directory each time, so Control's
# snapshot outlives a restart as it outlives a deploy.
start_worker() {
  write_dev_vars "${1:-}"
  echo "--- starting ${run_wrangler[*]} dev on $BASE (${1:-no analytics secrets})"
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
}
stop_worker() { stop_pid "$SERVER_PID"; SERVER_PID=""; }

echo "--- starting the fakes on $FAKE and $AE"
set -m
node "$ROOT/scripts/fake-providers.mjs" --port "$FAKE_PORT" > "$FAKE_LOG" 2>&1 < /dev/null &
FAKE_PID=$!
node "$ROOT/scripts/fake-analytics.mjs" --port "$AE_PORT" > "$AE_LOG" 2>&1 < /dev/null &
AE_PID=$!
set +m
for url in "$FAKE/_health" "$AE/_health"; do
  for _ in $(seq 1 50); do curl -s -o /dev/null "$url" && break; sleep 0.1; done
done

# ---------- no token: unavailable ----------

start_worker
status none
expect_status none 200
expect_public_headers none
expect_json none "b.counters === null && b.counters_as_of === null && b.counters_state === 'unavailable'"
expect_json none "Object.keys(b).join(',') === 'day,sandboxes_today,sandbox_cap,guests_today,guest_cap,demo_accounts_today,demo_account_cap,counters,counters_as_of,counters_state,breaker,flag'"

request preflight -X OPTIONS -H "Origin: $STOREFRONT" -H "Access-Control-Request-Method: GET" "$BASE/v1/status"
expect_status preflight 204
expect_header preflight access-control-allow-origin "$STOREFRONT"
expect_header preflight access-control-allow-credentials "true"

sweep cron_none
expect_status cron_none 200
wait_log '"event":"analytics_unconfigured"'
check "the cron logs analytics_unconfigured naming ANALYTICS_API_TOKEN" "log_has '\"event\":\"analytics_unconfigured\",\"var\":\"ANALYTICS_API_TOKEN\"'"
ae requests_none GET "" /_requests
check "the fake was sent nothing without a token" "[[ \"\$(json_field requests_none b.length)\" == 0 ]]"
status none_after
expect_json none_after "b.counters === null && b.counters_state === 'unavailable'"

# The points' writes never fail what wrote them: a guest's admission (sandbox_created) and the
# nightly wipe's end (wipe).
request guest -X POST -H "Origin: $STOREFRONT" -H "CF-Connecting-IP: 192.0.2.91" \
  -H "Idempotency-Key: $(ulid)" -H 'Content-Type: application/json' \
  --data '{"turnstile_token":"pass-1","replace":false}' "$BASE/v1/sandboxes"
expect_status guest 201
status admitted
expect_json admitted "b.sandboxes_today === 1 && b.guests_today === 1"
request cron_wipe "$WIPE_CRON"
expect_status cron_wipe 200
wait_log '"event":"wipe_point"'
check "the wipe's end logs wipe_point with the one sandbox" "log_has '\"event\":\"wipe_point\",\"sandboxes\":1,'"
check "no point write was refused or unbound" "! log_has '\"event\":\"metrics_error\"' && ! log_has '\"event\":\"metrics_unbound\"'"
stop_worker

# ---------- a refresh against the fake: live ----------

start_worker analytics
ae reset POST "" /_reset
before_ms="$(now_ms)"
sweep cron_live
expect_status cron_live 200
after_ms="$(now_ms)"
status live
expect_status live 200
expect_public_headers live
expect_json live "b.counters_state === 'live' && b.counters.sandboxes_24h === 7 && b.counters.orders_24h === 12 && b.counters.payments_24h === 10 && b.counters.payment_failures_24h === 2 && b.counters.refunds_24h === 1 && b.counters.dlq_24h === 0"
expect_json live "b.counters.last_wipe.at === '2026-11-06T10:00:04Z' && b.counters.last_wipe.sandboxes === 7 && b.counters.last_wipe.objects === 133 && b.counters.last_wipe.ms === 4210"
expect_json live "/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/.test(b.counters_as_of) && Date.parse(b.counters_as_of) >= $before_ms - 1000 && Date.parse(b.counters_as_of) <= $after_ms + 1000"
expect_json live "Object.keys(b.counters).join(',') === 'orders_24h,payments_24h,payment_failures_24h,refunds_24h,sandboxes_24h,dlq_24h,last_wipe'"
wait_log '"event":"analytics_refreshed","queries":2,'
check "the cron logs analytics_refreshed with two queries" "log_has '\"event\":\"analytics_refreshed\",\"queries\":2,'"
LIVE_AS_OF="$(json_field live b.counters_as_of)"

ae requests_live GET "" /_requests
expect_json requests_live "b.length === 2 && b.every((r) => r.method === 'POST' && r.status === 200 && r.account === 'ok' && r.auth_scheme === 'Bearer' && r.token_ok === true && /FROM bakery_events/.test(r.sql) && /FORMAT JSON\$/.test(r.sql))"
expect_json requests_live "b.map((r) => r.query).join(',') === 'counts_24h,last_wipe'"
check "the fake's count answer had no dlq row, read as 0 (a missing name is 0)" "curl -s '$AE/_rows' | node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>process.exit(JSON.parse(s).dlq_24h === 0 ? 0 : 1))'"
expect_json requests_live "b.every((r) => !JSON.stringify(r).includes('$AE_TOKEN'))"
check "the Worker's log holds neither the token nor the account id" "! log_has '$AE_TOKEN' && ! log_has '$AE_ACCOUNT'"
check "the Worker's log holds no query text" "! log_has 'FROM bakery_events' && ! log_has '_sample_interval'"
check "no analytics_base_refused for the loopback fake" "! log_has '\"event\":\"analytics_base_refused\"'"

# New rows show at the next refresh, and a dataset with no wipe yet reads as null.
ae rows POST '{"orders_24h":40,"payments_24h":38,"dlq_24h":3,"last_wipe":null}' /_rows
sweep cron_rows
status rows_live
expect_json rows_live "b.counters_state === 'live' && b.counters.orders_24h === 40 && b.counters.payments_24h === 38 && b.counters.dlq_24h === 3 && b.counters.last_wipe === null"
ROWS_AS_OF="$(json_field rows_live b.counters_as_of)"
check "the second refresh moved counters_as_of" "[[ '$ROWS_AS_OF' > '$LIVE_AS_OF' ]]"

# ---------- a failing fake: stale, the old values kept ----------

ae fail POST '{"status":500}' /_fail
ae rows2 POST '{"orders_24h":99}' /_rows
sweep cron_fail
expect_status cron_fail 200
status stale
expect_status stale 200
expect_public_headers stale
expect_json stale "b.counters_state === 'stale' && b.counters.orders_24h === 40 && b.counters.dlq_24h === 3 && b.counters_as_of === '$ROWS_AS_OF'"
wait_log '"status":500,'
check "analytics_failed names the query and status 500" "log_has '\"event\":\"analytics_failed\",\"query\":\"counts_24h\",\"reason\":\"status\",\"status\":500,'"
expect_json stale "!('reason' in b) && !('error' in b) && !JSON.stringify(b).includes('fake failure')"

# Only the second query failing: the line names last_wipe, and the counts read before it are
# not stored either, so the snapshot stays whole.
ae fail_wipe POST '{"status":503,"query":"last_wipe"}' /_fail
sweep cron_fail_wipe
status stale_wipe
expect_json stale_wipe "b.counters_state === 'stale' && b.counters.orders_24h === 40 && b.counters_as_of === '$ROWS_AS_OF'"
wait_log '"status":503,'
check "analytics_failed names last_wipe and status 503" "log_has '\"event\":\"analytics_failed\",\"query\":\"last_wipe\",\"reason\":\"status\",\"status\":503,'"

ae unfail POST '{"status":0}' /_fail
sweep cron_back
status back
expect_json back "b.counters_state === 'live' && b.counters.orders_24h === 99"

# ---------- a slow fake: the 5 s timeout, stale ----------

BACK_AS_OF="$(json_field back b.counters_as_of)"
ae delay POST '{"ms":7000}' /_delay
t0="$(now_ms)"
sweep cron_slow
t1="$(now_ms)"
status slow
expect_json slow "b.counters_state === 'stale' && b.counters.orders_24h === 99 && b.counters_as_of === '$BACK_AS_OF'"
wait_log '"reason":"timeout"'
check "analytics_failed says timeout" "log_has '\"reason\":\"timeout\",\"status\":null'"
check "the refresh gave up after about 5 s, not 7 ($(( t1 - t0 )) ms)" "(( t1 - t0 >= 4500 && t1 - t0 < 6900 ))"
ae undelay POST '{"ms":0}' /_delay

# ---------- the secrets removed: the refresh is skipped, the snapshot kept ----------

stop_worker
before_requests="$(curl -s "$AE/_requests" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).length))')"
start_worker
sweep cron_removed
status removed
expect_json removed "b.counters_state === 'stale' && b.counters.orders_24h === 99"
after_requests="$(curl -s "$AE/_requests" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).length))')"
check "no query was sent without the secrets" "[[ '$before_requests' == '$after_requests' ]]"
# Six refreshes reached the fake: four whole (live, new rows, last_wipe failing, back) at two
# queries each, and two that stopped at counts_24h (the 500 and the timeout) at one.
check "two queries per refresh, none after a failure ($after_requests in all)" "(( after_requests == 4 * 2 + 2 * 1 ))"
for _ in $(seq 1 50); do (( $(log_count '"event":"analytics_unconfigured"') >= 2 )) && break; sleep 0.2; done
UNCONFIGURED="$(log_count '"event":"analytics_unconfigured"')"
check "analytics_unconfigured was logged again ($UNCONFIGURED in all)" "(( UNCONFIGURED >= 2 ))"
check "the token never reached the Worker's log" "! log_has '$AE_TOKEN'"

echo
if (( FAILURES > 0 )); then
  echo "$PASSES passed, $FAILURES failed"
  exit 1
fi
echo "all $PASSES checks passed"
