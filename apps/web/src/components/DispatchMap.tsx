import type { PlanView, StopView } from '../contracts';
import {
  DEPOT,
  bandLabels,
  bandsLargestFirst,
  mapRoutes,
  paddedBox,
  placeName,
  pointOf,
  stopMarks,
  vanClass,
  viewBoxText,
  type Isochrones,
  type RouteData,
} from '../lib/dispatch';

/** Vans A and D mark their stops with squares, B and C with circles, so no two look alike by colour alone. */
const isSquare = (van: number) => van === 1 || van === 4;

const MARK = 22;

/** The bakery: a diamond. */
const diamond = (x: number, y: number, r: number) =>
  `M${x} ${y - r}L${x + r} ${y}L${x} ${y + r}L${x - r} ${y}Z`;

/**
 * The dispatch map, as inline SVG from the build's route data: the isochrone bands (largest first,
 * the minutes written on each), the 64 places as faint points, the bakery, the day's stops with the
 * numbers of the plan shown, and each van's route as straight lines through its stops in order (the
 * data carry no road geometry, and the page says so). No `style` attribute anywhere: the page policy
 * refuses them, so colour comes from classes that read tokens.css.
 */
export default function DispatchMap({
  data,
  isochrones,
  stops,
  plan,
  caption,
}: {
  data: RouteData;
  isochrones: Isochrones;
  stops: readonly StopView[];
  plan: PlanView | null;
  caption: string;
}) {
  const box = paddedBox(data.viewBox);
  const bakery = pointOf(data, DEPOT) ?? { x: isochrones.depot[0], y: isochrones.depot[1] };
  const routes = mapRoutes(data, stops, plan);
  const marks = stopMarks(data, stops, plan);
  return (
    <svg
      className="dispatch-map"
      viewBox={viewBoxText(box)}
      role="img"
      aria-labelledby="dispatch-map-title"
    >
      <title id="dispatch-map-title">{caption}</title>
      <rect className="map-land" x={box[0]} y={box[1]} width={box[2]} height={box[3]} />
      {bandsLargestFirst(isochrones).map((band) => (
        <path
          key={band.minutes}
          className={`map-band map-band-${band.level}`}
          d={band.d}
          fillRule="evenodd"
        />
      ))}
      {bandLabels(isochrones, data.viewBox).map((label) => (
        <text key={label.minutes} className="map-band-label" x={label.x} y={label.y}>
          {label.minutes} min
        </text>
      ))}
      {data.points.slice(1).map((p) => (
        <circle key={p.i} className="map-place" cx={p.x} cy={p.y} r={5} />
      ))}
      {routes.map((route) => (
        <polyline
          key={route.van}
          className={`map-route map-route-${vanClass(route.van)}`}
          points={route.points}
        />
      ))}
      {marks.map((mark) => {
        const label = `${mark.numbers.length > 0 ? `Stop ${mark.numbers.join(', ')}` : 'Stop'}, ${
          placeName(data, mark.place) ?? `place ${mark.place + 1}`
        }`;
        const kind =
          mark.van === null ? 'map-mark map-mark-open' : `map-mark map-mark-${vanClass(mark.van)}`;
        const r = mark.numbers.length > 1 ? MARK + 6 : MARK;
        return (
          <g key={mark.place}>
            <title>{label}</title>
            {mark.van !== null && isSquare(mark.van) ? (
              <rect className={kind} x={mark.x - r} y={mark.y - r} width={2 * r} height={2 * r} />
            ) : (
              <circle className={kind} cx={mark.x} cy={mark.y} r={r} />
            )}
            {mark.numbers.length > 0 && (
              <text
                className={
                  mark.numbers.length > 1 ? 'map-mark-text map-mark-small' : 'map-mark-text'
                }
                x={mark.x}
                y={mark.y}
              >
                {mark.numbers.join(',')}
              </text>
            )}
          </g>
        );
      })}
      <g>
        <title>The bakery</title>
        <path className="map-depot" d={diamond(bakery.x, bakery.y, 26)} />
        <text className="map-depot-label" x={bakery.x} y={bakery.y + 58}>
          The bakery
        </text>
      </g>
    </svg>
  );
}
