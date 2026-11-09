#!/usr/bin/env bash
# Smoke-tests PR 8 on `wrangler dev` against the fake providers and scripts/fake-stripe.mjs: CRM,
# campaigns and the inbox (docs/roadmap.md, PR 8; docs/architecture.md, "A campaign send").
#
# - The seed: 60 customers, five segments, the lead pipeline and 240 seeded receipts in the
#   inbox, whose opened and clicked counts are inside the engagement bounds and the same in two
#   sandboxes born from the same seed (SANDBOX_SEED, honored on a loopback API only).
# - The segment: a cake order placed and paid through the fake Stripe for the visitor's persona
#   (the script picks a seed whose persona has no cake order in the last 30 days today) makes
#   `cake-last-30-days` gain the persona; with `marketing: false` a campaign scheduled 20 minutes
#   ahead to that segment, sent when the clock passes it, freezes recipients that exclude the
#   persona and the inbox holds no campaign message for it; consent back on, a second campaign
#   includes it.
# - The double fire: a second alarm after the send (the clock advanced again) leaves one
#   `CampaignSent` in Crm's log and one message per recipient.
# - Campaign rules: 201 with Location, the same key replayed (Idempotent-Replayed), the PATCH of a
#   draft with its Idempotency-Key replayed, 422 `campaign` `schedule-too-soon` with the earliest
#   time as an ISO business time, 409 `out-of-order` editing a scheduled one, cancel back to
#   draft.
# - The inbox: the paid order's receipt, the ready notice (the kitchen socket's commands), the
#   refund notice, a catering inquiry's acknowledgement and quote; an hour of business time makes
#   some campaign messages opened, a day more some clicked, the counts inside the bounds and the
#   same in both sandboxes.
# - Loyalty: points on the paid order equal to its whole dollars, taken back by the full refund,
#   never below zero. The lead pipeline and the activity feed reflect the run: the feed has the
#   seeded orders' payments, the seeded catering steps (production started and delivered among
#   them since 2026-11-08, in the feed and a timeline) and each campaign sent, and no count reads
#   "1 vans" (the console audit of 2026-11-08, findings 13 and 36).
# - Consent by a guest on its own persona (200) and on another's (403 `guest-scope`); a guest's
#   staff actions are 403; unknown customers, segments, campaigns and messages are 404.
# - Free text: an order placed with a note and an inquiry with a brief; neither's words appear
#   in any CRM or inbox response, in Crm's projection or log, in the Inbox's messages, or in the
#   Worker's log.
# - The rebuild: every CRM response and Crm's stored projection read, the rebuild started (202;
#   409 `rebuild` while it runs), `applied` climbing to `total` over several alarms, then every
#   response and the projection byte-identical (the activity feed gains only the rebuild's own
#   row), and `ProjectionRebuildFinished` with `events` = the log's length.
# - The wipe: scripts/list-objects.mjs exits 0, the Customer, Crm and Inbox objects included.
#
# The Mailbox rule ("no Mailbox implementation can address a non-sandbox recipient") is proven
# natively in crates/app (the compile-fail doctests on `Recipient` and the fake's refusal), not
# here. It prints ok or FAIL per check as scripts/smoke-catering.sh does, and exits non-zero on
# any failure. A run takes about four minutes.
#
# Usage: scripts/smoke-crm.sh   (from anywhere; needs cargo, worker-build, pnpm, node 22 and curl).
#
# Like scripts/smoke-catering.sh it writes a throwaway workers/api/.dev.vars, refuses to run when
# one exists unless SMOKE_CRM_OVERWRITE=1, starts the fake providers (Turnstile) on 8790 and the
# fake Stripe on 8791, and keeps the Worker's log in SMOKE_CRM_LOG=<file> when set. Every key in
# the .dev.vars is a test-shaped fake, and every note and brief is made of synthetic words.
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

TMP="$(mktemp -d -t smoke-crm.XXXXXX)"
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
  if [[ -n "${SMOKE_CRM_LOG:-}" ]]; then cp "$LOG" "$SMOKE_CRM_LOG" 2>/dev/null || true; fi
  if (( FAILURES > 0 )); then
    mkdir -p "${TMPDIR:-/tmp}/smoke-crm-logs"
    cp "$LOG" "${TMPDIR:-/tmp}/smoke-crm-logs/worker.log" 2>/dev/null || true
    echo "logs kept in ${TMPDIR:-/tmp}/smoke-crm-logs" >&2
  fi
  rm -rf "$TMP"
}
trap stop EXIT

pass() { printf 'ok    %s\n' "$1"; PASSES=$((PASSES + 1)); }
fail() { printf 'FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }

if [[ -e "$DEV_VARS" ]]; then
  if [[ -z "${SMOKE_CRM_OVERWRITE:-}" ]]; then
    echo "workers/api/.dev.vars exists; this script would replace it. Move it aside, or set SMOKE_CRM_OVERWRITE=1 to have it moved and restored." >&2
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
    echo "# Written by scripts/smoke-crm.sh for one run; removed when it ends. Never committed."
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

# ---------- CRM helpers ----------

# inquiry DATE HEADCOUNT [BRIEF]: an inquiry's body, the brief JSON-escaped.
inquiry() {
  node -e "const [date, headcount, brief] = process.argv.slice(1); const b = { date, headcount: Number(headcount), package: 'breakfast-spread', venue: 'v2' }; if (brief) b.brief = brief; process.stdout.write(JSON.stringify(b))" "$@"
}
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

WS="ws://127.0.0.1:${PORT}"
# A word made of letters only, so no free-text class (a phone number's digits) refuses it.
letters() { node -e "const A='abcdefghijklmnopqrstuvwxyz';const r=require('crypto').randomBytes($1);let s='';for(const b of r)s+=A[b%26];process.stdout.write(s)"; }

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

# biz_iso SANDBOX JAR PLUS_MIN: the sandbox's business now plus PLUS_MIN minutes, on a whole
# minute, as the console's picker sends it: America/Denver with its offset.
biz_iso() {
  get_as "off_$1" "$2" "/v1/sandboxes/$1"
  node -e "
    const TZ = 'America/Denver';
    const parts = (ms) => { const o = {}; for (const p of new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms))) o[p.type] = p.value; return o; };
    const offsetMin = (ms) => { const p = parts(ms); return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000) / 60000); };
    const iso = (ms) => { const p = parts(ms), o = offsetMin(ms), a = Math.abs(o); return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute + ':00' + (o < 0 ? '-' : '+') + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0'); };
    const ms = Date.now() + Number(process.argv[1]) * 1000 + Number(process.argv[2]) * 60000;
    process.stdout.write(iso(Math.ceil(ms / 60000) * 60000));" "$(json_field "off_$1" b.clock_offset_s)" "$3"
}

