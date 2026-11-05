// Pure-function tests: projection, path encoding, selection, blocking, matrix assembly.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONFIG, routingBox, withOverrides } from '../config.mjs';
import { clipRing, makeProjection, pathData, parsePath, haversine } from '../lib/geo.mjs';
import { nesting, bandRings } from '../lib/isochrones.mjs';
import { blockRequest, buildMatrix, minutesRows, planBlocks } from '../lib/matrix.mjs';
import { OrsError } from '../lib/ors.mjs';
import { allocate, candidatesFromFeatures, selectPlaces } from '../lib/places.mjs';

test('the config adds up', () => {
  const q = Object.values(CONFIG.quotas).reduce((a, b) => a + b, 0);
  assert.equal(q, CONFIG.placeCount);
  assert.equal(CONFIG.placeCount, 64);
  assert.deepEqual(CONFIG.isochroneMinutes, [5, 10, 15, 20, 25, 30]);
  assert.equal(CONFIG.serviceSeconds, 180);
  assert.equal(CONFIG.viewWidth, 2000);
  assert.equal(CONFIG.profile, 'driving-car');
  assert.match(CONFIG.ors.tag, /^v9\.\d+\.\d+$/);
  // The display box is kept as integer ten-thousandths of a degree; the floats are derived from it.
  const d4 = CONFIG.displayBox.map((v) => Math.round(v * 1e4));
  assert.deepEqual(d4, [-1121014, 406999, -1117404, 408534]);
  assert.deepEqual(
    CONFIG.displayBox,
    d4.map((v) => v / 1e4),
  );
  // Nominatim's raw box is kept as integer ten-millionths of a degree.
  const nb = CONFIG.nominatim.boundingbox1e7;
  assert.deepEqual(nb, {
    south: 406999263,
    north: 408533905,
    west: -1121013916,
    east: -1117404843,
  });
  assert.ok(Object.values(nb).every(Number.isInteger));
  // The display box is the Nominatim box rounded outward, within 0.001 degree (10000 in 1e-7 units).
  const [w, s, e, n] = d4.map((v) => v * 1e3);
  assert.ok(w <= nb.west && s <= nb.south && e >= nb.east && n >= nb.north);
  assert.ok(nb.west - w < 1e4 && nb.south - s < 1e4 && e - nb.east < 1e4 && n - nb.north < 1e4);
  const r = routingBox();
  assert.deepEqual(
    r.map((v) => Math.round(v * 1e4)),
    [-1121364, 406729, -1117054, 408804],
  );
  assert.ok(r[0] < CONFIG.displayBox[0] && r[1] < CONFIG.displayBox[1]);
  assert.ok(r[2] > CONFIG.displayBox[2] && r[3] > CONFIG.displayBox[3]);
  for (const kind of CONFIG.fillOrder) assert.ok(kind in CONFIG.placeTags);
});

test('the projection is the site’s: its Seattle box gives its viewBox and scale', () => {
  // The site’s out/README.md: display box -122.44, 47.493, -122.16, 47.735 -> viewBox 0 0 2000 2564,
  // 10.506 m per unit.
  const p = makeProjection([-122.44, 47.493, -122.16, 47.735], 2000);
  assert.equal(p.height, 2564);
  assert.equal(p.metresPerUnit.toFixed(3), '10.506');
  const [x, y] = p.project([-122.44, 47.735]);
  assert.ok(Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9);
  const [x2, y2] = p.project([-122.16, 47.493]);
  assert.ok(Math.abs(x2 - 2000) < 1e-6 && Math.abs(y2 - 2564) < 0.5);
  const back = p.unproject(p.project([-122.3, 47.6]));
  assert.ok(Math.abs(back[0] + 122.3) < 1e-9 && Math.abs(back[1] - 47.6) < 1e-9);
});

