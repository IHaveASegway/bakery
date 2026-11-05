// Places: from osmium's GeoJSON sequence to candidates, and from candidates to the 64 places by a
// deterministic spread. Pure functions: no file, no network, no clock.

import { haversine, ringCentroid } from './geo.mjs';

const TYPE_RANK = { node: 0, way: 1, relation: 2 };

/** A name reduced for comparing: lower case, no accents, letters and digits only. */
export function normalizeName(name) {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The place kind a tag set has, in the config's order, or null. */
export function kindOf(tags, config) {
  for (const [kind, pairs] of Object.entries(config.placeTags)) {
    if (pairs.some(([k, v]) => tags[k] === v)) return kind;
  }
  return null;
}

/** The point a GeoJSON geometry stands for: a point as it is, a polygon at its outer rings' centroid. */
export function geometryPoint(geometry) {
  if (geometry.type === 'Point') return geometry.coordinates;
  const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  let best = null;
  for (const rings of polygons) {
    const outer = rings[0].slice(0, -1);
    const c = ringCentroid(outer);
    // Weight by the shoelace area of the outer ring: the largest part of a multipolygon wins.
    let area = 0;
    for (let i = 0; i < outer.length; i++) {
      const [x1, y1] = outer[i];
      const [x2, y2] = outer[(i + 1) % outer.length];
      area += x1 * y2 - x2 * y1;
    }
    if (best === null || Math.abs(area) > best.area) best = { area: Math.abs(area), c };
  }
  return best === null ? null : best.c;
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * Candidates from the features osmium exported. Returns { candidates, dropped } where dropped
 * counts each reason: no-kind, no-name, not-public, business-like, outside-box.
 */
export function candidatesFromFeatures(features, config) {
  const [w, s, e, n] = config.displayBox;
  const dropped = {};
  const drop = (reason) => (dropped[reason] = (dropped[reason] ?? 0) + 1);
  const candidates = [];
  for (const f of features) {
    const tags = { ...f.properties };
    const osmType = tags['@type'];
    const osmId = Number(tags['@id']);
    delete tags['@type'];
    delete tags['@id'];
    const kind = kindOf(tags, config);
    if (kind === null) {
      drop('no-kind');
      continue;
    }
    const name = (tags.name ?? '').replace(/\s+/g, ' ').trim();
    if (name.length < 3) {
      drop('no-name');
      continue;
    }
    if (
      config.notPublicAccess.includes(tags.access) ||
      config.notPublicTags.some((k) => tags[k] !== undefined) ||
      config.notPublicOperatorTypes.includes(tags['operator:type']) ||
      config.notPublicOperatorPattern.test(tags.operator ?? '') ||
      (tags.leisure === 'garden' && tags['garden:type'] === 'residential')
    ) {
      drop('not-public');
      continue;
    }
    if (config.businessPattern.test(name)) {
      drop('business-like');
      continue;
    }
    const point = geometryPoint(f.geometry);
    if (point === null) {
      drop('no-geometry');
      continue;
    }
    const [lon, lat] = point.map(round6);
    if (lon < w || lon > e || lat < s || lat > n) {
      drop('outside-box');
      continue;
    }
    const pair = config.placeTags[kind].find(([k, v]) => tags[k] === v);
    candidates.push({ osmType, osmId, name, kind, tag: `${pair[0]}=${pair[1]}`, lon, lat });
  }
  return { candidates, dropped };
}

/** OSM id order: the number, then node, way, relation. */
export const byOsmId = (a, b) => a.osmId - b.osmId || TYPE_RANK[a.osmType] - TYPE_RANK[b.osmType];

/**
 * The quota per kind that adds up to `count`: the configured quotas, with any shortfall (a kind
 * with fewer candidates than its quota) handed one at a time to the kinds that still have
 * candidates, in `fillOrder`.
 */
export function allocate(poolSizes, config) {
  const quota = {};
  let total = 0;
  for (const kind of Object.keys(config.quotas)) {
    quota[kind] = Math.min(config.quotas[kind], poolSizes[kind] ?? 0);
    total += quota[kind];
  }
  let progress = true;
  while (total < config.placeCount && progress) {
    progress = false;
    for (const kind of config.fillOrder) {
      if (total < config.placeCount && quota[kind] < (poolSizes[kind] ?? 0)) {
        quota[kind] += 1;
        total += 1;
        progress = true;
      }
    }
  }
  if (total < config.placeCount) {
    throw new Error(
      `only ${total} eligible places for ${config.placeCount}: widen the box or the tags`,
    );
  }
  return quota;
}

/**
 * The places: the 64 by a deterministic spread, then the depot first.
 *
 * 1. Sort by OSM id. 2. Drop a candidate whose normalised name an earlier one has, one listed in
 * `exclude`, or one within `minSeparationMetres` of an earlier kept one. 3. Group by kind. Each
 * kind gets its quota (see `allocate`) and takes every k-th of its id-sorted list: item
 * floor(i * n / q) for i = 0..q-1, so the first is always taken and the rest are evenly spread
 * through the id order. 4. The depot is the selected place of the first kind in `depotKinds`
 * that has one (squares, then gardens, then parks) nearest the mean of all selected points.
 * 5. Index 0 is the depot, then the others in OSM id order.
 */
export function selectPlaces(candidates, config) {
  const sorted = [...candidates].sort(byOsmId);
  const dropped = {};
  const drop = (reason) => (dropped[reason] = (dropped[reason] ?? 0) + 1);
  const names = new Set();
  const kept = [];
  for (const c of sorted) {
    if (config.exclude.includes(`${c.osmType}/${c.osmId}`)) {
      drop('excluded');
      continue;
    }
    const norm = normalizeName(c.name);
    if (names.has(norm)) {
      drop('duplicate-name');
      continue;
    }
    if (kept.some((k) => haversine([k.lon, k.lat], [c.lon, c.lat]) < config.minSeparationMetres)) {
      drop('too-close');
      continue;
    }
    names.add(norm);
    kept.push(c);
  }
  const pools = {};
  for (const c of kept) (pools[c.kind] ??= []).push(c);
  const poolSizes = Object.fromEntries(Object.entries(pools).map(([k, v]) => [k, v.length]));
  const quota = allocate(poolSizes, config);
  const chosen = [];
  for (const [kind, q] of Object.entries(quota)) {
    const pool = pools[kind] ?? [];
    for (let i = 0; i < q; i++) chosen.push(pool[Math.floor((i * pool.length) / q)]);
  }
  chosen.sort(byOsmId);
  const mean = [
    chosen.reduce((t, c) => t + c.lon, 0) / chosen.length,
    chosen.reduce((t, c) => t + c.lat, 0) / chosen.length,
  ];
  let depot = null;
  let depotKind = null;
  for (const kind of config.depotKinds) {
    const options = chosen.filter((c) => c.kind === kind);
    if (options.length === 0) continue;
    let bestD = Infinity;
    for (const c of options) {
      const d = haversine(mean, [c.lon, c.lat]);
      if (d < bestD) {
        bestD = d;
        depot = c;
      }
    }
    depotKind = kind;
    break;
  }
  if (depot === null)
    throw new Error('no square, garden or park among the selected places for the depot');
  const ordered = [depot, ...chosen.filter((c) => c !== depot)];
  return {
    places: ordered.map((c, index) => ({ ...c, index, isDepot: index === 0 })),
    stats: {
      eligible: sorted.length,
      afterDedupe: kept.length,
      poolSizes,
      quota,
      dropped,
      depotKind,
    },
  };
}
