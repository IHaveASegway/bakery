#!/usr/bin/env bash
# Copied from the site (IHaveASegway/website) at commit a0f7ac1fa221867737730127f6e3a8faf4c02336, with one change: the built output is
# a list of directories, DIST_DIRS (default apps/web/dist:workers/api/dist, colon-separated), not
# one directory, because this repository publishes two build outputs: the web app's dist/ and the
# API's bundle from `wrangler deploy --dry-run --outdir` (delivery.md, "Shape"). Every directory
# in the list gets every check the site's one directory got, the WebAssembly reader included, and
# each must exist and be non-empty. The missing-rules message points to operations.md step 9, where
# this repository's access setup puts the rules file. Exit codes and rules are the site's, unchanged.
# The content firewall (ADR 0007). The design, with its surfaces and exit codes, is in
# security.md, "Content firewall design"; this script is its only bespoke code.
#
#   check.sh                    CI: every surface for this event. Needs the built outputs and, except
#                               on the weekly rebuild, the commit range in FW_BASE..FW_HEAD.
#   check.sh --staged           pre-commit: the staged files, their names, and the identity that
#                               will commit them.
#   check.sh --range B H [REF]  pre-push: the commits in B..H with their messages, paths and
#                               identities; REF, the ref name being pushed; and H itself when it is
#                               an annotated tag.
#   check.sh --history          after a rule change: every commit, tag and ref name on every ref.
#   check.sh --pr-text          a pull request's title, body and branch name (pr-text.yml).
#
# Exit 0: clean. 1: a finding. 2: cannot prove clean. Output names a rule id, a file, a line and a
# commit; never a match, a matched line, an address, or anything derived from them.
#
# Environment: in CI (CI is set), GITLEAKS_CONFIG_TOML holds the rules, from the FIREWALL_RULES
# secret. Anywhere else the rules come only from ~/.config/ihaveasegway/firewall.toml, and a
# GITLEAKS_CONFIG_TOML left in the environment is ignored. FW_EVENT is the GitHub event; FW_BASE
# and FW_HEAD bound the commit range; PR_TITLE, PR_BODY and PR_BRANCH carry the pull request's
# text; DIST_DIRS lists the built outputs, colon-separated (default apps/web/dist:workers/api/dist).
set -euo pipefail
umask 077
export LC_ALL=C # names and messages are bytes here: no locale may reject or reinterpret them

# The rules hold at least this many, the canary included. The number is not a secret: raise it to
# the real count whenever rules are added. The canary must also be the last rule, so a truncated
# copy always loses it, whatever the count.
RULE_FLOOR=51

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/fw.XXXXXX")"
in_actions=false
[ "${GITHUB_ACTIONS:-}" = true ] && in_actions=true

# Any exit that is not a deliberate 0, 1 or 2 becomes 2: an error is never read as clean, and
# never read as a finding either.
final=""
# shellcheck disable=SC2329 # invoked by the EXIT trap below
on_exit() {
  local rc=$?
  rm -rf "$T"
  if [ -z "$final" ] && [ "$rc" -ne 2 ]; then
    report_error "unexpected error (status $rc)"
    exit 2
  fi
}
trap on_exit EXIT

# Control characters (a newline in a file name, a terminal escape) become "?", so no value can
# start a new log line or a new workflow command.
printable() { printf '%s' "$1" | tr '\000-\037\177' '?'; }
# GitHub's workflow commands: "%" is escaped everywhere, and ":" and "," in a property. printable()
# has already replaced CR and LF, which would otherwise end the command.
data() { printable "$1" | sed -e 's/%/%25/g'; }
prop() { printable "$1" | sed -e 's/%/%25/g' -e 's/:/%3A/g' -e 's/,/%2C/g'; }

report_error() {
  if $in_actions; then
    echo "::error::$(data "content-firewall: cannot prove clean: $1")"
  else
    echo "content-firewall: cannot prove clean: $(printable "$1")" >&2
  fi
}
cannot_prove() {
  report_error "$1"
  exit 2
}

mkdir "$T/empty"           # the working directory of stdin scans, which read a .gitleaksignore from it
: >"$T/gitleaksignore"     # the suppressions every scan reads: none until a mode names the reviewed ones
mkdir "$T/tree" "$T/staged" # committed and staged files, byte for byte

is_sha() {
  local re='^[0-9a-f]{40}$'
  [[ $1 =~ $re ]]
}

findings=0
hide_paths=false # set when a file name itself matched: from then on, no path is printed
finding() {      # finding <rule> <surface> [file] [line] [commit]
  local rule="$1" surface="$2" file="${3:-}" line="${4:-}" commit="${5:-}" re='^[A-Za-z0-9_-]+$'
  findings=$((findings + 1))
  [[ $rule =~ $re ]] || rule="(a rule id that is not printable)"
  if $hide_paths; then file="" line=""; fi
  case "$line" in "" | *[!0-9]*) line="" ;; esac
  if [ -n "$commit" ]; then
    is_sha "$commit" || cannot_prove "a finding named a commit that is not a commit id"
    surface="$surface, commit ${commit:0:12}"
  fi
  if $in_actions; then
    if [ -n "$file" ]; then
      echo "::error file=$(prop "$file")${line:+,line=$line}::$(data "content-firewall $rule ($surface)")"
    else
      echo "::error::$(data "content-firewall $rule ($surface)")"
    fi
  else
    echo "content-firewall: $rule ($(printable "$surface"))${file:+ at $(printable "$file")${line:+:$line}}" >&2
  fi
}

