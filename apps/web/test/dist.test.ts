import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { SCREENS } from '../src/lib/guide';
import { PRINCIPLE_TABLE, PRINCIPLES } from '../src/lib/how-its-built';
import { decisionRows } from '../src/guide/decisions';
import { ESSAYS, ESSAY_PAGES, HOW_PATH, SITE_LAB, adrUrl, labUrl } from '../src/lib/links';
import { RULE_PATHS } from '../src/policy';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { inlineHashes } from '../scripts/inline-hashes.mjs';
import { readLock, verifyFolder } from '../../../scripts/fetch-solver.mjs';

// The built pages against the policy: a page with no island carries no script at all (ADR 0008;
// as of 2026-11-09 seventeen pages: About, How it's built, its fourteen essays and the 404), and
// every inline script or style on a page with an island (the guide's, on every other screen,
// since PR 10 as the tour and since 2026-11-09 as the guide) is covered by a hash in the page's
// own rule.
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
    ['app/money/index.html', '/app/*'],
    ['app/menu/index.html', '/app/*'],
    ['app/catering/index.html', '/app/*'],
    ['app/customers/index.html', '/app/*'],
    ['app/system/index.html', '/app/*'],
    ['app/dispatch/index.html', '/app/dispatch/*'],
    ['index.html', '/*'],
    ['privacy/index.html', '/privacy/*'],
    ['docs/api/index.html', '/docs/api/*'],
    ['menu/index.html', '/menu/*'],
    ['inbox/index.html', '/inbox/*'],
    ['status/index.html', '/status/*'],
    ['order/index.html', '/order/*'],
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
    ['order/index.html', 'order'],
    ['app/index.html', 'console'],
    ['app/money/index.html', 'console'],
    ['app/menu/index.html', 'console'],
    ['app/catering/index.html', 'console'],
    ['app/customers/index.html', 'console'],
    ['app/system/index.html', 'console'],
    ['catering/index.html', 'catering'],
    ['inbox/index.html', 'inbox'],
    ['app/dispatch/index.html', 'dispatch'],
    ['docs/api/index.html', 'api'],
    ['privacy/index.html', 'privacy'],
  ])('%s carries the guide island for the %s screen, quiet', (file, screen) => {
    expect(SCREENS).toContain(screen);
    const html = page(file);
    expect(html).toContain('Guide.');
    expect(html).toContain(`&quot;${screen}&quot;`);
    expect(html).toContain('class="guide-bar"');
    expect(html).toMatch(/role="switch" aria-checked="true"/);
    expect(html).toContain('aria-expanded="false"');
    // Before anything is done the island draws no note, no mark and no ring, so the server HTML
    // has none either, and no style attribute (the policy has no 'unsafe-inline').
    expect(html).not.toContain('guide-note');
    expect(html).not.toContain('guide-spot');
    expect(html).not.toContain('data-guide-anchor');
    expect(html).not.toMatch(/<div class="guide-layer"[^>]*style=/);
  });

  // The guide stores one thing, in the tab's sessionStorage (lib/guide.ts, SWITCH_KEY), and the
  // privacy page says so in its table of what is kept.
  test('the privacy page names what the guide keeps, and where', () => {
    const html = page('privacy/index.html');
    expect(html).toContain('That you turned “Under the hood” off');
    expect(html).toContain('In this browser tab, until you close it');
    expect(html).toContain('never sent anywhere');
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

  test('no page asks not to be indexed but an order’s status: the rest are meant to be found', () => {
    // Previews on workers.dev carry X-Robots-Tag: noindex from Cloudflare (ci.yml requires it).
    // /order/ is one visitor's own order, read from their sandbox, so it alone stays out of search
    // (2026-11-09).
    for (const file of htmlFiles()) {
      if (file === 'order/index.html') {
        expect(page(file)).toContain('<meta name="robots" content="noindex">');
      } else expect(page(file), file).not.toMatch(/name="robots"/);
    }
  });

  test('every page carries the shell: the name, the nav, the footer and the one line that says it is made up', () => {
    for (const file of htmlFiles()) {
      const html = page(file);
      expect(html, file).toContain('class="site-name" href="/"');
      // The console's pages (the app shell, 2026-11-09) link back to the shop once, and list the
      // seven workspaces instead of the shop's nav; every other page has the shop's nav.
      const app = file.startsWith('app/') && !file.startsWith('app/dispatch/solver/');
      const nav = app
        ? [
            '/menu/',
            '/app/',
            '/app/money/',
            '/app/menu/',
            '/app/catering/',
            '/app/customers/',
            '/app/dispatch/',
            '/app/system/',
          ]
        : ['/menu/', '/catering/', '/how-its-built/', '/about/', '/status/', '/signin/'];
      if (app) expect(html, file).toContain('>The shop</a>');
      for (const href of nav) {
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

    // The decision table (guide/decisions.ts): a row a principle, in the guide's own words, on a
    // page that still loads no script.
    test('carries the decision table: each principle’s tool, why, when not and essay', () => {
      const text = html();
      expect(text).toContain('Why each tool, and when not');
      const rows = [...text.matchAll(/<tr id="decision-([a-z-]+)"/g)].map((m) => m[1]);
      expect(rows).toEqual(PRINCIPLE_TABLE.map((p) => p.id));
      for (const entry of decisionRows()) {
        const row = text.slice(text.indexOf(`id="decision-${entry.principle.id}"`));
        const cells = row.slice(0, row.indexOf('</tr>'));
        expect(cells, entry.id).toContain(entry.principle.name);
        expect(cells, entry.id).toContain(entry.why.replaceAll('’', '’'));
        expect(cells, entry.id).toContain(entry.whenNot.replaceAll('’', '’'));
        expect(cells, entry.id).toContain(`href="${entry.principle.essay?.url}"`);
      }
      expect(text).not.toContain('<script');
    });

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
    '/how-its-built/breaker/': [900, 1_300],
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
        'https://raft.github.io/raft.pdf',
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

    // The Status island and, since PR 18, the guide's (the tour's until 2026-11-09).
    test('is a static page with two islands, the status one and the guide’s, and no third party', () => {
      expect(html().split('<astro-island').length - 1).toBe(2);
      expect(html()).toContain('<h1>Status</h1>');
      expect(html()).not.toMatch(/<(link(?![^>]*rel="canonical")|script)[^>]+(href|src)="https?:/);
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
    // The sidebar is the server's HTML on every console page since 2026-11-09.
    expect(page('app/index.html')).toMatch(/<a href="\/app\/dispatch\/"/);
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

    test('names the document, the kitchen socket, the bearer header and the guide’s targets', () => {
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
      // The page's own script, by the name Astro gives a page script (another page, /app/, has one too).
      const copy = external
        .map((tag) => tag.match(/src="\/_astro\/([^"]+)"/)?.[1] ?? '')
        .filter((f) => f.startsWith('index.astro_astro_type_script'));
      expect(copy).toHaveLength(1);
      const code = page(`_astro/${copy[0]}`);
      expect(code).toContain('data-copy');
      expect(code).not.toMatch(/https?:\/\//);
      expect(html()).not.toMatch(/<(link(?![^>]*rel="canonical")|script)[^>]+(href|src)="https?:/);
    });

    test('is a reasonable size: under 600 KB of HTML, and under 60 KB gzipped', async () => {
      const bytes = Buffer.byteLength(html());
      const { gzipSync } = await import('node:zlib');
      expect(bytes).toBeLessThan(600_000);
      expect(gzipSync(html()).length).toBeLessThan(60_000);
    });
  });

  // ADR 0008, decision 8, asks for a byte budget per page type. This sums, for every built page,
  // the gzipped bytes of the JavaScript it loads: each module script and modulepreload link, each
  // island's component and renderer, every chunk those import statically (a dynamic import loads
  // later and is not counted), and the page's inline scripts. Each file counts once per page.
  //
  // Measured 2026-11-10 with node's gzipSync at its default level, per class (the largest page of
  // the class): guide only 80,413 B (home, privacy); API reference 80,666 B; status 83,189 B;
  // storefront 92,739 B (menu, sign-in); checkout 111,854 B; the order's page 103,825 B; console
  // screens 128,204 B (the console, dispatch, catering and the inbox). Each budget is the measured
  // size plus a quarter, rounded up to the next 1,000 B. The ADR's own numbers (5,000 B for a
  // public page, 120,000 B for an app screen or the checkout) are not met on the public pages:
  // every island page carries the guide's bar, and its React runtime is most of the total. A page
  // that is not named below must load no script.
  //
  // Since the guide replaced the tour (2026-11-09) these budgets hold the first load only: the
  // guide's bar and the trace store. With the guide on, the default, the page then loads the
  // deferred layer (the test after these holds it, at 24,088 B to 24,578 B), so a page with the
  // guide on costs more than it did with the tour. Per class, first load / with the guide on /
  // the tour's total it replaces, as main last measured it: guide only 80,413 / 104,991 / 94,187;
  // API reference 80,666 / 105,244 / 94,440; status 83,189 / 107,767 / 96,960; storefront
  // 92,739 / 116,827 / 103,417; checkout 111,854 / 135,942 / 122,775 (its three steps, #101);
  // console screens 128,204 / 152,562 / 137,999 (the new shells, #97). The first load is smaller
  // than the tour's by 9,795 B to 13,774 B; with the guide on the page is larger, by 10,804 B to
  // 14,563 B. The order's status page (/order/, #101) had no tour, at 97,911 B; with the guide's
  // bar it is 103,825 B first and 127,913 B with the guide on, which buys the order's read, its
  // watch on the kitchen socket, the tracker and the guide there. A visitor who turns the guide
  // off loads the first load alone on later pages.
  describe('JavaScript per page', () => {
    const KB = 1_000;
    const BUDGETS: Record<string, { budget: number; pages: string[] }> = {
      none: { budget: 0, pages: [] },
      guide: { budget: 101 * KB, pages: ['index.html', 'privacy/index.html'] },
      api: { budget: 101 * KB, pages: ['docs/api/index.html'] },
      status: { budget: 104 * KB, pages: ['status/index.html'] },
      order: { budget: 130 * KB, pages: ['order/index.html'] },
      storefront: { budget: 116 * KB, pages: ['menu/index.html', 'signin/index.html'] },
      checkout: { budget: 140 * KB, pages: ['checkout/index.html'] },
      // The console became seven pages on 2026-11-09 (the largest, the kitchen, was 122,195 B with
      // the tour; it was 137,999 B as one page): each page loads its own workspace and the frame
      // they share, which reads the session and draws the top bar. Re-measured with the guide below.
      console: {
        budget: 161 * KB,
        pages: [
          'app/index.html',
          'app/money/index.html',
          'app/menu/index.html',
          'app/catering/index.html',
          'app/customers/index.html',
          'app/dispatch/index.html',
          'app/system/index.html',
          'catering/index.html',
          'inbox/index.html',
        ],
      },
    };
    const classOf = (file: string) =>
      Object.entries(BUDGETS).find(([, c]) => c.pages.includes(file))?.[0] ?? 'none';

    const htmlFiles = (dir: string): string[] =>
      readdirSync(`${dist}${dir}`).flatMap((name) => {
        const rel = `${dir}${name}`;
        if (statSync(`${dist}${rel}`).isDirectory()) return htmlFiles(`${rel}/`);
        return rel.endsWith('.html') ? [rel] : [];
      });

    // Static imports of a built chunk: `import"./x.js"`, `import{a}from"./x.js"`, `export*from"./x.js"`.
    const staticImports = (code: string) =>
      [
        ...code.matchAll(
          /(?:^|[;}\s])(?:import|export)\s*(?:[^'"()]*?from\s*)?["']\.\/([^"']+\.js)["']/g,
        ),
      ].map((m) => m[1]);

    const scriptBytes = async (html: string) => {
      const { gzipSync } = await import('node:zlib');
      const queue = [
        ...[...html.matchAll(/<script[^>]*\ssrc="\/_astro\/([^"]+)"/g)].map((m) => m[1]),
        ...[...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="\/_astro\/([^"]+)"/g)].map(
          (m) => m[1],
        ),
        ...[...html.matchAll(/(?:component|renderer)-url="\/_astro\/([^"]+)"/g)].map((m) => m[1]),
      ];
      const seen = new Set<string>();
      let bytes = 0;
      for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
        if (seen.has(name)) continue;
        seen.add(name);
        const code = page(`_astro/${name}`);
        bytes += gzipSync(code).length;
        queue.push(...staticImports(code));
      }
      for (const m of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
        bytes += gzipSync(m[1] ?? '').length;
      }
      return bytes;
    };

    const files = htmlFiles('');

    // The guide's deferred load (components/Guide.tsx): the Layer chunk that a dynamic import brings
    // once the island has mounted and the guide is on or the recorder is open, with every chunk it
    // imports statically that the page's first load does not already carry, gzipped the same way.
    // Measured 2026-11-10: 24,088 B to 24,578 B (the light pages carry less React in their first
    // load, so their deferred load is the larger). The budget is the largest plus a quarter,
    // rounded up to the next 1,000 B. The bytes buy the 68 entries, the notes, the hotspots, the
    // recorder panel, the short path and, since 2026-11-10, the order page's watch note.
    const DEFERRED_BUDGET = 31_000;
    const firstLoad = (html: string) => {
      const queue = [
        ...[...html.matchAll(/<script[^>]*\ssrc="\/_astro\/([^"]+)"/g)].map((m) => m[1]),
        ...[...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="\/_astro\/([^"]+)"/g)].map(
          (m) => m[1],
        ),
        ...[...html.matchAll(/(?:component|renderer)-url="\/_astro\/([^"]+)"/g)].map((m) => m[1]),
      ];
      return closure(queue, new Set());
    };
    const closure = (start: (string | undefined)[], skip: Set<string>) => {
      const queue = [...start];
      const seen = new Set<string>();
      for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
        if (seen.has(name) || skip.has(name)) continue;
        seen.add(name);
        queue.push(...staticImports(page(`_astro/${name}`)));
      }
      return seen;
    };

    test('the guide’s deferred load, the layer and what only it imports, is within 31,000 B gzipped on every island page', async () => {
      const { gzipSync } = await import('node:zlib');
      const pages = files.filter((f) => classOf(f) !== 'none');
      expect(pages.length).toBeGreaterThan(5);
      for (const file of pages) {
        const first = firstLoad(page(file));
        const guide = [...first].find((name) => name.startsWith('Guide.'));
        expect(guide, `${file}: the guide island in the first load`).toBeDefined();
        const layer = page(`_astro/${guide}`).match(
          /import\([`"']\.\/(Layer\.[^`"']+\.js)[`"']\)/,
        )?.[1];
        expect(layer, `${file}: the layer, imported dynamically by the guide`).toBeDefined();
        const deferred = closure([layer], first);
        const bytes = [...deferred].reduce(
          (n, name) => n + gzipSync(page(`_astro/${name}`)).length,
          0,
        );
        expect(bytes, `${file}: ${bytes} B gzipped`).toBeGreaterThan(10_000);
        expect(bytes, `${file}: ${bytes} B gzipped`).toBeLessThanOrEqual(DEFERRED_BUDGET);
      }
    });

    test('every page named in a class is built', () => {
      for (const c of Object.values(BUDGETS)) for (const f of c.pages) expect(files).toContain(f);
    });

    test.each(files)('%s stays inside its class budget', async (file) => {
      const cls = classOf(file);
      const bytes = await scriptBytes(page(file));
      expect(bytes, `${file} (${cls}): ${bytes} B gzipped`).toBeLessThanOrEqual(
        BUDGETS[cls]?.budget ?? 0,
      );
    });
  });
});
