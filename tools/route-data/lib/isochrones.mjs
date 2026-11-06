// Step f: the isochrone polygons from ORS, projected to view units and written as SVG paths.

import {
  clipRing,
  dedupeRing,
  insideOrNear,
  parsePath,
  pathData,
  signedArea,
  simplifyRing,
} from './geo.mjs';

/** Rings of one band, projected, clipped to the viewBox, simplified and rounded to integers. */
export function bandRings(geometry, projection, tolerance) {
  const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  const rect = [0, 0, projection.width, projection.height];
  const out = [];
  for (const rings of polygons) {
    for (const ring of rings) {
      const projected = ring.slice(0, -1).map((c) => projection.project(c));
      const clipped = clipRing(projected, rect);
      if (clipped.length < 3) continue;
      const rounded = dedupeRing(
        simplifyRing(clipped, tolerance).map(([x, y]) => [Math.round(x), Math.round(y)]),
      );
      if (rounded.length >= 3 && Math.abs(signedArea(rounded)) >= 1) out.push(rounded);
    }
  }
  return out;
}

/**
 * The bands from an ORS isochrones response, ordered by range, one per requested minute:
 * { minutes, rings, path }. Throws if a requested range is missing.
 */
export function bandsFromResponse(response, minutes, projection, tolerance) {
  const byValue = new Map();
  for (const f of response.features ?? []) byValue.set(Number(f.properties?.value), f);
  return minutes.map((m) => {
    const f = byValue.get(m * 60);
    if (!f) throw new Error(`the isochrone response has no ${m}-minute range`);
    const rings = bandRings(f.geometry, projection, tolerance);
    if (rings.length === 0)
      throw new Error(`the ${m}-minute isochrone is empty after clipping to the map`);
    return { minutes: m, rings, path: pathData(rings) };
  });
}

/**
 * How nested the bands are: for each consecutive pair, the share of the smaller band's vertices
 * that lie inside the larger (or within `tolerance` units of its edge), and whether its area
 * grows. Reads the paths as written, so it checks what the screen draws.
 */
export function nesting(paths, tolerance = 3) {
  const bands = paths.map((d) => {
    const rings = parsePath(d);
    if (rings.some((r) => !r.closed)) throw new Error('an isochrone subpath is not closed');
    return rings.map((r) => r.points);
  });
  const area = (rings) => Math.max(...rings.map((r) => Math.abs(signedArea(r))));
  const pairs = [];
  for (let k = 0; k + 1 < bands.length; k++) {
    const inner = bands[k].flat();
    const inside = inner.filter((p) => insideOrNear(p, bands[k + 1], tolerance)).length;
    pairs.push({
      from: k,
      to: k + 1,
      inside: inside / inner.length,
      grows: area(bands[k + 1]) > area(bands[k]),
    });
  }
  return pairs;
}
