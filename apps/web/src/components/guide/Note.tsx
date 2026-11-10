import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { placeNote, type Box } from '../../lib/guide';
import { controlBoxes } from './clear';

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

/** The room under a phone's sheet: the console's tab bar or the menu's cart bar, else a margin. */
function footRoom(): number {
  return document.querySelector('.shell-app, .cart-bar') !== null ? 72 : 8;
}

/** How long a note stays once its evidence stops changing, unless the pointer or focus is in it. */
export const LINGER_MS = 8_000;

/**
 * Where a note about a thing on a dense screen goes in the page's flow (ADR 0014's postscript of
 * 2026-11-10, decision D1): after the moved card or table row; else after the result line the
 * press wrote near it (a line marked data-guide-result, a form's messages); else at the end of the
 * small part the press was in (a panel, a form, a card); else after the pressed control's own
 * block. Only on the console's workspaces, wider than a phone, and only inside the page's main
 * column: elsewhere a note floats beside its anchor, as before. `pressed` is the control pressed,
 * while it is in the page.
 */
export type FlowPlace = { after: Element } | { inside: Element };

const REGION = 'form, fieldset, section, article, .panel';
const RESULT = '[data-guide-result], .messages';

/** Whether an element lays its children out side by side: a row of flex items, a grid's columns. */
function isRow(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.display.includes('flex')) return !style.flexDirection.startsWith('column');
  if (style.display.includes('grid'))
    return style.gridTemplateColumns.trim().split(/\s+/).length > 1;
  return false;
}

/**
 * The block a note can follow: the element itself, or the nearest ancestor below `main` that is
 * not inline and not one of a row's items (a flex item's inline-flex reads as flex), so a note
 * never lands in a row of buttons.
 */
function blockOf(el: Element, main: Element): Element {
  let block = el;
  while (
    block.parentElement !== null &&
    block.parentElement !== main &&
    (getComputedStyle(block).display.startsWith('inline') || isRow(block.parentElement))
  ) {
    block = block.parentElement;
  }
  return block;
}

