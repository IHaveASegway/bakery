#!/usr/bin/env bash
# Runs the smoke scripts (scripts/smoke-*.sh) one after the other on `wrangler dev` with the fakes,
# for a person at a laptop and for scheduled.yml's weekly `smokes` job alike. A failing script does
# not stop the rest. Each script's output goes to <logs>/<name>.log and its Worker's log, where the
# script can keep one, to <logs>/<name>.worker.log. At the end it prints one table (script, checks,
# failed, seconds, result), writes <logs>/results.tsv for the job's issue, and exits non-zero when
# any script failed.
#
# Usage: scripts/smoke-all.sh [--logs DIR] [--markdown FILE] [NAME...]
#   NAME        a subset, by the part after smoke- (scripts/smoke-all.sh orders crm); all by default
#   --logs      where the logs go (made if missing; a scratch directory by default, printed)
#   --markdown  also write the table as Markdown to FILE (the job appends it to the step summary)
#   --list      print the names and exit
# Needs what the scripts need: cargo, worker-build, pnpm (after pnpm install), node 22 and curl.
# SMOKE_ALL_TIMEOUT_S (default 900) stops one script that runs longer, where `timeout` exists.
#
# The .dev.vars. Each script writes a throwaway workers/api/.dev.vars and refuses to run when one
# exists unless its own SMOKE_<NAME>_OVERWRITE=1 is set (smoke-api.sh writes none). The runner
# never sets those and unsets any it inherits, so no script moves a file aside on its behalf.
# Instead, when a .dev.vars exists, the runner refuses too, unless SMOKE_ALL_OVERWRITE=1: then it
# moves the file to a scratch directory of its own and puts it back on exit. It never deletes a
# .dev.vars. If one is there before a script starts (a script killed too hard to clean up), that
# script and the rest are not run and the file is left as it is. In CI none exists.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_VARS="$ROOT/workers/api/.dev.vars"
TIMEOUT_S="${SMOKE_ALL_TIMEOUT_S:-900}"
LOGS=""
MARKDOWN=""
BACKUP_DIR=""

