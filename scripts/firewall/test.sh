#!/usr/bin/env bash
# Copied from the site (IHaveASegway/website) at commit a0f7ac1fa221867737730127f6e3a8faf4c02336, with these changes, all so the cases
# fit this repository's two build outputs (check.sh's DIST_DIRS): the fixtures build both
# apps/web/dist and workers/api/dist; the cases that prove a built-output exit 2 run against
# each directory; the WebAssembly cases that were repeated for the API's bundle exist beside the
# web ones; the Route Lab's vroom.wasm, which this repository does not have, is replaced by a
# real module named in FW_REAL_WASM or, when a build is present, found in workers/api/dist
# (without either, those cases are skipped with a notice, and the firewall job's scan of the real bundle
# is what proves the reader follows a compiler's output). Every exit code is the site's.
# Self-test for check.sh: proves exit 0, 1 and 2 on throwaway fixtures. The only rules besides the
# canary are throwaway ones for nonsense terms, so no real rule is needed, read or revealed.
# It runs in CI's firewall-selftest job, beside verify (delivery.md, "Pipeline"); a check that
# cannot fail proves nothing.
#
# Each case is one way a term could pass unseen or a scan could pass unproven: a file name git
# quotes, a merge, a .gitattributes, an archive, a WebAssembly module (built here byte by byte, and
# a real one when FW_REAL_WASM names it), git settings that change git's output, rules left in the environment. Every
# case that finds something runs in both output formats, local and GitHub's annotations, and fails
# if either one prints a term or an address.
set -euo pipefail
export LC_ALL=C

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
check="$here/check.sh"
W="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/fwtest.XXXXXX")"
trap 'chmod -R u+rwX "$W" 2>/dev/null || true; rm -rf "$W"' EXIT

TERM_X="zq-test-term" # the throwaway terms: they name nothing
TERM_U="zq-tést-term" # the same with a non-ASCII letter, which git quotes in name listings
ok_email="58600977+IHaveASegway@users.noreply.github.com"
floor="$(sed -n 's/^RULE_FLOOR=\([0-9][0-9]*\).*/\1/p' "$check")"
[ -n "$floor" ] || {
  echo "test.sh: cannot read RULE_FLOOR from check.sh" >&2
  exit 2
}

# Fixtures never see the caller's git configuration, hooks, signing keys or private rules file:
# check.sh runs with a scratch HOME, and the gitleaks download cache is passed in explicitly.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 TZ=UTC
export GIT_AUTHOR_NAME=Fixture GIT_COMMITTER_NAME=Fixture GIT_EDITOR=true GIT_MERGE_AUTOEDIT=no
cache="${GITLEAKS_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/ihaveasegway/gitleaks}"
mkdir -p "$W/home"

canary_rule() {
  cat <<'EOF'
[[rules]]
id = "fw-canary"
regex = '''zq-fw-canary-[0-9a-f]{8}'''
keywords = ["zq-fw-canary-"]
EOF
}
throwaway_rules() { # the two throwaway rules, then filler rules up to the floor
  cat <<'EOF'
[[rules]]
id = "fw-test-01"
regex = '''(?i)\bzq-test-term\b'''
keywords = ["zq-test-term"]

[[rules]]
id = "fw-test-02"
regex = '''(?i)\bzq-tést-term\b'''
keywords = ["zq-tést-term"]
EOF
  local i=3
  while [ "$i" -lt "$floor" ]; do
    printf '\n[[rules]]\nid = "fw-test-filler-%s"\nregex = %s\nkeywords = ["zq-test-filler"]\n' \
      "$i" "'''zq-test-filler-$i'''"
    i=$((i + 1))
  done
}
rules() { # the shape the private file must have: the canary last
  throwaway_rules
  echo
  canary_rule
}
RULES="$(rules)"
# Rules that know nothing of the throwaway terms, though they would pass every guard: what a test
# could leave behind in GITLEAKS_CONFIG_TOML.
UNRELATED="$(printf '[[rules]]\nid = "fw-unrelated"\nregex = %s\nkeywords = ["zq-unrelated"]\n\n%s\n' \
  "'''zq-unrelated'''" "$(canary_rule)")"

# The private rules file for the cases that run as a hook does, outside CI.
mkdir -p "$W/hook-home/.config/ihaveasegway"
printf '%s\n' "$RULES" >"$W/hook-home/.config/ihaveasegway/firewall.toml"
chmod 600 "$W/hook-home/.config/ihaveasegway/firewall.toml"

