// The How it's built page's data (src/lib/how-its-built.ts) against the tour's principles and the
// principle map in docs/domain.md: one section per principle and one principle per section, in
// the order the brief for PR 12 gives, each with its links. The built page is dist.test.ts's.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  GROUPS,
  ONE_LINE,
  PRINCIPLES,
  PRINCIPLE_TABLE,
  principle,
  sections,
} from '../src/lib/how-its-built';
import { ESSAYS, ESSAY_PAGES, essayUrl } from '../src/lib/links';
import * as tourPrinciples from '../src/tour/principles';

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const exported = Object.values(tourPrinciples);

describe('the sections and the tour’s principles', () => {
  test('every principle the tour exports has a section, and every section is a principle the tour exports', () => {
    const tourIds = exported.map((p) => p.id).sort();
    const sectionIds = sections()
      .map((s) => s.id)
      .sort();
    expect(tourIds).toEqual(sectionIds);
    expect(new Set(sectionIds).size).toBe(sectionIds.length);
  });

  test('the five lab principles come first, in the brief’s order, then the six new ones, then the demo’s own', () => {
    const ids = PRINCIPLE_TABLE.map((p) => p.id);
    expect(ids.slice(0, 5)).toEqual(['queue', 'cache', 'backfill', 'routes', 'raft']);
    const groups = PRINCIPLE_TABLE.map((p) => p.group);
    expect(groups.slice(0, 5).every((g) => g === 'lab')).toBe(true);
    // Groups are contiguous: lab, then new, then demo.
    expect([...new Set(groups)]).toEqual(['lab', 'new', 'demo']);
    expect(Object.keys(GROUPS)).toEqual(['lab', 'new', 'demo']);
    const news = PRINCIPLE_TABLE.filter((p) => p.group === 'new').map((p) => p.id);
    for (const id of ['idempotency-keys', 'sagas', 'leases', 'admission', 'cqrs', 'time-travel']) {
      expect(news, id).toContain(id);
    }
    expect(PRINCIPLE_TABLE.filter((p) => p.group === 'demo').map((p) => p.id)).toEqual([
      'sandbox',
      'no-personal-data',
      'api',
      'breaker',
    ]);
  });

  test('a lab principle has a lab page, and only the five do', () => {
    for (const s of sections()) {
      expect(s.lab === 'none yet', s.id).toBe(s.group !== 'lab');
      const links = PRINCIPLES[s.id];
      expect(links?.adrUrl, s.id).toMatch(
        /^https:\/\/github\.com\/IHaveASegway\/bakery\/blob\/main\/docs\/adr\/\d{4}-/,
      );
      if (s.group === 'lab')
        expect(links?.labUrl, s.id).toMatch(/^https:\/\/ihaveasegway\.com\/lab\/[a-z]+\/$/);
      else expect(links?.labUrl, s.id).toBeUndefined();
    }
  });

  test('every section says all five things, and says them in a few plain sentences', () => {
    for (const s of sections()) {
      for (const field of ['problem', 'technique', 'how', 'where', 'see'] as const) {
        expect(s[field].trim().length, `${s.id}.${field}`).toBeGreaterThan(20);
      }
      const sentences = s.how.split(/(?<=[.:])\s+(?=[A-Z])/).length;
      expect(sentences, `${s.id}: how`).toBeLessThanOrEqual(4);
      expect(s.screen.href, s.id).toMatch(/^\/[a-z/]*$/);
    }
  });

  test('an unknown section is an error at build, not a missing link', () => {
    // @ts-expect-error: the id is checked by type as well.
    expect(() => principle('no-such-principle')).toThrow(/no How it's built section/);
  });

  test('every principle has its essay, at its path and by its title', () => {
    const withEssay = Object.values(PRINCIPLES).filter((p) => p.essay !== undefined);
    expect(withEssay.map((p) => p.id)).toEqual(PRINCIPLE_TABLE.map((p) => p.id));
    expect(Object.keys(ESSAYS)).toEqual(PRINCIPLE_TABLE.map((p) => p.id));
    for (const s of sections()) {
      expect(PRINCIPLES[s.id]?.essay, s.id).toBeDefined();
    }
    for (const p of withEssay) {
      const essay = ESSAYS[p.id as keyof typeof ESSAYS];
      expect(p.essay, p.id).toEqual({ url: essay.path, title: essay.title });
      expect(essayUrl(p.id), p.id).toBe(essay.path);
      expect(essay.path, p.id).toMatch(/^\/how-its-built\/[a-z-]+\/$/);
    }
    // Three pairs of principles share a page; every other page is one principle's.
    expect(ESSAYS['payment-keys']).toEqual(ESSAYS['idempotency-keys']);
    expect(ESSAYS.load).toEqual(ESSAYS.cqrs);
    expect(ESSAYS['no-personal-data']).toEqual(ESSAYS.sandbox);
    expect(ESSAY_PAGES).toEqual([
      { path: '/how-its-built/outbox/', title: 'Why a paid order is never lost and never doubled' },
      { path: '/how-its-built/cache/', title: 'Why the menu is cached by version, not by time' },
      { path: '/how-its-built/rebuild/', title: 'Why the CRM can be thrown away and rebuilt' },
      {
        path: '/how-its-built/routes/',
        title: 'Why the browser plans the route and the object decides',
      },
      {
        path: '/how-its-built/single-writer/',
        title: 'Why a single-writer object needs no consensus',
      },
      {
        path: '/how-its-built/idempotency/',
        title: 'Why pressing the button twice never orders twice',
      },
      {
        path: '/how-its-built/sagas/',
        title: 'Why a catering job is a saga that only moves forward',
      },
      { path: '/how-its-built/leases/', title: 'Why every hold and every sandbox has an end' },
      {
        path: '/how-its-built/admission/',
        title: 'Why a refusal is the cheapest thing the bakery does',
      },
      {
        path: '/how-its-built/lag/',
        title: 'Why the CRM trails the orders, and why you can watch it',
      },
      { path: '/how-its-built/time-travel/', title: 'Why the bakery’s clock is yours to move' },
      { path: '/how-its-built/sandbox/', title: 'Why nothing here is real, by construction' },
      { path: '/how-its-built/api/', title: 'Why the console is just another client' },
      {
        path: '/how-its-built/breaker/',
        title: 'Why the bakery can switch itself off before the bill does',
      },
    ]);
    expect(ESSAY_PAGES).toHaveLength(14);
    expect(new Set(ESSAY_PAGES.map((e) => e.title)).size).toBe(ESSAY_PAGES.length);
    expect(new Set(ESSAY_PAGES.map((e) => e.path)).size).toBe(ESSAY_PAGES.length);
  });
});

describe('the principle map in docs/domain.md', () => {
  const map = read('../../../docs/domain.md').split('## The principle map')[1]?.split('\n## ')[0];

  test('was read', () => {
    expect(map).toBeDefined();
    expect(map).toContain('| Queue Lab, `/lab/queue/` |');
  });

  test('each lab row names the slug the section links, and each ADR the section names is in its row', () => {
    const rows = (map ?? '')
      .split('\n')
      .filter((line) => line.startsWith('| ') && !line.startsWith('| Lab'));
    for (const s of sections().filter((x) => x.group === 'lab')) {
      const slug = PRINCIPLES[s.id]?.labUrl?.replace('https://ihaveasegway.com', '');
      const row = rows.find((r) => r.startsWith(`| ${s.lab}, \`${slug}\``));
      expect(row, `${s.id}: a row for ${s.lab} at ${slug}`).toBeDefined();
      expect(row, s.id).toContain(`adr/${s.adr}-`);
    }
  });
});

describe('the page’s one line', () => {
  test('is product.md’s, with the bakery as its subject', () => {
    const product = read('../../../docs/product.md');
    expect(product).toContain(
      "the made-up bakery that ihaveasegway.com's lab simulates, built as a real business system",
    );
    expect(ONE_LINE).toContain(
      'the made-up bakery that ihaveasegway.com’s lab simulates, built as a real business system',
    );
    expect(ONE_LINE).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  });
});
