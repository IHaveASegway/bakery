#!/usr/bin/env bash
# Copied from the site (IHaveASegway/website) at commit a0f7ac1fa221867737730127f6e3a8faf4c02336, with two changes: repo names this
# repository, and the error points to operations.md step 9, where this repository's access setup
# describes the rules file. The rules file is the same one, at the same path, for both.
# Copies the private rules file into both GitHub secrets named FIREWALL_RULES: the Actions one,
# and the Dependabot one that Dependabot's runs read (security.md, "Secrets inventory").
# One source, two copies, one command. The rules reach gh on standard input only: never an
# argument, an environment variable, the terminal or shell history.
#
# Run it after every rule change, then a full-history scan:  scripts/firewall/check.sh --history
set -euo pipefail
umask 077

repo="IHaveASegway/bakery"
rules="$HOME/.config/ihaveasegway/firewall.toml"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail() {
  echo "sync-secrets: $1" >&2
  exit 2
}

command -v gh >/dev/null || fail "the GitHub CLI (gh) is not installed"
[ -r "$rules" ] || fail "no rules file at $rules (operations.md, access setup, step 9)"
# GNU stat first: there -f means "file system status" and would print something else entirely.
# BSD stat rejects -c without printing anything, and then answers -f.
case "$(stat -c '%a' "$rules" 2>/dev/null || stat -f '%Lp' "$rules")" in
  600 | 400) ;;
  *) fail "$rules must be readable by its owner only: chmod 600 it first" ;;
esac

# The same checks check.sh makes on every run, made here so a bad copy never reaches the secrets.
floor="$(sed -n 's/^RULE_FLOOR=\([0-9][0-9]*\).*/\1/p' "$here/check.sh")"
[ -n "$floor" ] || fail "cannot read RULE_FLOOR from check.sh"
count="$(grep -c '^[[:space:]]*\[\[rules\]\]' "$rules" || true)"
[ "$count" -ge "$floor" ] || fail "the rules hold $count rules, below check.sh's floor of $floor"
last_id="$({ grep -E '^[[:space:]]*id[[:space:]]*=' "$rules" || true; } | tail -n 1 |
  sed -E "s/^[[:space:]]*id[[:space:]]*=[[:space:]]*[\"']([^\"']*)[\"'].*/\1/")"
[ "$last_id" = fw-canary ] ||
  fail "the last rule is not fw-canary: move the canary rule to the end, so a truncated copy always loses it"

for app in actions dependabot; do
  gh secret set FIREWALL_RULES --repo "$repo" --app "$app" <"$rules" >/dev/null
  echo "sync-secrets: FIREWALL_RULES updated for $app"
done
echo "sync-secrets: next, scan the full history with the new rules: scripts/firewall/check.sh --history"
