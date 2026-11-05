#!/usr/bin/env bash
# Smoke-tests PR 3 on `wrangler dev` against the local fake provider: Google and GitHub sign-in,
# demo accounts, guest and account sandboxes, the caps, the nightly wipe and "Wipe now". It
# proves each line of docs/roadmap.md's PR 3 "Done when" that can be proven without the real
# providers, prints ok or FAIL per check as scripts/smoke-api.sh does, and exits non-zero on
# any failure.
#
# Usage: scripts/smoke-auth.sh   (from anywhere; needs cargo, worker-build, pnpm, node and curl).
#
# It writes a throwaway workers/api/.dev.vars (random keys, the fake's client ids, Turnstile's
# documented always-pass test secret, the loopback overrides) and removes it afterwards. It
# refuses to run when a .dev.vars exists, so a real one is never clobbered; with
# SMOKE_AUTH_OVERWRITE=1 it moves the existing file aside and puts it back on exit.
# SMOKE_AUTH_LOG=<file> keeps a copy of the Worker's log there.
#
# Two runs of the Worker, each with fresh object state in a scratch directory: the first with
# the default caps, the second with tiny caps to reach every refusal. The fake provider starts
# first and runs throughout: it draws a new signing key each start, so restarting it mid-run
# would only prove the key-set refetch. Curl talks plain http to 127.0.0.1, so cookies are
# carried by hand rather than by curl's jar, which keeps Secure cookies off http.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SMOKE_PORT:-8788}"
FAKE_PORT="${SMOKE_FAKE_PORT:-8790}"
BASE="http://127.0.0.1:${PORT}"
FAKE="http://127.0.0.1:${FAKE_PORT}"
STOREFRONT="http://127.0.0.1:8787"
STARTUP_TIMEOUT_S="${STARTUP_TIMEOUT_S:-240}"
DEV_VARS="$ROOT/workers/api/.dev.vars"

TMP="$(mktemp -d -t smoke-auth.XXXXXX)"
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
    # Each server leads its own process group, so this stops it and its children only.
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
  if [[ -n "${SMOKE_AUTH_LOG:-}" ]]; then cp "$LOG" "$SMOKE_AUTH_LOG" 2>/dev/null || true; fi
  if (( FAILURES > 0 )); then
    mkdir -p "${TMPDIR:-/tmp}/smoke-auth-logs"
    cp "$LOG" "${TMPDIR:-/tmp}/smoke-auth-logs/worker.log" 2>/dev/null || true
    cp "$FAKE_LOG" "${TMPDIR:-/tmp}/smoke-auth-logs/fake.log" 2>/dev/null || true
    echo "logs kept in ${TMPDIR:-/tmp}/smoke-auth-logs" >&2
  fi
  rm -rf "$TMP"
}
trap stop EXIT

