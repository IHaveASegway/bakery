// The console's workspace icons: thin strokes in currentColor on a 20 px grid, decorative (each
// sits beside its workspace's name), so hidden from assistive technology, as components/Glyphs.tsx
// draws the menu's.
import type { WorkspaceId } from '../lib/console-sections';

const PATHS: Record<WorkspaceId, string[]> = {
  // A pot on a ring of heat.
  kitchen: ['M4 8h12v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z', 'M2 8h16', 'M7 5V3M10 5V2M13 5V3'],
  // A banknote.
  money: ['M2 5h16v10H2z', 'M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M5 8v4M15 8v4'],
  // A list with bullets.
  menu: ['M7 5h10M7 10h10M7 15h10', 'M3 5h1M3 10h1M3 15h1'],
  // A tiered cake.
  catering: ['M4 17h12', 'M5 17v-5h10v5', 'M7 12V8h6v4', 'M10 8V5', 'M10 5l-1-2'],
  // Two people.
  customers: [
    'M7 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M2 17c0-3 2-5 5-5s5 2 5 5',
    'M13 4a3 3 0 0 1 0 5',
    'M14 12c2 .5 4 2 4 5',
  ],
  // A van.
  dispatch: [
    'M2 6h10v8H2z',
    'M12 9h3l3 3v2h-6',
    'M5 16a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
    'M15 16a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  ],
  // Three sliders.
  system: ['M3 5h14M3 10h14M3 15h14', 'M7 3v4M13 8v4M9 13v4'],
};

export default function WorkspaceIcon({ workspace }: { workspace: WorkspaceId }) {
  return (
    <svg
      className="ws-icon"
      viewBox="0 0 20 20"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[workspace].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