usage() { sed -n '9,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }

ALL=()
for f in "$ROOT"/scripts/smoke-*.sh; do
  name="${f##*/smoke-}"; name="${name%.sh}"
  [[ "$name" == all ]] || ALL+=("$name")
done

NAMES=()
while (( $# > 0 )); do
  case "$1" in
    --logs) [[ $# -ge 2 ]] || usage; LOGS="$2"; shift 2 ;;
    --markdown) [[ $# -ge 2 ]] || usage; MARKDOWN="$2"; shift 2 ;;
    --list) printf '%s\n' "${ALL[@]}"; exit 0 ;;
    -h | --help) usage ;;
    -*) echo "unknown option $1" >&2; usage ;;
    *)
      if [[ ! -f "$ROOT/scripts/smoke-$1.sh" || "$1" == all ]]; then
        echo "no scripts/smoke-$1.sh; the names are: ${ALL[*]}" >&2
        exit 2
      fi
      NAMES+=("$1"); shift ;;
  esac
done
(( ${#NAMES[@]} > 0 )) || NAMES=("${ALL[@]}")

if [[ -z "$LOGS" ]]; then LOGS="$(mktemp -d -t smoke-all.XXXXXX)"; fi
mkdir -p "$LOGS"
LOGS="$(cd "$LOGS" && pwd)"

# No inherited per-script override: the runner alone decides what happens to a .dev.vars.
OVERWRITE="${SMOKE_ALL_OVERWRITE:-}"
while IFS= read -r var; do unset "$var"; done < <(compgen -e | grep -E '^SMOKE_[A-Z]+_OVERWRITE$' || true)

# shellcheck disable=SC2329 # run by the EXIT trap below
restore() {
  if [[ -n "$BACKUP_DIR" && -f "$BACKUP_DIR/dev.vars" ]]; then
    if [[ -e "$DEV_VARS" ]]; then
      echo "workers/api/.dev.vars exists again (a script left one); yours is kept in $BACKUP_DIR/dev.vars" >&2
    else
      mv "$BACKUP_DIR/dev.vars" "$DEV_VARS"
      rmdir "$BACKUP_DIR" 2>/dev/null || true
    fi
  fi
}
trap restore EXIT

if [[ -e "$DEV_VARS" ]]; then
  if [[ "$OVERWRITE" != 1 ]]; then
    echo "workers/api/.dev.vars exists; each smoke script would refuse. Move it aside, or set SMOKE_ALL_OVERWRITE=1 to have it moved and restored." >&2
    exit 2
  fi
  BACKUP_DIR="$(mktemp -d -t smoke-all-dev-vars.XXXXXX)"
  mv "$DEV_VARS" "$BACKUP_DIR/dev.vars"
  echo "moved workers/api/.dev.vars to $BACKUP_DIR; it goes back on exit"
fi

if command -v timeout > /dev/null 2>&1; then
  run_with_limit=(timeout --signal=TERM --kill-after=30 "$TIMEOUT_S")
else
  run_with_limit=() # macOS has no timeout; a person can stop a stuck script with Ctrl-C
fi

RESULTS="$LOGS/results.tsv"
printf 'script\tchecks\tfailed\tseconds\tresult\tcount line\n' > "$RESULTS"
ANY_FAILED=0
BLOCKED=""

echo "smoke-all: ${NAMES[*]}; logs in $LOGS"
for name in "${NAMES[@]}"; do
  script="$ROOT/scripts/smoke-$name.sh"
  log="$LOGS/$name.log"
  upper="$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')"
  if [[ -z "$BLOCKED" && -e "$DEV_VARS" ]]; then
    BLOCKED="workers/api/.dev.vars was left behind before smoke-$name.sh; it was not removed"
    echo "smoke-all: $BLOCKED" >&2
  fi
  if [[ -n "$BLOCKED" ]]; then
    printf 'smoke-%s.sh\t0\t0\t0\tnot run\t%s\n' "$name" "$BLOCKED" >> "$RESULTS"
    ANY_FAILED=1
    continue
  fi

  echo "--- smoke-$name.sh (log: $log)"
  extra=()
  # The Worker's own log, for the scripts that can keep one (SMOKE_<NAME>_LOG in their header).
  if grep -q "SMOKE_${upper}_LOG" "$script"; then extra=("SMOKE_${upper}_LOG=$LOGS/$name.worker.log"); fi
  start="$(date +%s)"
  set +e
  env ${extra[@]+"${extra[@]}"} ${run_with_limit[@]+"${run_with_limit[@]}"} "$script" < /dev/null > "$log" 2>&1
  code=$?
  set -e
  seconds=$(( $(date +%s) - start ))

  # The count line each script ends with: "all N checks passed" or "P passed, F failed"; for
  # smoke-api.sh, "all checks passed" or "F check(s) failed", so its ok and FAIL lines are counted.
  oks="$(grep -c '^ok    ' "$log" || true)"
  fails="$(grep -c '^FAIL  ' "$log" || true)"
  line="$(grep -E '^(all [0-9]+ checks passed|[0-9]+ passed, [0-9]+ failed|all checks passed|[0-9]+ check\(s\) failed.*)$' "$log" | tail -n 1 || true)"
  if [[ "$line" =~ ^all\ ([0-9]+)\ checks\ passed$ ]]; then
    checks="${BASH_REMATCH[1]}"; failed=0
  elif [[ "$line" =~ ^([0-9]+)\ passed,\ ([0-9]+)\ failed$ ]]; then
    checks=$(( BASH_REMATCH[1] + BASH_REMATCH[2] )); failed="${BASH_REMATCH[2]}"
  else
    checks=$(( oks + fails )); failed="$fails"
  fi
  if [[ "$line" == "all checks passed" ]]; then line="all $checks checks passed"; fi
  if [[ "$line" =~ ^[0-9]+\ check\(s\)\ failed ]]; then line="$oks passed, $fails failed"; fi

  if (( code == 0 )); then
    result="pass"
  else
    ANY_FAILED=1
    if (( code == 124 || code == 137 )) && (( ${#run_with_limit[@]} > 0 )); then
      result="timeout"
      line="stopped after ${TIMEOUT_S} s; ${oks} passed, ${fails} failed before then"
    else
      result="FAIL"
      if [[ -z "$line" ]]; then
        line="exit $code with no count line; ${oks} passed, ${fails} failed before: $(grep -v '^[[:space:]]*$' "$log" | tail -n 1 | cut -c1-200)"
      fi
    fi
  fi
  printf 'smoke-%s.sh\t%s\t%s\t%s\t%s\t%s\n' "$name" "$checks" "$failed" "$seconds" "$result" "$line" >> "$RESULTS"
  echo "    $result: ${line:-no count line} (${seconds} s)"
  if [[ "$result" != pass ]]; then grep '^FAIL  ' "$log" | sed 's/^/    /' || true; fi
done

echo
awk -F '\t' 'NR == 1 { printf "%-22s %7s %7s %8s  %s\n", $1, $2, $3, $4, $5; next }
  { printf "%-22s %7s %7s %8s  %s\n", $1, $2, $3, $4, $5; c += $2; f += $3; s += $4 }
  END { printf "%-22s %7s %7s %8s\n", "total", c, f, s }' "$RESULTS"

if [[ -n "$MARKDOWN" ]]; then
  awk -F '\t' 'NR == 1 { print "| Script | Checks | Failed | Seconds | Result |"; print "| --- | ---: | ---: | ---: | --- |"; next }
    { printf "| `%s` | %s | %s | %s | %s |\n", $1, $2, $3, $4, $5; c += $2; f += $3; s += $4 }
    END { printf "| total | %s | %s | %s | |\n", c, f, s }' "$RESULTS" > "$MARKDOWN"
fi

echo "logs in $LOGS"
exit "$ANY_FAILED"