# Git settings a person might have, each of which changed what git prints and hid a term from an
# earlier version of check.sh: colors, -diff and binary attributes, quoted names, one-line and
# abbreviated commit headers, no diff for the first commit, and UTF-16 messages.
hostile="$W/hostile.gitconfig"
printf '*.md -diff\n*.txt binary\n' >"$W/hostile.attributes"
cat >"$hostile" <<EOF
[color]
	ui = always
	diff = always
[core]
	attributesFile = $W/hostile.attributes
	quotePath = true
[diff]
	noprefix = true
	mnemonicPrefix = true
[log]
	showRoot = false
	abbrevCommit = true
	decorate = full
[format]
	pretty = oneline
[i18n]
	logOutputEncoding = UTF-16
EOF

new_repo() { # new_repo <name>: an empty repository, left as the working directory
  mkdir -p "$W/$1"
  cd "$W/$1"
  git init -q -b main .
  git config user.email "$ok_email"
  git config commit.gpgsign false
  git config tag.gpgsign false
}
built_site() { # both build outputs beside the repository's files, never committed
  mkdir -p apps/web/dist/.well-known workers/api/dist
  printf '<!doctype html><title>Fixture</title>\n' >apps/web/dist/index.html
  printf 'Contact: mailto:fixture@example.invalid\n' >apps/web/dist/.well-known/security.txt
  printf 'export default { fetch() { return new Response("ok"); } };\n' >workers/api/dist/index.js
}
# fixture <name>: a repository with one clean commit and a built site, left as the working
# directory; BASE holds the first commit.
fixture() {
  new_repo "$1"
  printf 'A fixture.\n' >README.md
  git add README.md
  git commit -qm "Fixture: first commit"
  BASE="$(git rev-parse HEAD)"
  built_site
}
commit() { # commit <message>: commits everything staged and unstaged except the build outputs
  git add -A -- . ':!apps/web/dist' ':!workers/api/dist'
  git commit -qm "$1"
}

