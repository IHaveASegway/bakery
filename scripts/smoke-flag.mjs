// Used by scripts/smoke-breaker.sh only: sets the local `Control`'s flag, as an operator does in
// Data Studio (docs/operations.md, "Kill switch L0 to L4"), with `changed_at` set to now. Run
// while `wrangler dev` is stopped, on the directory given to `--persist-to`.
//
//   node scripts/smoke-flag.mjs <persist-dir> <live|read-only|off> [minutes-ago]
//
// `minutes-ago` sets `changed_at` that many minutes before now, so a test can step outside the
// two minutes after a change in which a dead letter is still marked (crates/app/src/dead_letters.rs).
//
// It finds Control's database as the one SQLite file holding both `flags` and `sandboxes`,
// updates its one flag row and prints how many rows it changed. Exit 1 when no such file, or
// more than one, is found.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [root, mode, ago = '0'] = process.argv.slice(2);
if (!root || !['live', 'read-only', 'off'].includes(mode) || !/^[0-9]+$/.test(ago)) {
  console.error(
    'usage: node scripts/smoke-flag.mjs <persist-dir> <live|read-only|off> [minutes-ago]',
  );
  process.exit(2);
}

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith('.sqlite')) files.push(path);
  }
};
walk(root);

const controls = files.filter((file) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const names = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('flags', 'sandboxes')",
      )
      .all();
    return names.length === 2;
  } finally {
    db.close();
  }
});
if (controls.length !== 1) {
  console.error(`expected one Control database under ${root}, found ${controls.length}`);
  process.exit(1);
}

const db = new DatabaseSync(controls[0]);
const { changes } = db
  .prepare("UPDATE flags SET mode = ?, changed_at = ? WHERE demo = 'bakery'")
  .run(mode, new Date(Date.now() - Number(ago) * 60_000).toISOString());
db.close();
console.log(String(changes));
