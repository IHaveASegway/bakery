// Writes the storefront's static menu (src/data/menu.json) from the seed, so /menu/ shows exactly
// what a new sandbox's Catalog is seeded with (docs/domain.md, "The seed"). It runs the seed CLI,
// `cargo run -q -p bakery-seed -- 42 2026-11-07`, keeps the menu's three sections and nests them as
// the API's `GET /v1/sandboxes/{id}/menu` does: categories, each with its items, each with its
// variants. CI's `verify` job runs it again and compares with the committed file; test/menu.test.ts
// does the same where cargo is installed.
//
//   node scripts/menu.mjs [output file]
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as prettier from 'prettier';

/** The seed the demo's static menu is generated from: the same pair CI's determinism check uses. */
export const SEED = '42';
export const BORN = '2026-11-07';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const defaultOutput = fileURLToPath(new URL('../src/data/menu.json', import.meta.url));

/** The seed's JSON text, from the seed CLI. Throws with cargo's own words when it fails. */
export function runSeed() {
  const run = spawnSync('cargo', ['run', '-q', '-p', 'bakery-seed', '--', SEED, BORN], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`the seed CLI failed (${run.status}):\n${run.stderr}`);
  return run.stdout;
}

/** The menu's shape from the seed's three sections. Field names are the seed's own. */
export function buildMenu(seed) {
  const variantsOf = (slug) =>
    seed.variants
      .filter((v) => v.item === slug)
      .map(({ slug, label, price_cents, lead_minutes }) => ({
        slug,
        label,
        price_cents,
        lead_minutes,
      }));
  return {
    source: { seed: Number(SEED), born: BORN },
    categories: seed.categories.map((category) => ({
      slug: category.slug,
      name: category.name,
      items: seed.items
        .filter((item) => item.category === category.slug)
        .map((item) => ({
          slug: item.slug,
          name: item.name,
          allergens: item.allergens,
          daily_cap: item.daily_cap,
          days_baked: item.days_baked,
          season: item.season,
          bulk_lead: item.bulk_lead,
          pickup_only: item.pickup_only,
          status: 'available',
          variants: variantsOf(item.slug),
        })),
    })),
  };
}

/** The file's text, formatted with the repository's Prettier settings so `format:check` passes. */
export async function menuText(seedJson = runSeed()) {
  const config = (await prettier.resolveConfig(defaultOutput)) ?? {};
  return prettier.format(JSON.stringify(buildMenu(JSON.parse(seedJson))), {
    ...config,
    parser: 'json',
    plugins: [],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2] ?? defaultOutput;
  const text = await menuText();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log(`wrote ${out}`);
}
