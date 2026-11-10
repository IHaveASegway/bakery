import { TABS, WORKSPACES, type WorkspaceId } from '../lib/console-sections';
import WorkspaceIcon from './WorkspaceIcon';

/**
 * The console's sidebar: the seven workspaces, each a page of its own, the current one marked. On
 * a phone it is a tab bar at the foot of the window: four tabs, and "More" for the other three.
 * Rendered on the server by the app shell, so it costs no script; "More" is a <details>.
 */
export default function ConsoleNav({ here }: { here: WorkspaceId | null }) {
  const entry = (id: WorkspaceId) => {
    const ws = WORKSPACES.find((w) => w.id === id)!;
    return (
      <a href={ws.path} aria-current={id === here ? 'page' : undefined}>
        <WorkspaceIcon workspace={id} />
        <span>{ws.label}</span>
      </a>
    );
  };
  const more = WORKSPACES.filter((w) => !TABS.includes(w.id));
  return (
    <nav aria-label="Console" className="sidebar">
      <ul className="sidebar-list">
        {WORKSPACES.map((ws) => (
          <li key={ws.id} className={TABS.includes(ws.id) ? 'tab' : 'tab-overflow'}>
            {entry(ws.id)}
          </li>
        ))}
      </ul>
      <details className="tab-more">
        <summary aria-current={more.some((w) => w.id === here) ? 'page' : undefined}>
          <svg
            className="ws-icon"
            viewBox="0 0 20 20"
            width="20"
            height="20"
            fill="currentColor"
            aria-hidden="true"
            focusable="false"
          >
            <circle cx="4" cy="10" r="1.5" />
            <circle cx="10" cy="10" r="1.5" />
            <circle cx="16" cy="10" r="1.5" />
          </svg>
          <span>More</span>
        </summary>
        <ul>
          {more.map((ws) => (
            <li key={ws.id}>{entry(ws.id)}</li>
          ))}
        </ul>
      </details>
    </nav>
  );
}
