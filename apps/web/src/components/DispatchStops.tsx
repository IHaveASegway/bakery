import {
  placeName,
  statusText,
  stopRows,
  windowText,
  zoneText,
  type RouteData,
} from '../lib/dispatch';
import type { DispatchResponse } from '../contracts';

/** The column names, said in the table's head and, on a phone, before each value. */
const COLUMNS = ['Order', 'Place', 'Window', 'Zone', 'Units', 'Status', 'Van', 'Stop'] as const;

/**
 * A cell's own label, shown only below 40rem, where the global styles stack the table's rows into
 * blocks and hide its head: without it a phone shows "2", "Confirmed", "Not planned" with nothing to
 * say what each is. `sm:hidden` takes it away where the head is shown.
 */
function Label({ name }: { name: (typeof COLUMNS)[number] }) {
  return <span className="font-semibold sm:hidden">{name}: </span>;
}

/**
 * The day's stops: order, place, window, zone, units, status, and the van and stop number once a
 * plan is published. The place is a public drop-off spot named on the map, never anyone’s home.
 *
 * The page's column is narrow and the global styles let text break anywhere, which cut "Delivered"
 * and the order ids mid-word; the table breaks only between words, and scrolls inside its box when
 * it must be wider than the column.
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
      <table className="[overflow-wrap:normal]">
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
            const name = placeName(data, row.place);
            return (
              <tr key={row.order}>
                <td>
                  <Label name="Order" />
                  <code>{row.short}</code>
                </td>
                <td>
                  <Label name="Place" />
                  {row.label}
                  {name !== null && <span className="hint">Drop-off spot: {name}</span>}
                </td>
                <td>
                  <Label name="Window" />
                  {windowText(row.window)}
                </td>
                {/* "Zone 2" names itself, so it needs no label of its own. */}
                <td className="whitespace-nowrap">{zoneText(row.zone)}</td>
                <td>
                  <Label name="Units" />
                  {row.units}
                </td>
                <td>
                  <Label name="Status" />
                  {statusText(row.status)}
                </td>
                <td>
                  <Label name="Van" />
                  {row.van ?? 'Not planned'}
                </td>
                <td>
                  <Label name="Stop" />
                  {row.stop ?? '–'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
