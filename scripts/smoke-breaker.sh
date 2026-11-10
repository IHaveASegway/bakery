#!/usr/bin/env bash
# Smoke-tests the 15-minute cron breaker on `wrangler dev` against scripts/fake-cloudflare.mjs
# (docs/cost.md, "Guardrails"; docs/operations.md, "Breaker tripped"). It fires the cron the way
# the other smokes do and reads the Worker's log, GET /v1/status and the fake's request log.
#
# What it proves, one phase each (every phase starts a Worker on a fresh state directory, because
# the breaker's state lives in Control's local Durable Object storage and only ever goes up; a
# fresh `--persist-to` directory is how a phase starts from `unconfigured` again):
#
# - Unconfigured: with no secrets, with only the token, and with an ill-shaped zone id, the cron
#   logs `breaker_unconfigured` naming the first missing variable, the fake is sent nothing, and
#   the status says `unconfigured` with null times.
# - Quiet usage: four GraphQL requests, one per dataset, each with the Bearer token and a window
#   that is the last whole 15 minutes; `breaker_read` says `armed`; the status says `armed` with a
#   `last_run`; no rule request; the Worker's log holds no token, zone id, rule id, account id or
#   `/zones/` URL.
# - A tripped sequence: usage over a meter's line but under the dollar burst trips `read-only`
#   (the flag goes to `read-only`, the rule is not touched); the next run, still over, trips `off`
#   (the flag goes to `off`, the fake's rule is enabled by exactly one PATCH carrying the rule's
#   action, expression, description and `enabled`); the run after logs `breaker_held` and sends
#   no second PATCH; quiet usage after that does not lower the state.
# - A loop window (millions of rows written) trips `off` in one run, since its price is past the
#   dollar burst line.
# - The rule failing: the entry point's GET failing, then the PATCH failing, each log
#   `breaker_rule_failed` and leave the rule disabled; the next run tries again and succeeds.
# - One dataset answering a GraphQL error (the validation-error shape): both of its meters are
#   unread (reason `graphql`) and the verdict comes from the other three; an empty answer for the
#   Worker or DO request meters logs `breaker_meter_empty`.
# - Every request failing (500): `breaker_failed`, and the state and `last_run` stay as they were.
# - A slow dataset (past the 5 s timeout): `reason":"timeout"` for its meters, and the run takes
#   about 5 s, not 7.
# - A rejected token (401): every meter unread with status 401, `breaker_failed`.
# - The forced trip of the launch checklist (item 6): a Worker with BREAKER_CEILING_USD=0 trips on
#   quiet usage.
# - Dead letters while `off` (roadmap R67, 2026-11-10): in a demo sandbox, an order placed with
#   the `kitchen` fault on dies of the fault while `live` and is kept unmarked and counted; after a
#   loop window trips `off`, an order's event dies of the switch (the consumer retries everything
#   at `off`) and is kept with `made_while_off`, logged with `"counted":false`, so no `dlq` point
#   is written; its redrive answers 200 as any other. The fake Turnstile (scripts/fake-providers.mjs)
#   runs for this phase only, on SMOKE_FAKE_PORT.
#
# It prints ok or FAIL per check as scripts/smoke-status.sh does, and exits non-zero on any
# failure. Usage: scripts/smoke-breaker.sh   (from anywhere; needs cargo, worker-build, pnpm,
# node 22, curl).
#
# Like the other smokes it writes a throwaway workers/api/.dev.vars, refuses to run when one exists
# unless SMOKE_BREAKER_OVERWRITE=1, starts the fake Cloudflare API on 8793, and keeps the Worker's
# log in SMOKE_BREAKER_LOG=<file> when set. The token and ids are the fake's own fakes, not secrets.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SMOKE_PORT:-8788}"
CF_PORT="${SMOKE_CF_PORT:-8793}"
FAKE_PORT="${SMOKE_FAKE_PORT:-8790}"
FAKE="http://127.0.0.1:${FAKE_PORT}"
BASE="http://127.0.0.1:${PORT}"
CF="http://127.0.0.1:${CF_PORT}"
STOREFRONT="http://127.0.0.1:8787"
STARTUP_TIMEOUT_S="${STARTUP_TIMEOUT_S:-240}"
DEV_VARS="$ROOT/workers/api/.dev.vars"
SWEEP_CRON="$BASE/cdn-cgi/local/scheduled?cron=*/15+*+*+*+*"

# The fake's own values (scripts/fake-cloudflare.mjs), not secrets.
CF_TOKEN="fake-breaker-token"
CF_ZONE="000000000000000000000000fakezone"
CF_RULE="000000000000000000000000fakerule"
CF_ACCOUNT="0000000000000000000000000000fake"