test('path data is the site’s encoding and reads back closed', () => {
  assert.equal(
    pathData([
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
    ]),
    'M0 0l10 0 0 10-10 0z',
  );
  const d = pathData([
    [
      [100, 100],
      [200, 100],
      [200, 200],
      [100, 200],
    ],
    [
      [120, 120],
      [180, 120],
      [180, 180],
    ],
  ]);
  assert.match(d, /^M100 100l100 0 0 100-100 0zm20 20l60 0 0 60z$/);
  const rings = parsePath(d);
  assert.equal(rings.length, 2);
  assert.ok(rings.every((r) => r.closed));
  assert.deepEqual(rings[1].points[0], [120, 120]);
  assert.throws(() => parsePath('M1 1l2 2 junk'));
});

test('clipping keeps a ring inside the rectangle', () => {
  const out = clipRing(
    [
      [-10, -10],
      [50, -10],
      [50, 50],
      [-10, 50],
    ],
    [0, 0, 100, 100],
  );
  assert.ok(out.every(([x, y]) => x >= 0 && y >= 0 && x <= 100 && y <= 100));
  assert.equal(out.length, 4);
  assert.deepEqual(
    clipRing(
      [
        [200, 200],
        [300, 200],
        [300, 300],
      ],
      [0, 0, 100, 100],
    ),
    [],
  );
});

const feature = (type, id, tags, point) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: point },
  properties: { '@type': type, '@id': id, ...tags },
});

function pool() {
  // 10 parks, 3 libraries, 2 stations, 1 square, 1 viewpoint on a 0.05 degree grid.
  const out = [];
  let id = 1000;
  const add = (tags, n, row) => {
    for (let i = 0; i < n; i++) {
      id += 7;
      out.push(
        feature(
          'node',
          id,
          {
            name: `Name ${tags.leisure ?? tags.amenity ?? tags.railway ?? tags.place ?? tags.tourism} ${i}`,
            ...tags,
          },
          [-139.99 + i * 0.012, -40.7 - row * 0.012],
        ),
      );
    }
  };
  add({ leisure: 'park' }, 10, 0);
  add({ amenity: 'library' }, 3, 1);
  add({ railway: 'station' }, 2, 2);
  add({ place: 'square' }, 1, 3);
  add({ tourism: 'viewpoint' }, 1, 4);
  add({ leisure: 'garden' }, 2, 5);
  return out;
}

const small = withOverrides(CONFIG, {
  displayBox: [-140.1, -40.9, -139.7, -40.6],
  placeCount: 9,
  quotas: { park: 3, garden: 1, library: 2, station: 1, viewpoint: 1, square: 1 },
});

test('the selection is deterministic whatever order the candidates arrive in', () => {
  const { candidates } = candidatesFromFeatures(pool(), small);
  assert.equal(candidates.length, 19);
  const a = selectPlaces(candidates, small);
  const reversed = selectPlaces([...candidates].reverse(), small);
  const rotated = selectPlaces([...candidates.slice(7), ...candidates.slice(0, 7)], small);
  assert.deepEqual(reversed.places, a.places);
  assert.deepEqual(rotated.places, a.places);
  assert.equal(a.places.length, 9);
  // Every kind is present, index 0 is the square (the depot), the rest are in OSM id order.
  assert.deepEqual(
    new Set(a.places.map((p) => p.kind)),
    new Set(['park', 'garden', 'library', 'station', 'viewpoint', 'square']),
  );
  assert.equal(a.places[0].kind, 'square');
  assert.equal(a.stats.depotKind, 'square');
  const ids = a.places.slice(1).map((p) => p.osmId);
  assert.deepEqual(
    ids,
    [...ids].sort((x, y) => x - y),
  );
  assert.deepEqual(
    a.places.map((p) => p.index),
    [0, 1, 2, 3, 4, 5, 6, 7, 8],
  );
  // "Every k-th": 3 of 10 parks are items 0, 3 and 6 of the id-sorted list.
  const parks = candidates.filter((c) => c.kind === 'park').sort((x, y) => x.osmId - y.osmId);
  const chosen = a.places.filter((p) => p.kind === 'park').map((p) => p.osmId);
  assert.deepEqual(chosen, [parks[0].osmId, parks[3].osmId, parks[6].osmId]);
});

