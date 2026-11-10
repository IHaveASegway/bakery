// The tools page's data (src/data/tools.ts) and the page built from it (/how-its-built/tools/).
// The shape: three sentences a tool, a reason and a case for every alternative. The records: every
// ADR, document and essay it cites exists. The rot: every binding the Workers declare and every
// dependency the web app and the Rust workspace name has a row, or a reason here for having none,
// so a new one fails this test until someone decides. The page tests read dist/, so build first.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  NOT_RECORDED,
  TOOLS,
  TOOL_GROUPS,
  WEIGHED_AFTER,
  alternatives,
  type RecordRef,
} from '../src/data/tools';
import { ESSAYS, TOOLS_PATH } from '../src/lib/links';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const web = fileURLToPath(new URL('../', import.meta.url));
const dist = fileURLToPath(new URL('../dist/', import.meta.url));

// A sentence on this page: one sentence, so no full stop inside it followed by a new sentence, and
// it ends with a full stop. A tool's three lines are 20 to 240 characters; an alternative's lines,
// which carry their own qualifiers and dates, up to 280.
const ONE_SENTENCE = /^[^\s][\s\S]*\.$/;
const isSentence = (text: string, max: number) =>
  ONE_SENTENCE.test(text) && !/\.\s+[A-Z]/.test(text) && text.length >= 4 && text.length <= max;

describe('the tools data', () => {
  test('every tool has its three sentences, each one sentence with a full stop', () => {
    for (const tool of TOOLS) {
      for (const [field, text] of [
        ['doesHere', tool.doesHere],
        ['whyHere', tool.whyHere],
        ['whenNot', tool.whenNot],
      ] as const) {
        expect(text.length, `${tool.id}.${field}`).toBeGreaterThanOrEqual(20);
        expect(isSentence(text, 240), `${tool.id}.${field}: ${text}`).toBe(true);
      }
      expect(tool.version.length, tool.id).toBeGreaterThan(0);
      if (tool.notMeasured !== undefined) {
        expect(isSentence(tool.notMeasured, 240), tool.id).toBe(true);
      }
    }
  });

  test('every alternative has its reason, and a case or the words "never compared" or "not recorded"', () => {
    for (const { tool, alternative: a } of alternatives()) {
      const at = `${tool.id}: ${a.name}`;
      for (const text of [a.replaces, a.whyNot, a.whenRight]) {
        expect(isSentence(text, 280), `${at}: ${text}`).toBe(true);
      }
      const never = a.never?.kind === 'compared' || /never compared/i.test(a.whyNot);
      expect(a.whenRight.length > 0 || never, at).toBe(true);
      if (a.whenRight === NOT_RECORDED) expect(a.after, at).toBeUndefined();
      if (a.never !== undefined) expect(isSentence(a.never.text, 280), at).toBe(true);
    }
  });

  test('the ten alternatives of ADR 0016 are marked as weighed after the build, each once', () => {
    const late = alternatives().filter(({ alternative: a }) => a.after);
    expect(late).toHaveLength(10);
    const sections = late.map(({ alternative: a }) =>
      'adr' in a.record && a.record.adr === '0016' ? a.record.section : undefined,
    );
    expect([...sections].sort((x, y) => Number(x) - Number(y))).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
    ]);
    // Each says what was never measured, compared or checked, as the ADR does.
    for (const { alternative: a } of late) expect(a.never, a.name).toBeDefined();
    // Where nothing was compared, the words say so (ADR 0016, sections 4, 9 and 10).
    expect(late.filter(({ alternative: a }) => a.never?.kind === 'compared')).toHaveLength(3);
  });

  test('ids are unique, every group is used, and every tool sits in one', () => {
    const ids = TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(TOOLS).toHaveLength(34);
    for (const group of TOOL_GROUPS) {
      expect(
        TOOLS.some((t) => t.group === group.id),
        group.id,
      ).toBe(true);
    }
    for (const tool of TOOLS) {
      expect(
        TOOL_GROUPS.map((g) => g.id),
        tool.id,
      ).toContain(tool.group);
    }
    // The page lists them group by group, so the data keeps that order too.
    const order = TOOLS.map((t) => TOOL_GROUPS.findIndex((g) => g.id === t.group));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test('the owner’s rule and direction are named where the reason is theirs, and only there', () => {
    for (const tool of TOOLS) {
      const says = /owner’s (rule|direction)/.exec(tool.whyHere)?.[1];
      expect(tool.ownersRule, tool.id).toBe(says);
    }
  });
});