# scan [--known-line <n>] <surface> <directory to run in> <commit to report, or ""> <gitleaks arguments...>
# Standard input passes through, for "gitleaks stdin". gitleaks exits 3 on a finding (its own
# status 1 means both "found" and "failed"); anything other than 0 or 3 cannot prove clean. Its
# own output is never shown: a malformed config makes it print the rules.
# --known-line n: line n of the input is the run's canary. gitleaks must report it there, as
# fw-canary, or the scan cannot prove it read the input; that one report is the known answer, not
# a finding. Text this script extracts needs it (scan_wasm says why).
scan() {
  local known=""
  if [ "$1" = --known-line ]; then
    known="$2"
    shift 2
  fi
  local surface="$1" dir="$2" at="$3"
  shift 3
  local out="$T/report.json" rc=0 n=0 seen=false rule file line commit
  rm -f "$out"
  (cd "$dir" && exec "$GL" "$@" --no-banner --redact --exit-code 3 --ignore-gitleaks-allow \
    --log-level error --gitleaks-ignore-path "$T/gitleaksignore" \
    --report-format json --report-path "$out") >/dev/null 2>&1 || rc=$?
  case "$rc" in
    0)
      [ -n "$known" ] || return 0
      cannot_prove "gitleaks did not report the known answer at the end of $surface, so it skipped some or all of it"
      ;;
    3) ;;
    *) cannot_prove "gitleaks could not scan $surface" ;;
  esac
  # One record per line: every control character in a field, the separator included, becomes "?".
  jq -r '.[] | [.RuleID, .File, .StartLine, .Commit] | map(. // "" | tostring | gsub("[[:cntrl:]]"; "?")) | join("\u001f")' \
    "$out" >"$T/report.txt" 2>/dev/null || cannot_prove "gitleaks reported a finding in $surface, but its report could not be read"
  while IFS=$'\x1f' read -r rule file line commit; do
    n=$((n + 1))
    if [ -n "$known" ] && ! $seen && [ "$rule" = fw-canary ] && [ "$line" = "$known" ]; then
      seen=true
      continue
    fi
    finding "$rule" "$surface" "$file" "$line" "${commit:-$at}"
  done <"$T/report.txt"
  [ "$n" -gt 0 ] || cannot_prove "gitleaks reported a finding in $surface, but its report could not be read"
  [ -z "$known" ] || $seen ||
    cannot_prove "gitleaks did not report the known answer at the end of $surface, so it skipped some or all of it"
}

scan_text() { # scan_text <surface> <file> [commit]: a text file through "gitleaks stdin"
  scan "$1" "$T/empty" "${3:-}" stdin <"$2"
}

scan_paths() { # scan_paths <file holding one path per line>
  local before=$findings
  scan_text "file paths" "$1"
  [ "$findings" -eq "$before" ] || hide_paths=true
}

nul_lines() { tr '\0' '\n' | sed '/^$/d'; } # NUL-separated names, one per line, never quoted

scan_pdf() { # scan_pdf <file> <label>: a PDF's text and metadata
  if ! command -v pdftotext >/dev/null || ! command -v pdfinfo >/dev/null; then
    cannot_prove "a PDF is present and pdftotext or pdfinfo is missing, so PDFs are blocked"
  fi
  { pdftotext -q "$1" - && pdfinfo "$1"; } >"$T/pdf.txt" 2>/dev/null || cannot_prove "cannot read a PDF"
  scan "PDF text and metadata, $2" "$T/empty" "" stdin <"$T/pdf.txt"
}

# --- WebAssembly (surface 5, ADR 0017) ------------------------------------------------------------
# A module is compiled code around text: the names it imports and exports, its custom sections
# (each a name and bytes: "name", "producers", "sourceMappingURL", "target_features" or any other)
# and its data segments, active or passive, where a compiled program keeps its string literals.
# read_wasm walks the binary format by its declared lengths and writes each of those as a line of
# text. Control bytes (0x00-0x1f and 0x7f) become line breaks, so each string stands alone; bytes
# from 0x80 stay, so a UTF-8 name reads whole. Every other section (types, functions, tables,
# memories, tags, globals, start, elements, the data count and the code) is stepped over by its
# length. Anything the reader does not expect cannot prove clean: a version other than 1, a section
# it does not know, or out of order, or twice; a length past the end of its section or of the file;
# a LEB128 cut short, or longer than its type allows; an import, export, segment or offset of a
# kind it does not know; bytes left over at the end of a section; or a module past either cap.
#
# Why bash and od, not a parser in another language: every mode already runs on them (the canary
# is made with od), and nothing else the hooks and CI all have can read bytes. jq reads only JSON;
# node is optional for the pre-commit hook and not set up in the firewall job; python is not on
# every Mac. od prints a window of the file as hex pairs into an array; text goes back out through
# printf's \x escapes, and a long run is copied by dd from its own offset, so no byte is ever held
# in a shell variable as itself, and no run costs more than its own length.
#
# Why the caps: bash spends microseconds on every string and on every byte of a short one, so a
# module of many small strings reads at about 11 s per MiB (ADR 0017). The caps bound one read to
# about 90 s at worst, well inside the firewall job's timeout, and past them the run exits 2
# instead of timing out. vroom.wasm is 919,927 bytes and 1,145 strings. A real module past either
# cap raises it, with an ADR.

WASM_HEAD='WebAssembly text, as check.sh reads it' # the text's first line; scan_wasm says why
WASM_WINDOW=65536                                  # bytes of the file in the array at a time
WASM_RUN=512                                       # a run at least this long is copied by dd
WASM_MAX=8388608                                   # the largest module it reads, in bytes: 8 MiB
WASM_STRINGS=20000                                 # the most strings: names, custom sections, data segments

wasm_fail() { cannot_prove "a WebAssembly file the reader cannot follow ($wa_label): $1"; }

wasm_window() { # the file's bytes from wa_p, up to WASM_WINDOW of them, into wa_bytes
  local n=$((wa_size - wa_p))
  [ "$n" -le "$WASM_WINDOW" ] || n=$WASM_WINDOW
  od -An -v -tx1 -j "$wa_p" -N "$n" "$wa_file" >"$T/wasm.hex" || cannot_prove "cannot read a WebAssembly file ($wa_label)"
  wa_bytes=()
  IFS=$' \t\n' read -r -d '' -a wa_bytes <"$T/wasm.hex" || true
  [ "${#wa_bytes[@]}" -eq "$n" ] || cannot_prove "cannot read a WebAssembly file ($wa_label)"
  wa_base=$wa_p
  wa_top=$((wa_p + n))
}

