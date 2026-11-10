#!/usr/bin/env bash
# Self-test for scripts/list-objects.mjs. No Worker and no wrangler: a persist directory of one
# object that holds a row, listed while another connection holds that object's write lock, as an
# object does while it commits (a sandbox seeding, a delivery, an alarm). ci.yml's `verify` job
# runs it, and so can anyone:
#
#   scripts/list-objects.test.sh
#
# The listing must wait for the lock and answer exit 1 (the object holds data), not fail with
# "database is locked" and exit 2. Before the busy timeout it did, which failed smoke-auth's and
# smoke-orders' listings on 2026-11-10.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/list-objects.mjs"
W="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/listtest.XXXXXX")"
holder=""
trap '[ -n "$holder" ] && kill "$holder" 2>/dev/null; rm -rf "$W"' EXIT

file="$W/v3/do/bakery-api-Kitchen/board.sqlite"
mkdir -p "$(dirname "$file")"

# The writer: makes the object with one row, then holds the write lock for 2 s with a second row
# uncommitted. It writes "held" once it has the lock, so the listing starts while the lock is held.
node --no-warnings - "$file" > "$W/holder.out" <<'NODE' &
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2]);
db.exec('PRAGMA journal_mode = DELETE');
db.exec('CREATE TABLE board (id INTEGER PRIMARY KEY, body TEXT)');
db.exec("INSERT INTO board (body) VALUES ('{}')");
db.exec('BEGIN EXCLUSIVE');
db.exec("INSERT INTO board (body) VALUES ('{}')");
console.log('held');
setTimeout(() => {
  db.exec('COMMIT');
  db.close();
}, 2000);
NODE
holder=$!

for _ in $(seq 1 100); do
  grep -q held "$W/holder.out" 2>/dev/null && break
  sleep 0.05
done
grep -q held "$W/holder.out" || { echo "FAIL: the writer never took the lock"; exit 1; }

set +e
node "$script" "$W" > "$W/out" 2> "$W/err"
code=$?
set -e
wait "$holder"
holder=""

fail=0
if [ "$code" = 1 ]; then
  echo "ok: a listing taken while an object holds its write lock waits and exits 1"
else
  echo "FAIL: the listing exited $code, not 1: $(cat "$W/err")"
  fail=1
fi
if grep -q '"class":"Kitchen"' "$W/out" && grep -q '"rows":2' "$W/out"; then
  echo "ok: it reads the object after the commit (Kitchen, 2 rows)"
else
  echo "FAIL: the listing was: $(cat "$W/out")"
  fail=1
fi
exit "$fail"
