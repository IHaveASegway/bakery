import { clockText, type BrowserSolver, type Figures, type Report } from '../lib/dispatch';
import { HOW } from '../guide/how';
import HowItWorks from './HowItWorks';

const SOURCE_NAMES = { server: 'Server (savings heuristic)', browser: 'Browser (VROOM)' } as const;

function cell(figures: Figures | null, pick: (f: Figures) => string, missing: string): string {
  return figures === null ? missing : pick(figures);
}

/**
 * The two plans side by side: total drive minutes, the time the last van is back, vans used and the
 * gap between them as the API reports it. When there is no browser plan, because it has not run or
 * cannot, the server’s column stands alone and the other says why.
 */
export default function DispatchComparison({
  report,
  solver,
}: {
  report: Report;
  solver: BrowserSolver;
}) {
  const { server, browser } = report;
  const noBrowser = solver === 'unavailable' ? 'Unavailable here' : 'Not planned yet';
  const rows: { name: string; pick: (f: Figures) => string }[] = [
    { name: 'Drive minutes, all vans', pick: (f) => String(f.minutes) },
    { name: 'Last van back', pick: (f) => clockText(f.lastBack) },
    { name: 'Vans used', pick: (f) => String(f.vansUsed) },
    { name: 'Stops placed', pick: (f) => String(f.stops) },
  ];
  return (
    <>
      <p aria-live="polite">{report.summary}</p>
      <div className="table-scroll" role="region" aria-label="Plans compared" tabIndex={0}>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Figure</span>
              </th>
              <th scope="col" className="num">
                {SOURCE_NAMES.server}
              </th>
              <th scope="col" className="num">
                {SOURCE_NAMES.browser}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name}>
                <th scope="row">{row.name}</th>
                <td className="num">{cell(server, row.pick, 'Not proposed yet')}</td>
                <td className="num">{cell(browser, row.pick, noBrowser)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <HowItWorks>
        <p>
          Both plans keep to the delivery windows: the API refuses either one if a van would reach a
          stop after its window closes. Drive minutes are free-flow times from the travel-time
          matrix, with no traffic, no time at the door and no waiting for a window to open; the time
          the last van is back counts both. The gap is the server’s total less the browser’s, as a
          percentage of the browser’s.
        </p>
        <p>{HOW.dispatch}</p>
      </HowItWorks>
    </>
  );
}
