import { WORKSPACES, sectionsOf } from '../lib/console-sections';

/**
 * The console's sidebar: the seven workspaces, each with its sections. On the console itself the
 * entries are in-page links ("On this page"); on another console page (dispatch) they lead back to
 * the console's sections, and the page's own entry is marked current. Rendered on the server for
 * the dispatch page, so it costs that page no script.
 */
export default function ConsoleNav({
  here = 'console',
  live = true,
}: {
  here?: 'console' | 'dispatch';
  /** False while the sandbox is seeding: only the sections that exist are listed. */
  live?: boolean;
}) {
  const base = here === 'console' ? '' : '/app/';
  return (
    <nav aria-label={here === 'console' ? 'On this page' : 'Console'} className="sidebar">
      {WORKSPACES.map((ws) => {
        const sections = sectionsOf(ws.id, live);
        if (sections.length === 0 && ws.id !== 'dispatch') return null;
        return (
          <div key={ws.id} className="sidebar-group">
            <p className="sidebar-label" id={`nav-${ws.id}`}>
              {ws.label}
            </p>
            <ul aria-labelledby={`nav-${ws.id}`}>
              {sections.map((s) => (
                <li key={s.id}>
                  <a href={`${base}#${s.id}`}>{s.label}</a>
                </li>
              ))}
              {ws.id === 'dispatch' && (
                <li>
                  <a href="/app/dispatch/" aria-current={here === 'dispatch' ? 'page' : undefined}>
                    Delivery plans
                  </a>
                </li>
              )}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
