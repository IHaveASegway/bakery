#!/usr/bin/env bash
# Self-test for scripts/wipe-check.sh. No network: a fake `curl` on PATH answers with a canned
# status body or a 503, and a fake `gh` records the issue calls. ci.yml's `verify` job runs it,
# and so can anyone:
#
#   scripts/wipe-check.test.sh
#
# Cases: a count of 0 (green, no issue), 3 (an issue with the count and the runbook's link, red),
# 3 with the issue already open (a comment), a body from an API older than the field (a notice,
# no issue, green), null (red, no issue), not a count (red, no issue) and a 503 (red, no issue).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/wipe-check.sh"
W="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/wipetest.XXXXXX")"
trap 'rm -rf "$W"' EXIT

mkdir -p "$W/bin"
cat > "$W/bin/curl" <<'FAKE'
#!/usr/bin/env bash
# The fake. FAKE_BODY is the file to answer with; FAKE_HTTP=503 fails as `curl --fail` does.
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output) out="$2"; shift ;;
  esac
  shift
done
if [ "${FAKE_HTTP:-200}" != 200 ]; then
  echo "curl: (22) The requested URL returned error: $FAKE_HTTP" >&2
  exit 22
fi
cp "$FAKE_BODY" "$out"
FAKE
cat > "$W/bin/gh" <<'FAKE'
#!/usr/bin/env bash
# The fake. FAKE_LOG gets one line per call; `issue list` answers FAKE_OPEN (an issue number or
# nothing); the body of a create or comment is copied to FAKE_LOG.body.
echo "gh $1 $2" >> "$FAKE_LOG"
if [ "$1 $2" = "issue list" ]; then echo "${FAKE_OPEN:-}"; exit 0; fi
while [ $# -gt 0 ]; do
  if [ "$1" = --body-file ]; then cp "$2" "$FAKE_LOG.body"; fi
  shift
done
FAKE
chmod +x "$W/bin/curl" "$W/bin/gh"

STATUS='{"day":"2026-11-10","sandboxes_today":4,"sandbox_cap":300,"guests_today":3,"guest_cap":100,"demo_accounts_today":1,"demo_account_cap":100,"counters":null,"counters_as_of":null,"counters_state":"unavailable","breaker":{"state":"armed","since":null,"last_run":null,"last_usd":null,"unread":[]}'
echo "$STATUS"',"sandboxes_past_wipe":0,"flag":"live"}' > "$W/zero.json"
echo "$STATUS"',"sandboxes_past_wipe":3,"flag":"live"}' > "$W/three.json"
echo "$STATUS"',"flag":"live"}' > "$W/old.json"
echo "$STATUS"',"sandboxes_past_wipe":null,"flag":"live"}' > "$W/null.json"
echo "$STATUS"',"sandboxes_past_wipe":"3","flag":"live"}' > "$W/text.json"

passes=0
failures=0
ok() { passes=$((passes + 1)); echo "ok   $1"; }
bad() { failures=$((failures + 1)); echo "FAIL $1"; }

# run NAME BODY [ENV...]: runs the script, keeps its exit code, output, summary and gh log.
run() {
  local name="$1" body="$2"
  shift 2
  rm -f "$W/gh.log" "$W/gh.log.body" "$W/summary"
  touch "$W/gh.log" "$W/summary"
  set +e
  env PATH="$W/bin:$PATH" FAKE_BODY="$W/$body" FAKE_LOG="$W/gh.log" GITHUB_STEP_SUMMARY="$W/summary" \
    GITHUB_SERVER_URL=https://github.com STATUS_URL=http://127.0.0.1:9/v1/status \
    REPO=IHaveASegway/bakery RUN=https://github.com/IHaveASegway/bakery/actions/runs/1 RUNNER_TEMP="$W" \
    "$@" bash "$script" > "$W/out" 2>&1
  code=$?
  set -e
  echo "--- $name: exit $code"
}
expect() { if eval "$2"; then ok "$1"; else bad "$1"; sed 's/^/     | /' "$W/out" "$W/summary"; fi; }
no_issue() { ! grep -q "issue create\|issue comment" "$W/gh.log"; }

run zero zero.json
expect "0: green" '[ "$code" -eq 0 ]'
expect "0: no issue" 'no_issue'
expect "0: the summary gives the count" 'grep -q "Wipe check: 0 sandboxes past" "$W/summary"'

run three three.json
expect "3: red" '[ "$code" -eq 1 ]'
expect "3: opens the issue" 'grep -qx "gh issue create" "$W/gh.log"'
expect "3: the issue gives the count" 'grep -q "^3 sandboxes are past their nightly wipe" "$W/gh.log.body"'
expect "3: the issue links the runbook" 'grep -q "https://github.com/IHaveASegway/bakery/blob/main/docs/operations.md#the-nightly-wipe" "$W/gh.log.body"'
expect "3: an error annotation" 'grep -q "^::error::3 sandboxes are past" "$W/out"'

run three-open three.json FAKE_OPEN=99
expect "3, issue open: comments" 'grep -qx "gh issue comment" "$W/gh.log" && ! grep -q "issue create" "$W/gh.log"'
expect "3, issue open: red" '[ "$code" -eq 1 ]'

run old old.json
expect "no field: green" '[ "$code" -eq 0 ]'
expect "no field: no issue" 'no_issue'
expect "no field: a notice, not silence" 'grep -q "^::notice::the status route has no sandboxes_past_wipe" "$W/out"'
expect "no field: the summary says so" 'grep -q "has no sandboxes_past_wipe" "$W/summary"'

run null null.json
expect "null: red" '[ "$code" -eq 1 ]'
expect "null: no issue" 'no_issue'
expect "null: an error naming the sweep" 'grep -q "^::error::sandboxes_past_wipe is null" "$W/out"'

run text text.json
expect "not a count: red, no issue" '[ "$code" -eq 1 ] && no_issue'

run unavailable zero.json FAKE_HTTP=503
expect "503: red" '[ "$code" -eq 1 ]'
expect "503: no issue" 'no_issue && ! [ -s "$W/gh.log" ]'
expect "503: an error naming the fetch" 'grep -q "^::error::the wipe check could not fetch" "$W/out"'

echo "wipe-check.test.sh: $passes passed, $failures failed"
[ "$failures" -eq 0 ]