test('a short kind hands its quota to the others, and too few places is an error', () => {
  const quota = allocate(
    { park: 10, library: 1, station: 5, garden: 0, viewpoint: 0, square: 0 },
    { ...small, placeCount: 9 },
  );
  assert.equal(
    Object.values(quota).reduce((a, b) => a + b, 0),
    9,
  );
  assert.equal(quota.library, 1);
  assert.throws(() => allocate({ park: 2 }, small), /eligible places/);
});

test('names, access and businesses are dropped with a reason', () => {
  const f = [
    feature('node', 1, { leisure: 'park' }, [-139.9, -40.7]),
    feature('node', 2, { leisure: 'park', name: 'Test Meadow Apartments' }, [-139.9, -40.7]),
    feature(
      'node',
      3,
      { leisure: 'garden', name: 'Test Garden', access: 'private' },
      [-139.9, -40.7],
    ),
    feature('node', 4, { leisure: 'park', name: 'Far Park' }, [-128, -40.7]),
    feature('node', 5, { amenity: 'cafe', name: 'Test Cafe' }, [-139.9, -40.7]),
    feature(
      'node',
      6,
      { amenity: 'library', name: 'Test Library', shop: 'books' },
      [-139.9, -40.7],
    ),
    feature('node', 7, { leisure: 'park', name: 'Test Park' }, [-139.9, -40.7]),
    feature(
      'node',
      8,
      { amenity: 'library', name: 'Test Hall Library', 'operator:type': 'religious' },
      [-139.9, -40.7],
    ),
    feature(
      'node',
      9,
      { amenity: 'library', name: 'Test Health Library', operator: 'State University' },
      [-139.9, -40.7],
    ),
    feature(
      'node',
      10,
      { amenity: 'library', name: 'Test Public Library', 'operator:type': 'public' },
      [-139.9, -40.7],
    ),
  ];
  const { candidates, dropped } = candidatesFromFeatures(f, small);
  assert.deepEqual(
    candidates.map((c) => c.osmId),
    [7, 10],
  );
  assert.deepEqual(dropped, {
    'no-name': 1,
    'business-like': 1,
    'not-public': 4,
    'outside-box': 1,
    'no-kind': 1,
  });
});

test('polygons become centroids', () => {
  const f = {
    type: 'Feature',
    geometry: {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [-139.92, -40.76],
            [-139.918, -40.76],
            [-139.918, -40.762],
            [-139.92, -40.762],
            [-139.92, -40.76],
          ],
        ],
      ],
    },
    properties: { '@type': 'way', '@id': 5, leisure: 'park', name: 'Square Test Park' },
  };
  const { candidates } = candidatesFromFeatures([f], small);
  assert.deepEqual([candidates[0].lon, candidates[0].lat], [-139.919, -40.761]);
});

test('blocks cover every ordered pair exactly once and respect the caps', () => {
  for (const [n, tile] of [
    [64, 64],
    [64, 32],
    [64, 25],
    [64, 7],
    [6, 3],
    [6, 100],
    [1, 1],
  ]) {
    const seen = new Map();
    const blocks = planBlocks(n, tile);
    for (const b of blocks) {
      assert.ok(b.sources.length <= tile && b.destinations.length <= tile);
      assert.ok(b.sources.length * b.destinations.length <= Math.min(tile, n) ** 2);
      const { union, body } = blockRequest(
        b,
        Array.from({ length: n }, (_, i) => [i, 0]),
      );
      assert.ok(union.length <= 2 * Math.min(tile, n));
      assert.equal(body.locations.length, union.length);
      for (const s of b.sources)
        for (const d of b.destinations) seen.set(`${s}>${d}`, (seen.get(`${s}>${d}`) ?? 0) + 1);
    }
    assert.equal(seen.size, n * n, `n=${n} tile=${tile}`);
    assert.ok([...seen.values()].every((c) => c === 1));
  }
  // The caps the config asks the instance for: one 64 x 64 request is 4,096 routes.
  assert.equal(planBlocks(64, 64).length, 1);
  assert.equal(planBlocks(64, CONFIG.ors.matrixFallbackTile).length, 4);
});

