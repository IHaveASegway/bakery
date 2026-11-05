#!/usr/bin/env bash
# Puts a sha256-verified gitleaks binary into the directory given as $1 and prints its path.
#
# The release archive is downloaded once into a cache, then checked against gitleaks.version on
# every run, so a swapped, truncated or tampered file never executes. The checksum is the trust
# anchor, not the URL or the cache: either can be moved (GITLEAKS_DOWNLOAD_BASE,
# GITLEAKS_CACHE_DIR) without weakening the check.
#
# Exit 0: the path is printed. Exit 2: no verified binary (an unpinned platform, a failed
# download, a checksum mismatch), which check.sh reports as "cannot prove clean".
set -euo pipefail

dest="${1:?usage: install-gitleaks.sh <directory>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pins="$here/gitleaks.version"

fail() {
  echo "install-gitleaks: $1" >&2
  exit 2
}
pin() { sed -n "s/^$1=//p" "$pins"; } # read as data: the file is never sourced
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

[ -r "$pins" ] || fail "cannot read $pins"
version="$(pin version)"
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) platform=linux_x64 ;;
  Darwin/arm64) platform=darwin_arm64 ;;
  *) fail "no pinned build for $(uname -s)/$(uname -m): add its sha256 to gitleaks.version" ;;
esac
want="$(pin "sha256_$platform")"
[ -n "$version" ] && [ -n "$want" ] || fail "gitleaks.version lacks the version or the $platform checksum"

archive="gitleaks_${version}_${platform}.tar.gz"
base="${GITLEAKS_DOWNLOAD_BASE:-https://github.com/gitleaks/gitleaks/releases/download}"
cache="${GITLEAKS_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/ihaveasegway/gitleaks}"

mkdir -p "$cache" 2>/dev/null || fail "cannot create the cache directory $cache"
if [ ! -f "$cache/$archive" ] || [ "$(sha256 "$cache/$archive")" != "$want" ]; then
  tmp="$(mktemp "$cache/.download.XXXXXX" 2>/dev/null)" || fail "cannot write to $cache"
  if ! curl -fsSL --proto '=https,file' --retry 3 -o "$tmp" "$base/v$version/$archive"; then
    rm -f "$tmp"
    fail "could not download $archive"
  fi
  mv -f "$tmp" "$cache/$archive"
fi
[ "$(sha256 "$cache/$archive")" = "$want" ] || fail "sha256 mismatch for $archive: refusing to run it"

mkdir -p "$dest"
tar -xzf "$cache/$archive" -C "$dest" gitleaks 2>/dev/null || fail "cannot extract gitleaks from $archive"
chmod 0755 "$dest/gitleaks"
echo "$dest/gitleaks"
