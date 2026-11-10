// Whether a control that one of the page's own sticky or fixed bars covers at this scroll position
// could be scrolled clear of every bar (used by fixtures.ts, expectNoAxeViolations). Pure, so a
// unit test can hold it (test/e2e-cover.test.ts); the page side measures and calls it.

/** A band of the window a bar holds: from the top edge down to `top`, or from `bottom` down. */
export interface Bands {
  /** The lowest bottom edge of the bars along the window's top, 0 with none. */
  top: number;
  /** The highest top edge of the bars along the window's foot, the window's height with none. */
  bottom: number;
}

/**
 * True when some scroll position puts the control (its top and bottom in the document, `docTop`
 * and `docBottom`) inside the window and between the bars: below the top band and above the foot
 * band. `maxScroll` is how far the page scrolls. A control taller than the room between the bands,
 * or one the page cannot scroll far enough to free (content at the very end, under a fixed bottom
 * nav), is not freeable: a finding there is the control's, not the viewport's.
 */
export function freeable(
  control: { docTop: number; docBottom: number },
  bands: Bands,
  maxScroll: number,
): boolean {
  // At scroll s the control spans docTop - s .. docBottom - s in the window.
  const lowest = Math.max(0, control.docBottom - bands.bottom);
  const highest = Math.min(maxScroll, control.docTop - bands.top);
  return lowest <= highest;
}
