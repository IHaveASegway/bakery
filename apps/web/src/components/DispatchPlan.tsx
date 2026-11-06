import type { PlanView } from '../contracts';
import { clockText, vanClass } from '../lib/dispatch';

/**
 * One plan, as the API reports it: each van's stops, units and drive minutes, the total and when the
 * last van is back. Every figure is the Dispatch object's own arithmetic over its matrix, whoever
 * made the plan; the page adds none.
 */
export default function DispatchPlan({ plan, title }: { plan: PlanView; title: string }) {
  return (
    <div className="plan">
      <h4>{title}</h4>
      <p>
        {plan.vans.length} {plan.vans.length === 1 ? 'van' : 'vans'}, {plan.minutes} drive minutes
        in all, the last van back at {clockText(plan.last_back)}.
        {plan.unassigned.length > 0 && (
          <>
            {' '}
            <strong>
              {plan.unassigned.length} {plan.unassigned.length === 1 ? 'stop is' : 'stops are'} in
              no van.
            </strong>{' '}
            A plan with a stop left out cannot be published.
          </>
        )}
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Van</th>
              <th scope="col">Stops</th>
              <th scope="col">Units</th>
              <th scope="col">Drive minutes</th>
            </tr>
          </thead>
          <tbody>
            {plan.vans.map((van) => (
              <tr key={van.van}>
                <th scope="row">
                  <span className={`swatch swatch-${vanClass(van.van)}`} aria-hidden="true" />
                  Van {van.van}
                </th>
                <td>{van.stops.length}</td>
                <td>{van.units}</td>
                <td>{van.minutes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