wasm_u8() { # wasm_u8 <what>: the byte at wa_p into wa_v, inside the current section
  [ "$wa_p" -lt "$wa_end" ] || wasm_fail "$1 runs past the end of its section"
  if [ "$wa_p" -lt "$wa_base" ] || [ "$wa_p" -ge "$wa_top" ]; then wasm_window; fi
  wa_v=$((16#${wa_bytes[wa_p - wa_base]}))
  wa_p=$((wa_p + 1))
}

# wasm_leb <bits> <u|s> <what>: a LEB128 of at most <bits> bits, unsigned (its value into wa_v) or
# signed (stepped over). The last byte it may take can hold only the bits the type has left: an
# unsigned one's spare bits are 0, a signed one's copy its sign bit.
wasm_leb() {
  local bits="$1" kind="$2" what="$3" max=$((($1 + 6) / 7)) n=0 value=0 b used rest
  while :; do
    [ "$wa_p" -lt "$wa_end" ] || wasm_fail "$what: a LEB128 cut short"
    wasm_u8 "$what"
    b=$wa_v
    n=$((n + 1))
    if [ "$n" -eq "$max" ]; then
      [ "$b" -lt 128 ] || wasm_fail "$what: a LEB128 longer than its type allows"
      used=$((bits - 7 * (max - 1)))
      rest=$((b >> used))
      if [ "$kind" = s ] && [ $(((b >> (used - 1)) & 1)) -eq 1 ]; then
        [ "$rest" -eq $((127 >> used)) ] || wasm_fail "$what: a LEB128 longer than its type allows"
      else
        [ "$rest" -eq 0 ] || wasm_fail "$what: a LEB128 longer than its type allows"
      fi
    fi
    value=$((value | (b & 127) << (7 * (n - 1))))
    [ "$b" -ge 128 ] || break
  done
  wa_v=$value
}

wasm_text() { # wasm_text <count> <what>: that many bytes from wa_p as a line of text
  local stop=$((wa_p + $1)) i last s
  [ "$stop" -le "$wa_end" ] || wasm_fail "$2 runs past the end of its section"
  wa_strings=$((wa_strings + 1))
  [ "$wa_strings" -le "$WASM_STRINGS" ] || wasm_fail "more than $WASM_STRINGS strings, too many to read in bounded time"
  if [ "$1" -ge "$WASM_RUN" ]; then
    # ibs=1 puts skip and count in bytes; dd seeks to the run instead of reading up to it
    dd if="$wa_file" ibs=1 obs=65536 skip="$wa_p" count="$1" 2>/dev/null | tr '\000-\037\177' '\n' >>"$wa_out" ||
      cannot_prove "cannot read a WebAssembly file ($wa_label)"
    wa_p=$stop
  fi
  while [ "$wa_p" -lt "$stop" ]; do
    if [ "$wa_p" -lt "$wa_base" ] || [ "$wa_p" -ge "$wa_top" ]; then wasm_window; fi
    last=$stop
    [ "$last" -le "$wa_top" ] || last=$wa_top
    s=""
    for ((i = wa_p - wa_base; i < last - wa_base; i++)); do
      case "${wa_bytes[i]}" in
        [01]? | 7f) s+='\n' ;;
        *) s+="\\x${wa_bytes[i]}" ;;
      esac
    done
    printf '%b' "$s" >>"$wa_out"
    wa_p=$last
  done
  printf '\n' >>"$wa_out"
}

wasm_name() { # wasm_name <what>: a name (its length in bytes, then the bytes) as a line of text
  wasm_leb 32 u "$1"
  wasm_text "$wa_v" "$1"
}

wasm_limits() { # a table's or a memory's limits: a flag, the minimum, and the maximum if flagged
  local bits=32
  wasm_u8 "the limits"
  case "$wa_v" in
    0 | 1 | 2 | 3) ;;
    4 | 5 | 6 | 7) bits=64 ;; # memory64
    *) wasm_fail "limits of a kind it does not know" ;;
  esac
  wasm_leb "$bits" u "the limits"
  if [ $((wa_v & 1)) -eq 1 ]; then wasm_leb "$bits" u "the limits"; fi
}

wasm_valtype() { # wasm_valtype <what>: a number, vector or reference type
  wasm_u8 "$1"
  case "$wa_v" in
    127 | 126 | 125 | 124 | 123 | 112 | 111) ;; # i32 i64 f32 f64 v128 funcref externref
    *) wasm_fail "$1: a type it does not know" ;;
  esac
}

wasm_imports() { # the import section: each import's module and name
  local count
  wasm_leb 32 u "the import count"
  count=$wa_v
  while [ "$count" -gt 0 ]; do
    wasm_name "an import's module"
    wasm_name "an import's name"
    wasm_u8 "an import's kind"
    case "$wa_v" in
      0) wasm_leb 32 u "an imported function's type" ;;
      1)
        wasm_valtype "an imported table's type"
        case "$wa_v" in 112 | 111) ;; *) wasm_fail "an imported table of a type it does not know" ;; esac
        wasm_limits
        ;;
      2) wasm_limits ;;
      3)
        wasm_valtype "an imported global's type"
        wasm_u8 "an imported global's mutability"
        [ "$wa_v" -le 1 ] || wasm_fail "an imported global of a kind it does not know"
        ;;
      4)
        wasm_u8 "an imported tag"
        [ "$wa_v" -eq 0 ] || wasm_fail "an imported tag of a kind it does not know"
        wasm_leb 32 u "an imported tag's type"
        ;;
      *) wasm_fail "an import of a kind it does not know" ;;
    esac
    count=$((count - 1))
  done
}

wasm_exports() { # the export section: each export's name
  local count
  wasm_leb 32 u "the export count"
  count=$wa_v
  while [ "$count" -gt 0 ]; do
    wasm_name "an export's name"
    wasm_u8 "an export's kind"
    [ "$wa_v" -le 4 ] || wasm_fail "an export of a kind it does not know" # function, table, memory, global, tag
    wasm_leb 32 u "an export's index"
    count=$((count - 1))
  done
}

