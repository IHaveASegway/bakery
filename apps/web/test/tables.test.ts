// The tables that stack on a phone (F9, 2026-11-10): global.css turns a table's rows into blocks
// below 40rem, and each stacked cell names its column from its `data-label`, as the tools page
// labels its lines. A table of a few short columns of figures keeps its grid with `table-fits`; the
// API reference's two repeated shapes are labelled in global.css itself. This reads the source of
// every table, so a new one fails here until its cells are labelled or it says it fits.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const src = fileURLToPath(new URL('../src/', import.meta.url));
const files = (readdirSync(src, { recursive: true }) as string[])
  .filter((f) => /\.(tsx|astro)$/.test(f))
  .map((f) => join(src, f))
  .filter((f) => readFileSync(f, 'utf8').includes('<table'));

/** Each table in a file, from its opening tag to its close. */
const tables = (text: string) =>
  [...text.matchAll(/<table[\s\S]*?<\/table>/g)].map((m) => m[0]).filter(Boolean);

const LABELLED_IN_CSS = /class(Name)?="[^"]*\b(table-fits|schema-table|params-table)\b/;

describe('tables on a phone', () => {
  test('there are tables to check', () => {
    expect(files.length).toBeGreaterThan(8);
  });

  test.each(files.map((f) => [f.slice(src.length), f]))(
    '%s: every body cell names its column, or the table keeps its grid',
    (_, file) => {
      for (const table of tables(readFileSync(file, 'utf8'))) {
        const head = table.slice(0, table.indexOf('>') + 1);
        if (LABELLED_IN_CSS.test(head)) continue;
        const body = table.slice(table.indexOf('<tbody'));
        const cells = [...body.matchAll(/<(td|th)\b[^>]*>/g)].map((m) => m[0]);
        expect(cells.length, file).toBeGreaterThan(0);
        for (const cell of cells) {
          // A row header with no column name of its own (the decision table's tool) is the block's
          // title; every other cell carries its column's name.
          if (/scope="row"/.test(cell) && !/data-label/.test(cell)) continue;
          // A cell that spans the row is a row of its own under the one above it (the inbox's open
          // message, 2026-11-10), with no column to name.
          if (/colSpan=/.test(cell)) continue;
          expect(cell, file).toMatch(/data-label=/);
        }
      }
    },
  );

  test('no stacking table prints a dash for an empty value', () => {
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\?\?\s*'–'|:\s*'–'\}/);
    }
  });
});
