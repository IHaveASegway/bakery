#!/usr/bin/env node
// Lists every Durable Object a `wrangler dev --persist-to <dir>` run left on disk, and fails if
// any sandbox-scoped object still holds data. This is the local half of the morning object
// check (docs/security.md, "The wipe", step 6), which PR 11 turns into the `bakery-objects`
// job against the real namespaces; like that job it skips `Control` and `Account`, which
// outlive every sandbox on purpose.
//
// Run:   node scripts/list-objects.mjs <persist-dir>      (Node 22 or later, no dependencies)
//
// Wrangler 4.157.0 keeps each object in <persist-dir>/v3/do/<worker>-<Class>/<64 hex id>.sqlite,
// beside one metadata.sqlite per class (observed on 2026-11-05). Each file is opened read-only.
// An object holds data when a table of its own has a row: SQLite's tables (sqlite_*), the
// runtime's (_cf_*) and Miniflare's (__miniflare_*) are not its data. An object that ran
// deleteAll() has no tables left at all.
//
// Prints one JSON line per object: { class, id, name, has_data, rows }. `name` is the name the
// Worker addressed it by, such as sandbox:<ULID>, when Miniflare recorded one. Exits 0 when no
// sandbox-scoped object holds data, 1 when one does, 2 on a usage or read error.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

// node:sqlite prints an ExperimentalWarning on Node 22; this script's output is JSON lines.
process.removeAllListeners('warning');
const { DatabaseSync } = await import('node:sqlite');

const KEPT_CLASSES = new Set(['Control', 'Account']);
const NOT_DATA = /^(sqlite_|_cf_|__miniflare_)/;

const dir = process.argv[2];
if (!dir || process.argv.length > 3) {
  console.error('usage: node scripts/list-objects.mjs <persist-dir>');
  process.exit(2);
}
const root = path.join(dir, 'v3', 'do');
if (!existsSync(root)) {
  console.error(`no Durable Object state under ${root}`);
  process.exit(2);
}

const quote = (name) => `"${name.replaceAll('"', '""')}"`;

function inspect(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((t) => t.name);
    let rows = 0;
    for (const table of tables.filter((t) => !NOT_DATA.test(t))) {
      rows += Number(db.prepare(`SELECT count(*) AS n FROM ${quote(table)}`).get().n);
    }
    let name = null;
    if (tables.includes('__miniflare_do_name')) {
      name = db.prepare('SELECT name FROM __miniflare_do_name LIMIT 1').get()?.name ?? null;
    }
    return { rows, name };
  } finally {
    db.close();
  }
}

let leftovers = 0;
for (const classDir of readdirSync(root, { withFileTypes: true })) {
  if (!classDir.isDirectory()) continue;
  // `<worker>-<Class>`: a class name has no hyphen, a worker name may.
  const cls = classDir.name.slice(classDir.name.lastIndexOf('-') + 1);
  const files = readdirSync(path.join(root, classDir.name))
    .filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')
    .sort();
  for (const file of files) {
    let found;
    try {
      found = inspect(path.join(root, classDir.name, file));
    } catch (e) {
      console.error(`cannot read ${file}: ${e.message}`);
      process.exit(2);
    }
    const hasData = found.rows > 0;
    console.log(
      JSON.stringify({
        class: cls,
        id: file.replace(/\.sqlite$/, ''),
        name: found.name,
        has_data: hasData,
        rows: found.rows,
      }),
    );
    if (hasData && !KEPT_CLASSES.has(cls)) leftovers += 1;
  }
}

if (leftovers > 0) {
  console.error(`${leftovers} sandbox-scoped object(s) still hold data`);
  process.exit(1);
}
