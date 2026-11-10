#!/usr/bin/env bash
# Self-test for scripts/lighthouse-pages.sh. No network, no Chromium, no Lighthouse: a fake `lhci`
# on PATH answers the script's calls, and each case sets how it fails. Run it by hand:
#
#   scripts/lighthouse-pages.test.sh
#
# Cases: a runtime error once (retried, warned, extra reports cleared), twice (fails, no verdict
# asked for), an assertion failure (never retried, upload still runs), and a collect failure that
# is not a runtime error (not retried).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/lighthouse-pages.sh"
W="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/lhtest.XXXXXX")"
trap 'rm -rf "$W"' EXIT

mkdir -p "$W/bin"
cat > "$W/bin/lhci" <<'FAKE'
#!/usr/bin/env bash
# The fake. FAKE_LOG gets one line per call. FAKE_FAIL_PAGE names the path whose collects fail,
# FAKE_FAIL_TIMES how many of them fail, FAKE_FAIL_KIND is runtime or other. FAKE_ASSERT=fail
# makes `assert` fail. A failing collect saves two reports first, as a real one does, then fails.
cmd="$1"
shift
echo "$cmd $*" >> "$FAKE_LOG"
case "$cmd" in
  healthcheck | upload) exit 0 ;;
  assert)
    if [ "${FAKE_ASSERT:-pass}" = fail ]; then
      echo "Assertion failed. categories:performance expected >=0.9, found 0.5" >&2
      exit 1
    fi
    exit 0
    ;;
  collect)
    url=""
    for arg in "$@"; do
      case "$arg" in --url=*) url="${arg#--url=}" ;; esac
    done
    n="$(grep -c "^collect .*--url=$url " "$FAKE_LOG" || true)"
    save() {
      mkdir -p .lighthouseci
      local i
      for ((i = 0; i < $1; i++)); do
        stamp="$(date +%s%N)"
        echo "{\"finalUrl\":\"$url\"}" > ".lighthouseci/lhr-$stamp.json"
        echo "<html></html>" > ".lighthouseci/lhr-$stamp.html"
      done
    }
    if [ "$url" = "${FAKE_BASE}${FAKE_FAIL_PAGE:-none}" ] && [ "$n" -le "${FAKE_FAIL_TIMES:-0}" ]; then
      save 2
      if [ "${FAKE_FAIL_KIND:-runtime}" = runtime ]; then
        echo "Runtime error encountered: Something went wrong with recording the trace over your page load. Please run Lighthouse again. (NO_NAVSTART)" >&2
      else
        echo "Error: connect ECONNREFUSED" >&2
      fi
      exit 1
    fi
    save 3
    exit 0
    ;;
esac
exit 3
FAKE
chmod +x "$W/bin/lhci"

base="https://example.test"
pages=(/ /about/ /how-its-built/routes/)
fails=0

# run NAME, with the fake's settings in the environment: sets $out and $code, a fresh workdir.
run() {
  rm -rf "$W/work"
  mkdir -p "$W/work"
  echo '{}' > "$W/work/lighthouserc.json"
  : > "$W/calls.log"
  code=0
  out="$(PATH="$W/bin:$PATH" LIGHTHOUSE_WORKDIR="$W/work" FAKE_LOG="$W/calls.log" FAKE_BASE="$base" \
    "$script" "$base/" "${pages[@]}" 2>&1)" || code=$?
}

check() { # check DESCRIPTION CONDITION-EXIT-CODE
  if [ "$2" -eq 0 ]; then
    echo "ok   $1"
  else
    echo "FAIL $1"
    fails=$((fails + 1))
  fi
}

collects() { grep -c '^collect ' "$W/calls.log" || true; }
warnings() { printf '%s\n' "$out" | grep -c '^::warning title=Lighthouse runtime error::' || true; }
reports() { find "$W/work/.lighthouseci" -name 'lhr-*.json' | wc -l | tr -d ' '; }

echo "case 1: a runtime error once, then success"
FAKE_FAIL_PAGE=/about/ FAKE_FAIL_TIMES=1 FAKE_FAIL_KIND=runtime run once
check "exit 0" "$([ "$code" -eq 0 ]; echo $?)"
check "one warning line" "$([ "$(warnings)" -eq 1 ]; echo $?)"
check "the warning names the page and the code" \
  "$(printf '%s\n' "$out" | grep -q '^::warning title=Lighthouse runtime error::/about/ failed with NO_NAVSTART'; echo $?)"
check "four collects, the failed page twice" "$([ "$(collects)" -eq 4 ]; echo $?)"
check "three reports a page, none left from the failed collect" "$([ "$(reports)" -eq 9 ]; echo $?)"
check "assert and upload ran once each" \
  "$([ "$(grep -c '^assert ' "$W/calls.log")" -eq 1 ] && [ "$(grep -c '^upload ' "$W/calls.log")" -eq 1 ]; echo $?)"
check "the summary line" \
  "$(printf '%s\n' "$out" | grep -qx 'Lighthouse measured 3 pages; 1 needed a second collect.'; echo $?)"

echo "case 2: a runtime error twice"
FAKE_FAIL_PAGE=/about/ FAKE_FAIL_TIMES=2 FAKE_FAIL_KIND=runtime run twice
check "exit 1" "$([ "$code" -eq 1 ]; echo $?)"
check "one warning line, for the first failure" "$([ "$(warnings)" -eq 1 ]; echo $?)"
check "the failed page was collected twice, the last page never" "$([ "$(collects)" -eq 3 ]; echo $?)"
check "assert and upload did not run" "$([ "$(grep -c '^\(assert\|upload\) ' "$W/calls.log")" -eq 0 ]; echo $?)"

echo "case 3: an assertion failure"
FAKE_ASSERT=fail run assertion
check "exit 1" "$([ "$code" -eq 1 ]; echo $?)"
check "no warning line" "$([ "$(warnings)" -eq 0 ]; echo $?)"
check "no page was collected twice" "$([ "$(collects)" -eq 3 ]; echo $?)"
check "assert ran once, upload still ran" \
  "$([ "$(grep -c '^assert ' "$W/calls.log")" -eq 1 ] && [ "$(grep -c '^upload ' "$W/calls.log")" -eq 1 ]; echo $?)"
check "the assertion text is shown" "$(printf '%s\n' "$out" | grep -q 'Assertion failed'; echo $?)"

echo "case 4: a collect failure that is not a runtime error"
FAKE_FAIL_PAGE=/ FAKE_FAIL_TIMES=1 FAKE_FAIL_KIND=other run other
check "exit 1" "$([ "$code" -eq 1 ]; echo $?)"
check "no warning line" "$([ "$(warnings)" -eq 0 ]; echo $?)"
check "one collect only, no retry" "$([ "$(collects)" -eq 1 ]; echo $?)"
check "the error is shown" "$(printf '%s\n' "$out" | grep -q 'ECONNREFUSED'; echo $?)"

if [ "$fails" -ne 0 ]; then
  echo "$fails check(s) failed"
  exit 1
fi
echo "all checks passed"