wasm_offset() { # an active segment's offset: i32.const, i64.const or global.get, then end
  wasm_u8 "a data segment's offset"
  case "$wa_v" in
    65) wasm_leb 32 s "a data segment's offset" ;;  # i32.const
    66) wasm_leb 64 s "a data segment's offset" ;;  # i64.const, memory64
    35) wasm_leb 32 u "a data segment's offset" ;;  # global.get
    *) wasm_fail "a data segment's offset of a kind it does not know" ;;
  esac
  wasm_u8 "a data segment's offset"
  [ "$wa_v" -eq 11 ] || wasm_fail "a data segment's offset of a kind it does not know" # end
}

wasm_data() { # the data section: every segment's bytes, active (0, 2) or passive (1)
  local count
  wasm_leb 32 u "the data segment count"
  count=$wa_v
  while [ "$count" -gt 0 ]; do
    wasm_leb 32 u "a data segment's kind"
    case "$wa_v" in
      0) wasm_offset ;;
      1) ;;
      2)
        wasm_leb 32 u "a data segment's memory"
        wasm_offset
        ;;
      *) wasm_fail "a data segment of a kind it does not know" ;;
    esac
    wasm_leb 32 u "a data segment's length"
    wasm_text "$wa_v" "a data segment"
    count=$((count - 1))
  done
}

read_wasm() { # read_wasm <file> <label> <text file>: the module's text, or exit 2
  local id size rank last=0
  wa_file="$1" wa_label="$2" wa_out="$3" wa_base=0 wa_top=0 wa_strings=0
  wa_bytes=()
  wa_size="$(wc -c <"$1" | tr -d ' ')" || cannot_prove "cannot read a WebAssembly file ($wa_label)"
  printf '%s\n' "$WASM_HEAD" >"$wa_out"
  wa_p=0 wa_end=$wa_size
  [ "$wa_size" -le "$WASM_MAX" ] || wasm_fail "larger than $WASM_MAX bytes, too large to read in bounded time"
  [ "$wa_size" -ge 8 ] || wasm_fail "the file ends inside its header"
  wasm_window
  [ "${wa_bytes[*]:0:4}" = "00 61 73 6d" ] || wasm_fail "no WebAssembly magic"
  [ "${wa_bytes[*]:4:4}" = "01 00 00 00" ] || wasm_fail "a version other than 1"
  wa_p=8
  while [ "$wa_p" -lt "$wa_size" ]; do
    wa_end=$wa_size
    wasm_u8 "a section's id"
    id=$wa_v
    # Custom sections may come anywhere; every other one at most once, in the format's order.
    case "$id" in
      0) rank=0 ;;
      1 | 2 | 3 | 4 | 5) rank=$id ;;     # type, import, function, table, memory
      13) rank=6 ;;                      # tag
      6 | 7 | 8 | 9) rank=$((id + 1)) ;; # global, export, start, element
      12) rank=11 ;;                     # data count
      10 | 11) rank=$((id + 2)) ;;       # code, data
      *) wasm_fail "a section it does not know" ;;
    esac
    if [ "$rank" -gt 0 ]; then
      [ "$rank" -gt "$last" ] || wasm_fail "a section out of order, or twice"
      last=$rank
    fi
    wasm_leb 32 u "a section's length"
    size=$wa_v
    [ $((wa_p + size)) -le "$wa_size" ] || wasm_fail "a section runs past the end of the file"
    wa_end=$((wa_p + size))
    case "$id" in
      0)
        wasm_name "a custom section's name"
        wasm_text $((wa_end - wa_p)) "a custom section"
        ;;
      2) wasm_imports ;;
      7) wasm_exports ;;
      11) wasm_data ;;
      *) wa_p=$wa_end ;; # walked by its length
    esac
    [ "$wa_p" -eq "$wa_end" ] || wasm_fail "bytes left over at the end of a section"
  done
}

# scan_wasm <file> <label> [commit]: a module's text through "gitleaks stdin". gitleaks reads the
# first bytes of its input and skips, silently, whatever they type as application/*. Text taken
# from a binary can look like that by chance: "ustar" 257 bytes in reads as a tar archive. So the
# text opens with a fixed line, and the run's canary closes it as a known answer that must be
# reported on its line, or the scan cannot prove it read the text.
scan_wasm() {
  read_wasm "$1" "$2" "$T/wasm.txt"
  cat "$T/canary" >>"$T/wasm.txt"
  scan --known-line "$(wc -l <"$T/wasm.txt" | tr -d ' ')" "WebAssembly text, $2" "$T/empty" "${3:-}" stdin <"$T/wasm.txt"
}

# range_wasm <surface> <git log arguments...>: every file the commits add or change that opens
# with the WebAssembly magic, read as scan_wasm reads one in the tree, and reported with a commit
# that adds it. The git scan reads such a file only as raw bytes, where a name's length byte can
# be a letter that joins the name. Other packed formats are not typed in commit ranges yet
# (security.md, surface 5).
range_wasm() {
  local surface="$1" entry path mode object sha="" seen=" " label
  shift
  git log -z --raw --no-abbrev --no-renames --format=%H --diff-merges=first-parent "$@" >"$T/raw.z" ||
    cannot_prove "cannot list the files in $surface"
  while IFS= read -r -d '' entry; do
    while [ "${entry#$'\n'}" != "$entry" ]; do entry="${entry#$'\n'}"; done
    case "$entry" in
      :*) # ":<old mode> <new mode> <old object> <new object> <status>", then the path
        IFS= read -r -d '' path || cannot_prove "cannot read the files in $surface"
        read -r _ mode _ object _ <<<"${entry#:}"
        case "$mode" in 100644 | 100755) ;; *) continue ;; esac # a deletion, a link or a submodule
        case "$seen" in *" $object "*) continue ;; esac
        seen="$seen$object "
        git cat-file blob "$object" >"$T/blob" || cannot_prove "cannot read a file from git"
        [ "$(od -An -tx1 -N4 "$T/blob" | tr -d ' \n')" = 0061736d ] || continue
        label="$surface"
        $hide_paths || label="$surface: $path"
        scan_wasm "$T/blob" "$label" "$sha"
        ;;
      *)
        is_sha "$entry" || cannot_prove "a commit record could not be read"
        sha="$entry"
        ;;
    esac
  done <"$T/raw.z"
}