# WebAssembly modules, built byte by byte, with no toolchain. hex: bytes from hex pairs. leb: a
# number as an unsigned LEB128. str: a name, its length in bytes, then the bytes. section: a
# section, its id and its length, around what the command after the id prints.
hex() {
  local h
  for h in "$@"; do printf '%b' "\\x$h"; done
}
leb() {
  local n="$1" b
  while :; do
    b=$((n & 127))
    n=$((n >> 7))
    if [ "$n" -eq 0 ]; then
      hex "$(printf %02x "$b")"
      return 0
    fi
    hex "$(printf %02x $((b | 128)))"
  done
}
str() {
  leb "${#1}"
  printf '%s' "$1"
}
section() { # section <id> <command...>
  "${@:2}" >"$W/payload"
  hex "$(printf %02x "$1")"
  leb "$(wc -c <"$W/payload")"
  cat "$W/payload"
}
custom() { # custom <name> <bytes>
  str "$1"
  printf '%s' "$2"
}
imports() { # imports <name>: env.<name>, a function of type 0
  hex 01
  str env
  str "$1"
  hex 00 00
}
exports() { # exports <name>: <name>, function 1, and the memory
  hex 02
  str "$1"
  hex 00 01
  str memory
  hex 02 00
}
datas() { # datas <active bytes> <passive bytes>: an active segment at offset 0, then a passive one
  hex 02 00 41 00 0b
  str "$1"
  hex 01
  str "$2"
}
# module <custom name> <custom bytes> <import name> <export name> <active data> <passive data>:
# a valid module with every kind of section, in the format's order, and a custom section first
module() {
  hex 00 61 73 6d 01 00 00 00
  section 0 custom "$1" "$2"
  section 1 hex 01 60 00 00          # type: one, [] -> []
  section 2 imports "$3"             # import
  section 3 hex 01 00                # function: one, of type 0
  section 4 hex 01 70 00 01          # table: funcref, at least 1
  section 5 hex 01 00 01             # memory: at least 1 page
  section 13 hex 01 00 00            # tag: of type 0
  section 6 hex 01 7f 00 41 00 0b    # global: i32, i32.const 0
  section 7 exports "$4"             # export
  section 8 hex 01                   # start: function 1
  section 9 hex 01 00 41 00 0b 01 01 # element: function 1, into table 0 at 0
  section 12 hex 02                  # data count: 2
  section 10 hex 01 02 00 0b         # code: one body, no locals, end
  section 11 datas "$5" "$6"         # data
}
clean_module() { module fixture 'Plain words.' log run 'Plain words.' 'Plain words, passive.'; }
empties() { # empties <n>: n empty passive data segments
  local i
  leb "$1"
  for ((i = 0; i < $1; i++)); do hex 01 00; done
}
# sized <file> <bytes> <strings> <text>: a valid module of exactly that many bytes and strings, for
# check.sh's two caps: <strings> - 2 empty passive data segments, then a custom section whose
# bytes are spaces up to <text> at the very end
sized() {
  local lb=1 len
  {
    hex 00 61 73 6d 01 00 00 00
    section 11 empties $(($3 - 2))
  } >"$W/sized"
  while :; do # the custom section's length takes lb bytes of LEB128, for a total of <bytes>
    len=$(($2 - $(wc -c <"$W/sized") - 1 - lb))
    [ "$(leb "$len" | wc -c)" -ne "$lb" ] || break
    lb=$((lb + 1))
  done
  {
    cat "$W/sized"
    hex 00
    leb "$len"
    str pad
    head -c $((len - 4 - ${#4})) /dev/zero | tr '\000' ' '
    printf '%s' "$4"
  } >"$1"
  [ "$(wc -c <"$1")" -eq "$2" ] || {
    echo "test.sh: cannot build a module of $2 bytes" >&2
    exit 2
  }
}
# A name 65 bytes long, so its length byte is the letter A: read as raw bytes, the name would start
# with a letter, and no rule's \b would hold before the term.
long_name="$TERM_X-$(printf '%052d' 0)"
real="${FW_REAL_WASM:-}"
[ -n "$real" ] || real="$({ find "$here/../../workers/api/dist" -name '*.wasm' -type f 2>/dev/null || true; } | head -n 1)"
if [ -z "$real" ]; then
  echo "test.sh: no real WebAssembly module (FW_REAL_WASM, or workers/api/dist/*.wasm): its cases are skipped" >&2
fi
wasm_head="$(sed -n "s/^WASM_HEAD='\([^']*\)'.*/\1/p" "$check")"
[ -n "$wasm_head" ] || {
  echo "test.sh: cannot read WASM_HEAD from check.sh" >&2
  exit 2
}
wasm_max="$(sed -n 's/^WASM_MAX=\([0-9][0-9]*\).*/\1/p' "$check")"
wasm_strings="$(sed -n 's/^WASM_STRINGS=\([0-9][0-9]*\).*/\1/p' "$check")"
[ -n "$wasm_max" ] && [ -n "$wasm_strings" ] || {
  echo "test.sh: cannot read WASM_MAX and WASM_STRINGS from check.sh" >&2
  exit 2
}

# What check.sh must never print: either term, git's quoted form of the non-ASCII one, or any part
# of an identity (every identity in these fixtures that is not allowed is "Someone", at an address
# ending in example.invalid).
FORBIDDEN=("$TERM_X" "$TERM_U" 'zq-t\303\251st-term' 'someone' 'example.invalid')

failures=0
expect() { # expect <exit code> <what> [VAR=value ...] [-- check.sh arguments...]
  local want="$1" what="$2" got=0 got_actions=0 leaked="" s
  shift 2
  local vars=()
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do
    vars+=("$1")
    shift
  done
  [ "$#" -gt 0 ] && shift
  local base=(HOME="$W/home" GITLEAKS_CACHE_DIR="$cache" CI=true GITLEAKS_CONFIG_TOML="$RULES"
    FW_EVENT=push FW_BASE="$BASE" FW_HEAD="$(git rev-parse HEAD)")
  env "${base[@]}" GITHUB_ACTIONS= ${vars[@]+"${vars[@]}"} "$check" "$@" >"$W/out" 2>&1 || got=$?
  if [ "$want" -eq 1 ]; then
    # Findings print paths and commits: check the annotation format too, whose logs go public.
    env "${base[@]}" GITHUB_ACTIONS=true ${vars[@]+"${vars[@]}"} "$check" "$@" >"$W/out-actions" 2>&1 ||
      got_actions=$?
  else
    : >"$W/out-actions"
    got_actions=$got
  fi
  for s in "${FORBIDDEN[@]}"; do
    if grep -Fqi -e "$s" "$W/out" "$W/out-actions"; then leaked="$s"; fi
  done
  if [ -n "$leaked" ]; then
    # The logging rule: output names rule ids, files, lines and commits, never what matched.
    printf 'FAIL  exit %s, and the output printed what it must not  %s\n' "$got" "$what"
    failures=$((failures + 1))
  elif [ "$got" -eq "$want" ] && [ "$got_actions" -eq "$want" ]; then
    printf 'ok    exit %s  %s\n' "$got" "$what"
  else
    printf 'FAIL  exit %s (annotations: %s), expected %s  %s\n' "$got" "$got_actions" "$want" "$what"
    sed 's/^/      /' "$W/out" "$W/out-actions"
    failures=$((failures + 1))
  fi
}

echo "check.sh self-test, rule floor $floor"

# --- Exit 0: clean ----------------------------------------------------------------------------------
fixture clean
printf 'Plain words.\n' >notes.md
commit "Add notes"
git tag -a v1 -m "Release one"
expect 0 "a clean range, tree, built site and identity"
expect 0 "the weekly rebuild: no range, tree and built site only" FW_EVENT=schedule FW_BASE= FW_HEAD=
expect 0 "a pull request with clean text" FW_EVENT=pull_request PR_TITLE="Add notes" PR_BRANCH=notes PR_BODY="Body."
expect 0 "an edited pull request's clean text" PR_TITLE="Add notes" PR_BRANCH=notes PR_BODY="Body." -- --pr-text
expect 0 "pre-push: a clean pushed range and ref name" -- --range "$BASE" HEAD refs/heads/notes
expect 0 "pre-push: a clean annotated tag" -- --range "$BASE" "$(git rev-parse v1)" refs/tags/v1
expect 0 "the full history, after a rule change" -- --history
expect 0 "clean, with git settings that change git's output" GIT_CONFIG_GLOBAL="$hostile"
printf 'Plain words.\n' >staged.md
git add staged.md
expect 0 "pre-commit outside CI, with the rules from the private file" CI= HOME="$W/hook-home" GITLEAKS_CONFIG_TOML= -- --staged

fixture suppressed
printf 'Some %s here.\n' "$TERM_X" >notes.md
printf 'notes.md:fw-test-01:1\n' >.gitleaksignore
commit "Add notes, with a reviewed suppression"
expect 0 "a committed .gitleaksignore suppresses its finding" FW_EVENT=schedule FW_BASE= FW_HEAD=
printf 'Edited, not committed.\n' >.gitleaksignore
expect 2 "pre-push: a .gitleaksignore edited in the working tree and not committed" -- --range "$BASE" HEAD
git checkout -q -- .gitleaksignore

# WebAssembly is read, not refused (ADR 0017): its custom sections, imports, exports and data
# segments, in every mode. A real module, when one is named, must parse end to end.
fixture wasm-clean
mkdir -p lib apps/web/dist/lab
clean_module >lib/clean.wasm
[ -z "$real" ] || cp "$real" lib/real.wasm
commit "Add the modules"
clean_module >apps/web/dist/lab/clean.wasm
clean_module >workers/api/dist/clean.wasm
[ -z "$real" ] || cp "$real" workers/api/dist/real.wasm
expect 0 "WebAssembly: a clean module with every kind of section, and a real one when named, in the range, the tree and both built outputs"
expect 0 "pre-push: the same modules in a pushed range" -- --range "$BASE" HEAD
expect 0 "the full history: the same modules" -- --history
clean_module >lib/staged.wasm
[ -z "$real" ] || cp "$real" lib/staged-real.wasm
git add lib/staged.wasm
[ -z "$real" ] || git add lib/staged-real.wasm
expect 0 "pre-commit: the same modules, staged" -- --staged

# --- Exit 1: a finding --------------------------------------------------------------------------------
fixture in-file
printf 'Some %s here.\n' "$TERM_X" >notes.md
commit "Add notes"
expect 1 "the term in a committed file"
expect 1 "pre-push: the term in a pushed commit" -- --range "$BASE" HEAD
expect 1 "pre-push, with git settings that change git's output" GIT_CONFIG_GLOBAL="$hostile" -- --range "$BASE" HEAD

new_repo in-root
printf 'Some %s here.\n' "$TERM_X" >notes.txt
commit "The first commit"
BASE="$(git rev-parse HEAD)"
built_site
expect 1 "the full history: the term in the first commit, with log.showRoot off and *.txt binary" \
  GIT_CONFIG_GLOBAL="$hostile" -- --history

fixture removed-in-range
printf 'Some %s here.\n' "$TERM_X" >notes.md
commit "Add notes"
git rm -q notes.md
commit "Remove notes"
expect 1 "the term added and removed inside the range (history holds it)"
expect 1 "the term added and removed inside the range, with git settings that change git's output" \
  GIT_CONFIG_GLOBAL="$hostile"

fixture in-message
printf 'Plain words.\n' >notes.md
commit "Mention $TERM_X in the message"
expect 1 "the term in a commit message"
expect 1 "the term in a commit message, with git set to print messages in UTF-16" GIT_CONFIG_GLOBAL="$hostile"
expect 1 "the full history: the term in a message" -- --history

fixture in-path
printf 'Plain words.\n' >"$TERM_X.md"
commit "Add a page"
expect 1 "the term in a file name"

fixture in-path-unicode
printf 'Plain words.\n' >"notes-$TERM_U.md"
commit "Add a page"
expect 1 "a non-ASCII term in a file name, which git quotes"
expect 1 "pre-push: a non-ASCII term in a file name" -- --range "$BASE" HEAD
expect 1 "the full history: a non-ASCII term in a file name" -- --history
printf 'Plain words.\n' >"staged-$TERM_U.md"
git add "staged-$TERM_U.md"
expect 1 "pre-commit: a non-ASCII term in a staged file name" -- --staged

fixture in-path-newline
printf 'Some %s here.\n' "$TERM_X" >"draft"$'\n'"$TERM_X.md"
commit "Add a draft"
expect 1 "the term in a file name that holds a newline"

fixture in-dist
printf 'Plain words.\n' >notes.md
commit "Add notes"
printf 'Built %s.\n' "$TERM_X" >apps/web/dist/.well-known/extra.txt
expect 1 "the term only in the built site, in a hidden directory"

fixture in-api-dist
printf 'Plain words.\n' >notes.md
commit "Add notes"
printf 'export const note = "Built %s.";\n' "$TERM_X" >workers/api/dist/note.js
expect 1 "the term only in the API's bundle"

fixture in-api-dist-name
printf 'Plain words.\n' >notes.md
commit "Add notes"
printf 'export {};\n' >"workers/api/dist/$TERM_X.js"
expect 1 "the term in a file name in the API's bundle, which no output may print"

fixture in-dist-name
printf 'Plain words.\n' >notes.md
commit "Add notes"
mkdir -p "apps/web/dist/$TERM_X"
printf '<!doctype html><title>Built %s</title>\n' "$TERM_X" >"apps/web/dist/$TERM_X/index.html"
expect 1 "the term in a built page's directory name, which no output may print"

fixture in-pr
printf 'Plain words.\n' >notes.md
commit "Add notes"
expect 1 "the term in a pull request title" FW_EVENT=pull_request PR_TITLE="About $TERM_X" PR_BRANCH=notes
expect 1 "the term in a branch name" FW_EVENT=pull_request PR_TITLE="Add notes" PR_BRANCH="$TERM_X"
expect 1 "the term in an edited pull request body" PR_TITLE="Add notes" PR_BRANCH=notes PR_BODY="On $TERM_X." -- --pr-text

fixture merge-only
printf 'Line.\n' >resolution.md
commit "Add resolution"
git checkout -q -b side
printf 'Side.\n' >resolution.md
commit "Side"
git checkout -q main
printf 'Main.\n' >resolution.md
commit "Main"
git merge -q side >/dev/null 2>&1 || true
printf 'Resolved with %s.\n' "$TERM_X" >resolution.md
commit "Merge side"
printf 'Resolved.\n' >resolution.md
commit "Drop it again"
expect 1 "the term only in a merge's conflict resolution, removed after"
expect 1 "pre-push: the term only in a merge's conflict resolution" -- --range "$BASE" HEAD
expect 1 "the full history: the term only in a merge's conflict resolution" -- --history

fixture attributes-tree
printf 'kept.md export-ignore -diff\n' >.gitattributes
printf 'Some %s here.\n' "$TERM_X" >kept.md
commit "Add kept"
expect 1 "a file a committed .gitattributes marks export-ignore, in the weekly rebuild" FW_EVENT=schedule FW_BASE= FW_HEAD=

fixture attributes-range
printf 'kept.md -diff\n' >.gitattributes
printf 'Some %s here.\n' "$TERM_X" >kept.md
commit "Add kept"
printf 'Plain words.\n' >kept.md
commit "Clean kept"
expect 1 "a file a committed .gitattributes marks -diff, in the range"
expect 1 "pre-push: a file a committed .gitattributes marks -diff" -- --range "$BASE" HEAD
expect 1 "the full history: a file a committed .gitattributes marks -diff" -- --history

fixture identity
printf 'Plain words.\n' >notes.md
git add notes.md
git -c user.email=someone@example.invalid commit -qm "Add notes"
expect 1 "an author that is not on the allowlist"

fixture co-author
printf 'Plain words.\n' >notes.md
commit "$(printf 'Add notes\n\nCo-authored-by: Someone <someone@example.invalid>')"
expect 1 "a Co-authored-by address that is not on the allowlist"

fixture co-author-folded
printf 'Plain words.\n' >notes.md
commit "$(printf 'Add notes\n\nCo-authored-by: Someone\n  <someone@example.invalid>')"
expect 1 "a Co-authored-by trailer folded onto a second line"

fixture co-author-two
printf 'Plain words.\n' >notes.md
commit "$(printf 'Add notes\n\nCo-authored-by: Someone <someone@example.invalid> <%s>' "$ok_email")"
expect 1 "a Co-authored-by trailer with two addresses, the allowed one last"

fixture refs
printf 'Plain words.\n' >notes.md
commit "Add notes"
expect 1 "pre-push: the term in the pushed ref name" -- --range "$BASE" HEAD "refs/heads/$TERM_X"
git tag -a v1 -m "Release $TERM_X"
expect 1 "pre-push: the term in an annotated tag's message" -- --range "$BASE" "$(git rev-parse v1)" refs/tags/v1
expect 1 "the full history: the term in an annotated tag" -- --history
git tag -d v1 >/dev/null
git -c user.email=someone@example.invalid tag -a v2 -m "Release two"
expect 1 "pre-push: an annotated tag whose tagger is not on the allowlist" -- --range "$BASE" "$(git rev-parse v2)" refs/tags/v2
git tag -d v2 >/dev/null
git branch "$TERM_X"
expect 1 "the full history: the term in a branch name" -- --history

fixture staged
printf 'Some %s here.\n' "$TERM_X" >staged.md
git add staged.md
expect 1 "pre-commit: the term in the staged changes" -- --staged
expect 1 "pre-commit, with git settings that change git's output" GIT_CONFIG_GLOBAL="$hostile" -- --staged
printf 'staged.md:fw-test-01:1\n' >.gitleaksignore
expect 1 "pre-commit: an untracked .gitleaksignore suppresses nothing" -- --staged
rm .gitleaksignore
expect 1 "pre-commit outside CI: the private file's rules, not an inherited GITLEAKS_CONFIG_TOML" \
  CI= HOME="$W/hook-home" GITLEAKS_CONFIG_TOML="$UNRELATED" -- --staged
git reset -q
printf 'Plain words.\n' >staged.md
git add staged.md
expect 0 "pre-commit: clean staged changes" -- --staged
expect 1 "pre-commit: an identity that is not on the allowlist" GIT_AUTHOR_EMAIL=someone@example.invalid -- --staged

# WebAssembly: the term in each part of a module the reader turns into text, in each surface.
fixture wasm-active
mkdir -p lib
module fixture 'Plain words.' log run "$(printf '%600s' '') Some $TERM_X here." 'Plain words.' >lib/solver.wasm
commit "Add a module"
expect 1 "WebAssembly: the term in an active data segment, 600 bytes in, in the tree"

fixture wasm-api
module fixture 'Plain words.' log run 'Plain words.' "Some $TERM_X here." >workers/api/dist/index_bg.wasm
expect 1 "WebAssembly: the term in a passive data segment, in the API's bundle"
module producers "processed-by $TERM_X 1.0" log run 'Plain words.' 'Plain words.' >workers/api/dist/index_bg.wasm
expect 1 "WebAssembly: the term in a custom section's bytes, in the API's bundle"
head -c 40 workers/api/dist/index_bg.wasm >workers/api/dist/cut.wasm
expect 2 "WebAssembly: a module cut short, in the API's bundle"

fixture wasm-passive
mkdir -p apps/web/dist/lab
module fixture 'Plain words.' log run 'Plain words.' "Some $TERM_X here." >apps/web/dist/lab/solver.wasm
expect 1 "WebAssembly: the term in a passive data segment, in the built site"

fixture wasm-custom-name
module "$TERM_X" 'Plain words.' log run 'Plain words.' 'Plain words.' >solver.wasm
git add solver.wasm
expect 1 "pre-commit: the term in a staged module's custom section name" -- --staged

fixture wasm-custom-bytes
mkdir -p apps/web/dist/lab
module producers "processed-by $TERM_X 1.0" log run 'Plain words.' 'Plain words.' >apps/web/dist/lab/solver.wasm
expect 1 "WebAssembly: the term in a custom section's bytes, in the built site"

fixture wasm-export
mkdir -p lib
module fixture 'Plain words.' log "$long_name" 'Plain words.' 'Plain words.' >lib/solver.wasm
commit "Add a module"
expect 1 "WebAssembly: the term in an export name whose length byte is a letter, in the tree"

fixture wasm-import
mkdir -p apps/web/dist/lab
module fixture 'Plain words.' "$TERM_U" run 'Plain words.' 'Plain words.' >apps/web/dist/lab/solver.wasm
expect 1 "WebAssembly: a non-ASCII term in an import name, in the built site"

fixture wasm-renamed
module fixture 'Plain words.' log run "Some $TERM_X here." 'Plain words.' >apps/web/dist/solver.bin
expect 1 "WebAssembly: the term in a module called solver.bin, found by its bytes, not its name"

fixture wasm-canary-rule
module fixture 'Plain words.' log run "$(printf 'zq-fw-canary-%08x' 0)" 'Plain words.' >apps/web/dist/solver.wasm
expect 1 "WebAssembly: a string the canary rule matches is a finding, not the scan's own known answer"

# Read as raw bytes, as the git scan reads it, this module's term follows the letter A, so no rule
# with \b sees it: only the reader does.
fixture wasm-range
mkdir -p lib
module fixture 'Plain words.' log "$long_name" 'Plain words.' 'Plain words.' >lib/solver.wasm
commit "Add a module"
git rm -q lib/solver.wasm
commit "Remove it"
expect 1 "WebAssembly: the term in a module added and removed inside the range"
expect 1 "pre-push: the term in a module added and removed inside a pushed range" -- --range "$BASE" HEAD
expect 1 "the full history: the term in a module no ref holds any more" -- --history

# A module at both of the reader's caps is read to its last byte, not refused.
fixture wasm-caps
mkdir -p apps/web/dist/lab
sized apps/web/dist/lab/solver.wasm "$wasm_max" "$wasm_strings" "Some $TERM_X here."
expect 1 "WebAssembly: the term in the last bytes of a module exactly at both caps, $wasm_max bytes and $wasm_strings strings"

# --- Exit 2: cannot prove clean -------------------------------------------------------------------------
fixture guards
printf 'Plain words.\n' >notes.md
commit "Add notes"
expect 2 "the rules are not set in CI" GITLEAKS_CONFIG_TOML=
expect 2 "fewer rules than the floor" GITLEAKS_CONFIG_TOML="$(canary_rule)"
expect 2 "the canary is not the last rule, so a truncated copy could keep it" \
  GITLEAKS_CONFIG_TOML="$(canary_rule && echo && throwaway_rules)"
expect 2 "no canary rule, so the canary goes unseen" GITLEAKS_CONFIG_TOML="$(rules | sed 's/zq-fw-canary-\[0-9a-f\]{8}/zq-not-the-canary/')"
expect 2 "malformed rules (gitleaks fails to load them)" GITLEAKS_CONFIG_TOML="$(printf '%s\n[[rules\n' "$RULES")"
expect 2 "outside CI with no private rules file" CI= -- --staged
expect 2 "an unknown commit range" FW_BASE=0123456789abcdef0123456789abcdef01234567
expect 2 "a push with no previous commit" FW_BASE=0000000000000000000000000000000000000000
expect 2 "no commit range outside the weekly rebuild" FW_BASE=
expect 2 "the built site is missing" DIST_DIRS=apps/web/no-such-dist:workers/api/dist
expect 2 "the API's bundle is missing" DIST_DIRS=apps/web/dist:workers/api/no-such-dist
mv workers/api/dist workers/api/dist-away
expect 2 "the API's bundle is missing from its default place"
mv workers/api/dist-away workers/api/dist
mv workers/api/dist/index.js "$W/index.js"
expect 2 "the API's bundle is empty"
mv "$W/index.js" workers/api/dist/index.js
ln -s index.js workers/api/dist/link.js
expect 2 "a symbolic link in the API's bundle"
rm workers/api/dist/link.js
printf '\n' >workers/api/dist/.gitleaksignore
expect 2 "a .gitleaksignore in the API's bundle, which would suppress its scan"
rm workers/api/dist/.gitleaksignore
printf 'Built.\n' | gzip >workers/api/dist/notes.txt.gz
expect 2 "a gzip file in the API's bundle, which no rule can read"
rm workers/api/dist/notes.txt.gz
expect 2 "a pull request whose text was not passed in" FW_EVENT=pull_request PR_TITLE= PR_BRANCH=
expect 2 "an edited pull request whose text was not passed in" -- --pr-text
if [ "$(id -u)" -ne 0 ]; then
  chmod 000 apps/web/dist/index.html
  expect 2 "an unreadable file in the built site"
  chmod 644 apps/web/dist/index.html
fi
ln -s index.html apps/web/dist/link.html
expect 2 "a symbolic link in the built site"
rm apps/web/dist/link.html
printf '\n' >apps/web/dist/.gitleaksignore
expect 2 "a .gitleaksignore in the built site, which would suppress its scan"
rm apps/web/dist/.gitleaksignore
printf 'Built.\n' | gzip >apps/web/dist/notes.txt.gz
expect 2 "a gzip file in the built site, which no rule can read"
rm apps/web/dist/notes.txt.gz
printf 'PK\003\004 an office document\n' >apps/web/dist/cv.docx
expect 2 "an Office document (a zip inside) in the built site"
rm apps/web/dist/cv.docx

# WebAssembly the reader cannot follow, or text gitleaks did not read: each one exits 2.
fixture wasm-malformed
mkdir -p apps/web/dist/lab
m=apps/web/dist/lab/solver.wasm
clean_module >"$W/clean.wasm"
size="$(wc -c <"$W/clean.wasm")"
head -c $((size - 3)) "$W/clean.wasm" >"$m"
expect 2 "WebAssembly: a module cut 3 bytes short"
{
  hex 00 61 73 6d 01 00 00 00 00
  leb 1000
  custom fixture 'Plain words.'
} >"$m"
expect 2 "WebAssembly: a section whose length runs past the end of the file"
hex 00 61 73 6d 01 00 00 00 01 80 >"$m"
expect 2 "WebAssembly: a section's length cut short at the end of the file"
hex 00 61 73 6d 01 00 00 00 00 80 80 80 80 80 00 >"$m"
expect 2 "WebAssembly: an over-long LEB128, a section's length in six bytes"
hex 00 61 73 6d 01 00 00 00 0e 00 >"$m"
expect 2 "WebAssembly: a section id the reader does not know"
{
  cat "$W/clean.wasm"
  printf 'trailing garbage'
} >"$m"
expect 2 "WebAssembly: bytes after the last section"
{
  hex 00 61 73 6d 01 00 00 00
  section 11 hex 01 01 32 41 42
  section 0 custom fixture 'Plain words.'
} >"$m"
expect 2 "WebAssembly: a data segment longer than its section"
{
  hex 00 61 73 6d 01 00 00 00
  section 11 hex 01 03 01 41
} >"$m"
expect 2 "WebAssembly: a data segment of a kind the reader does not know"
{
  hex 00 61 73 6d 01 00 00 00
  section 11 datas a b
  section 11 datas a b
} >"$m"
expect 2 "WebAssembly: a data section twice"
hex 00 61 73 6d 02 00 00 00 >"$m"
expect 2 "WebAssembly: a version other than 1"
# The text opens with check.sh's fixed line; this segment puts "ustar" 257 bytes into it, where
# gitleaks types its input as a tar archive and skips it unread.
tar_like() { # one passive segment
  hex 01 01
  str "$(printf "%$((257 - ${#wasm_head} - 1))s" '')ustar Some $TERM_X here."
}
{
  hex 00 61 73 6d 01 00 00 00
  section 11 tar_like
} >"$m"
expect 2 "WebAssembly: text gitleaks types as a tar archive and skips, so its known answer goes unreported"
# Valid modules one past either cap, which would otherwise read clean: exit 2, not a slow pass.
sized "$m" $((wasm_max + 1)) 2 'Plain words.'
expect 2 "WebAssembly: a module one byte larger than the reader's cap"
sized "$m" 65536 $((wasm_strings + 1)) 'Plain words.'
expect 2 "WebAssembly: a module one string past the reader's cap"
rm "$m"
head -c $((size - 3)) "$W/clean.wasm" >staged.wasm
git add staged.wasm
expect 2 "pre-commit: a staged module cut 3 bytes short" -- --staged

fixture archive
printf 'PK\003\004 not much of a zip\n' >bundle.zip
commit "Add a bundle"
expect 2 "a zip archive in the tracked tree"
printf 'Built.\n' | gzip >staged.gz
git add staged.gz
expect 2 "pre-commit: a staged gzip file" -- --staged

fixture nested-ignore
mkdir -p apps/web/public
printf '\n' >apps/web/public/.gitleaksignore
commit "Add a nested .gitleaksignore"
expect 2 "a .gitleaksignore below the repository root, which the built site would copy"

mkdir -p "$W/empty-cache"
version="$(sed -n 's/^version=//p' "$here/gitleaks.version")"
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) platform=linux_x64 ;;
  *) platform=darwin_arm64 ;;
esac
mkdir -p "$W/mirror/v$version"
printf 'not gitleaks\n' | gzip >"$W/mirror/v$version/gitleaks_${version}_${platform}.tar.gz"
expect 2 "a gitleaks archive whose sha256 does not match the pin" \
  GITLEAKS_CACHE_DIR="$W/empty-cache" GITLEAKS_DOWNLOAD_BASE="file://$W/mirror"
expect 2 "no gitleaks: the download fails" \
  GITLEAKS_CACHE_DIR="$W/empty-cache-2" GITLEAKS_DOWNLOAD_BASE="file://$W/no-such-mirror"

echo
if [ "$failures" -gt 0 ]; then
  echo "test.sh: $failures case(s) did not exit as expected" >&2
  exit 1
fi
echo "test.sh: every case exited as expected"
