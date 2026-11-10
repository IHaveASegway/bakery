// Where a note goes in the page's flow, as pure decisions over facts the page was read for
// (Note.tsx, flowPlace, reads them), so each rule has a unit test.

/** After an element, or as the last child inside one. */
export type FlowPlace<E> = { after: E } | { inside: E };

/** What the page says about a pressed control's surroundings, read once per placing. */
export interface PlaceFacts<E> {
  /** The element the note explains: a card, a row, a result line, or the pressed control. */
  anchor: E;
  /** The anchor is a list item or a table row. */
  item: boolean;
  /** Its list lays its items side by side (a row of buttons, not a column of cards). */
  itemsInARow: boolean;
  /** The anchor is in a bar that sticks to the window, or is fixed. */
  sticky: boolean;
  /** The first result line after the anchor, near enough under it, lifted to its block. */
  result: E | null;
  /** That result line is in the window now. */
  resultInView: boolean;
  /**
   * The last thing the press made in the page near the anchor (a new draft card, a proposal's
   * table), lifted to its block: it comes first, and the note goes below it.
   */
  made: E | null;
  /** The small part the press was in (a panel, a form), when it may hold the note at its end. */
  region: E | null;
  /** The region's bottom less the anchor's, in pixels, measured without the note in it. */
  regionBelow: number;
  /** How far below the anchor the note may go: half the window. */
  reach: number;
  /** The anchor's own block, outside any row of controls. */
  block: E;
}

/**
 * Where the note goes, or null to float beside its anchor. A bar that sticks to the window is
 * asked about first: its place in the flow is far from where it is seen, so its note floats (just
 * above the bar, Note.tsx). Then a card or a row in a column of them: the note goes after it, in
 * its list; an item of a row of controls is not, and its note goes after the row's block. Then
 * what the press made, which comes first; then its result line; then the end of a small region;
 * else the anchor's own block.
 */
export function choosePlace<E>(f: PlaceFacts<E>): FlowPlace<E> | null {
  if (f.sticky) return null;
  if (f.item && !f.itemsInARow) return { after: f.anchor };
  if (f.made !== null) return { after: f.made };
  if (f.result !== null) return { after: f.result };
  if (f.region !== null && f.regionBelow <= f.reach) return { inside: f.region };
  return { after: f.block };
}

/**
 * The region's room below the anchor, measured as the page would be without the note: a note
 * already at the region's end does not count, so a placed note never measures itself out of its
 * place on the next frame.
 */
export function regionBelow(
  regionBottom: number,
  anchorBottom: number,
  noteInRegion: number,
): number {
  return regionBottom - noteInRegion - anchorBottom;
}

/** The tag a slot must have to fit where it goes: an item in a list, a row in a table, else a block. */
export function slotTag(parentTag: string, hostTag: string, inside: boolean): 'li' | 'tr' | 'div' {
  if (parentTag === 'ul' || parentTag === 'ol') return 'li';
  if (hostTag === 'tr' && !inside) return 'tr';
  return 'div';
}

/** Whether a slot of `current` must be made anew to sit where `wanted` fits. */
export function remakeSlot(current: string, wanted: string): boolean {
  return current !== wanted;
}
