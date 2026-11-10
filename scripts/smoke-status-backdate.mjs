// Used by scripts/smoke-status.sh only: makes every unwiped sandbox in the local `Control` two
// days old, so the next sweep counts it past its wipe without waiting a day. Run while
// `wrangler dev` is stopped, on the directory given to `--persist-to`.
//
//   node scripts/smoke-status-backdate.mjs <persist-dir>
//
// It finds Control's database as the one SQLite file holding both `sandboxes` and `past_wipe`,
// sets `created_at` back two days on its rows with no `wiped_at`, and prints how many it changed.
// Exit 1 when no such file, or more than one, is found.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = process.argv[2];
if (!root) {
  console.error('usage: node scripts/smoke-status-backdate.mjs <persist-dir>');
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
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sandboxes', 'past_wipe')",
      )
      .all()
      .map((r) => r.name);
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
const born = new Date(Date.now() - 2 * 86_400_000).toISOString();
const { changes } = db
  .prepare('UPDATE sandboxes SET created_at = ? WHERE wiped_at IS NULL')
  .run(born);
db.close();
console.log(String(changes));