TMP="$(mktemp -d -t smoke-breaker.XXXXXX)"
LOG="$TMP/worker.log"
CF_LOG="$TMP/cf.log"
FAILURES=0
PASSES=0
PHASE=0
MARK=0
SERVER_PID=""
CF_PID=""
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
  stop_pid "$CF_PID"
  stop_pid "$FAKE_PID"
  if [[ -n "$WROTE_DEV_VARS" ]]; then rm -f "$DEV_VARS"; fi
  if [[ -n "$BACKUP" && -f "$BACKUP" ]]; then mv "$BACKUP" "$DEV_VARS"; fi
  if [[ -n "${SMOKE_BREAKER_LOG:-}" ]]; then cp "$LOG" "$SMOKE_BREAKER_LOG" 2>/dev/null || true; fi
  if (( FAILURES > 0 )); then
    mkdir -p "${TMPDIR:-/tmp}/smoke-breaker-logs"
    cp "$LOG" "$CF_LOG" "${TMPDIR:-/tmp}/smoke-breaker-logs/" 2>/dev/null || true
    echo "logs kept in ${TMPDIR:-/tmp}/smoke-breaker-logs" >&2
  fi
  rm -rf "$TMP"
}
trap stop EXIT

pass() { printf 'ok    %s\n' "$1"; PASSES=$((PASSES + 1)); }
fail() { printf 'FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }

if [[ -e "$DEV_VARS" ]]; then
  if [[ -z "${SMOKE_BREAKER_OVERWRITE:-}" ]]; then
    echo "workers/api/.dev.vars exists; this script would replace it. Move it aside, or set SMOKE_BREAKER_OVERWRITE=1 to have it moved and restored." >&2
    exit 2
  fi
  BACKUP="$TMP/dev.vars.backup"
  mv "$DEV_VARS" "$BACKUP"
fi
for p in "$PORT" "$CF_PORT" "$FAKE_PORT"; do
  if curl -s -o /dev/null "http://127.0.0.1:$p/" 2>/dev/null; then
    echo "something already listens on port $p; stop it or set SMOKE_PORT / SMOKE_CF_PORT / SMOKE_FAKE_PORT" >&2
    exit 2
  fi
done

# ---------- helpers (as in scripts/smoke-status.sh) ----------

request() {
  local name="$1"; shift
  curl -sS -o "$TMP/$name.body" -D "$TMP/$name.raw" "$@" || true
  tr -d '\r' < "$TMP/$name.raw" | awk 'NR == 1 { print; next } { i = index($0, ":"); if (i) print tolower(substr($0, 1, i - 1)) substr($0, i) }' > "$TMP/$name.headers"
}
status_of() { head -n 1 "$TMP/$1.headers" | awk '{ print $2 }'; }
expect_status() {
  local got; got="$(status_of "$1")"
  if [[ "$got" == "$2" ]]; then pass "$1: status $2"; else fail "$1: status $got, wanted $2 ($(head -c 300 "$TMP/$1.body"))"; fi
}
expect_json() {
  if node -e "const b = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); if (!($2)) process.exit(1)" "$TMP/$1.body" 2>/dev/null; then
    pass "$1: body $2"
  else
    fail "$1: body $(head -c 600 "$TMP/$1.body") fails $2"
  fi
}
json_field() { node -e "const b = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); const v = ($2); process.stdout.write(v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v))" "$TMP/$1.body"; }
now_ms() { node -e 'console.log(Date.now())'; }
random_text() { node -e "process.stdout.write(require('crypto').randomBytes(64).toString('base64').replace(/[^A-Za-z0-9]/g,'').slice(0, $1))"; }

# The Worker's log. `mark` sets where the next run's lines start; the log_ helpers read from there,
# and whole_has reads everything since the script began (the secrets check).
mark() { MARK="$(wc -l < "$LOG")"; }
since() { tail -n +"$((MARK + 1))" "$LOG"; }
log_has() { since | grep -qF -- "$1"; }
log_count() { since | grep -cF -- "$1" || true; }
whole_has() { grep -qF -- "$1" "$LOG"; }
# ev_has EVENT FRAGMENT...: a line since the mark with this event and every fragment.
ev_has() {
  local ev="$1"; shift
  local text; text="$(since | grep -F -- "\"event\":\"$ev\"" || true)"
  [[ -n "$text" ]] || return 1
  local line
  while IFS= read -r line; do
    local ok=1 frag
    for frag in "$@"; do [[ "$line" == *"$frag"* ]] || { ok=0; break; }; done
    (( ok )) && return 0
  done <<< "$text"
  return 1
}
ev_count() { since | grep -cF -- "\"event\":\"$1\"" || true; }
# settle: workerd's lines reach the file late, so wait until the log has stopped growing.
settle() {
  local last=-1 now stable=0
  for _ in $(seq 1 40); do
    now="$(wc -l < "$LOG")"
    if [[ "$now" == "$last" ]]; then stable=$((stable + 1)); else stable=0; fi
    (( stable >= 3 )) && return 0
    last="$now"
    sleep 0.25
  done
  return 0
}

# One run of the 15-minute cron; the request returns when the handler has finished. The log is
# marked first and settled after, so the log_ helpers see exactly this run.
RUN_MS=0
run_cron() {
  mark
  local t0; t0="$(now_ms)"
  request "$1" "$SWEEP_CRON"
  RUN_MS=$(( $(now_ms) - t0 ))
  settle
}
status() { request "$1" -H "Origin: $STOREFRONT" -H "CF-Connecting-IP: 192.0.2.90" "$BASE/v1/status"; }
# cf NAME METHOD BODY PATH: one call to the fake's controls (and the reads of its logs).
cf() {
  local args=(-sS -o "$TMP/$1.body" -X "$2")
  if [[ -n "$3" ]]; then args+=(-H 'Content-Type: application/json' --data "$3"); fi
  curl "${args[@]}" "$CF$4"
}
cf_reset() { cf reset POST "" /_reset; }
# The fake's requests of one class, since the last reset.
graphql_count() { cf requests GET "" /_requests; json_field requests "b.filter((r) => r.class === 'graphql').length"; }
class_count() { cf requests GET "" /_requests; json_field requests "b.filter((r) => r.class === '$1').length"; }

