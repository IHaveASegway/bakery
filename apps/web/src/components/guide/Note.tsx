import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { placeNote } from '../../lib/guide';

/** Below this width a note is a sheet over the lower third of the window, placed by CSS alone. */
const PHONE = '(max-width: 40rem)';
/** The room kept at the foot of the window for the guide's bar, which a note never covers. */
const BAR_ROOM = 64;
/** The page's bars along the window's top: the console's top bar, the shop's masthead, the menu's categories. */
const TOP_BARS = '.topbar, .masthead, .category-bar';
/** Every bar a hotspot must keep off: those, the console's tab bar, the cart bar, the guide's bar. */
const BARS = `${TOP_BARS}, .sidebar, .cart-bar, .publish-bar, .guide-bar`;

/** The window-coordinate bottom of whatever bar shows along the window's top edge, else 0. */
export function topInset(): number {
  let inset = 0;
  for (const bar of document.querySelectorAll(TOP_BARS)) {
    const rect = bar.getBoundingClientRect();
    if (rect.height > 0 && rect.top <= 1 && rect.bottom > 0) inset = Math.max(inset, rect.bottom);
  }
  return Math.round(inset);
}

/** The boxes, in window coordinates, of the bars showing now. */
export function barBoxes() {
  return [...document.querySelectorAll(BARS)].flatMap((bar) => {
    const rect = bar.getBoundingClientRect();
    return rect.width === 0 || rect.height === 0
      ? []
      : [{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }];
  });
}

/** How long a note stays once its evidence stops changing, unless the pointer or focus is in it. */
export const LINGER_MS = 8_000;

/**
 * The anchor a note sits beside, at the moment it is drawn: the element itself while it is in the
 * page, else the next of `fallbacks` that is, else null (the note then sits in a corner). A card on
 * the board is drawn again in its new column after a move, so its old button is gone by the time
 * the event arrives; the board puts the focus on the new one, which is the first fallback.
 */
export function resolveAnchor(first: unknown, fallbacks: (() => Element | null)[]): Element | null {
  if (typeof Element === 'undefined') return null;
  if (first instanceof Element && first.isConnected) return around(first);
  for (const next of fallbacks) {
    const found = next();
    if (found !== null && found.isConnected) return around(found);
  }
  return null;
}

/**
 * The thing a pressed control is about: the card or row it sits in (a board card, a table row),
 * so the note sits beside the whole card and never over the card that just moved.
 */
export function around(element: Element): Element {
  return element.closest('li, tr') ?? element;
}

/**
 * A note: a dark card beside its anchor, with a caret pointing at it. It is not a dialog and takes
 * no focus; its position is computed after mount and set through the style object (never a style
 * attribute in the page's markup, which the policy forbids), and kept as the page scrolls. On a
 * phone, CSS makes it a sheet over the lower third. It closes itself after LINGER_MS of no change
 * unless it is pinned or the pointer or the focus is in it.
 */
export function Note({
  id,
  anchor,
  label,
  pinned,
  changed,
  onClose,
  children,
}: {
  id: string;
  anchor: () => Element | null;
  /** The note's accessible name. */
  label: string;
  pinned: boolean;
  /** A value that changes when the note's content does, which restarts its timer. */
  changed: unknown;
  onClose: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLElement>(null);
  const [inside, setInside] = useState({ pointer: false, focus: false });
  const [corner, setCorner] = useState(false);

  // Place the note beside its anchor, ring the anchor, and keep both right while the page
  // scrolls, resizes or redraws (a card that moved is a new element), one frame at a time.
  useLayoutEffect(() => {
    const note = box.current;
    if (note === null) return;
    let frame = 0;
    let ringed: Element | null = null;
    const ring = (target: Element | null) => {
      if (target === ringed) return;
      ringed?.removeAttribute('data-guide-anchor');
      target?.setAttribute('data-guide-anchor', '');
      ringed = target;
    };
    const place = () => {
      frame = 0;
      const target = anchor();
      ring(target);
      if (window.matchMedia(PHONE).matches || target === null) {
        note.style.removeProperty('top');
        note.style.removeProperty('left');
        note.removeAttribute('data-side');
        setCorner(target === null);
        return;
      }
      const rect = target.getBoundingClientRect();
      const at = placeNote(
        { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        { width: note.offsetWidth, height: note.offsetHeight },
        { width: document.documentElement.clientWidth, height: window.innerHeight - BAR_ROOM },
      );
      setCorner(false);
      note.style.top = `${Math.round(at.top)}px`;
      note.style.left = `${Math.round(at.left)}px`;
      note.style.setProperty('--guide-caret', `${Math.round(at.caret)}px`);
      if (at.side === 'none') note.removeAttribute('data-side');
      else note.setAttribute('data-side', at.side);
    };
    const soon = () => {
      if (frame === 0) frame = requestAnimationFrame(place);
    };
    place();
    window.addEventListener('scroll', soon, { passive: true, capture: true });
    window.addEventListener('resize', soon);
    const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(soon);
    sizes?.observe(note);
    const main = document.querySelector('main');
    const redraws = typeof MutationObserver === 'undefined' ? null : new MutationObserver(soon);
    if (main !== null) redraws?.observe(main, { childList: true, subtree: true });
    // The focus moving (the board puts it on a moved card's next button) can change the anchor.
    document.addEventListener('focusin', soon);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', soon, { capture: true });
      window.removeEventListener('resize', soon);
      sizes?.disconnect();
      redraws?.disconnect();
      document.removeEventListener('focusin', soon);
      ring(null);
    };
  }, [anchor, changed]);

  // Close after a while, unless pinned or in use.
  useEffect(() => {
    if (pinned || inside.pointer || inside.focus) return;
    const timer = window.setTimeout(onClose, LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [pinned, inside, changed, onClose]);

  return (
    <section
      ref={box}
      id={id}
      className={corner ? 'guide-note guide-corner' : 'guide-note'}
      aria-label={label}
      onPointerEnter={() => setInside((s) => ({ ...s, pointer: true }))}
      onPointerLeave={() => setInside((s) => ({ ...s, pointer: false }))}
      onFocus={() => setInside((s) => ({ ...s, focus: true }))}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setInside((s) => ({ ...s, focus: false }));
        }
      }}
    >
      {children}
    </section>
  );
}