describe('the records it cites', () => {
  const adrFiles = readdirSync(`${root}docs/adr`);
  const refs: { at: string; ref: RecordRef }[] = [
    ...TOOLS.flatMap((t) => t.records.map((ref) => ({ at: t.id, ref }))),
    ...alternatives().map(({ tool, alternative: a }) => ({
      at: `${tool.id}: ${a.name}`,
      ref: a.record,
    })),
  ];

  test('every ADR number is a file under docs/adr, and every document exists', () => {
    expect(refs.length).toBeGreaterThan(100);
    for (const { at, ref } of refs) {
      if ('adr' in ref) {
        expect(
          adrFiles.some((f) => f.startsWith(`${ref.adr}-`)),
          `${at}: ADR ${ref.adr}`,
        ).toBe(true);
      } else if ('doc' in ref) {
        expect(existsSync(`${root}docs/${ref.doc}.md`), `${at}: ${ref.doc}`).toBe(true);
      } else {
        expect(Object.hasOwn(ESSAYS, ref.essay), `${at}: ${ref.essay}`).toBe(true);
      }
    }
  });

  test('every essay a tool names is in ESSAYS', () => {
    for (const tool of TOOLS) {
      for (const id of tool.essays ?? []) expect(Object.hasOwn(ESSAYS, id), tool.id).toBe(true);
    }
  });
});

/** JSON with comments and trailing commas, as Wrangler accepts it. */
function parseJsonc(text: string): Record<string, unknown> {
  let json = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      json += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      json += '\n';
    } else {
      json += c;
    }
  }
  return JSON.parse(json.replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>;
}

const toolIds = new Set(TOOLS.map((t) => t.id));

describe('the table cannot rot', () => {
  // Each top-level key of a Worker's config: the tool row it is, or null for a key that binds
  // nothing (a name, a date, a build command, variables).
  const API_KEYS: Record<string, string | null> = {
    name: null,
    main: null,
    compatibility_date: null,
    compatibility_flags: null,
    build: null,
    workers_dev: null,
    preview_urls: null,
    vars: null,
    routes: 'custom-domains',
    limits: 'workers-paid',
    observability: 'workers-logs',
    durable_objects: 'durable-objects',
    exports: 'durable-objects',
    queues: 'queues',
    analytics_engine_datasets: 'analytics-engine',
    triggers: 'cron',
    ratelimits: 'rate-limiting',
  };
  const WEB_KEYS: Record<string, string | null> = {
    $schema: null,
    name: null,
    compatibility_date: null,
    workers_dev: null,
    preview_urls: null,
    previews: null,
    send_metrics: null,
    observability: null,
    assets: 'static-assets',
    routes: 'custom-domains',
  };
  const api = parseJsonc(readFileSync(`${root}workers/api/wrangler.jsonc`, 'utf8'));
  const site = parseJsonc(readFileSync(`${web}wrangler.jsonc`, 'utf8'));

  test('every key the two Workers declare is a tool row or binds nothing', () => {
    for (const [config, keys, file] of [
      [api, API_KEYS, 'workers/api/wrangler.jsonc'],
      [site, WEB_KEYS, 'apps/web/wrangler.jsonc'],
    ] as const) {
      for (const key of Object.keys(config)) {
        expect(Object.hasOwn(keys, key), `${file}: ${key} has no row and no reason`).toBe(true);
        const id = keys[key];
        if (id) expect(toolIds.has(id), `${file}: ${key} -> ${id}`).toBe(true);
      }
    }
  });

  test('each binding kind the API declares is there and has its row', () => {
    const queues = api.queues as { producers: unknown[]; consumers: unknown[] };
    expect(queues.producers.length).toBeGreaterThan(0);
    expect(queues.consumers.length).toBeGreaterThan(0);
    expect((api.analytics_engine_datasets as unknown[]).length).toBeGreaterThan(0);
    expect((api.ratelimits as unknown[]).length).toBeGreaterThan(0);
    expect((api.triggers as { crons: string[] }).crons.length).toBeGreaterThan(0);
    expect(site.assets).toBeDefined();
    // The row's own count of classes is the config's.
    const classes = Object.keys(api.exports as object).length;
    expect(TOOLS.find((t) => t.id === 'durable-objects')!.version).toContain(`${classes} classes`);
    expect(TOOLS.find((t) => t.id === 'rate-limiting')!.version).toContain(
      ['zero', 'one', 'two', 'three', 'four', 'five', 'six'][(api.ratelimits as unknown[]).length],
    );
  });

  // Dependencies with no row of their own, each with why. A new dependency fails the test until it
  // is named by a row's `packages` or added here.
  const UNLISTED: Record<string, string> = {
    tailwindcss:
      'The draft’s Tailwind row was dropped because no record says when it would be the wrong tool.',
    '@tailwindcss/vite': 'Tailwind’s build plugin, which goes with Tailwind’s dropped row.',
    culori:
      'It reads the tokens’ colours for the contrast test and the browser chrome, and no record weighs it.',
    thiserror:
      'stack.md gives its reason in one sentence and no case where it would be wrong, so it has no row.',
    'data-encoding':
      'stack.md gives its reason in one sentence and no case where it would be wrong, so it has no row.',
    icu_normalizer:
      'stack.md gives its reason in one sentence and no case where it would be wrong, so it has no row.',
    rand_chacha:
      'stack.md gives its reason in one sentence and no case where it would be wrong, so it has no row.',
    rand_core:
      'stack.md gives its reason in one sentence and no case where it would be wrong, so it has no row.',
    rand_chacha_rsa: 'A test-time generator for RSA keys only, a dev-dependency of the app crate.',
  };

  const named = new Set(TOOLS.flatMap((t) => t.packages ?? []));

  const webDependencies = Object.keys(
    (JSON.parse(readFileSync(`${web}package.json`, 'utf8')) as { dependencies: object })
      .dependencies,
  );
  const cargo = readFileSync(`${root}Cargo.toml`, 'utf8');
  const workspace = cargo.split('[workspace.dependencies]')[1]!.split(/\n\[/)[0]!;
  const crateDependencies = [...workspace.matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1]!);

  test('every dependency of the web app and the Rust workspace has a row or a reason', () => {
    expect(webDependencies.length).toBeGreaterThan(5);
    expect(crateDependencies.length).toBeGreaterThan(10);
    for (const name of [...webDependencies, ...crateDependencies]) {
      const row = named.has(name);
      const reason = Object.hasOwn(UNLISTED, name);
      expect(row || reason, `${name}: name it on a row's packages or in UNLISTED`).toBe(true);
      expect(row && reason, `${name} is both on a row and in UNLISTED`).toBe(false);
    }
  });

  test('no row or reason names a dependency that is gone, and each reason is one sentence', () => {
    const all = new Set([...webDependencies, ...crateDependencies]);
    for (const name of [...named, ...Object.keys(UNLISTED)]) {
      expect(all.has(name), `${name} is not a dependency any more`).toBe(true);
    }
    for (const reason of Object.values(UNLISTED)) expect(isSentence(reason, 200)).toBe(true);
  });
});