if [[ -n "${WRANGLER:-}" ]]; then run_wrangler=(npx --yes "$WRANGLER"); else run_wrangler=(pnpm exec wrangler); fi

# write_dev_vars MODE [EXTRA...]: MODE is none (no breaker secrets), token (the token only),
# badzone (an ill-shaped zone id), badtoken (a token the fake rejects) or full.
write_dev_vars() {
  local mode="$1"; shift
  {
    echo "# Written by scripts/smoke-breaker.sh for one run; removed when it ends. Never committed."
    echo "SESSION_HMAC_KEY=$(random_text 48)"
    echo "ACCOUNT_HMAC_KEY=$(random_text 48)"
    echo "TURNSTILE_SECRET=1x0000000000000000000000000000000AA"
    echo "TURNSTILE_SITEVERIFY_URL=${SITEVERIFY_URL:-http://127.0.0.1:1/turnstile/siteverify}"
    echo "ALLOWED_ORIGIN=$STOREFRONT"
    echo "API_ORIGIN=$BASE"
    if [[ "$mode" != none ]]; then
      echo "BREAKER_API_BASE=$CF"
      if [[ "$mode" == badtoken ]]; then
        echo "BREAKER_API_TOKEN=not-the-fakes-token"
      else
        echo "BREAKER_API_TOKEN=$CF_TOKEN"
      fi
    fi
    case "$mode" in
      badzone) echo "ANALYTICS_ACCOUNT_ID=$CF_ACCOUNT"; echo "BREAKER_ZONE_ID=not-a-zone-id!"; echo "BREAKER_RULE_ID=$CF_RULE" ;;
      full | badtoken)
        echo "BREAKER_ZONE_ID=$CF_ZONE"
        echo "BREAKER_RULE_ID=$CF_RULE"
        echo "ANALYTICS_ACCOUNT_ID=$CF_ACCOUNT"
        ;;
    esac
    local line
    for line in "$@"; do echo "$line"; done
  } > "$DEV_VARS"
  WROTE_DEV_VARS=1
}

