import {
  dropOffNote,
  placeName,
  statusText,
  stopRows,
  zoneText,
  type RouteData,
} from '../lib/dispatch';
import { windowText } from '../lib/when';
import type { DispatchResponse } from '../contracts';

/** The column names, said in the table's head and, on a phone, before each value (`data-label`). */
const COLUMNS = ['Order', 'Place', 'Window', 'Zone', 'Units', 'Status', 'Van', 'Stop'] as const;

/**
 * The day's stops: order, place, window, zone, units, status, and the van and stop number once a
 * plan is published. The place is a public drop-off spot named on the map, never anyone’s home.
 *
 * The global styles let text break anywhere, which cut "Delivered" and the order ids mid-word; the
 * table breaks only between words. It spans the page under the map and the plans (console.css), so
 * at 1280 px every column reads without a sideways scroll; on a narrower page it still scrolls
 * inside its box when it must, and on a phone its rows stack with their labels.
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
    <div className="table-scroll" role="region" aria-label="Stops table" tabIndex={0}>
      <table className="table [overflow-wrap:normal]">
        <caption className="sr-only">The day’s delivery stops</caption>
        <thead>
          <tr>
            {COLUMNS.map((name) => (
              <th key={name} scope="col" className="whitespace-nowrap">
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const note = dropOffNote(row.label, placeName(data, row.place));
            return (
              <tr key={row.order}>
                <td data-label="Order">
                  <code>{row.short}</code>
                </td>
                <td data-label="Place">
                  {row.label}
                  {note !== null && <span className="hint">{note}</span>}
                </td>
                <td data-label="Window">{windowText(row.window)}</td>
                <td className="whitespace-nowrap" data-label="Zone">
                  {zoneText(row.zone)}
                </td>
                <td className="num" data-label="Units">
                  {row.units}
                </td>
                <td data-label="Status">{statusText(row.status)}</td>
                <td data-label="Van">{row.van ?? 'Not planned'}</td>
                <td data-label="Stop">{row.stop ?? ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