# cake_order MENU_NAME NOTE: a pickup order of two cake slices at the first slot about four hours
# out on a day cakes are baked, with NOTE.
cake_order() {
  node -e "
    const TZ = 'America/Denver';
    const parts = (ms) => { const o = {}; for (const p of new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }).formatToParts(new Date(ms))) o[p.type] = p.value; return o; };
    const offsetMin = (ms) => { const p = parts(ms); return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000) / 60000); };
    const iso = (ms) => { const p = parts(ms), o = offsetMin(ms), a = Math.abs(o); return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute + ':' + p.second + (o < 0 ? '-' : '+') + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0'); };
    const wd = (ms) => parts(ms).weekday.toLowerCase().slice(0, 3);
    const minuteOf = (ms) => { const p = parts(ms); return +p.hour * 60 + +p.minute; };
    const isSlot = (ms) => wd(ms) !== 'mon' && minuteOf(ms) >= 420 && minuteOf(ms) <= 885 && minuteOf(ms) % 15 === 0;
    const menu = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const cakes = menu.categories.find((c) => c.slug === 'cakes').items.filter((i) => i.status === 'available');
    let slot = Math.ceil((Date.now() + 240 * 60000) / 900000) * 900000;
    for (let n = 0; n < 2000; n++, slot += 900000) {
      if (!isSlot(slot)) continue;
      const i = cakes.find((i) => i.days_baked.includes(wd(slot)) && !i.season);
      if (!i) continue;
      const v = i.variants.find((v) => v.slug.endsWith('/slice'));
      console.log(JSON.stringify({ kind: 'pickup', slot: iso(slot), lines: [{ variant: v.slug, qty: 2 }], note: process.argv[2] }));
      process.exit(0);
    }
    process.exit(1);" "$TMP/$1.body" "$2"
}

# The rebuild's reads: every CRM response a page shows, for sandbox $1 with jar $2, written to
# files named $3_<what>.
crm_reads() {
  local id="$1" jar_name="$2" tag="$3"
  get_as "${tag}_customers" "$jar_name" "/v1/sandboxes/$id/customers"
  get_as "${tag}_timeline" "$jar_name" "/v1/sandboxes/$id/customers/$PERSONA/timeline"
  get_as "${tag}_segments" "$jar_name" "/v1/sandboxes/$id/segments"
  get_as "${tag}_campaigns" "$jar_name" "/v1/sandboxes/$id/campaigns"
  get_as "${tag}_leads" "$jar_name" "/v1/sandboxes/$id/leads"
  get_as "${tag}_activity" "$jar_name" "/v1/sandboxes/$id/activity?limit=500"
  object_sql Crm "crm:$id" "SELECT projection FROM crm" > "$TMP/${tag}_projection.json" 2>/dev/null || echo '[]' > "$TMP/${tag}_projection.json"
}
crm_log_len() { sql_count Crm "crm:$1" "SELECT count(*) AS n FROM log"; }

# campaign_messages SANDBOX JAR CAMPAIGN NAME: the campaign's messages in the inbox, to NAME.body.
campaign_messages() { get_as "$4" "$2" "/v1/sandboxes/$1/inbox?kind=campaign&limit=500"; }

# ---------- a seed whose persona has no cake order in the last 30 days ----------

TODAY="$(cal 'day(Date.now())')"
echo "picking a seed for $TODAY whose persona has no cake order in the last 30 days and has consented"
SEED=""
(cd "$ROOT" && cargo build -q --locked -p bakery-seed) || { echo "cannot build the seed generator" >&2; exit 1; }
for s in $(seq 1 80); do
  if (cd "$ROOT" && cargo run -q --locked -p bakery-seed -- "$s" "$TODAY" 2>/dev/null) | node -e "
    const g = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const cakes = new Set(g.items.filter((i) => i.category === 'cakes').map((i) => i.slug));
    const p = g.customers[0];
    const since = Date.now() - 31 * 86400000;
    const cake = (o) => o.lines.some((l) => cakes.has(l.variant.split('/')[0]));
    // An order only placed whose slot is near at birth is paid then (Generated::born_at), so it counts too.
    const near = (o) => o.state === 'placed' && Date.parse(o.slot_start) < Date.now() + 20 * 60000;
    const counted = [...g.history, ...g.open_orders.filter((o) => ['confirmed', 'in_production', 'ready'].includes(o.state) || near(o))];
    const member = counted.some((o) => o.customer === p.id && cake(o) && Date.parse(o.slot_start) >= since);
    process.exit(!member && p.marketing ? 0 : 1);" 2>/dev/null; then SEED="$s"; break; fi
done
if [[ -z "$SEED" ]]; then echo "no seed from 1 to 80 fits today" >&2; exit 1; fi
echo "seed $SEED"

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

# ---------- a guest and two staff sandboxes, born from the same seed ----------

CANARY="$(random_text 24)"
command_as guest G 192.0.2.81 POST /v1/sandboxes '{"turnstile_token":"pass-1","replace":false}'
expect_status guest 201
GID="$(json_field guest b.id)"
signup a D 192.0.2.82
expect_status sandbox_a 201
AID="$SID"
signup b E 192.0.2.83
expect_status sandbox_b 201
BID="$SID"
check "guest: seeding reaches live" "wait_live guest_live G '$GID'"
expect_json guest_live "b.state === 'live' && b.children >= 36 && b.seed === $SEED"
check "a: seeding reaches live" "wait_live a_live D '$AID'"
expect_json a_live "b.children >= 36 && b.seed === $SEED"
check "b: seeding reaches live" "wait_live b_live E '$BID'"
expect_json b_live "b.seed === $SEED"
PERSONA="$(json_field a_live b.persona)"
BORN_A="$(json_field a_live b.born)"
BORN_B="$(json_field b_live b.born)"
check "the three sandboxes share the persona, as one seed gives" "[[ '$(json_field guest_live b.persona)' == '$PERSONA' && '$(json_field b_live b.persona)' == '$PERSONA' ]]"
check "Crm and the Inbox were seeded (crm_seeded, inbox_seeded)" "log_has '\"event\":\"crm_seeded\"' && log_has '\"event\":\"inbox_seeded\"'"

# ---------- what the seed gives, read by a guest ----------

