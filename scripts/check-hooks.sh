#!/bin/sh
# Runs after every pnpm install (postinstall) and warns, loudly, when this clone's git hooks are
# off. The hooks are the content firewall's local half, and once the repository is public they are
# the only prevention (security.md, "Local parity"). core.hooksPath is set per clone, so a fresh
# clone, a cloud agent's checkout included, starts without them.
#
# The hooks are on when core.hooksPath is .githooks, or when it names a directory whose hooks are
# this checkout's own, byte for byte and each one runnable, with no other file beside them: a
# worktree shares its clone's configuration, so there it is that clone's .githooks by its absolute
# path. Unset, another directory, or hooks that differ from these, and it warns: a hook that is not
# this checkout's may not run this checkout's checks, and git skips one it cannot run. Until
# 2026-10-31 only .githooks passed, and every worktree warned, a false alarm that teaches people to
# skip the real one.
#
# It only reads: it never changes git configuration and never fails the install. CI needs no hooks.
[ -z "${CI:-}" ] || exit 0
command -v git >/dev/null 2>&1 || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

top="$(git rev-parse --show-toplevel)"
path="$(git config --type=path --get core.hooksPath 2>/dev/null || true)"

# Whether the directory $1 holds exactly this checkout's hooks. git reads a relative hooksPath
# from the top of the working tree, so this does too.
same_hooks() {
  case "$1" in
    /*) dir="$1" ;;
    *) dir="$top/$1" ;;
  esac
  [ -d "$dir" ] || return 1
  seen=0
  for ours in "$top/.githooks"/*; do
    [ -f "$ours" ] || continue
    theirs="$dir/${ours##*/}"
    [ -f "$theirs" ] && [ -x "$theirs" ] && cmp -s "$ours" "$theirs" || return 1
    seen=$((seen + 1))
  done
  [ "$seen" -gt 0 ] || return 1
  for theirs in "$dir"/*; do
    [ -e "$theirs" ] || continue
    [ -f "$top/.githooks/${theirs##*/}" ] || return 1
  done
}

if [ "$path" != .githooks ] && { [ -z "$path" ] || ! same_hooks "$path"; }; then
  cat >&2 <<'EOF'

  !! The content firewall's git hooks are OFF in this clone: nothing is scanned before a commit or
  !! a push. Turn them on before the first commit:
  !!
  !!     git config core.hooksPath .githooks
  !!
  !! (README.md, Setup, step 3.) AI agents: stop and ask Joseph; never commit without the hooks.

EOF
fi
exit 0
