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

  test('the essay goes with the Raft principle alone', () => {
    const withEssay = Object.values(PRINCIPLES).filter((p) => p.essayUrl !== undefined);
    expect(withEssay.map((p) => p.id)).toEqual(['raft']);
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