# start_worker MODE [EXTRA...]: the Worker on a state directory of its own (fresh unless the
# phase says "same state"), with the dev vars for MODE.
STATE=""
start_worker() {
  local mode="$1"; shift
  write_dev_vars "$mode" "$@"
  echo "--- starting ${run_wrangler[*]} dev on $BASE (breaker secrets: $mode)"
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
# phase MODE [EXTRA...]: stop the Worker, reset the fake, start a Worker on a fresh state.
phase() {
  PHASE=$((PHASE + 1))
  stop_worker
  cf_reset
  STATE="$TMP/state-$PHASE"
  start_worker "$@"
}

# Wire shapes the checks read.
breaker_is() { # NAME STATE: the status body's breaker state
  expect_json "$1" "b.breaker.state === '$2'"
}
RULE_PATCH_BODY="b.patches.length === 1 && Object.keys(b.patches[0]).sort().join(',') === 'action,description,enabled,expression' && b.patches[0].enabled === true && b.patches[0].action === 'block' && b.patches[0].expression.includes('api.bakery.ihaveasegway.com')"

echo "--- starting the fake Cloudflare API on $CF"
set -m
node "$ROOT/scripts/fake-cloudflare.mjs" --port "$CF_PORT" > "$CF_LOG" 2>&1 < /dev/null &
CF_PID=$!
set +m
for _ in $(seq 1 50); do curl -s -o /dev/null "$CF/_health" && break; sleep 0.1; done

# ---------- no secrets, only the token, an ill-shaped zone id: unconfigured ----------

phase none
status none
expect_status none 200
breaker_is none unconfigured
expect_json none "b.breaker.since === null && b.breaker.last_run === null && b.breaker.last_usd === null && Array.isArray(b.breaker.unread) && b.breaker.unread.length === 0"
# By name, not by place: the order of JSON keys is not contract (ADR 0013, decision 4), and the
# status answer gains fields before `flag` (sandboxes_past_wipe on 2026-11-10).
expect_json none "Object.keys(b.breaker).sort().join(',') === 'last_run,last_usd,since,state,unread'"
expect_json none "['breaker', 'sandboxes_past_wipe', 'flag'].every((k) => k in b)"
run_cron cron_none
expect_status cron_none 200
check "without the secrets the cron logs breaker_unconfigured naming BREAKER_API_TOKEN" "ev_has breaker_unconfigured '\"var\":\"BREAKER_API_TOKEN\"'"
check "breaker_unconfigured is logged once for the run" "[[ \"\$(ev_count breaker_unconfigured)\" == 1 ]]"
check "no breaker_read without the secrets" "[[ \"\$(ev_count breaker_read)\" == 0 ]]"
cf requests_none GET "" /_requests
expect_json requests_none "b.length === 0"
status none_after
breaker_is none_after unconfigured
expect_json none_after "b.flag === 'live'"

stop_worker
start_worker token
run_cron cron_token
expect_status cron_token 200
check "with only the token the first missing variable is ANALYTICS_ACCOUNT_ID" "ev_has breaker_unconfigured '\"var\":\"ANALYTICS_ACCOUNT_ID\"'"
stop_worker
start_worker badzone
run_cron cron_badzone
check "an ill-shaped zone id is skipped, naming BREAKER_ZONE_ID" "ev_has breaker_unconfigured '\"var\":\"BREAKER_ZONE_ID\"'"
check "the ill-shaped value is not in the log" "! whole_has 'not-a-zone-id'"
cf requests_bad GET "" /_requests
expect_json requests_bad "b.length === 0"
status bad_after
breaker_is bad_after unconfigured

# ---------- quiet usage: armed ----------

phase full
cf usage POST '{"worker_requests":20,"do_requests":20,"rows_written":500,"do_gb_s":0.1,"queue_operations":30}' /_usage
before_ms="$(now_ms)"
run_cron cron_quiet
after_ms="$(now_ms)"
expect_status cron_quiet 200
check "the quiet run logs breaker_read armed with five meters read" "ev_has breaker_read '\"verdict\":\"armed\"' '\"read\":5' '\"unread\":[]'"
check "the quiet run logs neither a trip nor a held state" "[[ \"\$(ev_count breaker_tripped)\" == 0 && \"\$(ev_count breaker_held)\" == 0 ]]"
cf requests_quiet GET "" /_requests
expect_json requests_quiet "b.length === 4 && b.every((r) => r.class === 'graphql' && r.method === 'POST' && r.status === 200 && r.auth_scheme === 'Bearer' && r.token_ok === true)"
expect_json requests_quiet "new Set(b.map((r) => r.dataset)).size === 4 && b.every((r) => r.dataset !== null)"
expect_json requests_quiet "b.map((r) => r.dataset).join(',') === 'workersInvocationsAdaptive,durableObjectsInvocationsAdaptiveGroups,durableObjectsPeriodicGroups,queueMessageOperationsAdaptiveGroups'"
expect_json requests_quiet "b.every((r) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z\$/.test(r.start) && Date.parse(r.end) - Date.parse(r.start) === 900000 && Date.parse(r.end) % 900000 === 0 && Date.parse(r.end) <= Date.now() && Date.now() - Date.parse(r.end) < 1800000)"
expect_json requests_quiet "b.every((r) => r.start === b[0].start && r.end === b[0].end)"
expect_json requests_quiet "b.every((r) => !JSON.stringify(r).includes('$CF_TOKEN'))"
status quiet
expect_status quiet 200
breaker_is quiet armed
expect_json quiet "typeof b.breaker.last_run === 'string' && Date.parse(b.breaker.last_run) >= $before_ms - 1000 && Date.parse(b.breaker.last_run) <= $after_ms + 1000"
expect_json quiet "/^[0-9]+\\.[0-9]{4}\$/.test(b.breaker.last_usd) && b.breaker.unread.length === 0 && b.flag === 'live'"
check "the Worker's log holds neither the token, the zone id, the rule id nor the account id" "! whole_has '$CF_TOKEN' && ! whole_has '$CF_ZONE' && ! whole_has '$CF_RULE' && ! whole_has '$CF_ACCOUNT'"
check "the Worker's log holds no /zones/ URL, ruleset path or GraphQL text" "! whole_has '/zones/' && ! whole_has 'rulesets' && ! whole_has 'viewer'"
check "no breaker_base_refused for the loopback fake" "! whole_has '\"event\":\"breaker_base_refused\"'"
QUIET_RUN="$(json_field quiet b.breaker.last_run)"
run_cron cron_quiet2
status quiet2
breaker_is quiet2 armed
check "the second run moved last_run" "[[ '$(json_field quiet2 b.breaker.last_run)' > '$QUIET_RUN' ]]"

# ---------- over a meter's line: read-only, then off, then held (the same state) ----------

# 70,000 rows written is $0.07: past the dollar line ($0.0347) and the rows line (62,500), under
# the dollar burst line ($0.1389), so the first run trips read-only and not off.
cf reset_requests POST "" /_reset   # the fake's request log only counts this sequence
cf usage_loop POST '{"rows_written":70000}' /_usage
run_cron cron_ro
expect_status cron_ro 200
check "the over-the-line run trips from armed to read-only" "ev_has breaker_tripped '\"from\":\"armed\"' '\"to\":\"read-only\"'"
check "the trip logs breaker_point (the Analytics Engine point) and breaker_read read-only" "ev_has breaker_point && ev_has breaker_read '\"verdict\":\"read-only\"'"
check "Control raised the flag by the breaker" "ev_has flag_raised '\"by\":\"breaker\"'"
status ro
breaker_is ro read-only
expect_json ro "typeof b.breaker.since === 'string' && typeof b.breaker.last_run === 'string' && b.flag === 'read-only'"
cf rule_ro GET "" /_rule
expect_json rule_ro "b.enabled === false && b.patches.length === 0"
check "read-only does not touch the rule: no GET or PATCH reached the fake" "[[ \"\$(class_count rule_get)\" == 0 && \"\$(class_count rule_patch)\" == 0 ]]"
RO_SINCE="$(json_field ro b.breaker.since)"

run_cron cron_off
check "the next run, still over, trips from read-only to off" "ev_has breaker_tripped '\"from\":\"read-only\"' '\"to\":\"off\"'"
check "the rule was enabled and logged" "ev_has breaker_rule_enabled"
status off
breaker_is off off
expect_json off "b.flag === 'off' && typeof b.breaker.since === 'string' && b.breaker.since >= '$RO_SINCE'"
cf rule_off GET "" /_rule
expect_json rule_off "b.enabled === true"
expect_json rule_off "$RULE_PATCH_BODY"
check "one rule GET and one PATCH reached the fake, each with the right token" "[[ \"\$(class_count rule_get)\" == 1 && \"\$(class_count rule_patch)\" == 1 ]]"
expect_json requests "b.filter((r) => r.class !== 'graphql').every((r) => r.zone === 'ok' && r.token_ok === true && r.status === 200)"
OFF_SINCE="$(json_field off b.breaker.since)"

run_cron cron_held
check "a run after off logs breaker_held" "ev_has breaker_held '\"state\":\"off\"'"
check "no second trip, no second rule log" "[[ \"\$(ev_count breaker_tripped)\" == 0 && \"\$(ev_count breaker_rule_enabled)\" == 0 ]]"
cf rule_held GET "" /_rule
expect_json rule_held "b.enabled === true && b.patches.length === 1"
check "no second rule GET or PATCH" "[[ \"\$(class_count rule_get)\" == 1 && \"\$(class_count rule_patch)\" == 1 ]]"

# A state never goes down: quiet usage after off leaves it off.
cf usage_quiet POST '{"rows_written":500}' /_usage
run_cron cron_after_quiet
status after_quiet
breaker_is after_quiet off
expect_json after_quiet "b.flag === 'off' && b.breaker.since === '$OFF_SINCE'"
check "quiet usage after off still logs breaker_held, not a trip" "ev_has breaker_held && [[ \"\$(ev_count breaker_tripped)\" == 0 ]]"
check "the token and ids stayed out of the log through the whole trip sequence" "! whole_has '$CF_TOKEN' && ! whole_has '$CF_ZONE' && ! whole_has '$CF_RULE' && ! whole_has 'fakeruleset'"

# ---------- a loop window: off in one run ----------

phase full
cf usage_flood POST '{"rows_written":4320000}' /_usage
run_cron cron_flood
check "a loop window trips straight to off" "ev_has breaker_tripped '\"to\":\"off\"'"
check "the flood's rule was enabled" "ev_has breaker_rule_enabled"
status flood
breaker_is flood off
expect_json flood "b.flag === 'off'"
cf rule_flood GET "" /_rule
expect_json rule_flood "b.enabled === true && $RULE_PATCH_BODY"

# ---------- the rule failing: the next run tries again ----------

phase full
cf usage_fail POST '{"rows_written":4320000}' /_usage
cf fail_get POST '{"status":500,"dataset":"rule_get"}' /_fail
run_cron cron_rule_get
check "the entry point's GET failing logs breaker_rule_failed with status 500" "ev_has breaker_rule_failed '\"step\":\"get\"' '\"status\":500'"
check "the trip itself still happened" "ev_has breaker_tripped '\"to\":\"off\"'"
cf rule_failed_get GET "" /_rule
expect_json rule_failed_get "b.enabled === false && b.patches.length === 0"
status rule_get_failed
breaker_is rule_get_failed off
expect_json rule_get_failed "b.flag === 'off'"

cf fail_patch POST '{"status":500,"dataset":"rule_patch"}' /_fail
run_cron cron_rule_patch
check "the PATCH failing logs breaker_rule_failed again" "ev_has breaker_rule_failed '\"step\":\"patch\"' '\"status\":500'"
check "the run was a held one, not a second trip" "ev_has breaker_held && [[ \"\$(ev_count breaker_tripped)\" == 0 ]]"
check "the rule was fetched again and not enabled" "[[ \"\$(class_count rule_get)\" == 2 && \"\$(class_count rule_patch)\" == 1 && \"\$(ev_count breaker_rule_enabled)\" == 0 ]]"
cf rule_failed_patch GET "" /_rule
expect_json rule_failed_patch "b.enabled === false && b.patches.length === 0"

cf unfail POST '{"status":0}' /_fail
run_cron cron_rule_ok
check "after the failure ends the next run enables the rule" "ev_has breaker_rule_enabled"
cf rule_ok GET "" /_rule
expect_json rule_ok "b.enabled === true && $RULE_PATCH_BODY"
run_cron cron_rule_done
cf rule_done GET "" /_rule
expect_json rule_done "b.patches.length === 1"
check "the run after that does not PATCH again" "ev_has breaker_held && [[ \"\$(ev_count breaker_rule_enabled)\" == 0 ]]"
check "no rule failure leaked a body, token or id" "! whole_has '$CF_TOKEN' && ! whole_has '$CF_ZONE' && ! whole_has '$CF_RULE' && ! whole_has 'fake failure'"

# ---------- one dataset answering a GraphQL error; an empty answer ----------

phase full
cf gq POST '{"dataset":"durableObjectsPeriodicGroups"}' /_graphql_errors
cf usage_gq POST '{"worker_requests":3000}' /_usage
run_cron cron_gq
expect_status cron_gq 200
check "rows_written is unread with reason graphql" "ev_has breaker_meter_unread '\"meter\":\"rows_written\"' '\"dataset\":\"durableObjectsPeriodicGroups\"' '\"reason\":\"graphql\"'"
check "do_gb_s is unread with reason graphql" "ev_has breaker_meter_unread '\"meter\":\"do_gb_s\"' '\"reason\":\"graphql\"'"
check "exactly two meters were unread" "[[ \"\$(ev_count breaker_meter_unread)\" == 2 ]]"
check "the verdict comes from the other three: 3,000 Worker requests is over the line" "ev_has breaker_read '\"verdict\":\"read-only\"' '\"read\":3'"
check "the run was not a failure" "[[ \"\$(ev_count breaker_failed)\" == 0 ]]"
status gq
breaker_is gq read-only
expect_json gq "b.breaker.unread.join(',') === 'rows_written,do_gb_s' && b.flag === 'read-only'"
cf requests_gq GET "" /_requests
expect_json requests_gq "b.filter((r) => r.class === 'graphql').length === 4 && b.every((r) => r.status === 200)"

# Empty answers for the two request meters: logged, counted as 0 (a quiet account would not do
# this, the cron's own run leaves a request in every slot, so it means late data).
cf gq_off POST '{"dataset":"durableObjectsPeriodicGroups","off":true}' /_graphql_errors
cf empty_w POST '{"dataset":"workersInvocationsAdaptive"}' /_empty
cf empty_d POST '{"dataset":"durableObjectsInvocationsAdaptiveGroups"}' /_empty
run_cron cron_empty
check "an empty Worker request answer logs breaker_meter_empty" "ev_has breaker_meter_empty '\"meter\":\"worker_requests\"'"
check "an empty DO request answer logs breaker_meter_empty" "ev_has breaker_meter_empty '\"meter\":\"do_requests\"'"
check "an empty answer is a read of 0, not an unread meter" "ev_has breaker_read '\"read\":5' '\"unread\":[]'"
check "the empty-answer run was not a failure" "[[ \"\$(ev_count breaker_failed)\" == 0 && \"\$(ev_count breaker_meter_unread)\" == 0 ]]"

# ---------- every request failing: nothing changes ----------

# Same state as above (read-only). Record what the status says, fail everything, run, compare.
status before_fail
BEFORE_STATE="$(json_field before_fail b.breaker.state)"
BEFORE_RUN="$(json_field before_fail b.breaker.last_run)"
BEFORE_USD="$(json_field before_fail b.breaker.last_usd)"
cf reset_for_fail POST "" /_reset
cf fail_all POST '{"status":500}' /_fail
run_cron cron_fail
expect_status cron_fail 200
check "every request failing logs breaker_failed" "ev_has breaker_failed"
check "all five meters were unread with status 500 (reason status)" "[[ \"\$(ev_count breaker_meter_unread)\" == 5 ]] && ev_has breaker_meter_unread '\"reason\":\"status\"' '\"status\":500'"
check "no breaker_read when nothing was read" "[[ \"\$(ev_count breaker_read)\" == 0 ]]"
status after_fail
expect_json after_fail "b.breaker.state === '$BEFORE_STATE' && b.breaker.last_run === '$BEFORE_RUN' && b.breaker.last_usd === '$BEFORE_USD'"
check "all four requests were still tried (one dataset's failure never hides another's)" "[[ \"\$(graphql_count)\" == 4 ]]"
cf unfail2 POST '{"status":0}' /_fail

# ---------- a slow dataset: the 5 s timeout ----------

cf delay POST '{"ms":7000,"dataset":"durableObjectsPeriodicGroups"}' /_delay
run_cron cron_slow
check "rows_written is unread with reason timeout" "ev_has breaker_meter_unread '\"meter\":\"rows_written\"' '\"reason\":\"timeout\"'"
check "do_gb_s is unread with reason timeout" "ev_has breaker_meter_unread '\"meter\":\"do_gb_s\"' '\"reason\":\"timeout\"'"
check "the other three meters were read" "ev_has breaker_read '\"read\":3'"
check "the slow dataset cost about 5 s, not 7 (the cron request took $RUN_MS ms)" "(( RUN_MS >= 4500 && RUN_MS < 6900 ))"
cf undelay POST '{"ms":0}' /_delay

# ---------- a rejected token: 401 ----------

phase badtoken
run_cron cron_401
expect_status cron_401 200
check "a rejected token leaves every meter unread with status 401" "[[ \"\$(ev_count breaker_meter_unread)\" == 5 ]] && ev_has breaker_meter_unread '\"reason\":\"status\"' '\"status\":401'"
check "a rejected token logs breaker_failed" "ev_has breaker_failed"
status r401
breaker_is r401 unconfigured
check "the rejected token is not in the log" "! whole_has 'not-the-fakes-token'"
cf requests_401 GET "" /_requests
expect_json requests_401 "b.length === 4 && b.every((r) => r.status === 401 && r.token_ok === false)"

# ---------- dead letters while off: kept, marked, not counted (R67) ----------

echo "--- starting the fake Turnstile on $FAKE"
set -m
node "$ROOT/scripts/fake-providers.mjs" --port "$FAKE_PORT" > "$TMP/fake.log" 2>&1 < /dev/null &
FAKE_PID=$!
set +m
for _ in $(seq 1 50); do curl -s -o /dev/null "$FAKE/_health" && break; sleep 0.1; done
SITEVERIFY_URL="$FAKE/turnstile/siteverify"
phase full
JAR="$TMP/demo.jar"
touch "$JAR"
# The demo account's cookies, kept by hand as scripts/smoke-orders.sh keeps them: they are Secure,
# and this is plain HTTP on 127.0.0.1.
jar_update() {
  while IFS= read -r line; do
    local pair="${line#set-cookie: }"; pair="${pair%%;*}"
    local key="${pair%%=*}" value="${pair#*=}"
    grep -v "^$key=" "$JAR" > "$JAR.new" || true
    if [[ -n "$value" ]] && ! grep -qi 'max-age=0' <<<"$line"; then echo "$key=$value" >> "$JAR.new"; fi
    mv "$JAR.new" "$JAR"
  done < <(grep '^set-cookie: ' "$TMP/$1.headers" || true)
}
ulid() {
  node -e "const A='0123456789ABCDEFGHJKMNPQRSTVWXYZ';let t=Date.now(),s='';for(let i=0;i<10;i++){s=A[t%32]+s;t=Math.floor(t/32)}const r=require('crypto').randomBytes(16);for(let i=0;i<16;i++)s+=A[r[i]%32];process.stdout.write(s)"
}
# demo NAME METHOD PATH [BODY]: one request as the demo account, its cookies kept in $JAR.
demo() {
  local name="$1" method="$2" path="$3" body="${4:-}"
  local args=(-X "$method" -H "Origin: $STOREFRONT" -H "CF-Connecting-IP: 192.0.2.77")
  if [[ "$method" == POST ]]; then args+=(-H "Idempotency-Key: $(ulid)"); fi
  if [[ -n "$body" ]]; then args+=(-H 'Content-Type: application/json' --data "$body"); fi
  if [[ -s "$JAR" ]]; then args+=(-H "Cookie: $(paste -sd';' "$JAR" | sed 's/;/; /g')"); fi
  request "$name" "${args[@]}" "$BASE$path"
  jar_update "$name"
}
# The first pickup slot an hour or more ahead that the Schedule takes (07:00 to 14:45 on the
# quarter hour in America/Denver, closed Mondays), and an available variant baked that day, from
# the menu in NAME.body; as scripts/smoke-orders.sh picks them, without the season and lead rules
# beyond the variant's lead time.
pick() {
  node -e "
    const TZ = 'America/Denver';
    const parts = (ms) => { const o = {}; for (const p of new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }).formatToParts(new Date(ms))) o[p.type] = p.value; return o; };
    const offsetMin = (ms) => { const p = parts(ms); return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000) / 60000); };
    const iso = (ms) => { const p = parts(ms), o = offsetMin(ms), a = Math.abs(o); return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute + ':' + p.second + (o < 0 ? '-' : '+') + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0'); };
    const wd = (ms) => parts(ms).weekday.toLowerCase().slice(0, 3);
    const minuteOf = (ms) => { const p = parts(ms); return +p.hour * 60 + +p.minute; };
    const isSlot = (ms) => wd(ms) !== 'mon' && minuteOf(ms) >= 420 && minuteOf(ms) <= 885 && minuteOf(ms) % 15 === 0;
    const menu = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    let slot = Math.ceil((Date.now() + Number(process.argv[2]) * 60000) / 900000) * 900000;
    for (;;) {
      while (!isSlot(slot)) slot += 900000;
      const p = parts(slot);
      const md = p.month + '-' + p.day;
      const inSeason = (s) => !s || (s.from <= s.to ? s.from <= md && md <= s.to : md >= s.from || md <= s.to);
      const lead = Math.floor((slot - Date.now()) / 60000) - 30;
      for (const c of menu.categories) for (const i of c.items) {
        if (i.status !== 'available' || !i.days_baked.includes(wd(slot)) || !inSeason(i.season)) continue;
        const v = i.variants.find((v) => v.lead_minutes <= lead);
        if (v) { console.log(JSON.stringify({ variant: v.slug, slot: iso(slot) })); process.exit(0); }
      }
      slot += 900000;
    }" "$TMP/$1.body" "$2"
}
# dead_for NAME ORDER: polls the dead-letter list, up to 30 s, until it holds ORDER's OrderPlaced.
dead_for() {
  for _ in $(seq 1 150); do
    demo "$1" GET "/v1/sandboxes/$DSB/dead-letters"
    if node -e "const b = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); process.exit(Array.isArray(b) && b.some(d => d.type === 'OrderPlaced' && d.stream.endsWith(':$2')) ? 0 : 1)" "$TMP/$1.body" 2>/dev/null; then return 0; fi
    sleep 0.2
  done
  return 1
}
demo signup POST /v1/auth/demo "{\"password\":\"$(random_text 24)\",\"turnstile_token\":\"pass-1\"}"
expect_status signup 201
demo sandbox POST /v1/sandboxes '{"replace":false}'
expect_status sandbox 201
DSB="$(json_field sandbox b.id)"
for _ in $(seq 1 100); do
  demo sandbox_state GET "/v1/sandboxes/$DSB"
  [[ "$(json_field sandbox_state b.state)" == live ]] && break
  sleep 0.2
