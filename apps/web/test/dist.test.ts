import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { SCREENS } from '../src/lib/tour';
import { PRINCIPLE_TABLE, PRINCIPLES } from '../src/lib/how-its-built';
import { ESSAYS, ESSAY_PAGES, HOW_PATH, SITE_LAB, adrUrl, labUrl } from '../src/lib/links';
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
// The essays, from the one table of them (src/lib/links.ts): a page added there is checked here
// without a test of its own. Each page once, with every principle that links it (three pairs
// share one: the two idempotency principles, CQRS and load, the sandbox and no personal data).
const essays = ESSAY_PAGES.map((essay) => ({
  ...essay,
  ids: Object.entries(ESSAYS)
    .filter(([, e]) => e.path === essay.path)
    .map(([id]) => id),
}));
const essayFile = (path: string) => `${path.slice(1)}index.html`;
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
    ...essays.map((e) => essayFile(e.path)),
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
    ['index.html', '/*'],
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

  test.each(['/about/', '/how-its-built/', ...essays.map((e) => e.path)])(
    '%s is in the dist and takes the strict policy of every page, with no rule of its own',
    (path) => {
      expect(existsSync(`${dist}${path.slice(1)}index.html`), path).toBe(true);
      expect(RULE_PATHS.filter((rule) => matches(rule, path))).toEqual([]);
      const every = rule('/*');
      expect(every).toContain("Content-Security-Policy: default-src 'self'");
      // 'self' and the start page's hashes, which ride in this rule (src/policy.ts, ISLAND_PATHS).
      expect(every).toMatch(/script-src 'self'( 'sha256-[A-Za-z0-9+/=]+')+;/);
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

    test('links each essay from its sections, by its title, lists each once, and the contents link every section', () => {
      for (const { ids, path, title } of essays) {
        for (const id of ids) {
          const start = html().indexOf(`id="${id}"`);
          expect(start, id).toBeGreaterThan(-1);
          expect(html().slice(start, html().indexOf('</section>', start)), id).toContain(
            `<a href="${path}">${title}</a>`,
          );
        }
      }
      const contents = html().split('id="contents-title"')[1]!.split('</nav>')[0]!;
      for (const { path, title } of essays) {
        expect(contents.split(`<a href="${path}">${title}</a>`), path).toHaveLength(2);
      }
      for (const { id } of PRINCIPLE_TABLE) expect(html()).toContain(`href="#${id}"`);
      // A principle with no essay links none.
      for (const { id } of PRINCIPLE_TABLE.filter((p) => !Object.hasOwn(ESSAYS, p.id))) {
        const start = html().indexOf(`id="${id}"`);
        expect(html().slice(start, html().indexOf('</section>', start)), id).not.toMatch(
          /href="\/how-its-built\/[a-z-]+\/"/,
        );
      }
    });
  });

  // Each essay's words between its h1 and its sources: the first was held to 700 to 1,000 in PR
  // 12, the four of PR 14, the four of PR 15 and the four of PR 16 to 900 to 1,300.
  const WORDS: Record<string, [number, number]> = {
    '/how-its-built/single-writer/': [700, 1_000],
    '/how-its-built/outbox/': [900, 1_300],
    '/how-its-built/cache/': [900, 1_300],
    '/how-its-built/rebuild/': [900, 1_300],
    '/how-its-built/routes/': [900, 1_300],
    '/how-its-built/idempotency/': [900, 1_300],
    '/how-its-built/sagas/': [900, 1_300],
    '/how-its-built/leases/': [900, 1_300],
    '/how-its-built/admission/': [900, 1_300],
    '/how-its-built/lag/': [900, 1_300],
    '/how-its-built/time-travel/': [900, 1_300],
    '/how-its-built/sandbox/': [900, 1_300],
    '/how-its-built/api/': [900, 1_300],
  };

  test('every essay has its length set', () => {
    expect(Object.keys(WORDS).sort()).toEqual(essays.map((e) => e.path).sort());
  });

  describe.each(essays)('the essay $path', ({ ids, path, title }) => {
    const file = essayFile(path);
    const html = () => page(file);
    const text = () =>
      html()
        .replace(/<(script|style)[\s\S]*?<\/\1>/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ');
    const principles = ids.map((id) => PRINCIPLES[id]!);

    test('is in the dist, on the Base layout, with the hint back to How it’s built', () => {
      expect(existsSync(`${dist}${file}`), file).toBe(true);
      expect(html()).toContain('class="site-name" href="/"');
      expect(html()).toContain('Everything here is made up');
      expect(html()).toMatch(
        new RegExp(`<p class="hint"[^>]*>\\s*<a href="${HOW_PATH}"[^>]*>How it’s built</a>`),
      );
    });

    test('has its title as its one h1, then a lead', () => {
      expect(html().match(/<h1[^>]*>/g)).toHaveLength(1);
      expect(html()).toMatch(new RegExp(`<h1[^>]*>${title}</h1>\\s*<p class="lead"[^>]*>`));
      expect(html()).toContain(`<title>${title} | Proof of Concept Bakery</title>`);
    });

    test('links its lab page, or the lab’s index where its principle has none, and its ADR', () => {
      // In the essay itself: the footer links the lab's index on every page.
      const article = html().split('<article')[1]!.split('</article>')[0]!;
      for (const principle of principles) {
        const lab = labUrl(principle.lab);
        expect(article, principle.id).toContain(`href="${lab ?? SITE_LAB}"`);
        expect(article, principle.id).toContain(`href="${adrUrl(principle.adr)}"`);
        // One with no lab page says so.
        if (lab === undefined) expect(article, principle.id).toMatch(/no lab page/i);
      }
    });

    test('lists at least five sources, each linked with the date it was read, or saying it was not', () => {
      const sources = html().split('<h2>Sources</h2>')[1]?.split('</ul>')[0] ?? '';
      expect(sources).toMatch(/^\s*<ul class="sources"/);
      const items = sources.split('<li>').slice(1);
      const read = items.filter(
        (item) =>
          /<a href="https?:\/\/[^"]+" rel="noopener"/.test(item) &&
          /read on \d{4}-\d{2}-\d{2}/.test(item),
      );
      expect(read.length).toBeGreaterThanOrEqual(5);
      // A work cited without being read online (a paper in print) says so, with the date.
      for (const item of items.filter((i) => !read.includes(i))) {
        expect(item).toMatch(/not read on \d{4}-\d{2}-\d{2}/);
      }
    });

    test('is the length its brief sets, between its title and its sources', () => {
      const body = text().split(title).at(-1)!.split(' Sources ')[0]!;
      const words = body.trim().split(' ').length;
      const [least, most] = WORDS[path]!;
      expect(words).toBeGreaterThanOrEqual(least);
      expect(words).toBeLessThanOrEqual(most);
    });

    test('names no coordinates and no email address', () => {
      expect(text()).not.toMatch(/-?\d{1,3}\.\d{3,},\s*-?\d{1,3}\.\d{3,}/);
      expect(text()).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
    });
  });

  describe('the essay on single-writer objects', () => {
    const html = () => page('how-its-built/single-writer/index.html');

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

    // Measured 2026-11-06 with node's gzipSync at its default level: 2,510 bytes (2,248 before the
    // breaker line). The budget is the measured size plus a quarter, rounded up to 3,138, far under
    // the 8 KB the roadmap allows. The bytes buy the poller, the kept answer's storage code, the
    // page's sentences and the breaker's.
    test('the island’s chunk is within its JavaScript budget: 3,138 bytes gzipped', async () => {
      const { gzipSync } = await import('node:zlib');
      expect(gzipSync(island()).length).toBeLessThanOrEqual(3_138);
    });

    test('the island carries the breaker line’s words and test id', () => {
      const code = island();
      expect(code).toContain('status-breaker');
      expect(code).toContain('tripped: ');
      expect(code).toContain('not configured');
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