describe('the built page', () => {
  const file = `${dist}${TOOLS_PATH.slice(1)}index.html`;
  const html = () => readFileSync(file, 'utf8');
  const decode = (s: string) => s.replaceAll('&#39;', "'").replaceAll('&quot;', '"');

  test('is in the dist with one h1, no script, no style and no table', () => {
    expect(existsSync(file), 'run pnpm build first').toBe(true);
    expect(html().match(/<h1[^>]*>/g)).toHaveLength(1);
    expect(html()).toContain('<h1>The tools, and what was not chosen</h1>');
    expect(html()).not.toContain('<script');
    expect(html()).not.toContain('<style');
    expect(html()).not.toContain('<table');
    expect(html()).not.toMatch(/\sstyle="/);
  });

  test('has its canonical link and is in the sitemap', () => {
    const site = 'https://bakery.ihaveasegway.com';
    expect(html()).toContain(`<link rel="canonical" href="${site}${TOOLS_PATH}">`);
    expect(readFileSync(`${dist}sitemap.xml`, 'utf8')).toContain(`<loc>${site}${TOOLS_PATH}</loc>`);
  });

  test('links ADR 0016 from its lead, and is linked from How it’s built', () => {
    const lead = html().split('<h2')[0]!;
    expect(lead).toMatch(
      /href="https:\/\/github\.com\/IHaveASegway\/bakery\/blob\/main\/docs\/adr\/0016-[^"]+"/,
    );
    const how = readFileSync(`${dist}how-its-built/index.html`, 'utf8');
    expect(how.split(`href="${TOOLS_PATH}"`).length - 1).toBeGreaterThanOrEqual(2);
    expect(how).toContain('Every tool, and what was not chosen');
  });

  test('has an article a tool, in order, each with its three lines, its flags and its list', () => {
    const articles = html().split('<article').slice(1);
    expect(articles).toHaveLength(TOOLS.length);
    articles.forEach((article, i) => {
      const tool = TOOLS[i]!;
      expect(article, tool.id).toContain(`id="${tool.id}"`);
      for (const label of ['Does here', 'Why here', 'When not']) {
        expect(article, `${tool.id}: ${label}`).toContain(`<dt>${label}</dt>`);
      }
      expect(article.includes('The owner’s rule'), tool.id).toBe(tool.ownersRule === 'rule');
      expect(article.includes('The owner’s direction'), tool.id).toBe(
        tool.ownersRule === 'direction',
      );
      expect(article.includes('Not measured'), tool.id).toBe(tool.notMeasured !== undefined);
      const n = tool.alternatives?.length ?? 0;
      if (n === 0) expect(article, tool.id).not.toContain('<details');
      else {
        expect(article, tool.id).toMatch(/<details class="tool-alts">/);
        expect(article, tool.id).not.toMatch(/<details[^>]* open/);
        expect(decode(article), tool.id).toContain(`Considered and not chosen (${n})`);
      }
    });
  });

  test('labels every alternative of ADR 0016 as weighed after the build, with its date', () => {
    const label = `Weighed after the build, ${WEIGHED_AFTER}`;
    expect(html().split(label).length - 1).toBe(10);
  });

  test('has its headings in order, and its group index links every group', () => {
    const levels = [
      ...html()
        .split('<main')[1]!
        .matchAll(/<h([1-6])/g),
    ].map((m) => Number(m[1]));
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]! - levels[i - 1]!, `heading ${i}`).toBeLessThanOrEqual(1);
    }
    for (const group of TOOL_GROUPS) expect(html()).toContain(`href="#${group.id}"`);
  });

  test('carries no number with three or more decimal places', () => {
    expect(html()).not.toMatch(/\d\.\d{3,}/);
  });
});
