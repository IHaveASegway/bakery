// The console's words for a dead letter made while the bakery was off (roadmap R67), and the
// redrive's, which do not change with the mark. Synthetic ids only.
import { describe, expect, test } from 'vitest';
import type { DeadLetter } from '../src/contracts';
import { redriveSaid, whileOffNote } from '../src/lib/dead-letters';

const letter = (made_while_off: boolean): DeadLetter => ({
  id: '01JC8Z6K3W9QF2N4T7XRB5M0HD',
  type: 'OrderPlaced',
  stream: 'order:01JC8YV2D4QK7S1M9E3PZ6W8AN:01JC8Z5R0T2B6Y8C4V1N3K7QXE',
  seq: 1,
  error: 'no answer recorded',
  at: '2026-11-10T14:00:00Z',
  made_while_off,
});

describe('dead letters', () => {
  test('a letter made while off says so, and that a real fault is marked too', () => {
    const note = whileOffNote(letter(true));
    expect(note).toContain('while the bakery was off');
    expect(note).toContain('not counted');
    expect(note).toContain('real fault');
  });

  test('a letter without the mark, or from an API older than it, says nothing', () => {
    expect(whileOffNote(letter(false))).toBeNull();
    expect(whileOffNote({} as DeadLetter)).toBeNull();
  });

  test('a redrive reads the same either way', () => {
    expect(redriveSaid(letter(true))).toBe(redriveSaid(letter(false)));
    expect(redriveSaid(letter(true))).toBe(
      'Redrove OrderPlaced for order:01JC8YV2D4QK7S1M9E3PZ6W8AN:01JC8Z5R0T2B6Y8C4V1N3K7QXE. It was sent to the queue again.',
    );
  });
});
