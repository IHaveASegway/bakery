import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { contractsDir, generate, write } from '../scripts/contracts-lib.mjs';

// "Contracts in sync" (docs/delivery.md): the committed TypeScript must be exactly what the
// schemas generate today. A stale copy fails here; `pnpm --filter web contracts` fixes it.

const temp = mkdtempSync(join(tmpdir(), 'bakery-contracts-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

test('src/contracts/ matches a fresh generation, byte for byte', async () => {
  const names: string[] = await write(temp);
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) {
    const fresh = readFileSync(join(temp, name), 'utf8');
    const committed = readFileSync(join(contractsDir, name), 'utf8');
    expect(committed, `${name} is stale: run pnpm --filter web contracts`).toBe(fresh);
  }
});

test('every committed generated file has a schema; only the hand-written files are extra', async () => {
  const generated = new Set((await generate()).map((f: { file: string }) => f.file));
  const extra = readdirSync(contractsDir).filter((f) => !generated.has(f));
  expect(extra.sort()).toEqual(['index.ts', 'pending.ts'].filter((f) => extra.includes(f)));
});