# binary_surfaces <directory> <label>: files whose bytes the rules cannot read, found by their
# first bytes rather than their names. gitleaks skips every file it types as application/*, so an
# archive, an Office document or a database would pass unread. PDFs and WebAssembly are extracted
# (surface 5); everything else of the kind is refused, the way a PDF is when it cannot be extracted.
binary_surfaces() {
  local f rel magic tar label
  find "$1" -type f -print0 >"$T/files" || cannot_prove "cannot list $2"
  while IFS= read -r -d '' f || [ -n "$f" ]; do
    rel="${f#"$1"/}"
    label="$2"
    $hide_paths || label="$2: $rel"
    magic="$(od -An -tx1 -N8 "$f" | tr -d ' \n')" || cannot_prove "cannot read a file in $2"
    case "$magic" in
      255044462d*) # %PDF-
        scan_pdf "$f" "$label"
        continue
        ;;
      0061736d*) # \0asm, whatever the file is called
        scan_wasm "$f" "$label"
        continue
        ;;
      504b0304* | 504b0506* | 504b0708* | 1f8b* | 1f9d* | 1fa0* | 425a68* | fd377a585a00* | 28b52ffd* | \
        377abcaf271c* | 526172211a07* | 4c5a4950* | 4d534346* | 213c617263683e* | d0cf11e0a1b11ae1* | \
        7b5c727466* | 25215053* | 53514c6974652066* | 7f454c46* | 4d5a* | \
        feedface* | feedfacf* | cefaedfe* | cffaedfe* | cafebabe*)
        # zip and every format built on it (docx, xlsx, pptx, epub, jar), gzip, compress, bzip2,
        # xz, zstd, 7z, rar, lzip, cab, ar, OLE (doc, xls, ppt), RTF, PostScript, SQLite, and
        # executables (ELF, PE, Mach-O, Java classes)
        cannot_prove "a file no rule can read ($label): an archive, an Office document or another packed format. Commit what it holds instead, or remove it"
        ;;
    esac
    tar="$({ od -An -c -j257 -N5 "$f" 2>/dev/null || true; } | tr -d ' \n')"
    [ "$tar" != ustar ] || cannot_prove "a file no rule can read ($label): a tar archive. Commit what it holds instead, or remove it"
  done <"$T/files"
}

# write_blob <object> <directory> <path>: a blob's bytes, exactly as committed. git archive and
# git checkout would apply attributes (export-ignore, export-subst, working-tree-encoding) that a
# committed .gitattributes controls; cat-file applies none.
write_blob() {
  local dir
  case "/$3/" in */../* | */./* | *//*) cannot_prove "a path in git is not a plain relative path" ;; esac
  dir="${3%/*}"
  [ "$dir" != "$3" ] || dir=.
  mkdir -p "$2/$dir" || cannot_prove "cannot copy a file out of git"
  git cat-file blob "$1" >"$2/$3" || cannot_prove "cannot read a file from git"
}

extract_tree() { # extract_tree <tree-ish> <directory>: every committed file
  local entry meta path mode type object
  git ls-tree -r -z --full-tree "$1" >"$T/ls-tree" || cannot_prove "cannot list the tracked tree"
  while IFS= read -r -d '' entry || [ -n "$entry" ]; do
    meta="${entry%%$'\t'*}" # "<mode> <type> <object>", then a tab and the path
    path="${entry#*$'\t'}"
    read -r mode type object <<<"$meta"
    [ "$type" = blob ] || continue # a submodule: its files are not in this repository
    write_blob "$object" "$2" "$path"
  done <"$T/ls-tree"
}

extract_staged() { # the staged version of every added, copied, modified, renamed or retyped file, and its name
  local meta mode object status path
  git diff --cached -z --raw --no-abbrev --diff-filter=ACMRT >"$T/staged.raw" || cannot_prove "cannot list the staged files"
  : >"$T/paths"
  while IFS= read -r -d '' meta; do
    # ":<old mode> <new mode> <old object> <new object> <status>", then the path; a rename or a
    # copy names the old path first
    read -r _ mode _ object status <<<"${meta#:}"
    IFS= read -r -d '' path || cannot_prove "cannot read the staged file list"
    case "$status" in R* | C*) IFS= read -r -d '' path || cannot_prove "cannot read the staged file list" ;; esac
    [ "$mode" != 160000 ] || continue # a submodule pointer
    write_blob "$object" "$T/staged" "$path"
    printf '%s\n' "$path" >>"$T/paths"
  done <"$T/staged.raw"
}

# reviewed_ignore <object>: the .gitleaksignore under review (committed, or staged for a commit),
# or none. gitleaks also reads one from the directory it scans, so every scan runs in a directory
# where that file is either absent or this same version.
reviewed_ignore() {
  if git cat-file -e "$1" 2>/dev/null; then
    git cat-file blob "$1" >"$T/gitleaksignore" || cannot_prove "cannot read .gitleaksignore"
  else
    : >"$T/gitleaksignore"
  fi
}
worktree_ignore_matches() { # a git scan runs in the working tree, so its .gitleaksignore must be the reviewed one
  [ -e "$repo/.gitleaksignore" ] || return 0
  cmp -s "$repo/.gitleaksignore" "$T/gitleaksignore" ||
    cannot_prove "the working tree's .gitleaksignore differs from the one being scanned; a suppression counts only once it is committed and reviewed (security.md, Rule-writing rules)"
}

# Identities: exact match against the allowlist, ignoring case.
[ -r "$here/allowed-identities.txt" ] || cannot_prove "the identity allowlist is missing"
sed -e 's/#.*//' -e 's/[[:space:]]//g' -e '/^$/d' "$here/allowed-identities.txt" |
  tr '[:upper:]' '[:lower:]' >"$T/allowed"
allowed() {
  local address
  case "$1" in "" | *[[:space:]]*) return 1 ;; esac
  address="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  grep -Fxq -- "$address" "$T/allowed"
}
email_of() { printf '%s' "$1" | sed -n 's/.*<\([^>]*\)>.*/\1/p'; } # from "Name <email> time zone"
one_address() {                                                      # one_address <trailer value>: its address, only if it holds exactly one
  local re='^[^<>]*<([^<>[:space:]]+@[^<>[:space:]]+)>$'
  [[ $1 =~ $re ]] && printf '%s' "${BASH_REMATCH[1]}"
}

