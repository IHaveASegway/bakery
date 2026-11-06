import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { SCREENS } from '../src/lib/tour';
import { PRINCIPLE_TABLE, PRINCIPLES } from '../src/lib/how-its-built';
import { RULE_PATHS } from '../src/policy';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { inlineHashes } from '../scripts/inline-hashes.mjs';
import { readLock, verifyFolder } from '../../../scripts/fetch-solver.mjs';

// The built pages against the policy: the 404 carries no script at all (ADR 0008), and every
// inline script or style on a page with an island (since PR 10 every page but the 404 has one, the
// guided tour) is covered by a hash in the page's own rule.
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

  test.each([
    '404.html',
    'about/index.html',
    'how-its-built/index.html',
    'how-its-built/single-writer/index.html',
  ])('%s carries no React or script', (file) => {
    const html = page(file);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('astro-island');
    expect(html).not.toContain('<style');
  });

  test.each([
    ['signin/index.html', '/signin/*'],
    ['app/index.html', '/app/*'],
    ['app/dispatch/index.html', '/app/dispatch/*'],
    ['index.html', '/'],
    ['privacy/index.html', '/privacy/*'],
    ['docs/api/index.html', '/docs/api/*'],
    ['menu/index.html', '/menu/*'],
    ['inbox/index.html', '/inbox/*'],
    ['status/index.html', '/status/*'],
    ['checkout/index.html', '/checkout/*'],
    ['catering/index.html', '/catering/*'],
  ])('%s: every inline script and style has its hash in %s', (file, path) => {
    const html = page(file);
    const hashes = inlineHashes(html) as { script: string[]; style: string[] };
    expect(hashes.script.length).toBeGreaterThan(0);
    const policy = rule(path);
    for (const hash of [...hashes.script, ...hashes.style]) expect(policy).toContain(hash);
  });

  test.each([
    ['index.html', 'home'],
    ['signin/index.html', 'signin'],
    ['menu/index.html', 'menu'],
    ['checkout/index.html', 'checkout'],
    ['app/index.html', 'console'],
    ['catering/index.html', 'catering'],
    ['inbox/index.html', 'inbox'],
    ['app/dispatch/index.html', 'dispatch'],
    ['docs/api/index.html', 'api'],
    ['privacy/index.html', 'privacy'],
  ])('%s carries the tour island for the %s screen, closed', (file, screen) => {
    expect(SCREENS).toContain(screen);
    const html = page(file);
    expect(html).toContain('Tour.');
    expect(html).toContain(`&quot;${screen}&quot;`);
    expect(html).toContain('class="tour-trigger"');
    expect(html).toContain('aria-expanded="false"');
    // Closed, the island draws no card and no ring, so the server HTML has none either.
    expect(html).not.toContain('class="tour-card"');
    expect(html).not.toContain('data-tour-current');
  });

  // A Cloudflare _headers path: a splat matches anything, including nothing; a path without one
  // matches itself alone.
  const matches = (rulePath: string, path: string) =>
    rulePath.endsWith('*') ? path.startsWith(rulePath.slice(0, -1)) : rulePath === path;

  test.each(['/about/', '/how-its-built/', '/how-its-built/single-writer/'])(
    '%s is in the dist and takes the strict policy of every page, with no rule of its own',
    (path) => {
      expect(existsSync(`${dist}${path.slice(1)}index.html`), path).toBe(true);
      expect(RULE_PATHS.filter((rule) => matches(rule, path))).toEqual([]);
      const every = rule('/*');
      expect(every).toContain("Content-Security-Policy: default-src 'self'");
      expect(every).toContain("script-src 'self';");
      expect(every).toContain('X-Content-Type-Options: nosniff');
      expect(every).toContain('Cross-Origin-Opener-Policy: same-origin');
    },
  );

  const htmlFiles = () =>
    readdirSync(dist, { recursive: true }).filter(
      (f): f is string => typeof f === 'string' && f.endsWith('.html'),
    );

  test('no page asks not to be indexed: the production hostnames are meant to be found', () => {
    // Previews on workers.dev carry X-Robots-Tag: noindex from Cloudflare (ci.yml requires it).
    for (const file of htmlFiles()) expect(page(file), file).not.toMatch(/name="robots"/);
  });

  test('every page carries the shell: the name, the nav, the footer and the one line that says it is made up', () => {
    for (const file of htmlFiles()) {
      const html = page(file);
      expect(html, file).toContain('class="site-name" href="/"');
      for (const href of [
        '/menu/',
        '/catering/',
        '/how-its-built/',
        '/about/',
        '/status/',
        '/signin/',
      ]) {
        expect(html, `${file}: ${href}`).toContain(`href="${href}"`);
      }
      for (const href of [
        '/privacy/',
        '/docs/api/',
        'https://github.com/IHaveASegway/bakery',
        'https://ihaveasegway.com/lab/',
      ]) {
        expect(html, `${file}: ${href}`).toContain(`href="${href}"`);
      }
      expect(html, file).toContain('Everything here is made up');
      expect(html, file).toContain('href="#main"');
      expect(html, file).toContain('id="main"');
    }
    // The current page is marked, for the nav and for a screen reader.
    expect(page('about/index.html')).toMatch(/href="\/about\/" aria-current="page"/);
  });

  describe('the How it’s built page', () => {
    const html = () => page('how-its-built/index.html');

    test('has a section for every principle, in order, each with its lab page where there is one and its ADR', () => {
      let at = -1;
      for (const { id } of PRINCIPLE_TABLE) {
        const p = PRINCIPLES[id]!;
        const start = html().indexOf(`id="${id}"`);
        expect(start, id).toBeGreaterThan(at);
        at = start;
        const end = html().indexOf('</section>', start);
        const section = html().slice(start, end);
        expect(section, id).toContain(`href="${p.adrUrl}"`);
        if (p.labUrl !== undefined) expect(section, id).toContain(`href="${p.labUrl}"`);
        else expect(section, id).toContain('no lab page yet');
        for (const name of [
          'The problem',
          'The technique',
          'How it works here',
          'Where it runs',
          'See it yourself',
        ]) {
          expect(section, `${id}: ${name}`).toContain(name);
        }
      }
    });

    test('links the essay from the Raft section, and the contents link every section', () => {
      const start = html().indexOf('id="raft"');
      expect(html().slice(start, html().indexOf('</section>', start))).toContain(
        'href="/how-its-built/single-writer/"',
      );
      for (const { id } of PRINCIPLE_TABLE) expect(html()).toContain(`href="#${id}"`);
    });
  });

  describe('the essay', () => {
    const html = () => page('how-its-built/single-writer/index.html');
    const text = () =>
      html()
        .replace(/<(script|style)[\s\S]*?<\/\1>/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ');

    test('is about 700 to 1,000 words, between its title and its sources', () => {
      const body = text()
        .split('Why a single-writer object needs no consensus')
        .at(-1)!
        .split(' Sources ')[0]!;
      const words = body.trim().split(' ').length;
      expect(words).toBeGreaterThanOrEqual(700);
      expect(words).toBeLessThanOrEqual(1_000);
    });

    test('cites Cloudflare’s documentation, the Raft paper and the Raft Lab, each with the date it was read', () => {
      for (const href of [
        'https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/',
        'https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/',
        'https://developers.cloudflare.com/durable-objects/platform/limits/',
        'https://www.usenix.org/conference/atc14/technical-sessions/presentation/ongaro',
        'https://ihaveasegway.com/lab/raft/',
      ]) {
        expect(html()).toContain(`href="${href}"`);
      }
      const sources = html().split('<h2>Sources</h2>')[1]!.split('</ul>')[0]!;
      const items = sources.split('<li>').slice(1);
      expect(items.length).toBeGreaterThanOrEqual(7);
      for (const item of items) expect(item).toMatch(/read on 2026-11-06/);
    });

    test('says what a single writer buys and what it gives up', () => {
      for (const heading of [
        'What consensus is for',
        'What that buys',
        'What it gives up',
        'Where the bakery pays',
      ]) {
        expect(html()).toContain(`<h2>${heading}</h2>`);
      }
    });
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

  describe('the status page', () => {
    const html = () => page('status/index.html');
    const island = () => {
      const url = html().match(/component-url="\/_astro\/(Status\.[^"]+\.js)"/)?.[1];
      expect(url, 'the status island’s bundle').toBeDefined();
      return page(`_astro/${url}`);
    };

    test('is a static page with one island, the policy class island, and no third party', () => {
      expect(html().split('<astro-island').length - 1).toBe(1);
      expect(html()).toContain('<h1>Status</h1>');
      expect(html()).not.toMatch(/<(link|script)[^>]+(href|src)="https?:/);
      expect(island()).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    });

    // Measured 2026-11-06 with node's gzipSync at its default level: 2,248 bytes. The budget is the
    // measured size plus a quarter, rounded up to 2,810, far under the 8 KB the roadmap allows. The
    // bytes buy the poller, the kept answer's storage code and the page's sentences.
    test('the island’s chunk is within its JavaScript budget: 2,810 bytes gzipped', async () => {
      const { gzipSync } = await import('node:zlib');
      expect(gzipSync(island()).length).toBeLessThanOrEqual(2_810);
    });

    test('the only browser storage the island names is its one key', () => {
      const code = island();
      expect(code).toContain('bakery.status.last-good');
      expect(code).not.toContain('sessionStorage');
      expect(code).not.toContain('indexedDB');
      expect(code).not.toContain('document.cookie');
    });
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

  describe('the API reference page', () => {
    const html = () => page('docs/api/index.html');
    const doc = JSON.parse(readFileSync(`${dist}docs/api/openapi.json`, 'utf8')) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
      components: { schemas: Record<string, unknown> };
    };
    const ids = Object.values(doc.paths).flatMap((item) =>
      Object.values(item).flatMap((op) => (op.operationId ? [op.operationId] : [])),
    );

    test('the document is served as it is committed', () => {
      expect(readFileSync(`${dist}docs/api/openapi.json`, 'utf8')).toBe(
        readFileSync(
          fileURLToPath(new URL('../public/docs/api/openapi.json', import.meta.url)),
          'utf8',
        ),
      );
    });

    test('every operation has its anchor once, and every schema its section once', () => {
      expect(ids.length).toBeGreaterThanOrEqual(72);
      for (const id of ids) {
        expect(html().split(`id="op-${id}"`).length - 1, id).toBe(1);
      }
      for (const name of Object.keys(doc.components.schemas)) {
        expect(html().split(`id="schema-${name}"`).length - 1, name).toBe(1);
      }
    });

    test('names the document, the kitchen socket, the bearer header and the tour’s targets', () => {
      const text = html();
      expect(text).toContain('href="/docs/api/openapi.json"');
      expect(text).toContain('id="socket"');
      expect(text).toContain('Authorization: Bearer');
      for (const target of ['api-token', 'api-index', 'api-operations', 'api-socket']) {
        expect(text).toContain(`data-tour="${target}"`);
      }
    });

    test('has no script of its own but the copy buttons’, which is a file of this origin', () => {
      const scripts = [...html().matchAll(/<script[^>]*>/g)].map((m) => m[0]);
      const external = scripts.filter((tag) => /\ssrc="/.test(tag));
      for (const tag of external) expect(tag).toMatch(/src="\/_astro\//);
      const copy = readdirSync(`${dist}_astro`).filter((f) =>
        f.startsWith('index.astro_astro_type_script'),
      );
      expect(copy).toHaveLength(1);
      const code = page(`_astro/${copy[0]}`);
      expect(code).toContain('data-copy');
      expect(code).not.toMatch(/https?:\/\//);
      expect(html()).not.toMatch(/<(link|script)[^>]+(href|src)="https?:/);
    });

    test('is a reasonable size: under 600 KB of HTML, and under 60 KB gzipped', async () => {
      const bytes = Buffer.byteLength(html());
      const { gzipSync } = await import('node:zlib');
      expect(bytes).toBeLessThan(600_000);
      expect(gzipSync(html()).length).toBeLessThan(60_000);
    });
  });
});