done
expect_json sandbox_state "b.state === 'live'"
demo menu GET "/v1/sandboxes/$DSB/menu"
PICK="$(pick menu 60)"
VARIANT="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).variant)" "$PICK")"
SLOT="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).slot)" "$PICK")"
ORDER_BODY="{\"kind\":\"pickup\",\"slot\":\"$SLOT\",\"lines\":[{\"variant\":\"$VARIANT\",\"qty\":1}]}"

# A real dead letter, while live: the Kitchen refuses every try.
demo fault_on POST "/v1/sandboxes/$DSB/faults" '{"fault":"kitchen","on":true}'
expect_json fault_on "b.faults.kitchen === true"
mark
demo real_order POST "/v1/sandboxes/$DSB/orders" "$ORDER_BODY"
expect_status real_order 201
REAL="$(json_field real_order b.id)"
check "live: the faulted OrderPlaced reaches the dead-letter list" "dead_for real_dead '$REAL'"
expect_json real_dead "b.find(d => d.stream.endsWith(':$REAL')).made_while_off === false && b.find(d => d.stream.endsWith(':$REAL')).error === 'Kitchen answered 503'"
settle
check "live: the dead letter is kept and counted" "ev_has dlq '\"outcome\":\"kept\"' '\"while_off\":false' '\"counted\":true'"
demo fault_off POST "/v1/sandboxes/$DSB/faults" '{"fault":"kitchen","on":false}'
expect_json fault_off "b.faults.kitchen === false"

