// The console's sections in the order the page renders them (components/SandboxView.tsx), grouped
// under the seven workspaces of the design brief (2026-11-09). The sidebar ("On this page") is drawn
// from this, and a test checks that each id is a heading in a render of the page, so a section added
// without a line here, or a line without a heading, fails. The workspaces become pages of their own
// later; until then each is a group on the one page, and its sections are its sidebar entries.

export type WorkspaceId =
  'kitchen' | 'money' | 'menu' | 'catering' | 'customers' | 'dispatch' | 'system';

export interface Workspace {
  id: WorkspaceId;
  /** The workspace's name, in the sidebar and as its group's heading. */
  label: string;
}

export const WORKSPACES: readonly Workspace[] = [
  { id: 'kitchen', label: 'Kitchen' },
  { id: 'money', label: 'Money' },
  { id: 'menu', label: 'Menu' },
  { id: 'catering', label: 'Catering' },
  { id: 'customers', label: 'Customers' },
  { id: 'dispatch', label: 'Dispatch' },
  { id: 'system', label: 'System' },
];

export interface ConsoleSection {
  /** The id of the section's heading, the target of the in-page link. */
  id: string;
  /** What the link says. */
  label: string;
  /** True for a section that exists only once the sandbox has been seeded. */
  live: boolean;
  /** The workspace the section belongs to. */
  workspace: WorkspaceId;
}

export const CONSOLE_SECTIONS: readonly ConsoleSection[] = [
  { id: 'board-heading', label: 'Kitchen board', live: true, workspace: 'kitchen' },
  { id: 'bake-heading', label: 'Bake list', live: true, workspace: 'kitchen' },
  { id: 'feed-heading', label: 'Activity feed', live: true, workspace: 'kitchen' },
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

/** The heading the board's skip link jumps to: the first section after the board's cards. */
export const AFTER_BOARD = 'bake-heading';
