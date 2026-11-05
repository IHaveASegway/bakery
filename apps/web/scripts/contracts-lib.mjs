// Turns the contracts crate's JSON Schemas into TypeScript, one file per schema. The schemas are
// written by `cargo test` in crates/contracts and are the source; the .ts files are copies that
// nobody edits. test/contracts.test.ts regenerates into a temp directory and compares byte for
// byte, so a schema changed without `pnpm --filter web contracts` fails CI (docs/delivery.md,
// "Contracts in sync").
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';

export const schemasDir = fileURLToPath(
  new URL('../../../crates/contracts/schemas/', import.meta.url),
);
export const contractsDir = fileURLToPath(new URL('../src/contracts/', import.meta.url));

const SUFFIX = '.schema.json';

/** Every schema's name (`Problem`) with the TypeScript it generates. */
export async function generate() {
  const names = readdirSync(schemasDir)
    .filter((file) => file.endsWith(SUFFIX))
    .sort();
  const out = [];
  for (const file of names) {
    const name = file.slice(0, -SUFFIX.length);
    const schema = JSON.parse(readFileSync(join(schemasDir, file), 'utf8'));
    const body = await compile(schema, name, {
      bannerComment: [
        '/**',
        ` * Generated from crates/contracts/schemas/${file} by apps/web/scripts/contracts.mjs.`,
        ' * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then',
        ' * `pnpm --filter web contracts`.',
        ' */',
      ].join('\n'),
      additionalProperties: false,
      // The repository's Prettier settings (.prettierrc.json), so `pnpm format:check` passes.
      style: { singleQuote: true, printWidth: 100 },
    });
    out.push({ file: `${name}.ts`, text: body });
  }
  return out;
}

/** Writes the generated files into `dir`, creating it. */
export async function write(dir) {
  mkdirSync(dir, { recursive: true });
  const files = await generate();
  for (const { file, text } of files) writeFileSync(join(dir, file), text);
  return files.map(({ file }) => file);
}