check "the guest reads 60 customers once the seeded orders reach Crm" "until_json g_customers G '/v1/sandboxes/$GID/customers' 'b.customers.length === 60 && b.customers.every(c => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(c.customer) && c.display_name && c.place && c.preferences.length >= 1 && c.loyalty_points >= 0)'"
OTHER="$(json_field g_customers "b.customers.find(c => c.customer !== '$PERSONA').customer")"
get_as g_customer G "/v1/sandboxes/$GID/customers/$PERSONA"
expect_status g_customer 200
expect_json g_customer "b.customer === '$PERSONA' && b.marketing === true && Object.keys(b).every(k => ['customer','display_name','preferences','home_zone','place','marketing','loyalty_points','orders','last_order_at','catering'].includes(k))"
get_as g_timeline G "/v1/sandboxes/$GID/customers/$PERSONA/timeline"
expect_status g_timeline 200
expect_json g_timeline "b.customer === '$PERSONA' && b.entries.length >= 1 && b.entries.some(e => e.type === 'OrderClosed') && b.entries.every((e, i) => i === 0 || Date.parse(b.entries[i - 1].at) <= Date.parse(e.at))"
get_as g_segments G "/v1/sandboxes/$GID/segments"
expect_json g_segments "b.segments.map(s => s.segment).join() === 'everyone,cake-last-30-days,delivery-customers,lapsed-60-days,catering-leads' && b.segments[0].members === 60 && b.segments.every(s => s.sample.length === Math.min(5, s.members))"
get_as g_segment G "/v1/sandboxes/$GID/segments/everyone"
expect_json g_segment "b.segment === 'everyone' && b.members === 60 && b.sample.length === 5 && b.sample.every((x, i) => i === 0 || b.sample[i - 1] < x)"
get_as g_segment_404 G "/v1/sandboxes/$GID/segments/regulars"
expect_status g_segment_404 404
get_as g_customer_404 G "/v1/sandboxes/$GID/customers/01JC8Z6K3W9QF2N4T7XRB5M0HD"
expect_status g_customer_404 404
get_as g_campaigns G "/v1/sandboxes/$GID/campaigns"
expect_status g_campaigns 200
expect_json g_campaigns "Array.isArray(b.campaigns) && b.campaigns.length === 0"
get_as g_campaign_404 G "/v1/sandboxes/$GID/campaigns/01JC8Z6K3W9QF2N4T7XRB5M0HD"
expect_status g_campaign_404 404
get_as g_leads G "/v1/sandboxes/$GID/leads"
expect_json g_leads "b.stages.map(s => s.stage).join() === 'inquiry,quoted,accepted,won,lost,closed' && b.stages.reduce((n, s) => n + s.count, 0) === 8 && b.stages.every(s => s.count === s.events.length)"
get_as g_activity G "/v1/sandboxes/$GID/activity?limit=5"
expect_status g_activity 200
expect_json g_activity "Array.isArray(b.entries) && b.entries.length <= 5"
get_as g_rebuild G "/v1/sandboxes/$GID/rebuild"
expect_json g_rebuild "b.state === 'idle' && b.applied === 0 && b.total > 600"
get_as g_inbox G "/v1/sandboxes/$GID/inbox"
expect_status g_inbox 200
expect_json g_inbox "b.messages.length === 50 && b.total >= 240 && b.messages.every((m, i) => i === 0 || Date.parse(b.messages[i - 1].delivered_at) >= Date.parse(m.delivered_at))"
MID="$(json_field g_inbox "b.messages[0].message")"
get_as g_message G "/v1/sandboxes/$GID/inbox/$MID"
expect_json g_message "b.message === '$MID' && typeof b.subject === 'string' && typeof b.body === 'string'"
get_as g_message_404 G "/v1/sandboxes/$GID/inbox/01JC8Z6K3W9QF2N4T7XRB5M0HD"
expect_status g_message_404 404
get_as g_inbox_bad G "/v1/sandboxes/$GID/inbox?kind=letter"
expect_problem g_inbox_bad 400 filter
get_as g_inbox_to G "/v1/sandboxes/$GID/inbox?to=$PERSONA&limit=500"
expect_json g_inbox_to "b.messages.every(m => m.to === '$PERSONA') && b.total === b.messages.length"

# ---------- the guest's reach ----------

command_as g_consent_other G 192.0.2.81 POST "/v1/sandboxes/$GID/customers/$OTHER/consent" '{"marketing":false}'
expect_problem g_consent_other 403 guest-scope
KEY_GC="$(ulid)"
KEY="$KEY_GC" command_as g_consent_own G 192.0.2.81 POST "/v1/sandboxes/$GID/customers/$PERSONA/consent" '{"marketing":false}'
expect_status g_consent_own 200
expect_json g_consent_own "b.customer === '$PERSONA' && b.marketing === false"
KEY="$KEY_GC" command_as g_consent_again G 192.0.2.81 POST "/v1/sandboxes/$GID/customers/$PERSONA/consent" '{"marketing":false}'
expect_header g_consent_again idempotent-replayed true
check "the guest's consent reaches Crm" "until_json g_consent_crm G '/v1/sandboxes/$GID/customers/$PERSONA' 'b.marketing === false'"
command_as g_consent_unknown G 192.0.2.81 POST "/v1/sandboxes/$GID/customers/01JC8Z6K3W9QF2N4T7XRB5M0HD/consent" '{"marketing":false}'
expect_problem g_consent_unknown 403 guest-scope
command_as a_consent_unknown D 192.0.2.82 POST "/v1/sandboxes/$AID/customers/01JC8Z6K3W9QF2N4T7XRB5M0HD/consent" '{"marketing":false}'
expect_status a_consent_unknown 404
command_as g_campaign G 192.0.2.81 POST "/v1/sandboxes/$GID/campaigns" '{"subject":"cake-week","body":"cake-orders","segment":"everyone"}'
expect_problem g_campaign 403 guest-scope
command_as g_rebuild_post G 192.0.2.81 POST "/v1/sandboxes/$GID/rebuild"
expect_problem g_rebuild_post 403 guest-scope
command_as g_patch G 192.0.2.81 PATCH "/v1/sandboxes/$GID/campaigns/01JC8Z6K3W9QF2N4T7XRB5M0HD" '{"subject":"cake-week","body":"cake-orders","segment":"everyone"}'
expect_problem g_patch 403 guest-scope
get_as cross E "/v1/sandboxes/$GID/customers"
expect_status cross 404

# ---------- the seeded receipts: engagement from the seed, the same in two sandboxes ----------

# The seed's 240 receipts are the Inbox's messages no MessageDelivered of its own announced.
SEEDED_SQL="SELECT count(*) AS n, sum(json_extract(body, '\$.opened_at') IS NOT NULL) AS o, sum(json_extract(body, '\$.clicked_at') IS NOT NULL) AS c FROM messages WHERE id NOT IN (SELECT json_extract(data, '\$.message') FROM events WHERE type = 'MessageDelivered')"
seeded_of() { object_sql Inbox "inbox:$1" "$SEEDED_SQL" 2>/dev/null | node -e "const r = JSON.parse(require('fs').readFileSync(0, 'utf8'))[0]; process.stdout.write([r.n, r.o, r.c].join())"; }
sleep 2
A_SEEDED="$(seeded_of "$AID")"
B_SEEDED="$(seeded_of "$BID")"
echo "seeded receipts (count, opened, clicked): a $A_SEEDED, b $B_SEEDED"
check "240 seeded receipts, 80 to 140 opened and 15 to 60 clicked, in both sandboxes alike" "[[ '$A_SEEDED' == '$B_SEEDED' ]] && node -e \"const [n, o, c] = '$A_SEEDED'.split(',').map(Number); process.exit(n === 240 && o >= 80 && o <= 140 && c >= 15 && c <= 60 ? 0 : 1)\""

# ---------- the segment: a paid cake order, then consent ----------

get_as a_cake_before D "/v1/sandboxes/$AID/segments/cake-last-30-days"
CAKE_BEFORE="$(json_field a_cake_before b.members)"
until_json a_p_before D "/v1/sandboxes/$AID/customers/$PERSONA" 'b.loyalty_points >= 0' 5 || true
POINTS_BEFORE="$(json_field a_p_before b.loyalty_points)"
ORDERS_BEFORE="$(json_field a_p_before b.orders)"
NOTE_WORD="Notecanary$(letters 10)"
get_as a_menu D "/v1/sandboxes/$AID/menu"
CAKE="$(cake_order a_menu "Please box it, $NOTE_WORD")" || { fail "no cake slice fits a slot"; CAKE='{}'; }
command_as a_place D 192.0.2.82 POST "/v1/sandboxes/$AID/orders" "$CAKE"
expect_status a_place 201
OID="$(json_field a_place b.id)"
TOTAL="$(json_field a_place b.total_cents)"
KEY="$OID" command_as a_pay D 192.0.2.82 POST "/v1/sandboxes/$AID/orders/$OID/payment"
expect_status a_pay 200
PI="$(intent_of a_pay)"
stripe_call a_confirm POST "/v1/payment_intents/$PI/confirm" "payment_method=pm_card_visa"
expect_json a_confirm "b.status === 'succeeded'"
check "the order reads confirmed" "until_json a_order D '/v1/sandboxes/$AID/orders/$OID' \"b.status === 'confirmed'\""
check "the Kitchen, which alone keeps the note, has it on the card" "(( $(sql_count Kitchen "kitchen:$AID" "SELECT count(*) AS n FROM board WHERE body LIKE '%$NOTE_WORD%'") == 1 ))"
check "cake-last-30-days gains the persona: one member more" "until_json a_cake_after D '/v1/sandboxes/$AID/segments/cake-last-30-days' 'b.members === $CAKE_BEFORE + 1'"
check "points on the paid order equal its whole dollars ($TOTAL cents)" "until_json a_points D '/v1/sandboxes/$AID/customers/$PERSONA' 'b.loyalty_points === $POINTS_BEFORE + Math.floor($TOTAL / 100) && b.orders === $ORDERS_BEFORE + 1'"
check "the paid order's receipt is in the inbox" "until_json a_receipt D '/v1/sandboxes/$AID/inbox?kind=receipt&to=$PERSONA' \"b.messages.some(m => m.ref === '$OID' && m.kind === 'receipt' && m.to === '$PERSONA')\""
check "the persona's timeline shows the order, the payment and the points" "until_json a_tl D '/v1/sandboxes/$AID/customers/$PERSONA/timeline' \"['OrderPlaced', 'OrderPaid', 'LoyaltyPointsEarned', 'MessageDelivered'].every(t => b.entries.some(e => e.type === t && (t === 'MessageDelivered' || e.ref === '$OID')))\""