const places6 = Array.from({ length: 6 }, (_, i) => ({ index: i, label: `Place ${i}` }));
const locs6 = places6.map((_, i) => [-139.9 + i * 0.01, -40.7]);

// A fake post that answers a matrix request from a formula of the two place numbers.
function formulaPost(calls, { limit = Infinity } = {}) {
  return async (route, body) => {
    calls.push(body);
    if (body.sources.length * body.destinations.length > limit) {
      throw new OrsError('too many routes', { status: 400, code: 6004 });
    }
    const at = (p) => Math.round((p[0] + 139.9) / 0.01);
    return {
      durations: body.sources.map((s) =>
        body.destinations.map((d) => 100 * at(body.locations[+s]) + at(body.locations[+d]) + 0.4),
      ),
      distances: body.sources.map((s) =>
        body.destinations.map((d) => 1000 * at(body.locations[+s]) + at(body.locations[+d]) + 0.6),
      ),
    };
  };
}

test('the matrix assembles row-major with zero diagonals, in one request or in blocks', async () => {
  for (const limit of [Infinity, 9]) {
    const calls = [];
    const m = await buildMatrix({
      post: formulaPost(calls, { limit }),
      route: 'r',
      places: places6,
      locations: locs6,
      config: { ors: { matrixFallbackTile: 3 } },
    });
    assert.equal(m.durations.length, 36);
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        assert.equal(
          m.durations[i * 6 + j],
          i === j ? 0 : Math.round(100 * i + j + 0.4),
          `d ${i}->${j}`,
        );
        assert.equal(
          m.distances[i * 6 + j],
          i === j ? 0 : Math.round(1000 * i + j + 0.6),
          `m ${i}->${j}`,
        );
      }
    }
    assert.equal(m.requests, limit === Infinity ? 1 : 4);
    assert.ok(m.durations.every(Number.isInteger) && m.distances.every(Number.isInteger));
  }
});

test('an unreachable pair stops the build and names both places', async () => {
  const post = async (route, body) => ({
    durations: body.sources.map((s) =>
      body.destinations.map((d) => (s === '1' && d === '4' ? null : 60)),
    ),
    distances: body.sources.map(() => body.destinations.map(() => 500)),
  });
  await assert.rejects(
    buildMatrix({
      post,
      route: 'r',
      places: places6,
      locations: locs6,
      config: { ors: { matrixFallbackTile: 3 } },
    }),
    /unreachable pair: Place 1 \(1\) to Place 4 \(4\)/,
  );
});

test('minutes round up from seconds with zero diagonals', () => {
  const rows = minutesRows([0, 59, 60, 61, 0, 120, 1, 3599, 0], 3);
  assert.deepEqual(rows, [
    [0, 1, 1],
    [2, 0, 2],
    [1, 60, 0],
  ]);
});

test('isochrone paths are closed and nested', () => {
  const projection = makeProjection([-140, -41, -139, -40], 2000);
  const sq = (h) => ({
    type: 'Polygon',
    coordinates: [
      [
        [-139.5 - h, -40.5 + h],
        [-139.5 + h, -40.5 + h],
        [-139.5 + h, -40.5 - h],
        [-139.5 - h, -40.5 - h],
        [-139.5 - h, -40.5 + h],
      ],
    ],
  });
  const paths = [0.02, 0.04, 0.06].map((h) => pathData(bandRings(sq(h), projection, 0.8)));
  const pairs = nesting(paths);
  assert.ok(pairs.every((p) => p.inside === 1 && p.grows));
  // Swapped order is not nested.
  assert.ok(nesting([paths[2], paths[0]]).some((p) => p.inside < 0.5 || !p.grows));
  // A band that leaves the map is clipped to it.
  const big = pathData(bandRings(sq(2), projection, 0.8));
  assert.ok(
    parsePath(big)[0].points.every(
      ([x, y]) => x >= 0 && y >= 0 && x <= 2000 && y <= projection.height,
    ),
  );
  assert.ok(haversine([0, 0], [0, 1]) > 111000);
});