export function flowPlace(anchor: Element | null, pressed: Element | null): FlowPlace | null {
  if (anchor === null || typeof document === 'undefined') return null;
  if (!document.body.classList.contains('shell-app')) return null;
  if (window.matchMedia(PHONE).matches) return null;
  const main = anchor.closest('main');
  if (main === null) return null;
  if (anchor.matches('li, tr')) return { after: anchor };
  // A control in a bar that sticks to the window (the menu's Publish bar) has its place in the
  // flow far from where it is seen: its note floats beside it instead.
  for (let el: Element | null = anchor; el !== null && el !== main; el = el.parentElement) {
    const position = getComputedStyle(el).position;
    if (position === 'sticky' || position === 'fixed') return null;
  }
  const from = pressed !== null && pressed.isConnected && main.contains(pressed) ? pressed : anchor;
  const reach = 0.5 * window.innerHeight;
  const bottom = anchor.getBoundingClientRect().bottom;
  // The first result line at or after the anchor in its part of the page, near enough under it,
  // with something said.
  const part = from.closest('section, article, .panel');
  const scope = part !== null && main.contains(part) ? part : main;
  for (const line of scope.querySelectorAll(RESULT)) {
    const after =
      line === anchor ||
      (anchor.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    if (!after || line.contains(anchor) || (line.textContent ?? '').trim() === '') continue;
    if (line.getBoundingClientRect().top - bottom > reach) break;
    return { after: blockOf(line, main) };
  }
  const region = from.closest(REGION);
  if (region !== null && region !== main && main.contains(region) && !isRow(region)) {
    if (region.getBoundingClientRect().bottom - bottom <= reach) return { inside: region };
  }
  return { after: blockOf(anchor, main) };
}

/** The element a note in the flow is drawn into: a list item, a table row's cell, or a block. */
function makeSlot(host: Element, inside: boolean): { slot: HTMLElement; content: HTMLElement } {
  const parent = inside ? host : host.parentElement;
  const tag = parent?.matches('ul, ol') ? 'li' : host.matches('tr') && !inside ? 'tr' : 'div';
  const slot = document.createElement(tag);
  slot.className = 'guide-layer guide-flow';
  slot.setAttribute('data-guide-root', '');
  if (tag !== 'tr') return { slot, content: slot };
  const cell = document.createElement('td');
  cell.colSpan = Math.max(1, (host as HTMLTableRowElement).cells.length);
  slot.append(cell);
  return { slot, content: cell };
}

/** Puts the slot where `place` says, moving it only when it is not there already. */
function putSlot(slot: HTMLElement, place: FlowPlace): void {
  if ('after' in place) {
    if (slot.previousElementSibling !== place.after) place.after.after(slot);
  } else if (place.inside.lastElementChild !== slot) {
    place.inside.append(slot);
  }
}

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
  onCrowded,
  keepClear,
  flow,
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
  /**
   * Called when the note arrives beside an element and no place by it, nor a corner, is clear of
   * the page's controls. The caller may fold it to its line rather than lay it over the next thing
   * to press, and says true; otherwise, or without it, the note takes the place that covers least.
   */
  onCrowded?: (() => boolean) | undefined;
  /**
   * What this note must never cover, in window boxes: the pressed control, the result it made, and
   * what the visitor presses next (Layer.tsx). Without it, every control on the page.
   */
  keepClear?: (() => Box[] | null) | undefined;
  /**
   * Where the note goes in the page's flow (flowPlace), or null to float beside its anchor. Asked
   * again on each placing, so a card drawn again in its new column takes the note with it.
   */
  flow?: ((anchor: Element | null) => FlowPlace | null) | undefined;
  children: ReactNode;
}) {
  const box = useRef<HTMLElement>(null);
  const [inside, setInside] = useState({ pointer: false, focus: false });
  const [corner, setCorner] = useState(false);
  const crowded = useRef(onCrowded);
  crowded.current = onCrowded;
  const keep = useRef(keepClear);
  keep.current = keepClear;
  const flowRef = useRef(flow);
  flowRef.current = flow;
  // The note's place in the page's flow, while it has one: the slot and what it is drawn into.
  const [slot, setSlot] = useState<{ slot: HTMLElement; content: HTMLElement } | null>(null);
  const slotRef = useRef(slot);
  slotRef.current = slot;
  const scrolledFor = useRef<Element | null>(null);
  // Whether the note has a place by the element it is beside now; a new element (the pressed
  // control gone, a fallback in its place) is a new arrival, judged afresh.
  const arrived = useRef<Element | null>(null);
  const arrivedAt = useRef(0);
  /** The end of the window a phone's sheet took when it arrived. */
  const sheet = useRef<'foot' | 'head' | null>(null);

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
      // In the page's flow: the slot goes where flowPlace says, and the page shows the note by
      // scrolling only as far as it must, never past the anchor's top (D1).
      const where = flowRef.current?.(target) ?? null;
      const held = slotRef.current;
      if (where !== null) {
        const host = 'after' in where ? where.after : where.inside;
        const made = held ?? makeSlot(host, 'inside' in where);
        putSlot(made.slot, where);
        if (held === null) {
          setSlot(made);
          return;
        }
        note.style.removeProperty('top');
        note.style.removeProperty('left');
        note.style.removeProperty('max-height');
        note.removeAttribute('data-side');
        setCorner(false);
        if (target !== null && scrolledFor.current !== target) {
          scrolledFor.current = target;
          const n = note.getBoundingClientRect();
          const room = window.innerHeight - BAR_ROOM;
          const over = n.bottom - room;
          const most = target.getBoundingClientRect().top - topInset() - 8;
          const by = Math.min(over, most);
          if (by > 0) {
            const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            window.scrollBy({ top: by, behavior: calm ? 'auto' : 'smooth' });
          }
        }
        return;
      }
      if (held !== null) {
        setSlot(null);
        return;
      }
      // The element it sat by has gone and nothing stands in for it (a button the page replaced):
      // the caller may fold it to its line rather than leave it in a corner over the page (F6).
      if (target === null && arrived.current !== null && crowded.current?.() === true) return;
      if (window.matchMedia(PHONE).matches || target === null) {
        note.style.removeProperty('top');
        note.style.removeProperty('left');
        note.style.removeProperty('max-height');
        note.removeAttribute('data-side');
        setCorner(target === null);
        // A phone's sheet sits at the foot or at the top, under the page's bars. Where it arrives,
        // it takes the end that covers fewer of the page's controls, the foot on a tie; never the
        // end over what the visitor pressed. It keeps that end while the page scrolls, so it
        // never jumps under a reading eye, unless the pressed control comes under it.
        if (!window.matchMedia(PHONE).matches) {
          note.removeAttribute('data-sheet');
          return;
        }
        const h = note.offsetHeight;
        const foot = {
          top: window.innerHeight - h - footRoom(),
          left: 0,
          width: window.innerWidth,
          height: h,
        };
        const head = { top: topInset() + 8, left: 0, width: window.innerWidth, height: h };
        const a = target?.getBoundingClientRect();
        const over = (box: typeof foot, r: { top: number; bottom: number }) =>
          r.top < box.top + box.height && r.bottom > box.top;
        const footBad = a !== undefined && over(foot, a);
        const headBad = a !== undefined && over(head, a);
        if (sheet.current === null || (sheet.current === 'foot' ? footBad : headBad)) {
          const count = (box: typeof foot) =>
            controlBoxes().filter((c) => over(box, { top: c.top, bottom: c.top + c.height }))
              .length;
          sheet.current =
            footBad && !headBad
              ? 'head'
              : headBad && !footBad
                ? 'foot'
                : count(head) < count(foot)
                  ? 'head'
                  : 'foot';
        }
        if (sheet.current === 'head') note.setAttribute('data-sheet', 'top');
        else note.removeAttribute('data-sheet');
        return;
      }
      // A note never runs past the window's foot: taller than the room, it scrolls inside itself.
      note.style.maxHeight = `${Math.max(160, window.innerHeight - BAR_ROOM - topInset() - 16)}px`;
      const rect = target.getBoundingClientRect();
      const anchorBox = { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
      const size = { width: note.offsetWidth, height: note.offsetHeight };
      const view = {
        width: document.documentElement.clientWidth,
        height: window.innerHeight - BAR_ROOM,
        top: topInset(),
      };
      // Best, clear of every control on the page; else clear of what matters to this press (the
      // pressed control, its result, what is pressed next: audit G3), beside the anchor or, with
      // no room there, docked in the first corner clear of them, the same each time on a page.
      // null: keep clear of every control (a note by a fallback), else of what matters to the press.
      const asked = keep.current?.();
      const matters = asked ?? [];
      const everywhere = placeNote(anchorBox, size, view, [...controlBoxes(), ...matters]);
      let at =
        everywhere.clear || asked === undefined || asked === null
          ? everywhere
          : placeNote(anchorBox, size, view, matters);
      // Too tall to sit clear of them (a wide result line across the board, a long chain): the
      // note takes the larger band above or below its anchor and scrolls inside itself.
      if (!at.clear && asked !== undefined && asked !== null) {
        const below = view.height - (anchorBox.top + anchorBox.height) - 12 - 8;
        const above = anchorBox.top - 12 - (view.top + 8);
        const band = Math.max(below, above);
        if (band >= 200 && band < size.height) {
          note.style.maxHeight = `${Math.round(band)}px`;
          at = placeNote(
            anchorBox,
            { width: note.offsetWidth, height: note.offsetHeight },
            view,
            matters,
          );
        }
      }
      // Only where it arrives: a note the visitor is reading never folds away under them.
      // Judged where it arrives, and again while the page settles under it in its first 2 s (the
      // checkout's steps drawn after the gate), never later under a reading eye.
      const settling = performance.now() - arrivedAt.current < 2_000;
      if (!at.clear && (arrived.current !== target || settling) && crowded.current?.() === true) {
        return;
      }
      if (arrived.current !== target) arrivedAt.current = performance.now();
      arrived.current = target;
      setCorner(false);
      note.style.top = `${Math.round(at.top)}px`;
      note.style.left = `${Math.round(at.left)}px`;
      note.style.setProperty('--guide-caret', `${Math.round(at.caret)}px`);
      if (at.side === 'none') note.removeAttribute('data-side');
      else note.setAttribute('data-side', at.side);
    };
    // More below the note's edge, and not yet scrolled to: the foot fades (guide.css).
    const more = () => {
      const left = note.scrollHeight - note.clientHeight - note.scrollTop;
      if (left > 4) note.setAttribute('data-more', '');
      else note.removeAttribute('data-more');
    };
    const soon = () => {
      if (frame === 0) {
        frame = requestAnimationFrame(() => {
          place();
          more();
        });
      }
    };
    place();
    more();
    note.addEventListener('scroll', more, { passive: true });
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
      note.removeEventListener('scroll', more);
      ring(null);
    };
  }, [anchor, changed, slot]);

  // The slot is the note's own element in the page: it goes when the note does.
  useEffect(() => {
    if (slot === null) return;
    return () => slot.slot.remove();
  }, [slot]);

  // Where the pointer is, so a note in the flow never leaves from under it: what is below the
  // note would move up into the place the pointer is.
  const pointer = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (slot === null) return;
    const track = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
    };
    document.addEventListener('pointermove', track, { passive: true });
    return () => document.removeEventListener('pointermove', track);
  }, [slot]);

  // Close after a while, unless pinned or in use. A note in the flow folds shut over a fifth of a
  // second, and waits while the pointer is below it in its column or panel, which would rise.
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (pinned || inside.pointer || inside.focus) return;
    let timer = 0;
    const leave = () => {
      const held = slotRef.current;
      if (held === null) {
        onClose();
        return;
      }
      const box = held.slot.parentElement?.getBoundingClientRect();
      const at = pointer.current;
      const top = held.slot.getBoundingClientRect().top;
      if (box !== undefined && at !== null && at.y > top && at.y < box.bottom) {
        if (at.x > box.left && at.x < box.right) {
          timer = window.setTimeout(leave, 2_000);
          return;
        }
      }
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        onClose();
        return;
      }
      setLeaving(true);
      timer = window.setTimeout(onClose, 220);
    };
    timer = window.setTimeout(leave, LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [pinned, inside, changed, onClose]);
  useEffect(() => {
    if (slot === null) return;
    if (leaving) slot.slot.setAttribute('data-leaving', '');
    else slot.slot.removeAttribute('data-leaving');
  }, [slot, leaving]);

  const section = (
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
  return slot === null ? section : createPortal(section, slot.content);
}
