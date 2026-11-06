#!/bin/sh
# Build the pinned openrouteservice jar without Docker: Java 21 and Maven, nothing else.
# Output: work/ors.jar. Run from anywhere. Idempotent: it leaves an existing jar alone.
set -eu
TAG="${ORS_TAG:-v9.10.0}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$HERE/work"
MVN="${MVN:-mvn}"
if [ -f "$WORK/ors.jar" ]; then
  echo "work/ors.jar exists; delete it to rebuild"
  exit 0
fi
mkdir -p "$WORK"
if [ ! -d "$WORK/ors-src/.git" ]; then
  git clone --depth 1 --branch "$TAG" https://github.com/GIScience/openrouteservice "$WORK/ors-src"
fi
cd "$WORK/ors-src"
echo "building $(git describe --tags --always) at $(git rev-parse HEAD)"
"$MVN" -B -q -pl ors-api -am package -DskipTests -Dmaven.javadoc.skip=true
cp ors-api/target/ors.jar "$WORK/ors.jar"
git rev-parse HEAD > "$WORK/ors-commit.txt"
cd "$WORK"
# The source tree holds JavaScript that the repository's lint would pick up; keep only the jar.
[ "${KEEP_SRC:-0}" = 1 ] || rm -rf "$WORK/ors-src"
echo "wrote work/ors.jar from $(cat "$WORK/ors-commit.txt")"
