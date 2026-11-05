#!/usr/bin/env bash
# Smoke-tests bakery-api on `wrangler dev`: starts it, runs the checks from docs/roadmap.md's
# PR 2 "Done when" and docs/security.md's CORS table, stops it, and exits non-zero on any failure.
#
# Usage: scripts/smoke-api.sh   (from anywhere; needs cargo, worker-build, pnpm and curl).
# WRANGLER=wrangler@x.y.z runs that version through npx instead of the lockfile's.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SMOKE_PORT:-8788}"
BASE="http://127.0.0.1:${PORT}"
WRANGLER="${WRANGLER:-}"
STOREFRONT="https://bakery.ihaveasegway.com"
STARTUP_TIMEOUT_S="${STARTUP_TIMEOUT_S:-180}"

LOG="$(mktemp -t smoke-api.XXXXXX.log)"
TMP="$(mktemp -d -t smoke-api.XXXXXX)"
FAILURES=0
SERVER_PID=""

stop() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    # The server leads its own process group, so this stops wrangler and workerd only.
    kill -TERM -- "-$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.1; done
    kill -KILL -- "-$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap stop EXIT

pass() { printf 'ok    %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

# request NAME [curl args...]: writes NAME.headers (lower-cased names, no CR) and NAME.body.
request() {
  local name="$1"; shift
  curl -sS -o "$TMP/$name.body" -D "$TMP/$name.raw" "$@" || true
  tr -d '\r' < "$TMP/$name.raw" | awk 'NR == 1 { print; next } { i = index($0, ":"); if (i) print tolower(substr($0, 1, i - 1)) substr($0, i) }' > "$TMP/$name.headers"
}
status_of() { head -n 1 "$TMP/$1.headers" | awk '{ print $2 }'; }
header_of() { grep -m 1 "^$2:" "$TMP/$1.headers" | cut -d: -f2- | sed 's/^ //' || true; }

expect_status() {
  local got; got="$(status_of "$1")"
  if [[ "$got" == "$2" ]]; then pass "$1: status $2"; else fail "$1: status $got, wanted $2"; fi
}
expect_header() {
  local got; got="$(header_of "$1" "$2")"
  if [[ "$got" == "$3" ]]; then pass "$1: $2: $3"; else fail "$1: $2 is '$got', wanted '$3'"; fi
}
expect_no_header() {
  if grep -q "^$2:" "$TMP/$1.headers"; then fail "$1: unexpected $2"; else pass "$1: no $2"; fi
}
expect_json() {
  if node -e "const b = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); if (!($2)) process.exit(1)" "$TMP/$1.body" 2>/dev/null; then
    pass "$1: body $2"
  else
    fail "$1: body $(head -c 300 "$TMP/$1.body") fails $2"
  fi
}
expect_api_headers() {
  local name="$1" type="$2"
  expect_header "$name" content-type "$type"
  expect_header "$name" x-content-type-options "nosniff"
  expect_header "$name" cache-control "no-store"
  expect_header "$name" content-security-policy "default-src 'none'; frame-ancestors 'none'"
  expect_header "$name" referrer-policy "no-referrer"
  expect_header "$name" cross-origin-resource-policy "same-site"
  expect_header "$name" vary "Origin"
}

if curl -s -o /dev/null "$BASE/" 2>/dev/null; then
  echo "something already listens on port $PORT; stop it or set SMOKE_PORT" >&2
  exit 2
fi

# macOS's date has no %N, and node is here already for the JSON checks.
now_ms() { node -e 'console.log(Date.now())'; }

if [[ -n "$WRANGLER" ]]; then run_wrangler=(npx --yes "$WRANGLER"); else run_wrangler=(pnpm exec wrangler); fi
echo "starting ${run_wrangler[*]} dev on $BASE (log: $LOG)"
cd "$ROOT/workers/api"
start_ms="$(now_ms)"
# Fresh object state in a scratch directory, so "nobody admitted today" holds on any laptop.
# Job control gives the background server its own process group, whose id is $!, so stop() can
# end wrangler and workerd together, and nothing else. macOS has no setsid to do this with.
set -m
"${run_wrangler[@]}" dev --local --ip 127.0.0.1 --port "$PORT" \
  --persist-to "$TMP/state" --show-interactive-dev-session=false > "$LOG" 2>&1 < /dev/null &
SERVER_PID=$!
set +m

deadline=$(( $(date +%s) + STARTUP_TIMEOUT_S ))
until [[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/health" 2>/dev/null || true)" == "200" ]]; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null || (( $(date +%s) > deadline )); then
    echo "wrangler dev did not answer /v1/health; its log:" >&2
    tail -n 40 "$LOG" >&2
    exit 1
  fi
  sleep 0.2
done
echo "first 200 after $(( $(now_ms) - start_ms )) ms (including the build)"

# Health: 200 JSON, no object touched.
request health "$BASE/v1/health"
expect_status health 200
expect_api_headers health "application/json"
expect_json health "b.status === 'ok' && typeof b.commit === 'string' && b.commit.length > 0 && typeof b.version === 'string'"

# Status: one call to Control; a fresh local state has admitted nobody.
request status "$BASE/v1/status"
expect_status status 200
expect_api_headers status "application/json"
expect_json status "b.sandboxes_today === 0 && b.sandbox_cap === 300 && /^\\d{4}-\\d{2}-\\d{2}$/.test(b.day) && b.flag === 'live'"

# CORS for the storefront: the exact origin, credentials, the exposed headers.
request cors_storefront -H "Origin: $STOREFRONT" "$BASE/v1/health"
expect_status cors_storefront 200
expect_header cors_storefront access-control-allow-origin "$STOREFRONT"
expect_header cors_storefront access-control-allow-credentials "true"
expect_header cors_storefront access-control-expose-headers "ETag, Location, Retry-After, Bakery-Cache"
expect_header cors_storefront vary "Origin"

# Any other origin: no CORS header at all.
request cors_foreign -H "Origin: https://example.com" "$BASE/v1/health"
expect_status cors_foreign 200
for h in access-control-allow-origin access-control-allow-credentials access-control-expose-headers \
  access-control-allow-methods access-control-allow-headers access-control-max-age; do
  expect_no_header cors_foreign "$h"
done

# Preflight from the storefront.
request preflight -X OPTIONS -H "Origin: $STOREFRONT" -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type, idempotency-key" "$BASE/v1/status"
expect_status preflight 204
expect_header preflight access-control-allow-origin "$STOREFRONT"
expect_header preflight access-control-allow-credentials "true"
expect_header preflight access-control-allow-methods "GET, POST, PATCH, DELETE"
expect_header preflight access-control-allow-headers "Content-Type, Idempotency-Key, If-Match, If-None-Match"
expect_header preflight access-control-max-age "7200"

# A preflight from another origin is answered with no CORS header.
request preflight_foreign -X OPTIONS -H "Origin: https://example.com" -H "Access-Control-Request-Method: POST" "$BASE/v1/status"
expect_no_header preflight_foreign access-control-allow-origin

# Unknown path and wrong method: problem+json.
request nope "$BASE/v1/nope"
expect_status nope 404
expect_api_headers nope "application/problem+json"
expect_json nope "b.status === 404 && b.type === 'about:blank' && b.title === 'Not Found'"

request wrong_method -X POST "$BASE/v1/health"
expect_status wrong_method 405
expect_api_headers wrong_method "application/problem+json"
expect_header wrong_method allow "GET, OPTIONS"
expect_json wrong_method "b.status === 405"

if (( FAILURES > 0 )); then
  echo "$FAILURES check(s) failed; wrangler's log is $LOG" >&2
  exit 1
fi
echo "all checks passed"
rm -f "$LOG"
