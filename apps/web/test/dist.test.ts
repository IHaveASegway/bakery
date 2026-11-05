import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { inlineHashes } from '../scripts/inline-hashes.mjs';
import { readLock, verifyFolder } from '../../../scripts/fetch-solver.mjs';

// The built pages against the policy: public pages carry no script at all (ADR 0008), and every
// inline script or style on the two island pages is covered by a hash in the page's own rule.
// Run after `pnpm build`.

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const page = (path: string) => readFileSync(`${dist}${path}`, 'utf8');
const rule = (path: string) => {
  const lines = page('_headers').split('\n');
  const start = lines.indexOf(path);
  return lines
    .slice(start + 1)
    .filter(
      (line, i, all) => line.startsWith(' ') && all.slice(0, i).every((l) => l.startsWith(' ')),
    )
    .join('\n');
};

describe('dist', () => {
  expect(existsSync(dist), 'run pnpm build first').toBe(true);

  test.each(['index.html', '404.html', 'privacy/index.html'])(
    '%s carries no React or script',
    (file) => {
      const html = page(file);
      expect(html).not.toContain('<script');
      expect(html).not.toContain('astro-island');
      expect(html).not.toContain('<style');
    },
  );

  test.each([
    ['signin/index.html', '/signin/*'],
    ['app/index.html', '/app/*'],
    ['app/dispatch/index.html', '/app/dispatch/*'],
    ['menu/index.html', '/menu/*'],
    ['inbox/index.html', '/inbox/*'],
    ['checkout/index.html', '/checkout/*'],
    ['catering/index.html', '/catering/*'],
  ])('%s: every inline script and style has its hash in %s', (file, path) => {
    const html = page(file);
    const hashes = inlineHashes(html) as { script: string[]; style: string[] };
    expect(hashes.script.length).toBeGreaterThan(0);
    const policy = rule(path);
    for (const hash of [...hashes.script, ...hashes.style]) expect(policy).toContain(hash);
  });

  test('no page has a style attribute or an inline event handler, which hashes would not cover', () => {
    const files = readdirSync(dist, { recursive: true }).filter(
      (f): f is string => typeof f === 'string' && f.endsWith('.html'),
    );
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const file of files) {
      const html = page(file);
      expect(html, file).not.toMatch(/\sstyle="/);
      expect(html, file).not.toMatch(/\son[a-z]+="/);
    }
  });

  test('the dispatch page loads no script of another origin and names its worker nowhere in the HTML', () => {
    const html = page('app/dispatch/index.html');
    expect(html).toContain('astro-island');
    expect(html).not.toMatch(/<script[^>]+src="https?:/);
    // The worker is started by the island, from the bundle; the HTML only carries the attribution.
    expect(html).toContain('© OpenStreetMap contributors');
    expect(html).toContain('openrouteservice');
    expect(html).toContain('Free-flow times: no traffic');
  });

  test('the console links to the dispatch screen', () => {
    const files = readdirSync(`${dist}_astro`).filter((f) => f.startsWith('Console.'));
    expect(files.length).toBeGreaterThan(0);
    expect(files.map((f) => page(`_astro/${f}`)).join('')).toContain('/app/dispatch/');
  });

  // The solver is fetched by the build's prebuild step and copied from public/ into dist/. Without
  // it (a build that skipped the step) the checks say so and stop; the build itself would have failed.
  const lock = readLock();
  const solverDist = `${dist}app/dispatch/solver/${lock.folder}`;
  const built = existsSync(solverDist);
  if (!built) console.warn(`dist: no ${solverDist}; skipping the solver checks`);

  test.skipIf(!built)('the built solver folder is the locked one, byte for byte', () => {
    expect(verifyFolder(solverDist, lock)).toEqual([]);
    expect(statSync(`${solverDist}/vroom.wasm`).size).toBe(919_927);
  });

  test.skipIf(!built)(
    'the route data and attribution ship beside it, and the solver is not bundled',
    () => {
      for (const name of ['route-data.json', 'isochrones.json', 'ATTRIBUTION.txt']) {
        expect(existsSync(`${dist}app/dispatch/data/${name}`), name).toBe(true);
      }
      // 'wasm-unsafe-eval' and the wasm are only where the policy file says; no bundle holds them.
      for (const file of readdirSync(`${dist}_astro`)) {
        expect(file).not.toMatch(/\.wasm$/);
        expect(page(`_astro/${file}`)).not.toContain('wasm-unsafe-eval');
      }
    },
  );

  test('Turnstile is named by the sign-in script and nowhere else in the built output', () => {
    for (const file of readdirSync(dist, { recursive: true })) {
      if (typeof file !== 'string' || !/\.(html|js)$/.test(file)) continue;
      if (page(file).includes('challenges.cloudflare.com')) {
        expect(file).toMatch(/Turnstile\./);
      }
    }
  });
});