# The switch: a loop window trips straight to off, and the consumer retries everything.
cf usage_off POST '{"rows_written":4320000}' /_usage
run_cron cron_off_dlq
status off_dlq
expect_json off_dlq "b.flag === 'off'"
# A consumer isolate keeps its copy of the flag for 60 s (FLAG_CACHE_MS in queue.rs), so it reads
# `off` only once its copy of `live` from the order above has expired.
sleep 62
mark
demo off_order POST "/v1/sandboxes/$DSB/orders" "$ORDER_BODY"
expect_status off_order 201
OFF="$(json_field off_order b.id)"
check "off: the order's OrderPlaced reaches the dead-letter list" "dead_for off_dead '$OFF'"
expect_json off_dead "b.find(d => d.stream.endsWith(':$OFF')).made_while_off === true"
expect_json off_dead "b.find(d => d.stream.endsWith(':$REAL')).made_while_off === false"
settle
check "off: the dead letter is kept, marked and not counted (no dlq point)" "ev_has dlq '\"outcome\":\"kept\"' '\"while_off\":true' '\"counted\":false' && ! ev_has dlq '\"outcome\":\"kept\"' '\"counted\":true'"
check "off: the consumer retried at off" "ev_has queue_batch '\"off\":true'"
OFF_EVENT="$(json_field off_dead "(b.find(d => d.stream.endsWith(':$OFF')) || {}).id")"
demo redrive_off POST "/v1/sandboxes/$DSB/dead-letters/$OFF_EVENT/redrive"
expect_status redrive_off 200
expect_json redrive_off "b.id === '$OFF_EVENT' && b.made_while_off === true"
demo after_redrive GET "/v1/sandboxes/$DSB/dead-letters"
expect_json after_redrive "!b.some(d => d.id === '$OFF_EVENT') || b.find(d => d.id === '$OFF_EVENT').made_while_off === true"
stop_pid "$FAKE_PID"; FAKE_PID=""
SITEVERIFY_URL=""

# ---------- the launch checklist's forced trip: a ceiling of 0 ----------

phase full BREAKER_CEILING_USD=0
cf usage_forced POST '{"worker_requests":20,"do_requests":20,"rows_written":500,"do_gb_s":0.1,"queue_operations":30}' /_usage
run_cron cron_forced
expect_status cron_forced 200
check "a ceiling of 0 trips on quiet usage" "[[ \"\$(ev_count breaker_tripped)\" == 1 ]]"
check "the forced trip goes to off (the window's price is past a burst of a zero line) and enables the rule" "ev_has breaker_tripped '\"to\":\"off\"' && ev_has breaker_rule_enabled"
status forced
breaker_is forced off
expect_json forced "b.flag === 'off'"
cf rule_forced GET "" /_rule
expect_json rule_forced "b.enabled === true"

echo
if (( FAILURES > 0 )); then
  echo "$PASSES passed, $FAILURES failed"
  exit 1
fi
echo "all $PASSES checks passed"
