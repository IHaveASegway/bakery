// The console as seven pages (design brief, 2026-11-09): the sidebar's workspaces, each page's
// sections in order, the old anchors of the one-page console, the skip past the board, and the
// menu tour's first-card target (audit C26, P3). Static renders show the first paint; effects do
// not run in them, so each panel draws its heading and its first-read text, which is all these
// checks need.
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { SandboxResponse } from '../src/contracts';
import type { WorkspaceProps } from '../src/components/Console';
import ConsoleNav from '../src/components/ConsoleNav';
import MenuList from '../src/components/MenuList';
import { CateringView } from '../src/components/workspaces/Catering';
import { CustomersView } from '../src/components/workspaces/Customers';
import { KitchenView } from '../src/components/workspaces/Kitchen';
import { MenuView } from '../src/components/workspaces/Menu';
import { MoneyView } from '../src/components/workspaces/Money';
import { SystemView } from '../src/components/workspaces/System';
import {
  AFTER_BOARD,
  CONSOLE_SECTIONS,
  WORKSPACES,
  movedAnchor,
  sectionsOf,
  workspaceAt,
  type WorkspaceId,
} from '../src/lib/console-sections';
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

// Dispatch is its own island (components/Dispatch.tsx) and has no section of this list.
const VIEWS: Partial<Record<WorkspaceId, ComponentType<WorkspaceProps>>> = {
  kitchen: KitchenView,
  money: MoneyView,
  menu: MenuView,
  catering: CateringView,
  customers: CustomersView,
  system: SystemView,
};

const render = (id: WorkspaceId, state: SandboxResponse['state'] = 'live', isGuest = false) =>
  renderToStaticMarkup(
    createElement(VIEWS[id]!, {
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

describe('the sidebar', () => {
  test('lists the seven workspaces, each a page, and marks the current one', () => {
    const html = renderToStaticMarkup(createElement(ConsoleNav, { here: 'money' }));
    expect(html).toContain('aria-label="Console"');
    for (const ws of WORKSPACES) expect(html, ws.id).toContain(`href="${ws.path}"`);
    expect(html).toMatch(/href="\/app\/money\/" aria-current="page"/);
    // The entry; on a phone its copy under "More", and "More" itself.
    expect(html.match(/aria-current="page"/g)).toHaveLength(3);
  });

  test('on a phone four workspaces are tabs and the others sit under More', () => {
    const html = renderToStaticMarkup(createElement(ConsoleNav, { here: 'kitchen' }));
    expect(html.match(/class="tab"/g)).toHaveLength(4);
    expect(html.match(/class="tab-overflow"/g)).toHaveLength(3);
    expect(html).toContain('<details class="tab-more">');
  });

  test('each page’s path names its workspace, and nothing else does', () => {
    for (const ws of WORKSPACES) expect(workspaceAt(ws.path)).toBe(ws.id);
    expect(workspaceAt('/menu/')).toBeNull();
  });
});

describe('each workspace’s sections', () => {
  test('every section is a focusable heading on its own page, in the list’s order', () => {
    for (const id of Object.keys(VIEWS) as WorkspaceId[]) {
      const html = render(id);
      const found = [...html.matchAll(/<h3[^>]*\sid="([^"]+)"/g)].map((m) => m[1]);
      expect(found, id).toEqual(sectionsOf(id).map((s) => s.id));
      for (const s of sectionsOf(id)) {
        expect(html, s.id).toMatch(new RegExp(`<h3[^>]*\\sid="${s.id}"[^>]*tabindex="-1"`));
      }
      const all = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
      expect(new Set(all).size, id).toBe(all.length);
    }
  });

  test('every section belongs to a workspace with a page', () => {
    const pages = new Set(WORKSPACES.map((w) => w.id));
    for (const s of CONSOLE_SECTIONS) expect(pages.has(s.workspace), s.id).toBe(true);
  });

  test('while the sandbox is seeding, the system page has the sandbox and its actions only', () => {
    const html = render('system', 'seeding');
    const found = [...html.matchAll(/<h3[^>]*\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(found).toEqual(sectionsOf('system', false).map((s) => s.id));
    expect(render('kitchen', 'seeding')).toContain('Seeding your bakery');
  });

  test('a guest’s pages have the same sections', () => {
    for (const id of Object.keys(VIEWS) as WorkspaceId[]) {
      const found = [...render(id, 'live', true).matchAll(/<h3[^>]*\sid="([^"]+)"/g)].map(
        (m) => m[1],
      );
      expect(found, id).toEqual(sectionsOf(id).map((s) => s.id));
    }
  });
});

describe('the one-page console’s anchors', () => {
  test('each moved section’s old anchor, with or without -heading, goes to its new page', () => {
    expect(movedAnchor('#ledger-heading')).toBe('/app/money/#ledger-heading');
    expect(movedAnchor('#ledger')).toBe('/app/money/#ledger-heading');
    expect(movedAnchor('#clock-heading')).toBe('/app/system/#clock-heading');
    expect(movedAnchor('#catering-queue-heading')).toBe('/app/catering/#catering-queue-heading');
    for (const s of CONSOLE_SECTIONS.filter((s) => s.workspace !== 'kitchen')) {
      const page = WORKSPACES.find((w) => w.id === s.workspace)!.path;
      expect(movedAnchor(`#${s.id}`), s.id).toBe(`${page}#${s.id}`);
    }
  });

  test('the kitchen’s anchors stay on /app/, and an unknown one goes nowhere', () => {
    for (const s of sectionsOf('kitchen')) expect(movedAnchor(`#${s.id}`), s.id).toBeNull();
    expect(movedAnchor('#main')).toBeNull();
    expect(movedAnchor('')).toBeNull();
  });
});

describe('the skip past the board’s cards', () => {
  const html = render('kitchen');

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
    const ids = sectionsOf('kitchen').map((s) => s.id);
    expect(ids[ids.indexOf('board-heading') + 1]).toBe(AFTER_BOARD);
  });
});

describe('the console tour still reaches every target', () => {
  test('each step’s data-tour target is drawn by the first paint of one of the pages', () => {
    const html = (Object.keys(VIEWS) as WorkspaceId[]).map((id) => render(id)).join('');
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
