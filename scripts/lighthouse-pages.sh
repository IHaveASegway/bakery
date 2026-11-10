#!/usr/bin/env bash
# Lighthouse CI over a list of pages, one page at a time, for the `lighthouse` job in ci.yml.
#
#   scripts/lighthouse-pages.sh BASE_URL PATH...
#
# `lhci autorun` collects every page in one process, so one run where Lighthouse cannot record its
# trace (a "Runtime error encountered", NO_NAVSTART on 2026-11-10, runs 42732186709 and
# 42738698838) threw away the other pages' results. This script collects each page with its own
# `lhci collect --additive`. A failed collect whose output holds "Runtime error encountered" is
# a tool failure, not a verdict: it prints a warning annotation and collects that page once more.
# A second failure, or any failure that is not a runtime error, fails the script at once.
#
# The retry never touches a budget. Collecting says nothing about scores; `lhci assert` runs once,
# after every page is collected, with the config's own assertions, and its failure is never retried.
#
# What `lhci assert` does with extra runs, checked in @lhci/cli 0.15.1: with "median-run" it groups
# the saved reports by URL, takes the median first contentful paint and the median interactive time
# of that page's reports, and asserts the single report nearest to both (@lhci/utils,
# representative-runs.js). It accepts any count, so extra runs would not fail, but they would
# change the sample: a retried page would be judged on five runs, two of them from the failed
# collect, not on the three the budgets name. Reports are files named lhr-<millisecond time>.json
# and .html in .lighthouseci, with no page in the name, so the script keeps the listing taken
# before each collect and, before the second collect, removes the report files that the failed
# collect created and no others. A retried page is judged on exactly numberOfRuns runs.
#
# Run from anywhere: it works in apps/web, where lighthouserc.json is, or in
# LIGHTHOUSE_WORKDIR. `lhci` and the Chromium (CHROME_PATH) come from the caller's environment.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 BASE_URL PATH..." >&2
  exit 2
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
base="${1%/}"
shift

cd "${LIGHTHOUSE_WORKDIR:-$here/../apps/web}"
config="lighthouserc.json"
dir=".lighthouseci"
log="$(mktemp "${TMPDIR:-/tmp}/lhci-collect.XXXXXX")"
trap 'rm -f "$log"' EXIT

# The files of every saved report, one per line, sorted.
reports() {
  if [ -d "$dir" ]; then
    (cd "$dir" && find . -maxdepth 1 -type f \( -name 'lhr-*.json' -o -name 'lhr-*.html' \) | sort)
  fi
}

# One collect of one page, its output on the screen and in $log. Returns lhci's exit code.
collect() {
  lhci collect --config="$config" --url="$1" --additive 2>&1 | tee "$log"
}

lhci healthcheck --config="$config" --fatal

# What a collect without --additive would do first: forget earlier reports.
if [ -d "$dir" ]; then
  find "$dir" -maxdepth 1 -type f \( -name 'lhr-*.json' -o -name 'lhr-*.html' \) -delete
fi

measured=0
retried=0
for page in "$@"; do
  url="$base$page"
  before="$(reports)"
  if ! collect "$url"; then
    if ! grep -q 'Runtime error encountered' "$log"; then
      echo "Lighthouse failed on $page and it is not a runtime error, so it is not retried." >&2
      exit 1
    fi
    code="$(grep -oE '\([A-Z][A-Z0-9_]+\)' "$log" | head -n 1 | tr -d '()' || true)"
    echo "::warning title=Lighthouse runtime error::$page failed with ${code:-an unnamed error code} before a verdict; collecting it once more"
    # Remove only the reports this failed collect saved: the ones that were not there before it.
    after="$(reports)"
    comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after") | while IFS= read -r file; do
      if [ -n "$file" ]; then
        rm -f -- "$dir/$file"
      fi
    done
    retried=$((retried + 1))
    if ! collect "$url"; then
      echo "Lighthouse failed on $page twice, so the job fails." >&2
      exit 1
    fi
  fi
  measured=$((measured + 1))
done

# Same order as `lhci autorun`: assert, then upload even when assert failed, then the verdict.
assert_status=0
lhci assert --config="$config" || assert_status=$?
lhci upload --config="$config" || echo "WARNING: upload command failed." >&2

echo "Lighthouse measured $measured pages; $retried needed a second collect."
if [ "$assert_status" -ne 0 ]; then
  echo "assert command failed. Exiting with status code 1." >&2
  exit 1
fi