check_identities() { # check_identities <git log arguments...>
  local sha author committer trailers co email
  git log -z --format='%H%x1f%ae%x1f%ce%x1f%(trailers:key=Co-authored-by,valueonly,unfold,separator=%x1e)' "$@" \
    >"$T/identities" || cannot_prove "cannot list the commits' identities"
  while IFS=$'\x1f' read -r -d '' sha author committer trailers || [ -n "$sha" ]; do
    is_sha "$sha" || cannot_prove "a commit record could not be read"
    allowed "$author" || finding identity "author not on the allowlist" "" "" "$sha"
    allowed "$committer" || finding identity "committer not on the allowlist" "" "" "$sha"
    [ -n "$trailers" ] || continue
    printf '%s\n' "$trailers" | tr '\036' '\n' >"$T/trailers"
    while IFS= read -r co; do
      email="$(one_address "$co")" || email=""
      if [ -z "$email" ] || ! allowed "$email"; then
        finding identity "Co-authored-by not on the allowlist" "" "" "$sha"
      fi
    done <"$T/trailers"
  done <"$T/identities"
}

scan_messages() { # scan_messages <git log arguments...>: each commit's message, alone
  local sha
  git log -z --format=%H "$@" >"$T/shas" || cannot_prove "cannot list the commits"
  while IFS= read -r -d '' sha || [ -n "$sha" ]; do
    is_sha "$sha" || cannot_prove "a commit record could not be read"
    git log -1 --format=%B "$sha" >"$T/message" || cannot_prove "cannot read a commit message"
    scan_text "commit message" "$T/message" "$sha"
  done <"$T/shas"
}

scan_tag() { # scan_tag <object>: if it is an annotated tag, its name, message and tagger, then any tag it points at
  local object="$1" depth=0 tagger type
  while :; do
    type="$(git cat-file -t "$object")" || cannot_prove "cannot read a pushed or tagged object"
    [ "$type" = tag ] || return 0
    depth=$((depth + 1))
    [ "$depth" -le 10 ] || cannot_prove "a chain of tags too long to follow"
    git cat-file tag "$object" >"$T/tag" || cannot_prove "cannot read a tag"
    scan_text "annotated tag" "$T/tag"
    tagger="$(sed -n 's/^tagger [^<]*<\([^>]*\)>.*/\1/p' "$T/tag" | head -n 1)"
    allowed "$tagger" || finding identity "tagger not on the allowlist"
    object="$(sed -n 's/^object //p' "$T/tag" | head -n 1)"
  done
}

scan_pr_text() { # the pull request's title, body and branch name, passed through env, never ${{ }}
  printf '%s\n%s\n%s\n' "${PR_TITLE:-}" "${PR_BRANCH:-}" "${PR_BODY:-}" >"$T/pr.txt"
  scan_text "pull request title, body or branch name" "$T/pr.txt"
}

# --- Git, as this script and gitleaks read it -------------------------------------------------------
# Both parse git's output, so the caller's git configuration must not change it, or a term passes
# unseen: colors break the parser, a -diff attribute turns a file into "Binary files differ", UTF-16
# log output hides a message from every rule, log.showRoot=false drops the first commit, an
# abbreviated or decorated commit line loses the commit id. These settings outrank every config file.
git_settings=(
  color.ui=never
  color.diff=never
  core.attributesFile=/dev/null
  core.quotePath=false
  diff.noprefix=false
  diff.mnemonicPrefix=false
  diff.relative=false
  diff.srcPrefix=a/
  diff.dstPrefix=b/
  format.pretty=medium
  i18n.logOutputEncoding=UTF-8
  log.abbrevCommit=false
  log.date=default
  log.decorate=false
  log.showRoot=true
  log.showSignature=false
)
export GIT_CONFIG_COUNT="${#git_settings[@]}"
i=0
for setting in "${git_settings[@]}"; do
  export "GIT_CONFIG_KEY_$i=${setting%%=*}" "GIT_CONFIG_VALUE_$i=${setting#*=}"
  i=$((i + 1))
done
# For git log -p as gitleaks runs it: --text reads files marked binary or -diff, --no-textconv and
# --no-ext-diff keep a configured converter from rewriting them, and --diff-merges=first-parent shows
# what a merge itself introduced, such as a conflict resolution. gitleaks splits this on spaces.
LOG_OPTS="--no-color --text --no-textconv --no-ext-diff --diff-merges=first-parent"

# --- Guards: every missing input is exit 2 --------------------------------------------------------

command -v git >/dev/null || cannot_prove "git is not installed"
command -v jq >/dev/null || cannot_prove "jq is not installed"
repo="$(git rev-parse --show-toplevel 2>/dev/null)" || cannot_prove "not inside a git repository"
cd "$repo"
mode="${1:-ci}"

# The identity a commit is about to record, read with any "git -c user.email=..." the commit itself
# was given, before that is dropped below.
if [ "$mode" = --staged ]; then
  for role in author committer; do
    ident="$(git var "GIT_$(printf '%s' "$role" | tr '[:lower:]' '[:upper:]')_IDENT" 2>/dev/null)" ||
      cannot_prove "git has no $role identity: set user.email for this clone"
    printf '%s %s\n' "$role" "$(email_of "$ident")" >>"$T/staged-identities"
  done
fi
# "git -c" from the command that ran a hook arrives here as GIT_CONFIG_PARAMETERS, which git reads
# after the settings above, so it would outrank them.
unset GIT_CONFIG_PARAMETERS
# Attributes from git's empty tree, that is, none: a committed .gitattributes cannot mark a file
# -diff or binary for any git command here (git 2.40 and later; --text covers older ones).
export GIT_ATTR_SOURCE=4b825dc642cb6eb9a060e54bf8d69288fbee4904
# The variables that point git at this repository, which a hook sets. The git known answer below
# builds a scratch repository and must not write into this one.
repo_vars="$(git rev-parse --local-env-vars | grep -v '^GIT_CONFIG' || true)"