command_as a_consent_off D 192.0.2.82 POST "/v1/sandboxes/$AID/customers/$PERSONA/consent" '{"marketing":false}'
expect_json a_consent_off "b.marketing === false"
check "the withdrawn consent reaches Crm" "until_json a_off D '/v1/sandboxes/$AID/customers/$PERSONA' 'b.marketing === false'"

# ---------- campaign one, to the segment, without the persona ----------

C1="$(ulid)"
KEY="$C1" command_as c1 D 192.0.2.82 POST "/v1/sandboxes/$AID/campaigns" '{"subject":"cake-week","body":"cake-orders","segment":"cake-last-30-days"}'
expect_status c1 201
expect_header c1 location "/v1/sandboxes/$AID/campaigns/$C1"
expect_json c1 "b.campaign === '$C1' && b.state === 'draft' && b.recipients === 0 && b.segment === 'cake-last-30-days'"
KEY="$C1" command_as c1_again D 192.0.2.82 POST "/v1/sandboxes/$AID/campaigns" '{"subject":"cake-week","body":"cake-orders","segment":"cake-last-30-days"}'
expect_status c1_again 200
expect_header c1_again idempotent-replayed true
KEY="$C1" command_as c1_reused D 192.0.2.82 POST "/v1/sandboxes/$AID/campaigns" '{"subject":"thank-you","body":"cake-orders","segment":"cake-last-30-days"}'
expect_problem c1_reused 422 idempotency-key
K_EDIT="$(ulid)"
KEY="$K_EDIT" command_as c1_edit D 192.0.2.82 PATCH "/v1/sandboxes/$AID/campaigns/$C1" '{"subject":"weekend-bake","body":"cake-orders","segment":"cake-last-30-days"}'
expect_status c1_edit 200
expect_json c1_edit "b.subject === 'weekend-bake' && b.state === 'draft'"
KEY="$K_EDIT" command_as c1_edit_again D 192.0.2.82 PATCH "/v1/sandboxes/$AID/campaigns/$C1" '{"subject":"weekend-bake","body":"cake-orders","segment":"cake-last-30-days"}'
expect_header c1_edit_again idempotent-replayed true
command_as c1_soon D 192.0.2.82 POST "/v1/sandboxes/$AID/campaigns/$C1/schedule" "{\"send_at\":\"$(biz_iso "$AID" D 5)\"}"
expect_problem c1_soon 422 campaign
expect_json c1_soon "/\\bschedule-too-soon\\b/.test(b.detail) && /\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}[-+]\\d{2}:\\d{2}/.test(b.detail)"
EARLIEST="$(json_field c1_soon "b.detail.match(/\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}[-+]\\d{2}:\\d{2}/)[0]")"
check "the earliest time named is about 15 business minutes ahead ($EARLIEST)" "node -e \"const d = (Date.parse('$EARLIEST') - Date.now() - Number('$(json_field "off_$AID" b.clock_offset_s)') * 1000) / 60000; process.exit(d >= 14 && d <= 17 ? 0 : 1)\""
SEND_1="$(biz_iso "$AID" D 20)"
KEY_S1="$(ulid)"
KEY="$KEY_S1" command_as c1_sched D 192.0.2.82 POST "/v1/sandboxes/$AID/campaigns/$C1/schedule" "{\"send_at\":\"$SEND_1\"}"
expect_status c1_sched 200
expect_json c1_sched "b.state === 'scheduled' && b.send_at === '$SEND_1'"
KEY="$KEY_S1" command_as c1_sched_again D 192.0.2.82 POST "/v1/sandboxes/$AID/campaigns/$C1/schedule" "{\"send_at\":\"$SEND_1\"}"
expect_header c1_sched_again idempotent-replayed true
KEY="$(ulid)" command_as c1_edit_late D 192.0.2.82 PATCH "/v1/sandboxes/$AID/campaigns/$C1" '{"subject":"cake-week","body":"cake-orders","segment":"cake-last-30-days"}'
expect_problem c1_edit_late 409 campaign
expect_json c1_edit_late "/\\bout-of-order\\b/.test(b.detail)"
check "the scheduled campaign has its send timer row" "(( $(sql_count Crm "crm:$AID" "SELECT count(*) AS n FROM timers WHERE id = 'send:$C1'") == 1 ))"
command_as c1_unsched D 192.0.2.82 POST "/v1/sandboxes/$AID/campaigns/$C1/cancel"
expect_json c1_unsched "b.state === 'draft' && b.send_at === undefined"
check "unscheduled, it keeps no send timer" "(( $(sql_count Crm "crm:$AID" "SELECT count(*) AS n FROM timers WHERE id = 'send:$C1'") == 0 ))"
SEND_1="$(biz_iso "$AID" D 20)"
command_as c1_sched2 D 192.0.2.82 POST "/v1/sandboxes/$AID/campaigns/$C1/schedule" "{\"send_at\":\"$SEND_1\"}"
expect_json c1_sched2 "b.state === 'scheduled'"
get_as a_members D "/v1/sandboxes/$AID/segments/cake-last-30-days"
MEMBERS_1="$(json_field a_members b.members)"
command_as clock_1 D 192.0.2.82 POST "/v1/sandboxes/$AID/clock" '{"step":"1h"}'
expect_status clock_1 200
check "the clock past send_at sends campaign one" "until_json c1_sent D '/v1/sandboxes/$AID/campaigns/$C1' \"b.state === 'sent' && b.recipients > 0 && b.recipients < $MEMBERS_1 && b.delivered === b.recipients\""
R1="$(json_field c1_sent b.recipients)"
check "logged campaign_sent once" "(( $(grep -c "\"event\":\"campaign_sent\".*$C1" "$LOG") == 1 ))"
campaign_messages "$AID" D "$C1" c1_msgs
check "one message per recipient, none to the persona" "node -e \"const b = JSON.parse(require('fs').readFileSync('$TMP/c1_msgs.body', 'utf8')); const m = b.messages.filter(m => m.ref === '$C1'); process.exit(m.length === $R1 && new Set(m.map(x => x.to)).size === $R1 && !m.some(x => x.to === '$PERSONA') ? 0 : 1)\""
get_as c1_p_inbox D "/v1/sandboxes/$AID/inbox?kind=campaign&to=$PERSONA"
expect_json c1_p_inbox "b.total === 0"
CAMPAIGN_SENT="SELECT count(*) AS n FROM events WHERE type = 'CampaignSent' AND data LIKE '%$C1%'"
# The double fire: a second alarm after the send.
command_as clock_2 D 192.0.2.82 POST "/v1/sandboxes/$AID/clock" '{"step":"15m"}'
expect_status clock_2 200
sleep 2
check "after a second alarm, one CampaignSent in Crm's log" "(( $(sql_count Crm "crm:$AID" "$CAMPAIGN_SENT") == 1 ))"
campaign_messages "$AID" D "$C1" c1_msgs2
check "and still one message per recipient" "node -e \"const b = JSON.parse(require('fs').readFileSync('$TMP/c1_msgs2.body', 'utf8')); process.exit(b.messages.filter(m => m.ref === '$C1').length === $R1 ? 0 : 1)\""
command_as c1_cancel_sent D 192.0.2.82 POST "/v1/sandboxes/$AID/campaigns/$C1/cancel"
expect_problem c1_cancel_sent 409 campaign