pass() { printf 'ok    %s\n' "$1"; PASSES=$((PASSES + 1)); }
fail() { printf 'FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }

if [[ -e "$DEV_VARS" ]]; then
  if [[ -z "${SMOKE_AUTH_OVERWRITE:-}" ]]; then
    echo "workers/api/.dev.vars exists; this script would replace it. Move it aside, or set SMOKE_AUTH_OVERWRITE=1 to have it moved and restored." >&2
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

# ---------- helpers ----------

# request NAME [curl args...]: writes NAME.headers (lower-cased names, no CR) and NAME.body.
request() {
  local name="$1"; shift
  curl -sS -o "$TMP/$name.body" -D "$TMP/$name.raw" "$@" || true
  tr -d '\r' < "$TMP/$name.raw" | awk 'NR == 1 { print; next } { i = index($0, ":"); if (i) print tolower(substr($0, 1, i - 1)) substr($0, i) }' > "$TMP/$name.headers"
}
status_of() { head -n 1 "$TMP/$1.headers" | awk '{ print $2 }'; }
header_of() { grep -m 1 "^$2:" "$TMP/$1.headers" | cut -d: -f2- | sed 's/^ //' || true; }
set_cookie_of() { grep "^set-cookie: $2=" "$TMP/$1.headers" | head -n 1 | cut -d' ' -f2- || true; }
body_of() { cat "$TMP/$1.body"; }

expect_status() {
  local got; got="$(status_of "$1")"
  if [[ "$got" == "$2" ]]; then pass "$1: status $2"; else fail "$1: status $got, wanted $2 ($(head -c 300 "$TMP/$1.body"))"; fi
}
# expect_json NAME EXPR: EXPR is JavaScript over the parsed body `b`.
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
expect_location() {
  local got; got="$(header_of "$1" location)"
  if [[ "$got" == "$2" ]]; then pass "$1: location $2"; else fail "$1: location '$got', wanted '$2'"; fi
}
expect_no_session_cookie() {
  if [[ -z "$(set_cookie_of "$1" __Host-session)" ]]; then pass "$1: no __Host-session"; else fail "$1: sets __Host-session"; fi
}

# Cookie jars: one file per visitor, "name=value" lines, updated from a response's Set-Cookie.
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
jar_reset() { rm -f "$TMP/$1.jar"; }

ulid() {
  node -e "const A='0123456789ABCDEFGHJKMNPQRSTVWXYZ';let t=Date.now(),s='';for(let i=0;i<10;i++){s=A[t%32]+s;t=Math.floor(t/32)}const r=require('crypto').randomBytes(16);for(let i=0;i<16;i++)s+=A[r[i]%32];process.stdout.write(s)"
}
# A random string of N letters and digits.
random_text() { node -e "process.stdout.write(require('crypto').randomBytes(64).toString('base64').replace(/[^A-Za-z0-9]/g,'').slice(0, $1))"; }

# command NAME JAR IP METHOD PATH [JSON]: a browser's command, with Origin, a fresh
# Idempotency-Key on POST, the visitor's cookies and a CF-Connecting-IP for the IP hash.
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
  local name="$1" jar_name="$2" path="$3"
  local cookies; cookies="$(jar "$jar_name")"
  local args=(-H "CF-Connecting-IP: 192.0.2.250")
  if [[ -n "$cookies" ]]; then args+=(-H "Cookie: $cookies"); fi
  request "$name" "${args[@]}" "$BASE$path"
  jar_update "$name" "$jar_name"
}

fake_config() { curl -sS -o /dev/null -X POST -H 'Content-Type: application/json' --data "$1" "$FAKE/_config"; }
fake_reset() { curl -sS -o /dev/null -X POST "$FAKE/_reset"; }
fake_requests() { curl -sS "$FAKE/_requests" > "$TMP/$1.body"; }

# oauth_flow NAME PROVIDER JAR [STATE_OVERRIDE]: start, the fake's authorize, the callback.
oauth_flow() {
  local name="$1" provider="$2" jar_name="$3" state_override="${4:-}"
  jar_reset "$jar_name"
  get_as "${name}_start" "$jar_name" "/v1/auth/$provider/start?return=/app/"
  local authorize; authorize="$(header_of "${name}_start" location)"
  request "${name}_authorize" "$authorize"
  local callback; callback="$(header_of "${name}_authorize" location)"
  if [[ -n "$state_override" ]]; then callback="$(sed -E "s/([?&]state=)[^&]*/\1$state_override/" <<<"$callback")"; fi
  local cookies; cookies="$(jar "$jar_name")"
  request "${name}_callback" -H "Cookie: $cookies" -H "CF-Connecting-IP: 192.0.2.250" "$callback"
  jar_update "${name}_callback" "$jar_name"
}

now_ms() { node -e 'console.log(Date.now())'; }

