#!/usr/bin/env bash
# Prints "true" when <head> changes the scanner against <base>, and "false" when it does not.
#
#   scanner-changed.sh <base> [<head>, default HEAD]
#
# The scanner is what the self-test (test.sh) proves, and what runs it: this directory, which holds
# check.sh, the installer, the pinned gitleaks version and the self-test itself, and ci.yml. CI
# asks twice (delivery.md, "Pipeline"). A push to main runs the self-test only when this prints
# true: otherwise main's scanner is the one its pull request's run already proved. A pull request
# publishes a preview only when this prints false, because its self-test runs beside the preview,
# and a scanner nothing has proved yet cannot clear a public page.
#
# It fails toward running the self-test: an empty or all-zero base (a new branch), a base this
# clone does not hold (a force push), or any error in the comparison prints true.
set -euo pipefail

SCANNER=(scripts/firewall .github/workflows/ci.yml)

base="${1:-}"
head="${2:-HEAD}"
case "$base" in "" | *[!0]*) ;; *) base="" ;; esac # all zeros: no previous commit

cd "$(git rev-parse --show-toplevel)"
if [ -z "$base" ] || ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
  echo true
  exit 0
fi
rc=0
git diff --quiet "$base" "$head" -- "${SCANNER[@]}" 2>/dev/null || rc=$?
if [ "$rc" -eq 0 ]; then echo false; else echo true; fi
