// The console's seven workspaces and their sections (design brief, 2026-11-09). Each workspace is a
// page of its own in the app shell, with its own address and island; the sidebar lists the
// workspaces, and each page renders its sections in the order given here. A test checks that every
// section's id is a heading on its workspace's page, so a section added without a line here, or a
// line without a heading, fails. Until 2026-11-09 the sections were one page, /app/, and their ids
// were its anchors: /app/'s redirect sends an old anchor (`/app/#ledger-heading`, or `#ledger`) to
// the section's new address.

export type WorkspaceId =
  'kitchen' | 'money' | 'menu' | 'catering' | 'customers' | 'dispatch' | 'system';

export interface Workspace {
  id: WorkspaceId;
  /** The workspace's name: the sidebar's entry and the page's heading. */
  label: string;
  /** The page's address. */
  path: string;
}

export const WORKSPACES: readonly Workspace[] = [
  { id: 'kitchen', label: 'Kitchen', path: '/app/' },
  { id: 'money', label: 'Money', path: '/app/money/' },
  { id: 'menu', label: 'Menu', path: '/app/menu/' },
  { id: 'catering', label: 'Catering', path: '/app/catering/' },
  { id: 'customers', label: 'Customers', path: '/app/customers/' },
  { id: 'dispatch', label: 'Dispatch', path: '/app/dispatch/' },
  { id: 'system', label: 'System', path: '/app/system/' },
];

/** The phone's tab bar holds these four; the other three sit under "More". */
export const TABS: readonly WorkspaceId[] = ['kitchen', 'menu', 'catering', 'customers'];

export interface ConsoleSection {
  /** The id of the section's heading, the target of a link to it. */
  id: string;
  /** What the section is called. */
  label: string;
  /** True for a section that exists only once the sandbox has been seeded. */
  live: boolean;
  /** The workspace the section belongs to. */
  workspace: WorkspaceId;
}

export const CONSOLE_SECTIONS: readonly ConsoleSection[] = [
  { id: 'board-heading', label: 'Kitchen board', live: true, workspace: 'kitchen' },
  { id: 'feed-heading', label: 'Activity feed', live: true, workspace: 'kitchen' },
  { id: 'bake-heading', label: 'Bake list', live: true, workspace: 'kitchen' },
  { id: 'ledger-heading', label: 'Ledger', live: true, workspace: 'money' },
  { id: 'menu-heading', label: 'Menu', live: true, workspace: 'menu' },
  { id: 'capacity-heading', label: 'Capacity', live: true, workspace: 'menu' },
  { id: 'catering-queue-heading', label: 'Catering queue', live: true, workspace: 'catering' },
  { id: 'leads-heading', label: 'Catering lead pipeline', live: true, workspace: 'catering' },
  { id: 'customers-heading', label: 'Customers', live: true, workspace: 'customers' },
  { id: 'segments-heading', label: 'Segments', live: true, workspace: 'customers' },
  { id: 'campaigns-heading', label: 'Campaigns', live: true, workspace: 'customers' },
  { id: 'activity-heading', label: 'Activity', live: true, workspace: 'customers' },
  { id: 'rebuild-heading', label: 'Rebuild projections', live: true, workspace: 'customers' },
  { id: 'sandbox-heading', label: 'Your sandbox', live: false, workspace: 'system' },
  { id: 'token-heading', label: 'API token', live: true, workspace: 'system' },
  { id: 'clock-heading', label: 'Clock', live: true, workspace: 'system' },
  { id: 'traffic-heading', label: 'Simulated traffic', live: true, workspace: 'system' },
  { id: 'faults-heading', label: 'Faults', live: true, workspace: 'system' },
  { id: 'dead-letters-heading', label: 'Dead letters', live: true, workspace: 'system' },
  { id: 'actions-heading', label: 'Sandbox actions', live: false, workspace: 'system' },
];

/** The sections of one workspace, in page order; while seeding, only those that exist yet. */
export function sectionsOf(workspace: WorkspaceId, live = true): ConsoleSection[] {
  return CONSOLE_SECTIONS.filter((s) => s.workspace === workspace && (live || !s.live));
}

/** The workspace a page's path is, or null for a path outside the console. */
export function workspaceAt(path: string): WorkspaceId | null {
  const page = WORKSPACES.find((w) => w.path === path || `${w.path}index.html` === path);
  return page?.id ?? null;
}

/**
 * Where an old anchor of the one-page console now lives: `#ledger-heading` or `#ledger` gives
 * `/app/money/#ledger-heading`. Null for an anchor that stays on /app/ (the Kitchen's) or names no
 * section.
 */
export function movedAnchor(hash: string): string | null {
  const name = hash.replace(/^#/, '');
  if (name === '') return null;
  const section = CONSOLE_SECTIONS.find((s) => s.id === name || s.id === `${name}-heading`);
  if (section === undefined || section.workspace === 'kitchen') return null;
  const page = WORKSPACES.find((w) => w.id === section.workspace);
  return page === undefined ? null : `${page.path}#${section.id}`;
}

/** The heading the board's skip link jumps to: the first section after the board's cards. */
export const AFTER_BOARD = 'feed-heading';