unset GITLEAKS_CONFIG # it would outrank the rules below
if [ -n "${CI:-}" ]; then
  [ -n "${GITLEAKS_CONFIG_TOML:-}" ] || cannot_prove "FIREWALL_RULES is not set for this run"
else
  # Local hooks read the private file and nothing else, so rules left in the environment by a test
  # or a debugging session cannot stand in for it.
  rules_file="$HOME/.config/ihaveasegway/firewall.toml"
  [ -r "$rules_file" ] || cannot_prove "no rules file at $rules_file. Create it, mode 600, as operations.md describes (access setup, step 9)"
  if [ -n "${GITLEAKS_CONFIG_TOML:-}" ]; then
    echo "content-firewall: ignoring GITLEAKS_CONFIG_TOML from the environment; outside CI the rules come only from $rules_file" >&2
  fi
  GITLEAKS_CONFIG_TOML="$(cat "$rules_file")"
  export GITLEAKS_CONFIG_TOML
fi
count="$(grep -c '^[[:space:]]*\[\[rules\]\]' <<<"$GITLEAKS_CONFIG_TOML" || true)"
[ "$count" -ge "$RULE_FLOOR" ] || cannot_prove "$count rules loaded, below the floor of $RULE_FLOOR"
last_id="$({ grep -E '^[[:space:]]*id[[:space:]]*=' <<<"$GITLEAKS_CONFIG_TOML" || true; } | tail -n 1 |
  sed -E "s/^[[:space:]]*id[[:space:]]*=[[:space:]]*[\"']([^\"']*)[\"'].*/\1/")"
[ "$last_id" = fw-canary ] ||
  cannot_prove "the last rule is not fw-canary. Keep the canary rule at the end of the rules, so a truncated copy always loses it (security.md, The canary)"

GL="$("$here/install-gitleaks.sh" "$T/bin")" || cannot_prove "no verified gitleaks binary"

# The canary: a fresh random string that only the secret's fw-canary rule knows. If gitleaks fell
# back to its default rules, or the secret is empty or malformed, it goes unseen.
printf 'zq-fw-canary-%s\n' "$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')" >"$T/canary"
rc=0
(cd "$T/empty" && exec "$GL" stdin --no-banner --redact --exit-code 3 --log-level error \
  --gitleaks-ignore-path "$T/empty") <"$T/canary" >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 3 ] || cannot_prove "the canary was not detected, so the rules did not load"

# The git path's own known answer: a scratch commit holding the canary must be reported, with its
# commit id, under the same settings. A git setting this script does not override, that still
# changes what gitleaks reads, fails here instead of hiding a term.
git_known_answer() {
  local rc=0 sha=""
  (
    for v in $repo_vars; do unset "$v"; done
    kat="$T/known-answer"
    git init -q --template= --object-format=sha1 "$kat" &&
      blob="$(git -C "$kat" hash-object -w --no-filters --stdin <"$T/canary")" &&
      tree="$(printf '100644 blob %s\tknown-answer.txt\n' "$blob" | git -C "$kat" mktree)" &&
      sha="$(GIT_AUTHOR_NAME=firewall GIT_AUTHOR_EMAIL=known-answer@example.invalid \
        GIT_COMMITTER_NAME=firewall GIT_COMMITTER_EMAIL=known-answer@example.invalid \
        git -C "$kat" commit-tree --no-gpg-sign -m "known answer" "$tree")" &&
      git -C "$kat" update-ref refs/heads/known-answer "$sha" &&
      printf '%s' "$sha" >"$T/known-answer.sha" || exit 9
    cd "$kat"
    exec "$GL" git --no-banner --redact --exit-code 3 --ignore-gitleaks-allow --log-level error \
      --gitleaks-ignore-path "$T/empty" --report-format json --report-path "$T/known-answer.json" \
      --log-opts="$LOG_OPTS --all" .
  ) >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq 3 ] && sha="$(cat "$T/known-answer.sha")" &&
    [ "$(jq -r '.[0].Commit // empty' "$T/known-answer.json" 2>/dev/null)" = "$sha" ] ||
    cannot_prove "the git known answer failed: a commit holding the canary was not reported, so this machine's git output does not reach the scan intact"
}

# --- Surfaces -----------------------------------------------------------------------------------

