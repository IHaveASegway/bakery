// A local stand-in for an openrouteservice instance: health, status, snap, matrix and isochrones,
// answering from hand-written rules and test/fixtures/isochrone-bands.json. It records every
// request so a test can say what the build asked. No key is read or needed.

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { haversine } from '../lib/geo.mjs';

const BANDS = JSON.parse(
  readFileSync(new URL('./fixtures/isochrone-bands.json', import.meta.url), 'utf8'),
);

/** The fake's travel time and distance from a to b: a function of the two points only. */
export function fakeLeg(a, b) {
  const metres = haversine(a, b) * 1.3;
  // 11 m/s, a fraction on purpose (rounding is the build's job), and one-way asymmetry.
  const seconds = metres / 11 + 0.4 + (a[1] > b[1] ? 7 : 0);
  return { seconds, metres: metres + 0.3 };
}

export async function startFakeOrs({ maxRoutes = 100000, unsnappable = [], nullPair = null } = {}) {
  const log = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      log.push({ method: req.method, url: req.url, body });
      const send = (status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.url === '/ors/v2/health') return send(200, { status: 'ready' });
      if (req.url === '/ors/v2/status') {
        return send(200, {
          engine: { version: '9.10.0-fake', build_date: '2026-07-28', graph_date: '2026-11-05' },
          profiles: { 'profile 1': { profiles: 'driving-car' } },
        });
      }
      if (req.url === '/ors/v2/snap/driving-car') {
        return send(200, {
          locations: body.locations.map((l) =>
            unsnappable.some((u) => Math.abs(u[0] - l[0]) < 1e-5 && Math.abs(u[1] - l[1]) < 1e-5)
              ? null
              : { location: [l[0] + 0.0001, l[1] + 0.0001], snapped_distance: 14.2 },
          ),
        });
      }
      if (req.url === '/ors/v2/matrix/driving-car') {
        const src = body.sources ?? body.locations.map((_, i) => String(i));
        const dst = body.destinations ?? body.locations.map((_, i) => String(i));
        if (src.length * dst.length > maxRoutes) {
          return send(400, {
            error: { code: 6004, message: 'Exceeded the maximum number of routes' },
          });
        }
        const loc = body.locations;
        const cell = (s, d, key) => {
          if (
            nullPair &&
            loc[Number(s)][0] === nullPair[0][0] &&
            loc[Number(d)][0] === nullPair[1][0]
          )
            return null;
          const leg = fakeLeg(loc[Number(s)], loc[Number(d)]);
          return key === 'duration' ? leg.seconds : leg.metres;
        };
        return send(200, {
          durations: src.map((s) => dst.map((d) => (s === d ? 0 : cell(s, d, 'duration')))),
          distances: src.map((s) => dst.map((d) => (s === d ? 0 : cell(s, d, 'distance')))),
        });
      }
      if (req.url === '/ors/v2/isochrones/driving-car') {
        const [lon, lat] = body.locations[0];
        // ORS returns the largest range first.
        const features = [...body.range].reverse().map((value) => {
          const h = BANDS.halfWidthDegrees[String(value)];
          return {
            type: 'Feature',
            properties: { value, center: [lon, lat] },
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [lon - h, lat - h],
                  [lon + h, lat - h],
                  [lon + h, lat + h],
                  [lon - h, lat + h],
                  [lon - h, lat - h],
                ],
              ],
            },
          };
        });
        return send(200, { type: 'FeatureCollection', features });
      }
      return send(404, { error: { code: 404, message: 'no such endpoint' } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    log,
    posts: (suffix) => log.filter((l) => l.method === 'POST' && l.url.endsWith(suffix)),
    close: () => new Promise((r) => server.close(r)),
  };
}