# ---------- campaign two: consent back, the persona included ----------

command_as a_consent_on D 192.0.2.82 POST "/v1/sandboxes/$AID/customers/$PERSONA/consent" '{"marketing":true}'
expect_json a_consent_on "b.marketing === true"
check "the consent reaches Crm" "until_json a_on D '/v1/sandboxes/$AID/customers/$PERSONA' 'b.marketing === true'"
C2="$(ulid)"
KEY="$C2" command_as c2 D 192.0.2.82 POST "/v1/sandboxes/$AID/campaigns" '{"subject":"cake-week","body":"cake-orders","segment":"cake-last-30-days"}'
expect_status c2 201
command_as c2_sched D 192.0.2.82 POST "/v1/sandboxes/$AID/campaigns/$C2/schedule" "{\"send_at\":\"$(biz_iso "$AID" D 20)\"}"
expect_json c2_sched "b.state === 'scheduled'"
command_as clock_3 D 192.0.2.82 POST "/v1/sandboxes/$AID/clock" '{"step":"1h"}'
check "campaign two is sent" "until_json c2_sent D '/v1/sandboxes/$AID/campaigns/$C2' \"b.state === 'sent' && b.recipients > 0 && b.delivered === b.recipients\""
check "the persona has campaign two's message" "until_json c2_p D '/v1/sandboxes/$AID/inbox?kind=campaign&to=$PERSONA' \"b.messages.some(m => m.ref === '$C2' && m.subject === 'It is cake week')\""

# ---------- the ready notice, the inquiry, the refund ----------

probe_args() {
  PROBE=("$ROOT/scripts/ws-probe.mjs" --url "$WS/v1/sandboxes/$2/kitchen/ws" --jar "$TMP/$1.jar" --origin "$STOREFRONT")
}
probe_args D "$AID"
node "${PROBE[@]}" --cmd "$(ulid):$OID:start_production" --cmd "$(ulid):$OID:mark_ready" --wait-evt OrderReady --timeout 20 > "$TMP/ws_ready.out" 2>&1 || true
check "the order reads ready" "until_json a_ready_order D '/v1/sandboxes/$AID/orders/$OID' \"b.status === 'ready'\""
check "the ready notice is in the inbox" "until_json a_ready D '/v1/sandboxes/$AID/inbox?kind=ready&to=$PERSONA' \"b.messages.some(m => m.ref === '$OID')\""

BRIEF_WORD="Briefcanary$(letters 10)"
CDATE="$(cal 'nthOpen(day(Date.now() + Number(a[0]) * 1000), 9)' "$(json_field "off_$AID" b.clock_offset_s)")"
get_as a_leads_before D "/v1/sandboxes/$AID/leads"
INQ_BEFORE="$(json_field a_leads_before "b.stages.find(s => s.stage === 'inquiry').count")"
QUO_BEFORE="$(json_field a_leads_before "b.stages.find(s => s.stage === 'quoted').count")"
command_as a_inquiry D 192.0.2.82 POST "/v1/sandboxes/$AID/catering" "$(inquiry "$CDATE" 40 "A morning gathering, $BRIEF_WORD")"
expect_status a_inquiry 201
CID="$(json_field a_inquiry b.catering)"
check "the inquiry's acknowledgement is in the inbox" "until_json a_ack D '/v1/sandboxes/$AID/inbox?kind=acknowledgement' \"b.messages.some(m => m.ref === '$CID' && m.to === '$PERSONA')\""
check "the lead pipeline gains an inquiry" "until_json a_leads1 D '/v1/sandboxes/$AID/leads' \"b.stages.find(s => s.stage === 'inquiry').count === $INQ_BEFORE + 1 && b.stages.find(s => s.stage === 'inquiry').events.includes('$CID')\""
command_as a_quote D 192.0.2.82 POST "/v1/sandboxes/$AID/catering/$CID/quote" '{}'
expect_status a_quote 200
check "the quote is in the inbox" "until_json a_quote_msg D '/v1/sandboxes/$AID/inbox?kind=quote' \"b.messages.some(m => m.ref === '$CID')\""
check "the lead moves to quoted" "until_json a_leads2 D '/v1/sandboxes/$AID/leads' \"b.stages.find(s => s.stage === 'quoted').count === $QUO_BEFORE + 1 && b.stages.find(s => s.stage === 'quoted').events.includes('$CID') && !b.stages.find(s => s.stage === 'inquiry').events.includes('$CID')\""
check "catering-leads gains the persona" "until_json a_cl D '/v1/sandboxes/$AID/segments/catering-leads' \"b.members >= 1 && b.sample.includes('$PERSONA')\""

command_as a_refund D 192.0.2.82 POST "/v1/sandboxes/$AID/orders/$OID/refund" '{"reason":"goodwill"}'
expect_status a_refund 200
check "the refund notice is in the inbox" "until_json a_refund_msg D '/v1/sandboxes/$AID/inbox?kind=refund&to=$PERSONA' \"b.messages.some(m => m.ref === '$OID')\""
check "the full refund takes the order's points back" "until_json a_points_back D '/v1/sandboxes/$AID/customers/$PERSONA' 'b.loyalty_points === $POINTS_BEFORE'"
check "never below zero: every customer's points are 0 or more" "until_json a_all D '/v1/sandboxes/$AID/customers' 'b.customers.every(c => c.loyalty_points >= 0)'"
get_as a_tl2 D "/v1/sandboxes/$AID/customers/$PERSONA/timeline"
expect_json a_tl2 "['ConsentChanged', 'CateringInquiryReceived', 'OrderRefunded', 'LoyaltyPointsEarned'].every(t => b.entries.some(e => e.type === t)) && b.entries.some(e => e.type === 'LoyaltyPointsEarned' && /taken back/.test(e.label))"
get_as a_activity D "/v1/sandboxes/$AID/activity?limit=500"
expect_json a_activity "b.entries.filter(e => e.type === 'ClockAdvanced').length >= 3 && b.entries.some(e => e.type === 'PaymentIntentCreated') && b.entries.every((e, i) => i === 0 || Date.parse(b.entries[i - 1].at) >= Date.parse(e.at))"
expect_json a_activity "b.entries.some(e => e.type === 'SandboxSeeded' && /born \\d{4}-\\d{2}-\\d{2}$/.test(e.summary))"
check "the feed has the seeded orders' payments, the seeded catering steps and the campaigns sent (audit 2026-11-08, finding 13)" "node -e \"
  const b = JSON.parse(require('fs').readFileSync('$TMP/a_activity.body', 'utf8'));
  const has = (t, re) => b.entries.some(e => e.type === t && re.test(e.summary));
  process.exit(has('OrderPaid', /^Order paid: .\\d{1,3}(,\\d{3})*\\.\\d{2}, (pickup|delivery)$/)
    && b.entries.some(e => e.type.startsWith('Catering') && /^Catering /.test(e.summary))
    && b.entries.filter(e => e.type === 'CampaignSent' && /^Campaign sent to \\d+ customers?$/.test(e.summary)).length >= 2 ? 0 : 1);\""