write_dev_vars() {
  {
    echo "# Written by scripts/smoke-auth.sh for one run; removed when it ends. Never committed."
    echo "SESSION_HMAC_KEY=$(random_text 48)"
    echo "ACCOUNT_HMAC_KEY=$(random_text 48)"
    echo "TURNSTILE_SECRET=1x0000000000000000000000000000000AA"
    echo "GOOGLE_CLIENT_ID=fake-google-client"
    echo "GOOGLE_CLIENT_SECRET=fake-google-client-secret"
    echo "GITHUB_CLIENT_ID=fake-github-client"
    echo "GITHUB_CLIENT_SECRET=fake-github-client-secret"
    echo "GOOGLE_ISSUER=$FAKE/google"
    echo "GITHUB_AUTHORIZE_URL=$FAKE/github/login/oauth/authorize"
    echo "GITHUB_TOKEN_URL=$FAKE/github/login/oauth/access_token"
    echo "GITHUB_USER_URL=$FAKE/github/user"
    echo "TURNSTILE_SITEVERIFY_URL=$FAKE/turnstile/siteverify"
    echo "ALLOWED_ORIGIN=$STOREFRONT"
    echo "API_ORIGIN=$BASE"
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
  # Job control gives the server its own process group, as in scripts/smoke-api.sh.
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

# ---------- the fake provider ----------

echo "starting the fake provider on $FAKE"
set -m
node "$ROOT/scripts/fake-providers.mjs" --port "$FAKE_PORT" > "$FAKE_LOG" 2>&1 < /dev/null &
FAKE_PID=$!
set +m
for _ in $(seq 1 100); do curl -s -o /dev/null "$FAKE/_health" && break; sleep 0.1; done

start_worker defaults

# ---------- Google ----------

fake_reset
fake_config '{"google":{"sub":"fake-sub-000001","extra_claims":true,"fault":"none"}}'
oauth_flow google google G
expect_status google_start 302
location="$(header_of google_start location)"
check "google_start: the authorize URL asks for scope=openid alone, state, nonce and S256" \
  "node -e \"const u = new URL(process.argv[1]); const q = u.searchParams; if (!(q.getAll('scope').length === 1 && q.get('scope') === 'openid' && q.get('state') && q.get('nonce') && q.get('code_challenge') && q.get('code_challenge_method') === 'S256' && q.get('response_type') === 'code' && q.get('client_id') === 'fake-google-client' && q.get('redirect_uri') === '$BASE/v1/auth/google/callback')) process.exit(1)\" '$location'"
oauth_cookie="$(set_cookie_of google_start __Host-oauth)"
check "google_start: __Host-oauth is HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600" \
  "[[ '$oauth_cookie' == *'; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600' ]]"
expect_status google_callback 303
expect_location google_callback "$STOREFRONT/app/"
session_cookie="$(set_cookie_of google_callback __Host-session)"
check "google_callback: __Host-session is HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400" \
  "[[ '$session_cookie' == *'; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400' ]]"
check "google_callback: __Host-oauth is cleared" \
  "[[ '$(set_cookie_of google_callback __Host-oauth)' == '__Host-oauth=; '*'Max-Age=0' ]]"
get_as google_session G /v1/session
expect_status google_session 200
expect_json google_session "b.kind === 'google' && /^[0-9a-f]{64}$/.test(b.account) && b.sandbox === null && /Z$/.test(b.expires_at)"
google_account="$(json_field google_session b.account)"
fake_requests google_requests
expect_json google_requests "b.filter(r => r.path === '/google/authorize').length === 1 && b.find(r => r.path === '/google/authorize').query.scope === 'openid'"
expect_json google_requests "b.filter(r => r.path === '/google/token').length === 1"

# The same sub without the profile claims gives the same account: nothing but sub was hashed.
fake_config '{"google":{"extra_claims":false}}'
oauth_flow google_plain google G2
expect_status google_plain_callback 303
get_as google_plain_session G2 /v1/session
expect_json google_plain_session "b.account === '$google_account'"
fake_config '{"google":{"extra_claims":true,"sub":"fake-sub-000002"}}'
oauth_flow google_other google G3
get_as google_other_session G3 /v1/session
expect_json google_other_session "b.kind === 'google' && b.account !== '$google_account'"

for fault in wrong_nonce wrong_iss wrong_aud expired bad_signature alg_none unknown_kid; do
  fake_config "{\"google\":{\"sub\":\"fake-sub-000001\",\"fault\":\"$fault\"}}"
  oauth_flow "google_$fault" google GF
  expect_status "google_${fault}_callback" 303
  expect_location "google_${fault}_callback" "$STOREFRONT/signin/?error=token"
  expect_no_session_cookie "google_${fault}_callback"
done
fake_config '{"google":{"fault":"none"}}'
oauth_flow google_state google GS wrong-state-value
expect_status google_state_callback 303
expect_location google_state_callback "$STOREFRONT/signin/?error=state"
expect_no_session_cookie google_state_callback
# A callback with no __Host-oauth at all is the same failure.
request google_nocookie "$BASE/v1/auth/google/callback?code=x&state=y"
expect_location google_nocookie "$STOREFRONT/signin/?error=state"

# ---------- GitHub ----------

fake_reset
oauth_flow github github H
expect_status github_start 302
location="$(header_of github_start location)"
check "github_start: no scope parameter; state and S256" \
  "node -e \"const q = new URL(process.argv[1]).searchParams; if (q.has('scope') || !q.get('state') || q.get('code_challenge_method') !== 'S256' || q.has('nonce')) process.exit(1)\" '$location'"
expect_status github_callback 303
expect_location github_callback "$STOREFRONT/app/"
get_as github_session H /v1/session
expect_json github_session "b.kind === 'github' && /^[0-9a-f]{64}$/.test(b.account) && b.account !== '$google_account' && b.sandbox === null"
fake_requests github_requests
expect_json github_requests "b.find(r => r.path === '/github/login/oauth/authorize').has_scope_param === false"
expect_json github_requests "b.filter(r => r.path === '/github/login/oauth/access_token').length === 1"
expect_json github_requests "b.filter(r => r.path === '/github/user').length === 1 && b.find(r => r.path === '/github/user').auth_scheme === 'Bearer' && b.find(r => r.path === '/github/user').has_user_agent === true"
fake_config '{"github":{"fault":"bad_code"}}'
oauth_flow github_bad github HB
expect_location github_bad_callback "$STOREFRONT/signin/?error=exchange"
expect_no_session_cookie github_bad_callback
fake_config '{"github":{"fault":"none"}}'

# ---------- Demo accounts ----------

CANARY="$(random_text 24)"
command_as demo_signup D1 192.0.2.21 POST /v1/auth/demo "{\"password\":\"$CANARY\",\"turnstile_token\":\"pass-1\"}"
expect_status demo_signup 201
expect_json demo_signup "/^baker-[0-9a-hjkmnp-tv-z]{4}$/.test(b.username) && Object.keys(b).length === 1"
check "demo_signup: sets __Host-session" "[[ -n '$(set_cookie_of demo_signup __Host-session)' ]]"
username="$(json_field demo_signup b.username)"
get_as demo_signup_session D1 /v1/session
expect_json demo_signup_session "b.kind === 'demo' && /^[0-9a-f]{64}$/.test(b.account)"
command_as demo_signout D1 192.0.2.21 POST /v1/auth/signout
expect_status demo_signout 204
check "demo_signout: clears __Host-session" "[[ '$(set_cookie_of demo_signout __Host-session)' == '__Host-session=; '*'Max-Age=0' ]]"
get_as demo_after_signout D1 /v1/session
expect_problem demo_after_signout 401 session

# A second browser: its own jar.
command_as demo_signin D2 192.0.2.22 POST /v1/auth/demo/signin "{\"username\":\"$username\",\"password\":\"$CANARY\"}"
expect_status demo_signin 200
expect_json demo_signin "b.kind === 'demo' && /^[0-9a-f]{64}$/.test(b.account)"
get_as demo_signin_session D2 /v1/session
expect_json demo_signin_session "b.kind === 'demo'"
command_as demo_unknown D3 192.0.2.22 POST /v1/auth/demo/signin '{"username":"baker-zzzz","password":"some-long-password"}'
expect_problem demo_unknown 401 credentials
command_as demo_wrong D3 192.0.2.22 POST /v1/auth/demo/signin "{\"username\":\"$username\",\"password\":\"wrong-$CANARY\"}"
expect_problem demo_wrong 401 credentials
wrong_ok=0
for i in $(seq 2 10); do
  command_as "demo_wrong_$i" D3 192.0.2.22 POST /v1/auth/demo/signin "{\"username\":\"$username\",\"password\":\"wrong-$i-$CANARY\"}"
  if [[ "$(status_of "demo_wrong_$i")" == 401 ]]; then wrong_ok=$((wrong_ok + 1)); fi
done
check "demo: wrong passwords 2 to 10 each get 401" "(( wrong_ok == 9 ))"
command_as demo_locked D3 192.0.2.22 POST /v1/auth/demo/signin "{\"username\":\"$username\",\"password\":\"$CANARY\"}"
expect_problem demo_locked 429 locked
check "demo_locked: Retry-After in seconds" "[[ '$(header_of demo_locked retry-after)' =~ ^[0-9]+$ ]]"
command_as demo_turnstile D4 192.0.2.23 POST /v1/auth/demo "{\"password\":\"$CANARY\",\"turnstile_token\":\"fail\"}"
expect_problem demo_turnstile 403 turnstile
command_as demo_short D4 192.0.2.23 POST /v1/auth/demo '{"password":"elevenchars","turnstile_token":"pass-1"}'
expect_problem demo_short 422 password

# ---------- The checks every command passes ----------

request no_origin -X POST -H "Idempotency-Key: $(ulid)" -H 'Content-Type: application/json' --data '{}' "$BASE/v1/sandboxes"
expect_problem no_origin 403 origin
request cross_site -X POST -H "Origin: $STOREFRONT" -H 'Sec-Fetch-Site: cross-site' -H "Idempotency-Key: $(ulid)" --data '{}' "$BASE/v1/sandboxes"
expect_problem cross_site 403 origin
request other_origin -X POST -H 'Origin: https://example.com' -H "Idempotency-Key: $(ulid)" --data '{}' "$BASE/v1/sandboxes"
expect_problem other_origin 403 origin
request no_key -X POST -H "Origin: $STOREFRONT" --data '{}' "$BASE/v1/sandboxes"
expect_problem no_key 400 idempotency-key
request bad_key -X POST -H "Origin: $STOREFRONT" -H 'Idempotency-Key: not-a-ulid' --data '{}' "$BASE/v1/sandboxes"
expect_problem bad_key 400 idempotency-key
request no_session "$BASE/v1/session"
expect_problem no_session 401 session
request wrong_method -X PUT "$BASE/v1/sandboxes"
expect_status wrong_method 405
check "wrong_method: Allow: POST, OPTIONS" "[[ '$(header_of wrong_method allow)' == 'POST, OPTIONS' ]]"

# ---------- Guests and sandboxes ----------

command_as guest_1 S1 192.0.2.31 POST /v1/sandboxes '{"turnstile_token":"pass-1","replace":false}'
expect_status guest_1 201
# PR 4 seeds a sandbox on its first alarm, so it answers `seeding` until its 14 children exist.
expect_json guest_1 "b.kind === 'guest' && ['seeding', 'live'].includes(b.state) && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(b.id) && Number.isSafeInteger(b.seed) && b.seed >= 0 && b.clock_offset_s === 0 && b.children <= 14 && b.faults.inbox === false"
expect_json guest_1 "(() => { const born = Date.parse(b.born); const d = new Date(born); let w = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 10); if (w <= born) w += 86400000; return Date.parse(b.wipe_at) === w; })()"
guest_1_id="$(json_field guest_1 b.id)"
get_as guest_1_get S1 "/v1/sandboxes/$guest_1_id"
expect_status guest_1_get 200
expect_json guest_1_get "b.id === '$guest_1_id' && ['seeding', 'live'].includes(b.state)"
get_as guest_1_session S1 /v1/session
expect_json guest_1_session "b.kind === 'guest' && b.account === null && b.sandbox === '$guest_1_id'"
command_as guest_no_token S9 192.0.2.39 POST /v1/sandboxes '{"replace":false}'
expect_problem guest_no_token 403 turnstile
command_as guest_2 S2 192.0.2.32 POST /v1/sandboxes '{"turnstile_token":"pass-2","replace":false}'
expect_status guest_2 201
guest_2_id="$(json_field guest_2 b.id)"
get_as guest_cross S1 "/v1/sandboxes/$guest_2_id"
expect_status guest_cross 404
get_as guest_unknown S1 "/v1/sandboxes/01JC8Z6K3W9QF2N4T7XRB5M0HD"
expect_status guest_unknown 404
command_as guest_fault S1 192.0.2.31 POST "/v1/sandboxes/$guest_1_id/faults" '{"fault":"inbox","on":true}'
expect_problem guest_fault 403 guest-scope
expect_json guest_fault "b.detail.includes('Q45 · Q-guest-scope')"
# A live sandbox comes back instead of a second one.
command_as guest_again S1 192.0.2.33 POST /v1/sandboxes '{"turnstile_token":"pass-3","replace":false}'
expect_status guest_again 200
expect_json guest_again "b.id === '$guest_1_id'"

command_as demo_sandbox D2 192.0.2.24 POST /v1/sandboxes '{"replace":false}'
expect_status demo_sandbox 201
expect_json demo_sandbox "b.kind === 'account' && ['seeding', 'live'].includes(b.state)"
demo_sandbox_id="$(json_field demo_sandbox b.id)"
command_as demo_fault D2 192.0.2.24 POST "/v1/sandboxes/$demo_sandbox_id/faults" '{"fault":"inbox","on":true}'
expect_status demo_fault 200
expect_json demo_fault "b.faults.inbox === true"
get_as demo_sandbox_get D2 "/v1/sandboxes/$demo_sandbox_id"
expect_json demo_sandbox_get "b.faults.inbox === true"
command_as demo_sandbox_again D2 192.0.2.25 POST /v1/sandboxes '{"replace":false}'
expect_status demo_sandbox_again 200
expect_json demo_sandbox_again "b.id === '$demo_sandbox_id'"

# The same Idempotency-Key twice: the same sandbox, and one place in the day's count.
request status_before_replay "$BASE/v1/status"
before="$(json_field status_before_replay b.sandboxes_today)"
KEY="$(ulid)"
command_as replay_1 S3 192.0.2.34 POST /v1/sandboxes '{"turnstile_token":"pass-4","replace":false}'
command_as replay_2 S4 192.0.2.35 POST /v1/sandboxes '{"turnstile_token":"pass-5","replace":false}'
unset KEY
expect_status replay_1 201
replay_id="$(json_field replay_1 b.id)"
expect_json replay_2 "b.id === '$replay_id'"
check "replay_2: Idempotent-Replayed: true" "[[ '$(header_of replay_2 idempotent-replayed)' == true ]]"
request status_after_replay "$BASE/v1/status"
expect_json status_after_replay "b.sandboxes_today === $before + 1 && b.guests_today >= 3 && b.demo_accounts_today === 1"

# ---------- The nightly wipe ----------

request status_before_wipe "$BASE/v1/status"
day_count="$(json_field status_before_wipe b.sandboxes_today)"
list_objects list_before_wipe
check "list-objects: exits 1 while sandboxes are live" "(( LIST_EXIT == 1 ))"
request cron_wipe "$BASE/cdn-cgi/local/scheduled?cron=0+10+*+*+*"
expect_status cron_wipe 200
wiped=0
for _ in $(seq 1 75); do
  get_as wipe_poll S1 "/v1/sandboxes/$guest_1_id"
  get_as wipe_poll_demo D2 "/v1/sandboxes/$demo_sandbox_id"
  if [[ "$(status_of wipe_poll)" == 410 && "$(status_of wipe_poll_demo)" == 410 ]]; then wiped=1; break; fi
  sleep 0.2
done
check "the 10:00 UTC cron wiped the sandboxes within 15 s" "(( wiped == 1 ))"
for pair in "S1:$guest_1_id" "S2:$guest_2_id" "D2:$demo_sandbox_id" "S3:$replay_id"; do
  get_as "wiped_${pair%%:*}" "${pair%%:*}" "/v1/sandboxes/${pair#*:}"
  expect_problem "wiped_${pair%%:*}" 410 wiped
done
request status_after_wipe "$BASE/v1/status"
expect_json status_after_wipe "b.sandboxes_today === $day_count"
list_objects list_after_wipe
check "list-objects: exits 0 after the wipe" "(( LIST_EXIT == 0 ))"
check "list-objects: lists the wiped sandboxes" "grep -q '\"class\":\"Sandbox\"' '$TMP/list_after_wipe.out'"
cp "$TMP/list_after_wipe.out" "$TMP/report_clean.out"

# A sandbox made after the wipe is found by the listing.
command_as orphan S5 192.0.2.36 POST /v1/sandboxes '{"turnstile_token":"pass-6","replace":false}'
expect_status orphan 201
orphan_id="$(json_field orphan b.id)"
list_objects list_orphan
check "list-objects: exits 1 with one sandbox holding data" "(( LIST_EXIT == 1 ))"
check "list-objects: names the orphan" "grep -q \"sandbox:$orphan_id\" '$TMP/list_orphan.out' && grep \"sandbox:$orphan_id\" '$TMP/list_orphan.out' | grep -q '\"has_data\":true'"
cp "$TMP/list_orphan.out" "$TMP/report_orphan.out"

# "Wipe now", as a guest: the sandbox goes, and with it the guest's session.
command_as wipe_now_guest S5 192.0.2.36 DELETE "/v1/sandboxes/$orphan_id"
expect_status wipe_now_guest 200
expect_json wipe_now_guest "b.id === '$orphan_id' && b.state === 'wiped'"
check "wipe_now_guest: the guest cookie is cleared" "[[ '$(set_cookie_of wipe_now_guest __Host-session)' == '__Host-session=; '*'Max-Age=0' ]]"

# "Wipe now", as an account: the cookie is re-issued without the sandbox.
command_as demo_sandbox_2 D2 192.0.2.26 POST /v1/sandboxes '{"replace":false}'
expect_status demo_sandbox_2 201
demo_sandbox_2_id="$(json_field demo_sandbox_2 b.id)"
check "demo_sandbox_2: a new sandbox after the old one was wiped" "[[ '$demo_sandbox_2_id' != '$demo_sandbox_id' ]]"
list_objects list_before_wipe_now
check "list-objects: exits 1 before Wipe now" "(( LIST_EXIT == 1 ))"
command_as wipe_now D2 192.0.2.26 DELETE "/v1/sandboxes/$demo_sandbox_2_id"
expect_status wipe_now 200
expect_json wipe_now "b.id === '$demo_sandbox_2_id' && b.state === 'wiped'"
check "wipe_now: __Host-session re-issued" "[[ '$(set_cookie_of wipe_now __Host-session)' == *'Max-Age=86400' ]]"
get_as wipe_now_session D2 /v1/session
expect_json wipe_now_session "b.kind === 'demo' && b.sandbox === null"
get_as wipe_now_old_id D2 "/v1/sandboxes/$demo_sandbox_2_id"
expect_status wipe_now_old_id 404
list_objects list_after_wipe_now
check "list-objects: exits 0 after Wipe now" "(( LIST_EXIT == 0 ))"

# The sweep and a second wipe change nothing.
request status_before_sweep "$BASE/v1/status"
request cron_sweep "$BASE/cdn-cgi/local/scheduled?cron=*/15+*+*+*+*"
expect_status cron_sweep 200
request cron_wipe_again "$BASE/cdn-cgi/local/scheduled?cron=0+10+*+*+*"
expect_status cron_wipe_again 200
sleep 1
request status_after_sweep "$BASE/v1/status"
check "the sweep and a second wipe leave the day's counts unchanged" "cmp -s '$TMP/status_before_sweep.body' '$TMP/status_after_sweep.body'"
list_objects list_after_sweep
check "list-objects: still exits 0 after the sweep" "(( LIST_EXIT == 0 ))"

# Signed out, an account's copied cookie stops working on the routes that ask its Account.
cp "$TMP/D2.jar" "$TMP/D2copy.jar"
command_as demo_sandbox_3 D2 192.0.2.27 POST /v1/sandboxes '{"replace":false}'
demo_sandbox_3_id="$(json_field demo_sandbox_3 b.id)"
cp "$TMP/D2.jar" "$TMP/D2copy.jar"
command_as demo_signout_2 D2 192.0.2.27 POST /v1/auth/signout
get_as revoked_copy D2copy "/v1/sandboxes/$demo_sandbox_3_id"
expect_problem revoked_copy 401 session

stop_worker

# ---------- The caps, with a second Worker run ----------

start_worker caps GUEST_SANDBOX_CAP=2 SANDBOX_CAP=3 DEMO_ACCOUNT_CAP=2 ACCOUNT_SANDBOX_CAP=1
command_as cap_guest_1 C1 198.51.100.1 POST /v1/sandboxes '{"turnstile_token":"pass-1","replace":false}'
expect_status cap_guest_1 201
command_as cap_guest_2 C2 198.51.100.2 POST /v1/sandboxes '{"turnstile_token":"pass-1","replace":false}'
expect_status cap_guest_2 201
command_as cap_guest_3 C3 198.51.100.3 POST /v1/sandboxes '{"turnstile_token":"pass-1","replace":false}'
expect_problem cap_guest_3 503 guest-cap
check "cap_guest_3: Retry-After to 00:00 UTC" "[[ '$(header_of cap_guest_3 retry-after)' =~ ^[0-9]+$ ]] && (( $(header_of cap_guest_3 retry-after) <= 86400 ))"
command_as cap_demo_1 CA 198.51.100.11 POST /v1/auth/demo "{\"password\":\"$CANARY\",\"turnstile_token\":\"pass-1\"}"
expect_status cap_demo_1 201
command_as cap_demo_2 CB 198.51.100.12 POST /v1/auth/demo "{\"password\":\"$CANARY\",\"turnstile_token\":\"pass-1\"}"
expect_status cap_demo_2 201
command_as cap_demo_3 CC 198.51.100.13 POST /v1/auth/demo "{\"password\":\"$CANARY\",\"turnstile_token\":\"pass-1\"}"
expect_problem cap_demo_3 503 demo-cap
check "cap_demo_3: Retry-After" "[[ '$(header_of cap_demo_3 retry-after)' =~ ^[0-9]+$ ]]"
command_as cap_account_1 CA 198.51.100.21 POST /v1/sandboxes '{"replace":false}'
expect_status cap_account_1 201
command_as cap_account_2 CA 198.51.100.22 POST /v1/sandboxes '{"replace":true}'
expect_problem cap_account_2 429 account-sandbox-cap
get_as cap_account_kept CA "/v1/sandboxes/$(json_field cap_account_1 b.id)"
expect_status cap_account_kept 200
command_as cap_sandbox_4 CB 198.51.100.23 POST /v1/sandboxes '{"replace":false}'
expect_problem cap_sandbox_4 503 sandbox-cap
check "cap_sandbox_4: Retry-After to 00:00 UTC" "[[ '$(header_of cap_sandbox_4 retry-after)' =~ ^[0-9]+$ ]]"
request cap_status "$BASE/v1/status"
expect_json cap_status "b.sandboxes_today === 3 && b.sandbox_cap === 3 && b.guests_today === 2 && b.guest_cap === 2 && b.demo_accounts_today === 2 && b.demo_account_cap === 2"
# The per-IP limit: a second creation from one address within the minute.
command_as rate_1 C9 198.51.100.99 POST /v1/sandboxes '{"turnstile_token":"pass-1","replace":false}'
command_as rate_2 C9 198.51.100.99 POST /v1/sandboxes '{"turnstile_token":"pass-1","replace":false}'
expect_problem rate_2 429 rate-limit

stop_worker

# ---------- What the logs hold ----------

# Only what the Worker wrote at run time: the build output before "Ready" is not request data.
runtime_log="$TMP/runtime.log"
awk '/^=== .*: Worker ready/ { on = 1 } on' "$LOG" > "$runtime_log"
for needle in '@' 'fake-sub' 'Fake Person' 'picture' 'example.com' 'fake-login' '1234567' "$CANARY" "$username"; do
  label="$needle"
  [[ "$needle" == "$CANARY" ]] && label="the canary password"
  [[ "$needle" == "$username" ]] && label="the demo username"
  check "the Worker's log holds no $label" "! grep -qF -- '$needle' '$runtime_log'"
done
check "the Worker's log has one request line per request" "grep -q '\"type\":\"request\",\"route\":\"/v1/auth/google/callback\"' '$runtime_log'"
check "no request line holds a query string" "! grep '\"type\":\"request\"' '$runtime_log' | grep -q '\"route\":\"[^\"]*?'"
check "the request lines carry an IP hash, never the address" "grep '\"type\":\"request\",\"route\":\"/v1/sandboxes\"' '$runtime_log' | grep -q '\"ip_hash\":\"[0-9a-f]\\{64\\}\"' && ! grep -q '192\\.0\\.2\\.31' '$runtime_log'"

echo
echo "list-objects after the wipe:"
cat "$TMP/report_clean.out"
echo "list-objects with the orphan:"
cat "$TMP/report_orphan.out"
echo
if (( FAILURES > 0 )); then
  echo "$PASSES passed, $FAILURES failed"
  exit 1
fi
echo "all $PASSES checks passed"
