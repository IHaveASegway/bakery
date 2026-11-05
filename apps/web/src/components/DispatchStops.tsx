import {
  placeName,
  statusText,
  stopRows,
  windowText,
  zoneText,
  type RouteData,
} from '../lib/dispatch';
import type { DispatchResponse } from '../contracts';

/**
 * The day's stops: order, place, window, zone, units, status, and the van and stop number once a
 * plan is published. The place is a public drop-off spot named on the map, never anyone’s home.
 */
export default function DispatchStops({
  day,
  data,
}: {
  day: DispatchResponse;
  data: RouteData | null;
}) {
  const rows = stopRows(day);
  if (rows.length === 0) {
    return <p className="hint">This day has no delivery stops.</p>;
  }
  return (
    <div className="table-scroll">
      <table>
        <caption className="sr-only">The day’s delivery stops</caption>
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col">Place</th>
            <th scope="col">Window</th>
            <th scope="col">Zone</th>
            <th scope="col">Units</th>
            <th scope="col">Status</th>
            <th scope="col">Van</th>
            <th scope="col">Stop</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const name = placeName(data, row.place);
            return (
              <tr key={row.order}>
                <td>
                  <code>{row.short}</code>
                </td>
                <td>
                  {row.label}
                  {name !== null && <span className="hint">Drop-off spot: {name}</span>}
                </td>
                <td>{windowText(row.window)}</td>
                <td>{zoneText(row.zone)}</td>
                <td>{row.units}</td>
                <td>{statusText(row.status)}</td>
                <td>{row.van ?? 'Not planned'}</td>
                <td>{row.stop ?? ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