# An amount is written as dollars() writes it, with a comma every three digits: a seeded balance
# of $1,000.00 or more is common (a large headcount), so the pattern allows the commas.
object_sql Crm "crm:$AID" "SELECT projection FROM crm" > "$TMP/a_projection_now.json" 2>/dev/null || echo '[]' > "$TMP/a_projection_now.json"
check "the seeded catering's production and delivery are in the feed and a timeline, once each for the invoiced and the closed event (2026-11-08)" "node -e \"
  const rows = JSON.parse(require('fs').readFileSync('$TMP/a_projection_now.json', 'utf8'));
  const p = rows.length ? (typeof rows[0].projection === 'string' ? JSON.parse(rows[0].projection) : rows[0].projection) : {};
  const feed = p.activity || [];
  const started = feed.filter(e => e.type === 'CateringProductionStarted' && e.summary === 'Catering production started');
  const delivered = feed.filter(e => e.type === 'CateringDelivered' && /^Catering delivered: balance .\\d{1,3}(,\\d{3})*\\.\\d{2} due \\d{4}-\\d{2}-\\d{2}$/.test(e.summary));
  const entries = Object.values(p.timelines || {}).flat();
  const lines = entries.filter(e => (e.type === 'CateringProductionStarted' && e.label === 'Production started') || (e.type === 'CateringDelivered' && /^Delivered; balance .\\d{1,3}(,\\d{3})*\\.\\d{2}$/.test(e.label)));
  process.exit(started.length === 2 && delivered.length === 2 && lines.length === 4 ? 0 : 1);\""
check "no activity row says '1 vans', '1 minutes' or '1 orders' (finding 36)" "! grep -qE '\\b1 (vans|minutes|orders|customers)\\b' '$TMP/a_activity.body'"
get_as a_activity_3 D "/v1/sandboxes/$AID/activity?limit=3"
expect_json a_activity_3 "b.entries.length === 3"

# ---------- engagement: one campaign to everyone, in both sandboxes ----------

command_as a_consent_seed D 192.0.2.82 POST "/v1/sandboxes/$AID/customers/$PERSONA/consent" '{"marketing":true}'
CE="$(ulid)"
for s in "D:$AID:192.0.2.82" "E:$BID:192.0.2.83"; do
  IFS=: read -r j sid ip <<<"$s"
  KEY="$CE" command_as "ce_$j" "$j" "$ip" POST "/v1/sandboxes/$sid/campaigns" '{"subject":"thank-you","body":"announcement","segment":"everyone"}'
  expect_status "ce_$j" 201
  command_as "ce_sched_$j" "$j" "$ip" POST "/v1/sandboxes/$sid/campaigns/$CE/schedule" "{\"send_at\":\"$(biz_iso "$sid" "$j" 20)\"}"
  expect_json "ce_sched_$j" "b.state === 'scheduled'"
  command_as "ce_clock_$j" "$j" "$ip" POST "/v1/sandboxes/$sid/clock" '{"step":"1h"}'
  expect_status "ce_clock_$j" 200
  check "$j: the campaign to everyone is sent" "until_json ce_sent_$j $j '/v1/sandboxes/$sid/campaigns/$CE' \"b.state === 'sent' && b.recipients > 0 && b.delivered === b.recipients\""
done
check "both sandboxes froze the same recipients" "[[ '$(json_field ce_sent_D b.recipients)' == '$(json_field ce_sent_E b.recipients)' ]]"
RE="$(json_field ce_sent_D b.recipients)"
campaign_messages "$AID" D "$CE" ce_msgs0
OPEN_0="$(json_field ce_msgs0 "b.messages.filter(m => m.ref === '$CE' && m.opened_at).length")"
for s in "D:$AID:192.0.2.82" "E:$BID:192.0.2.83"; do
  IFS=: read -r j sid ip <<<"$s"
  command_as "ce_hour_$j" "$j" "$ip" POST "/v1/sandboxes/$sid/clock" '{"step":"1h"}'
done
check "an hour more: some of the campaign's messages show opened_at" "until_json ce_msgs1 D '/v1/sandboxes/$AID/inbox?kind=campaign&limit=500' \"b.messages.filter(m => m.ref === '$CE' && m.opened_at).length > $OPEN_0\""
for s in "D:$AID:192.0.2.82" "E:$BID:192.0.2.83"; do
  IFS=: read -r j sid ip <<<"$s"
  command_as "ce_day_$j" "$j" "$ip" POST "/v1/sandboxes/$sid/clock" '{"step":"1d"}'
done
check "a day more: some show clicked_at, every click after its open" "until_json ce_msgs2 D '/v1/sandboxes/$AID/inbox?kind=campaign&limit=500' \"b.messages.some(m => m.ref === '$CE' && m.clicked_at) && b.messages.filter(m => m.clicked_at).every(m => Date.parse(m.opened_at) < Date.parse(m.clicked_at))\""
sleep 2
check "a's campaign stats settle" "until_json ce_stats_D D '/v1/sandboxes/$AID/campaigns/$CE' 'b.opened > 0 && b.clicked > 0'"
check "b's campaign stats settle" "until_json ce_stats_E E '/v1/sandboxes/$BID/campaigns/$CE' 'b.opened > 0 && b.clicked > 0'"
sleep 2
get_as ce_stats_D D "/v1/sandboxes/$AID/campaigns/$CE"
get_as ce_stats_E E "/v1/sandboxes/$BID/campaigns/$CE"
STATS_A="$(json_field ce_stats_D "[b.recipients, b.delivered, b.opened, b.clicked].join()")"
STATS_B="$(json_field ce_stats_E "[b.recipients, b.delivered, b.opened, b.clicked].join()")"
echo "campaign to everyone (recipients, delivered, opened, clicked): a $STATS_A, b $STATS_B"
check "the same opens and clicks in both sandboxes, inside the engagement bounds" "[[ '$STATS_A' == '$STATS_B' ]] && node -e \"const [r, d, o, c] = '$STATS_A'.split(',').map(Number); process.exit(r === d && o >= 0.2 * d && o <= 0.7 * d && c >= 1 && c <= o ? 0 : 1)\""

# ---------- the stripping: no note or brief anywhere Crm or the Inbox writes ----------

