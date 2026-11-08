// The console's in-page navigation, the skip past the board, and the menu tour's first-card
// target (audit C26, P3). Static renders show the first paint; effects do not run in them, so each
// panel draws its heading and its first-read text, which is all these checks need.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { SandboxResponse } from '../src/contracts';
import SandboxView from '../src/components/SandboxView';
import { AFTER_BOARD, CONSOLE_SECTIONS } from '../src/lib/console-sections';
import MenuList from '../src/components/MenuList';
import { STATIC_MENU } from '../src/lib/menu';
import { TOURS } from '../src/tour';
import { CONSOLE_ORDER } from '../src/tour/index';

const sandbox = (state: SandboxResponse['state']): SandboxResponse => ({
  born: '2026-11-08T09:00:00Z',
  children: 14,
  clock_offset_s: 0,
  clock_v: 0,
  faults: { inbox: false, kitchen: false },
  id: 'sandbox-nav-test',
  kind: 'account',
  persona: 'persona-nav-test',
  persona_address: {
    city: 'Salt Lake City',
    country: 'US',
    line1: 'p17, unit 3 (synthetic)',
    postal_code: '84101',
    state: 'UT',
  },
  persona_name: 'Test Customer',
  seed: 7,
  state,
  token_v: 0,
  wipe_at: '2026-11-09T10:00:00Z',
});

const render = (state: SandboxResponse['state'], isGuest = false) =>
  renderToStaticMarkup(
    createElement(SandboxView, {
      sandbox: sandbox(state),
      isGuest,
      busy: false,
      error: null,
      onReload: () => undefined,
      onBoardWiped: () => undefined,
      onFault: () => undefined,
      onWipe: () => undefined,
      onReplace: () => undefined,
    }),
  );

const idsIn = (html: string, tag: string) =>
  [...html.matchAll(new RegExp(`<${tag}[^>]*\\sid="([^"]+)"`, 'g'))].map((m) => m[1]);

describe('the console’s “On this page” list', () => {
  const html = render('live');
  const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));

  test('is a labelled nav that lists every section in console-sections.ts, in order', () => {
    expect(nav).toContain('aria-label="On this page"');
    const hrefs = [...nav.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(CONSOLE_SECTIONS.map((s) => s.id));
  });

  test('every link has words, and every id is listed once', () => {
    const ids = CONSOLE_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of CONSOLE_SECTIONS) {
      expect(s.label.trim(), s.id).not.toBe('');
      expect(nav, s.id).toContain(`>${s.label}</a>`);
    }
  });

  test('every id is a heading in the render, and focusable by script', () => {
    for (const s of CONSOLE_SECTIONS) {
      const heading = html.match(new RegExp(`<h[34][^>]*\\sid="${s.id}"[^>]*>`));
      expect(heading, s.id).not.toBeNull();
      expect(heading?.[0], s.id).toContain('tabindex="-1"');
    }
  });

  test('the headings come in the list’s order, and no heading id repeats', () => {
    const found = [...html.matchAll(/<h3[^>]*\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(found).toEqual(CONSOLE_SECTIONS.map((s) => s.id));
    const all = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(all).size).toBe(all.length);
  });

  test('keeps the ids that existed before the list', () => {
    const ids = CONSOLE_SECTIONS.map((s) => s.id);
    for (const id of [
      'feed-heading',
      'bake-heading',
      'ledger-heading',
      'customers-heading',
      'segments-heading',
      'campaigns-heading',
      'leads-heading',
      'activity-heading',
      'token-heading',
      'catering-queue-heading',
    ]) {
      expect(ids, id).toContain(id);
    }
  });

  test('while the sandbox is seeding the list holds only the sections that exist', () => {
    const seeding = render('seeding');
    const listed = [...seeding.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    expect(listed).toEqual(CONSOLE_SECTIONS.filter((s) => !s.live).map((s) => s.id));
    for (const id of listed) expect(seeding).toContain(`id="${id}"`);
  });

  test('a guest’s page has the same sections', () => {
    expect(idsIn(render('live', true), 'h3')).toEqual(CONSOLE_SECTIONS.map((s) => s.id));
  });
});

describe('the skip past the board’s cards', () => {
  const html = render('live');

  test('is the first link in the board, before any card, and says what it skips', () => {
    const board = html.slice(
      html.indexOf('id="board-heading"'),
      html.indexOf(`id="${AFTER_BOARD}"`),
    );
    expect(board).toContain(
      `<a class="skip-inline" href="#${AFTER_BOARD}">Skip the board’s cards</a>`,
    );
    expect(board.indexOf('skip-inline')).toBeLessThan(board.indexOf('class="column"'));
  });

  test('lands on a heading that exists, the first section after the board', () => {
    expect(html).toContain(`id="${AFTER_BOARD}"`);
    const ids = CONSOLE_SECTIONS.map((s) => s.id);
    expect(ids[ids.indexOf('board-heading') + 1]).toBe(AFTER_BOARD);
  });
});

describe('the console tour still reaches every target', () => {
  const html = render('live');
  test('each step’s data-tour target is drawn by the console’s first paint', () => {
    const targets = new Set([...html.matchAll(/data-tour="([^"]+)"/g)].map((m) => m[1]));
    // Panels that draw only after a read answers are not in a first paint; the rest must be.
    const drawn = TOURS.console.filter((s) => targets.has(s.target));
    expect(drawn.length).toBeGreaterThan(15);
    expect(TOURS.console.map((s) => s.id)).toEqual(CONSOLE_ORDER);
  });
});

describe('the menu tour on a phone', () => {
  test('the steps run in the page’s order: the cart, the list, where the menu came from', () => {
    expect(TOURS.menu.map((s) => s.id)).toEqual(['menu-cart', 'menu-list', 'menu-how']);
  });

  test('the list step rings one card, the first, and nothing taller than a screen', () => {
    const html = renderToStaticMarkup(
      createElement(MenuList, { menu: STATIC_MENU, onAdd: () => undefined }),
    );
    expect(html.match(/data-tour="menu-list"/g)).toHaveLength(1);
    // It is the first card of the first category, not the list or a category.
    const cards = [...html.matchAll(/<li[^>]*class="item"[^>]*>/g)].map((m) => m[0]);
    expect(cards.length).toBeGreaterThan(1);
    expect(cards[0]).toContain('data-tour="menu-list"');
    for (const card of cards.slice(1)) expect(card).not.toContain('data-tour');
    expect(html).toContain('<div class="menu">');
  });

  test('the list step’s words say what is ringed', () => {
    const step = TOURS.menu.find((s) => s.id === 'menu-list')!;
    expect(step.what).toContain('first card');
  });
});
