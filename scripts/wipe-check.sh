#!/usr/bin/env bash
# The morning wipe check (scheduled.yml, bakery-objects, the 12:17 UTC run; docs/operations.md,
# "The nightly wipe"). It reads `sandboxes_past_wipe` from the public GET /v1/status: the
# sandboxes `Control` found not wiped more than 2 hours after their nightly wipe, the first
# 10:00 UTC after each was made. It needs no baseline listing and no secret, so a run GitHub
# starts hours late reads the same answer as one on time.
#
#   STATUS_URL=... REPO=owner/name RUN=<run url> scripts/wipe-check.sh
#
# By answer:
# - a count above 0: opens, or comments on, the issue "Objects survived the wipe" with the count
#   and the runbook's link, and fails;
# - 0: one summary line, green;
# - no field (an API deployed before 2026-11-10): a notice, opens nothing, green, so the first
#   day's run before the deploy neither opens an issue nor passes silently;
# - null (Control has not counted in the last 20 minutes, so the 15-minute cron, which also
#   retries the wipe, may not be running): fails without an issue;
# - the fetch fails, or the answer is not a status object or the field is not a count: fails
#   without an issue. The API being down is prod-smoke's finding.
#
# It writes to GITHUB_STEP_SUMMARY when set and calls `gh` only for the issue. Tested by
# scripts/wipe-check.test.sh with canned answers and fake `curl` and `gh`.
set -euo pipefail

: "${STATUS_URL:?STATUS_URL is the status route}"
: "${REPO:?REPO is owner/name}"
RUN="${RUN:-this run}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"
SERVER="${GITHUB_SERVER_URL:-https://github.com}"
RUNBOOK="$SERVER/$REPO/blob/main/docs/operations.md#the-nightly-wipe"
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/wipe-check.XXXXXX")"
trap 'rm -rf "$work"' EXIT
status="$work/status.json"

if ! curl --fail --silent --show-error --max-time 20 --retry 2 --retry-delay 5 \
  --output "$status" "$STATUS_URL"; then
  echo "Wipe check: could not fetch the status route, so the count of sandboxes past their wipe is unknown. The API being down is prod-smoke's finding; look at this run." >> "$SUMMARY"
  echo "::error::the wipe check could not fetch $STATUS_URL"
  exit 1
fi
if ! jq -e 'type == "object" and (.day | type) == "string"' "$status" > /dev/null 2>&1; then
  echo "Wipe check: the status route answered something that is not a status object." >> "$SUMMARY"
  echo "::error::the status route answered something that is not a status object"
  exit 1
fi
if ! jq -e 'has("sandboxes_past_wipe")' "$status" > /dev/null; then
  echo "Wipe check: the status route has no sandboxes_past_wipe, so the API running is older than the count (2026-11-10). Nothing was opened; the check works from the deploy that adds it." >> "$SUMMARY"
  echo "::notice::the status route has no sandboxes_past_wipe yet (an API deployed before the count), so the wipe was not checked by it"
  exit 0
fi
if jq -e '.sandboxes_past_wipe == null' "$status" > /dev/null; then
  echo "Wipe check: sandboxes_past_wipe is null: Control has not counted in the last 20 minutes, so the 15-minute cron, which also retries the wipe, may not be running. Read the cron's log (\`sweep\` lines)." >> "$SUMMARY"
  echo "::error::sandboxes_past_wipe is null: the 15-minute sweep has not counted in the last 20 minutes"
  exit 1
fi
if ! jq -e '(.sandboxes_past_wipe | type) == "number" and .sandboxes_past_wipe >= 0 and (.sandboxes_past_wipe | floor) == .sandboxes_past_wipe' "$status" > /dev/null; then
  echo "Wipe check: sandboxes_past_wipe is not a count." >> "$SUMMARY"
  echo "::error::sandboxes_past_wipe is not a count"
  exit 1
fi
count="$(jq -r '.sandboxes_past_wipe' "$status")"
echo "Wipe check: $count sandboxes past their nightly wipe and not wiped (sandboxes_past_wipe on the status route)." >> "$SUMMARY"
if [ "$count" -eq 0 ]; then exit 0; fi

title="Objects survived the wipe"
{
  echo "$(date -u +%F), the 12:17 UTC check ($RUN):"
  echo
  echo "$count sandboxes are past their nightly wipe and not wiped (\`sandboxes_past_wipe\` on the public status route)."
  echo "Control counts a sandbox once it is unwiped more than 2 hours after the first 10:00 UTC wipe after it was made, so a sandbox made after today's wipe is not counted."
  echo
  echo "Runbook: $RUNBOOK. The sandboxes' ids are in Control's \`sandboxes\` table (rows with no \`wiped_at\`), not here."
} > "$work/body.md"
number="$(gh issue list --repo "$REPO" --state open --search "in:title \"$title\"" --json number,title \
  --jq "map(select(.title == \"$title\")) | first | .number // empty")"
if [ -n "$number" ]; then
  gh issue comment "$number" --repo "$REPO" --body-file "$work/body.md"
else
  gh issue create --repo "$REPO" --title "$title" --body-file "$work/body.md"
fi
echo "::error::$count sandboxes are past their nightly wipe and not wiped"
exit 1