get_as a_inbox_all D "/v1/sandboxes/$AID/inbox?limit=500"
get_as a_tl3 D "/v1/sandboxes/$AID/customers/$PERSONA/timeline"
get_as a_activity2 D "/v1/sandboxes/$AID/activity?limit=500"
get_as a_customers2 D "/v1/sandboxes/$AID/customers"
check "the note's and the brief's words are in no CRM or inbox response" "! grep -qE '$NOTE_WORD|$BRIEF_WORD' '$TMP/a_inbox_all.body' '$TMP/a_tl3.body' '$TMP/a_activity2.body' '$TMP/a_customers2.body'"
check "nor in Crm's projection or log" "(( $(sql_count Crm "crm:$AID" "SELECT count(*) AS n FROM crm WHERE projection LIKE '%$NOTE_WORD%' OR projection LIKE '%$BRIEF_WORD%'") == 0 && $(sql_count Crm "crm:$AID" "SELECT count(*) AS n FROM log WHERE envelope LIKE '%$NOTE_WORD%' OR envelope LIKE '%$BRIEF_WORD%' OR envelope LIKE '%\"note\"%' OR envelope LIKE '%\"brief\"%'") == 0 ))"
check "nor in the Inbox's messages or state" "(( $(sql_count Inbox "inbox:$AID" "SELECT count(*) AS n FROM messages WHERE body LIKE '%$NOTE_WORD%' OR body LIKE '%$BRIEF_WORD%'") == 0 && $(sql_count Inbox "inbox:$AID" "SELECT count(*) AS n FROM inbox WHERE body LIKE '%$NOTE_WORD%' OR body LIKE '%$BRIEF_WORD%'") == 0 ))"
check "the note's and the brief's words never reached the Worker's log" "! grep -qE '$NOTE_WORD|$BRIEF_WORD' '$LOG'"

# ---------- the rebuild ----------

# Quiet first: no delivery is still on its way (the projection the same twice, 1.5 s apart).
wait_quiet() {
  for _ in $(seq 1 20); do
    object_sql Crm "crm:$AID" "SELECT projection FROM crm" > "$TMP/q1.json" 2>/dev/null || true
    sleep 1.5
    object_sql Crm "crm:$AID" "SELECT projection FROM crm" > "$TMP/q2.json" 2>/dev/null || true
    if cmp -s "$TMP/q1.json" "$TMP/q2.json"; then break; fi
  done
}
wait_quiet
REBUILT=""
for attempt in 1 2 3; do
  LOG_BEFORE="$(crm_log_len "$AID")"
  crm_reads "$AID" D before
  command_as rb_start D 192.0.2.82 POST "/v1/sandboxes/$AID/rebuild"
  command_as rb_again D 192.0.2.82 POST "/v1/sandboxes/$AID/rebuild"
  : > "$TMP/rb_seen.txt"
  for _ in $(seq 1 150); do
    get_as rb_poll D "/v1/sandboxes/$AID/rebuild"
    json_field rb_poll "[b.state, b.applied, b.total].join()" >> "$TMP/rb_seen.txt"; echo >> "$TMP/rb_seen.txt"
    get_as rb_read D "/v1/sandboxes/$AID/segments"
    header_of rb_read projection-state >> "$TMP/rb_states.txt"
    if [[ "$(json_field rb_poll b.state)" == finished ]]; then break; fi
    sleep 0.1
  done
  LOG_AFTER="$(crm_log_len "$AID")"
  crm_reads "$AID" D after
  if [[ "$LOG_BEFORE" == "$LOG_AFTER" ]]; then REBUILT=1; break; fi
  echo "a delivery reached Crm during rebuild $attempt ($LOG_BEFORE then $LOG_AFTER entries); again"
  sleep 2
done
expect_status rb_start 202
expect_json rb_start "b.state === 'rebuilding' && b.applied === 0 && b.total === $LOG_BEFORE"
expect_problem rb_again 409 rebuild
check "the log held the seed's history and the run's events ($LOG_BEFORE entries)" "(( LOG_BEFORE > 600 ))"
check "the log did not grow while the rebuild ran" "[[ -n '$REBUILT' ]]"
check "applied climbed to total over several alarms" "node -e \"const rows = require('fs').readFileSync('$TMP/rb_seen.txt', 'utf8').split('\n').filter(Boolean).map(r => r.split(',')); const applied = [...new Set(rows.filter(r => r[0] === 'rebuilding').map(r => Number(r[1])))]; const last = rows[rows.length - 1]; process.exit(last[0] === 'finished' && Number(last[1]) === $LOG_BEFORE && Number(last[2]) === $LOG_BEFORE && applied.length >= 2 && applied.every((a, i) => i === 0 || applied[i - 1] < a) ? 0 : 1)\""
check "a read while it ran said Projection-State: rebuilding" "grep -q rebuilding '$TMP/rb_states.txt'"
get_as rb_done D "/v1/sandboxes/$AID/rebuild"
expect_json rb_done "b.state === 'finished' && b.applied === $LOG_BEFORE && b.total === $LOG_BEFORE && Number.isInteger(b.ms) && b.ms >= 0"
for what in customers timeline segments campaigns leads projection; do
  check "$what: byte-identical after the rebuild" "cmp -s '$TMP/before_$what.body' '$TMP/after_$what.body' 2>/dev/null || cmp -s '$TMP/before_$what.json' '$TMP/after_$what.json'"
done
# The feed gains one row, the rebuild's own, and is otherwise the same.
check "activity: identical after the rebuild but for the rebuild's own row" "node -e \"
  const read = (f) => JSON.parse(require('fs').readFileSync(f, 'utf8')).entries;
  const before = read('$TMP/before_activity.body'), after = read('$TMP/after_activity.body');
  const rest = (es) => JSON.stringify(es.filter(e => e.type !== 'ProjectionRebuildFinished'));
  const added = after.filter(e => e.type === 'ProjectionRebuildFinished').length - before.filter(e => e.type === 'ProjectionRebuildFinished').length;
  process.exit(rest(before) === rest(after) && added === 1 && /^CRM projection rebuilt: $LOG_BEFORE events replayed in \\d+ ms$/.test(after.find(e => e.type === 'ProjectionRebuildFinished').summary) ? 0 : 1);\""
check "the stored projection was read, not empty" "(( $(wc -c < "$TMP/after_projection.json") > 100000 ))"
check "ProjectionRebuildFinished with events = the log's length, logged identical" "(( $(sql_count Crm "crm:$AID" "SELECT count(*) AS n FROM events WHERE type = 'ProjectionRebuildFinished' AND data LIKE '%\"events\":$LOG_BEFORE,%'") >= 1 )) && log_has '\"event\":\"rebuild_finished\",\"object\":\"Crm\",\"events\":$LOG_BEFORE,' && log_has '\"identical\":true'"
check "rebuild_step was logged more than once" "(( $(grep -c '\"event\":\"rebuild_step\"' "$LOG") >= 2 ))"
sleep 1
get_as rb_later D "/v1/sandboxes/$AID/rebuild"
expect_json rb_later "b.state === 'finished'"

# ---------- a send that falls due while a rebuild runs ----------

