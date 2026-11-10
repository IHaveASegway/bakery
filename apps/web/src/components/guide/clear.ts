// What a hotspot must not sit on, read from the page: its controls and its lines of text. The
// placing itself is pure (lib/guide.ts, spotPlaces and spotFits); this is the part only the page
// can answer.
import { lineBoxOf, overlapsBy, type Box } from '../../lib/guide';

const HEADINGS = 'h1, h2, h3, h4';
export const CONTROLS =
  'a[href], button, input, select, textarea, summary, label, [role="button"], [role="switch"], [tabindex]:not([tabindex="-1"])';

const boxOf = (r: DOMRect): Box => ({ top: r.top, left: r.left, width: r.width, height: r.height });
/** An element's line height in pixels, or NaN when it is `normal`. */
const lineHeightOf = (element: Element | null): number =>
  element === null ? Number.NaN : Number.parseFloat(getComputedStyle(element).lineHeight);
/** A line of an element's text as its line box (lib/guide.ts, lineBoxOf). */
const lineOf = (r: DOMRect, element: Element | null): Box =>
  lineBoxOf(boxOf(r), lineHeightOf(element));
/** How far a mark may reach into a line of text before it counts as lying on it, in pixels. */
const SLACK = 0.5;

/**
 * The heading a target is explained under: the target itself when it is one, its first heading,
 * or the nearest heading before it in the page (the menu's lead sentence sits under "Menu").
 */
function headingOf(target: Element): Element | null {
  if (target.matches(HEADINGS)) return target;
  const inside = target.querySelector(HEADINGS);
  if (inside !== null) return inside;
  for (let node: Element | null = target, depth = 0; node !== null && depth < 3; depth++) {
    for (
      let before = node.previousElementSibling;
      before !== null;
      before = before.previousElementSibling
    ) {
      if (before.matches(HEADINGS)) return before;
      const last = [...before.querySelectorAll(HEADINGS)].at(-1);
      if (last !== undefined) return last;
    }
    node = node.parentElement;
  }
  return null;
}

/** The box of the last line of text in the heading a target is explained under, in window terms. */
export function headingLine(target: Element): Box | null {
  const heading = headingOf(target);
  if (heading === null) return null;
  const range = document.createRange();
  range.selectNodeContents(heading);
  const lines = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  const last = lines.reduce<DOMRect | null>(
    (best, r) =>
      best === null || r.bottom > best.bottom || (r.bottom === best.bottom && r.right > best.right)
        ? r
        : best,
    null,
  );
  return last === null ? null : lineOf(last, heading);
}

/**
 * The box of the last line of a target's words, in window terms: where its sentence ends. Only
 * text counts, not the boxes of the controls inside it, so a paragraph that ends in a button has
 * its end inside that button, which the layer then refuses as a place.
 */
export function textEnd(target: Element): Box | null {
  let last: DOMRect | null = null;
  let within: Element | null = null;
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    if ((n.textContent ?? '').trim() === '') continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      if (r.width === 0 || r.height === 0) continue;
      if (
        last === null ||
        r.bottom > last.bottom ||
        (r.bottom === last.bottom && r.right > last.right)
      ) {
        last = r;
        within = n.parentElement;
      }
    }
  }
  return last === null ? null : lineOf(last, within);
}

/** The boxes of an element's own lines of text: its direct text, not its children's. */
function ownLines(element: Element): Box[] {
  const lines: Box[] = [];
  for (const node of element.childNodes) {
    if (node.nodeType !== Node.TEXT_NODE || (node.textContent ?? '').trim() === '') continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) lines.push(lineOf(r, element));
  }
  return lines;
}

/**
 * Whether `box` (window coordinates) is clear of the page: no control and no line of text under
 * any of its corners or its middle. The guide's own layer is not the page.
 */
export function clearOfPage(box: Box): boolean {
  const inset = 2;
  const points = [
    [box.left + inset, box.top + inset],
    [box.left + box.width - inset, box.top + inset],
    [box.left + inset, box.top + box.height - inset],
    [box.left + box.width - inset, box.top + box.height - inset],
    [box.left + box.width / 2, box.top + box.height / 2],
  ] as const;
  for (const [x, y] of points) {
    const under = document
      .elementsFromPoint(x, y)
      .find((el) => el.closest('[data-guide-root]') === null);
    if (under === undefined || under === document.documentElement || under === document.body) {
      continue;
    }
    if (under.closest(CONTROLS) !== null) return false;
    // The mark as drawn, inside its box's margin, against the lines of text: a wrapped heading's
    // first line ends a pixel or two into the margin of a mark set after its last line. Each line
    // is its line box, and a mark that only shares an edge with one is not on it.
    const drawn = {
      top: box.top + inset,
      left: box.left + inset,
      width: box.width - 2 * inset,
      height: box.height - 2 * inset,
    };
    if (ownLines(under).some((line) => overlapsBy(line, drawn, SLACK))) return false;
  }
  return true;
}

/**
 * The boxes, in window coordinates, of the page's controls showing in the window now: what a note
 * keeps clear of (lib/guide.ts, placeNote). The guide's own layer is not the page.
 */
export function controlBoxes(): Box[] {
  const view = { width: document.documentElement.clientWidth, height: window.innerHeight };
  const boxes: Box[] = [];
  for (const el of document.querySelectorAll(CONTROLS)) {
    if (el.closest('[data-guide-root]') !== null) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= view.height || r.left >= view.width) continue;
    boxes.push(boxOf(r));
  }
  return boxes;
}
