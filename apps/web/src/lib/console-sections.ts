// The console's sections in the order the page renders them (components/SandboxView.tsx). The
// "On this page" list is drawn from this, and a test checks that each id is a heading in a render
// of the page, so a section added without a line here, or a line without a heading, fails.

export interface ConsoleSection {
  /** The id of the section's heading, the target of the in-page link. */
  id: string;
  /** What the link says. */
  label: string;
  /** True for a section that exists only once the sandbox has been seeded. */
  live: boolean;
}

export const CONSOLE_SECTIONS: readonly ConsoleSection[] = [
  { id: 'sandbox-heading', label: 'Your sandbox', live: false },
  { id: 'token-heading', label: 'API token', live: true },
  { id: 'board-heading', label: 'Kitchen board', live: true },
  { id: 'bake-heading', label: 'Bake list', live: true },
  { id: 'feed-heading', label: 'Activity feed', live: true },
  { id: 'ledger-heading', label: 'Ledger', live: true },
  { id: 'traffic-heading', label: 'Simulated traffic', live: true },
  { id: 'menu-heading', label: 'Menu', live: true },
  { id: 'capacity-heading', label: 'Capacity', live: true },
  { id: 'catering-queue-heading', label: 'Catering queue', live: true },
  { id: 'customers-heading', label: 'Customers', live: true },
  { id: 'segments-heading', label: 'Segments', live: true },
  { id: 'campaigns-heading', label: 'Campaigns', live: true },
  { id: 'leads-heading', label: 'Catering lead pipeline', live: true },
  { id: 'activity-heading', label: 'Activity', live: true },
  { id: 'rebuild-heading', label: 'Rebuild projections', live: true },
  { id: 'faults-heading', label: 'Faults', live: true },
  { id: 'dead-letters-heading', label: 'Dead letters', live: true },
  { id: 'clock-heading', label: 'Clock', live: true },
  { id: 'actions-heading', label: 'Sandbox actions', live: false },
];

/** The heading the board's skip link jumps to: the first section after the board's cards. */
export const AFTER_BOARD = 'bake-heading';