# Campaign three to everyone is scheduled 20 business minutes ahead. The rebuild is started, and
# the very next request advances the clock an hour, so Crm is told while the rebuild's runs (200
# log entries each, 300 ms apart, six or more of them over about 1.5 s) are still going and the
# send falls due inside them. Nothing sleeps between the two requests and nothing waits for a
# moment: the proof is the log, which holds `sends_deferred` only if an alarm found the send due
# with the rebuild running at its start. If the rebuild had ended before Crm was told (the line is
# missing), the attempt is made again with a new campaign, as the rebuild above is.
log_since_has() { tail -n "+$((LOG_FROM + 1))" "$LOG" > "$TMP/since.log"; grep -qF -- "$1" "$TMP/since.log"; }
log_since_until() {
  for _ in $(seq 1 50); do
    if log_since_has "$1"; then return 0; fi
    sleep 0.2
  done
  return 1
}
DEFERRED=""
for attempt in 1 2 3; do
  wait_quiet
  C3="$(ulid)"
  KEY="$C3" command_as c3 D 192.0.2.82 POST "/v1/sandboxes/$AID/campaigns" '{"subject":"thank-you","body":"announcement","segment":"everyone"}'
  command_as c3_sched D 192.0.2.82 POST "/v1/sandboxes/$AID/campaigns/$C3/schedule" "{\"send_at\":\"$(biz_iso "$AID" D 20)\"}"
  C3_LOG_LEN="$(crm_log_len "$AID")"
  K_CLOCK="$(ulid)"
  REARMS_BEFORE="$(sql_count Crm "crm:$AID" "SELECT coalesce(sum(n), 0) AS n FROM rearms")"
  LOG_FROM="$(wc -l < "$LOG")"
  command_as d_rb D 192.0.2.82 POST "/v1/sandboxes/$AID/rebuild"
  KEY="$K_CLOCK" command_as d_clock D 192.0.2.82 POST "/v1/sandboxes/$AID/clock" '{"step":"1h"}'
  get_as d_mid D "/v1/sandboxes/$AID/rebuild"
  get_as d_mid_campaign D "/v1/sandboxes/$AID/campaigns/$C3"
  until_json d_fin D "/v1/sandboxes/$AID/rebuild" "b.state === 'finished'" 100 || true
  if log_since_until '"event":"sends_deferred"'; then DEFERRED=1; break; fi
  echo "the rebuild ended before the clock reached Crm in attempt $attempt; again with a new campaign"
done
expect_status d_rb 202
expect_json d_rb "b.state === 'rebuilding' && b.applied === 0 && b.total >= $C3_LOG_LEN"
expect_status d_clock 200
check "the rebuild finished" "[[ \"\$(json_field d_fin b.state)\" == finished ]]"
check "the Worker's log holds sends_deferred, logged after the rebuild started" "[[ -n '$DEFERRED' ]]"
MID_STATE="$(json_field d_mid b.state)"
echo "    (the rebuild read '$MID_STATE' ($(json_field d_mid b.applied) of $(json_field d_mid b.total)) when the clock's answer came back)"
check "the deferred send went after the rebuild: campaign three is sent, recipients and delivered above 0" "until_json c3_sent D '/v1/sandboxes/$AID/campaigns/$C3' \"b.state === 'sent' && b.recipients > 0 && b.delivered === b.recipients\""
get_as d_after D "/v1/sandboxes/$AID/rebuild"
expect_json d_after "b.state === 'finished' && b.applied === b.total && b.total >= $C3_LOG_LEN && Number.isInteger(b.ms) && b.ms >= 0"
tail -n "+$((LOG_FROM + 1))" "$LOG" > "$TMP/defer.log"
check "the log line of the rebuild's end says identical: true" "[[ \"\$(grep -c '\"event\":\"rebuild_finished\"' '$TMP/defer.log')\" == 1 ]] && grep -q '\"event\":\"rebuild_finished\".*\"identical\":true' '$TMP/defer.log'"
line_of() { grep -n -m 1 -- "$1" "$TMP/defer.log" | cut -d: -f1 || true; }
L_DEFER="$(line_of '"event":"sends_deferred"')"
L_FINISH="$(line_of '"event":"rebuild_finished"')"
L_SENT="$(line_of "\"event\":\"campaign_sent\".*$C3")"
check "the log runs in order: sends_deferred ($L_DEFER), rebuild_finished ($L_FINISH), then campaign_sent for campaign three ($L_SENT)" "[[ -n '$L_DEFER' && -n '$L_FINISH' && -n '$L_SENT' ]] && (( L_DEFER < L_FINISH && L_FINISH < L_SENT ))"
check "campaign three was sent once: one CampaignSent in Crm's log, none sent before the rebuild ended" "(( $(sql_count Crm "crm:$AID" "SELECT count(*) AS n FROM events WHERE type = 'CampaignSent' AND data LIKE '%$C3%'") == 1 )) && (( $(grep -c "\"event\":\"campaign_sent\".*$C3" "$LOG") == 1 ))"
R3="$(json_field c3_sent b.recipients)"
campaign_messages "$AID" D "$C3" c3_msgs
check "one message per recipient ($R3), none lost to the rebuild" "node -e \"const b = JSON.parse(require('fs').readFileSync('$TMP/c3_msgs.body', 'utf8')); const m = b.messages.filter(m => m.ref === '$C3'); process.exit(m.length === $R3 && new Set(m.map(x => x.to)).size === $R3 ? 0 : 1)\""
# A deferred send is made due again when the rebuild's next step is, so the wait costs about one
# alarm run per rebuild step and not one per millisecond. Before that was fixed, the same wait
# logged sends_deferred 72 to 74 times and spent 83 of the day's 100 re-arms (docs/architecture.md,
# "The rules, restated for Rust", rule 4).
DEFER_RUNS="$(grep -c '"event":"sends_deferred"' "$TMP/defer.log" || true)"
STEPS="$(grep -c '"event":"rebuild_step"' "$TMP/defer.log" || true)"
REARMS="$(sql_count Crm "crm:$AID" "SELECT coalesce(sum(n), 0) AS n FROM rearms")"
SPENT=$(( REARMS - REARMS_BEFORE ))
echo "    (sends_deferred was logged $DEFER_RUNS times over $STEPS rebuild steps in attempt $attempt; the wait spent $SPENT re-arms, $REARMS of 100 today)"
check "sends_deferred is logged at most once per rebuild run ($DEFER_RUNS lines, $STEPS steps)" "(( DEFER_RUNS >= 1 && DEFER_RUNS <= STEPS + 1 ))"
check "the wait spent at most 15 re-arms ($SPENT), and no alarm_guard was logged" "(( SPENT <= 15 )) && ! grep -q '\"event\":\"alarm_guard\"' '$TMP/defer.log'"

# ---------- the wipe ----------

for s in "G:$GID:192.0.2.81" "D:$AID:192.0.2.82" "E:$BID:192.0.2.83"; do
  IFS=: read -r j sid ip <<<"$s"
  command_as "wipe_$j" "$j" "$ip" DELETE "/v1/sandboxes/$sid"
  expect_status "wipe_$j" 200
done
sleep 1
set +e
node "$ROOT/scripts/list-objects.mjs" "$STATE" > "$TMP/list.out" 2> "$TMP/list.err"
LIST_EXIT=$?
set -e
check "list-objects exits 0 after the wipe, the Customer, Crm and Inbox objects included" "(( LIST_EXIT == 0 )) && grep -q '\"class\":\"Crm\"' '$TMP/list.out' && grep -q '\"class\":\"Inbox\"' '$TMP/list.out' && grep -q '\"class\":\"Customer\"' '$TMP/list.out'"
check "no alarm_guard was logged" "! log_has '\"event\":\"alarm_guard\"'"
check "no delivery dead-lettered" "! log_has '\"event\":\"dlq\"'"

echo
if (( FAILURES > 0 )); then
  echo "$PASSES passed, $FAILURES failed"
  exit 1
fi
echo "all $PASSES checks passed"
