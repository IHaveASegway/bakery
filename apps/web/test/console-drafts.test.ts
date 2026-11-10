// The menu editor and the capacity panel after the audit of 2026-11-08 (afternoon): a price drafted
// in another tab is noticed, and the capacity panel follows a publish without a reload.
import { describe, expect, test } from 'vitest';
import { catchUpToMenu } from '../src/lib/capacity';
import { anotherTabText, unseenDrafts } from '../src/lib/menu';

describe('drafts made in another tab', () => {
  test('a slug the page did not know is unseen; the same slugs are not', () => {
    expect(unseenDrafts(['country-loaf'], ['country-loaf', 'baguette'])).toEqual(['baguette']);
    expect(unseenDrafts(['country-loaf'], ['country-loaf'])).toEqual([]);
    expect(unseenDrafts(['country-loaf', 'baguette'], ['country-loaf'])).toEqual([]);
  });

  test('before the first read nothing is unseen (the first read is not a surprise)', () => {
    expect(unseenDrafts(null, ['baguette'])).toEqual([]);
  });

  test('the sentence names the items and says what to do', () => {
    expect(anotherTabText(['Baguette'])).toBe(
      'Another tab drafted a price for Baguette. It is listed now. Press Publish menu again to put everything that waits on sale.',
    );
    expect(anotherTabText(['Baguette', 'Rye'])).toContain('Baguette and Rye');
    expect(anotherTabText(['Baguette', 'Rye'])).toContain('They are listed now.');
  });
});

describe('the capacity panel follows the menu', () => {
  const no = async () => undefined;

  test('stops as soon as the day reports the published version', async () => {
    const reads: number[] = [];
    const answers = [2, 3];
    const out = await catchUpToMenu(async () => (reads.push(1), answers.shift() ?? 3), 3, {
      sleep: no,
    });
    expect(out.kind).toBe('paid');
    expect(reads).toHaveLength(2);
  });

  test('gives up after its limit and says so', async () => {
    const out = await catchUpToMenu(async () => 2, 3, { sleep: no, limitMs: 3_000 });
    expect(out.kind).toBe('timeout');
  });

  test('a failed read is a missed look', async () => {
    let n = 0;
    const out = await catchUpToMenu(
      async () => {
        if (n++ === 0) throw new Error('offline');
        return 3;
      },
      3,
      { sleep: no },
    );
    expect(out.kind).toBe('paid');
  });
});
