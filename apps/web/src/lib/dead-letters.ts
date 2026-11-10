import type { DeadLetter } from '../contracts';

/**
 * The console's words for a dead letter's `made_while_off` mark (roadmap R67): such a letter was
 * kept but not counted on the status page. The mark says when the message died, not why, so the
 * words do not claim the switch killed it. `null` for a letter without the mark, and for an answer
 * from an API older than the field.
 */
export function whileOffNote(letter: Pick<DeadLetter, 'made_while_off'>): string | null {
  return letter.made_while_off === true
    ? 'Made while the bakery was off, or just after: kept, not counted on the status page. A real fault at that time is marked too.'
    : null;
}

/** What the console says after a redrive, the same for a marked letter and any other. */
export function redriveSaid(letter: Pick<DeadLetter, 'type' | 'stream'>): string {
  return `Redrove ${letter.type} for ${letter.stream}. It was sent to the queue again.`;
}