case "$mode" in
  --staged)
    reviewed_ignore ":0:.gitleaksignore"
    extract_staged
    scan_paths "$T/paths"
    scan "staged files" "$T/staged" "" dir .
    binary_surfaces "$T/staged" "staged files"
    while read -r role email; do
      allowed "$email" || finding identity "the $role is not on the allowlist"
    done <"$T/staged-identities"
    ;;

  --range)
    base="$(git rev-parse --verify --quiet "${2:-}^{commit}")" || cannot_prove "unknown commit range"
    head="$(git rev-parse --verify --quiet "${3:-}")" || cannot_prove "unknown commit range"
    head_commit="$(git rev-parse --verify --quiet "$head^{commit}")" || cannot_prove "unknown commit range"
    ref="${4:-}"
    reviewed_ignore "$head_commit:.gitleaksignore"
    worktree_ignore_matches
    git log -z --format= --name-only --diff-merges=first-parent "$base..$head_commit" >"$T/paths.z" ||
      cannot_prove "cannot list the paths in the range"
    nul_lines <"$T/paths.z" | sort -u >"$T/paths"
    scan_paths "$T/paths"
    if [ -n "$ref" ]; then
      printf '%s\n' "$ref" >"$T/ref"
      scan_text "the pushed ref name" "$T/ref"
    fi
    git_known_answer
    scan "commits ${base:0:12}..${head_commit:0:12}" "$repo" "" git --log-opts="$LOG_OPTS $base..$head_commit" "$repo"
    range_wasm "commits ${base:0:12}..${head_commit:0:12}" "$base..$head_commit"
    scan_messages "$base..$head_commit"
    check_identities "$base..$head_commit"
    scan_tag "$head"
    ;;

  --history)
    reviewed_ignore "HEAD:.gitleaksignore"
    worktree_ignore_matches
    git log -z --all --format= --name-only --diff-merges=first-parent >"$T/paths.z" ||
      cannot_prove "cannot list the paths in the history"
    nul_lines <"$T/paths.z" | sort -u >"$T/paths"
    scan_paths "$T/paths"
    git for-each-ref --format='%(refname)' >"$T/refs" || cannot_prove "cannot list the refs"
    scan_text "ref names" "$T/refs"
    git_known_answer
    scan "history" "$repo" "" git --log-opts="$LOG_OPTS --all" "$repo"
    range_wasm "history" --all
    scan_messages --all
    check_identities --all
    git for-each-ref --format='%(objectname)' refs/tags >"$T/tags" || cannot_prove "cannot list the tags"
    while IFS= read -r tag; do scan_tag "$tag"; done <"$T/tags"
    ;;

  --pr-text)
    [ -n "${PR_TITLE:-}" ] && [ -n "${PR_BRANCH:-}" ] || cannot_prove "the pull request's text was not passed in"
    reviewed_ignore "HEAD:.gitleaksignore"
    scan_pr_text
    ;;

  ci)
    range=""
    if [ "${FW_EVENT:-}" != schedule ]; then
      case "${FW_BASE:-}" in "" | *[!0]*) ;; *) FW_BASE="" ;; esac # all zeros: no previous commit
      [ -n "${FW_BASE:-}" ] && [ -n "${FW_HEAD:-}" ] || cannot_prove "unknown commit range"
      for end in FW_BASE FW_HEAD; do
        given="${!end}"
        sha="$(git rev-parse --verify --quiet "$given^{commit}")" || sha=""
        is_sha "$sha" || cannot_prove "commit range end ${given:0:12} is not in this clone"
        printf -v "$end" '%s' "$sha"
      done
      range="$FW_BASE..$FW_HEAD"
    fi
    if [ "${FW_EVENT:-}" = pull_request ]; then
      [ -n "${PR_TITLE:-}" ] && [ -n "${PR_BRANCH:-}" ] || cannot_prove "the pull request's text was not passed in"
    fi
    IFS=: read -r -a dists <<<"${DIST_DIRS:-apps/web/dist:workers/api/dist}"
    [ "${#dists[@]}" -gt 0 ] || cannot_prove "no built output is named"
    for dist in "${dists[@]}"; do
      [ -d "$dist" ] || cannot_prove "the built output is missing ($dist)"
      [ -n "$(find "$dist" -type f -print | head -n 1)" ] || cannot_prove "the built output is empty ($dist)"
      find "$dist" -print0 >"$T/dist.z" || cannot_prove "a file or directory in the built output is unreadable ($dist)"
      while IFS= read -r -d '' f; do
        [ -r "$f" ] || cannot_prove "a file or directory in the built output is unreadable ($dist)"
      done <"$T/dist.z"
      find "$dist" -type l -print >"$T/links" || cannot_prove "cannot list the built output ($dist)"
      [ ! -s "$T/links" ] ||
        cannot_prove "the built output holds a symbolic link, so the scan cannot prove what would be published ($dist)"
      find "$dist" -name .gitleaksignore -print >"$T/dist-ignore" || cannot_prove "cannot list the built output ($dist)"
      [ ! -s "$T/dist-ignore" ] ||
        cannot_prove "the built output holds a .gitleaksignore: it would suppress the built output's scan, and be served ($dist)"
    done

    reviewed_ignore "HEAD:.gitleaksignore"
    worktree_ignore_matches
    extract_tree HEAD "$T/tree"
    find "$T/tree" -mindepth 2 -name .gitleaksignore -print >"$T/nested-ignore" || cannot_prove "cannot list the tracked tree"
    [ ! -s "$T/nested-ignore" ] ||
      cannot_prove "a .gitleaksignore below the repository root: only the root one is reviewed and read"

    # 3: file names at HEAD, in the range and in the built outputs (a slug is a file name)
    git ls-tree -r -z --name-only --full-tree HEAD >"$T/paths.z" || cannot_prove "cannot list the tracked tree"
    if [ -n "$range" ]; then
      git log -z --format= --name-only --diff-merges=first-parent "$range" >>"$T/paths.z" ||
        cannot_prove "cannot list the paths in the range"
    fi
    for dist in "${dists[@]}"; do
      (cd "$dist" && find . -mindepth 1 -print0) >>"$T/paths.z" || cannot_prove "cannot list the built output ($dist)"
    done
    nul_lines <"$T/paths.z" | sed 's#^\./##' | sort -u >"$T/paths"
    scan_paths "$T/paths"

    # 1: the tracked tree at HEAD, byte for byte; untracked files and node_modules are excluded by
    # construction
    scan "the tracked tree" "$T/tree" "" dir .

    # 2, 3 and 5: the commit range, the WebAssembly it adds, and each commit's message
    if [ -n "$range" ]; then
      git_known_answer
      scan "commits in ${FW_BASE:0:12}..${FW_HEAD:0:12}" "$repo" "" git --log-opts="$LOG_OPTS $range" "$repo"
      range_wasm "commits in ${FW_BASE:0:12}..${FW_HEAD:0:12}" "$range"
      scan_messages "$range"
    fi

    # 3: the pull request's title, body and branch name
    if [ -n "${PR_TITLE:-}${PR_BODY:-}${PR_BRANCH:-}" ]; then scan_pr_text; fi

    # 4: the built outputs, the bytes that will be published
    for dist in "${dists[@]}"; do
      scan "the built output ($dist)" "$repo" "" dir "$dist"
    done

    # 5: PDFs and WebAssembly, read, and formats no rule can read, refused, in the tree and in the
    # built outputs
    binary_surfaces "$T/tree" "the tracked tree"
    for dist in "${dists[@]}"; do
      binary_surfaces "$dist" "the built output ($dist)"
    done

    # 6: commit identities in the range
    if [ -n "$range" ]; then check_identities "$range"; fi
    ;;

  *) cannot_prove "unknown mode (use --staged, --range BASE HEAD [REF], --history or --pr-text)" ;;
esac

final=1
if [ "$findings" -gt 0 ]; then
  echo "content-firewall: $findings finding(s). Rule ids are opaque: the rules file says what each one guards." >&2
  exit 1
fi
echo "content-firewall: clean"
exit 0
