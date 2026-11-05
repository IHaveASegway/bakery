// Step e: the 64 x 64 travel-time matrix from ORS's Matrix v2, in one request when the instance
// allows it and in square blocks when it does not.

import { OrsError } from './ors.mjs';

/**
 * Blocks of source and destination indices that cover every ordered pair exactly once. With
 * `tile` at least n, one block holds all pairs; otherwise square tiles of `tile` places a side.
 */
export function planBlocks(n, tile) {
  const size = Math.max(1, Math.min(tile, n));
  const ranges = [];
  for (let start = 0; start < n; start += size) {
    ranges.push(Array.from({ length: Math.min(size, n - start) }, (_, i) => start + i));
  }
  const blocks = [];
  for (const sources of ranges)
    for (const destinations of ranges) blocks.push({ sources, destinations });
  return blocks;
}

/** The request body for a block over `locations` ([lon, lat] per place). */
export function blockRequest(block, locations) {
  const union = [...block.sources];
  for (const d of block.destinations) if (!union.includes(d)) union.push(d);
  const position = new Map(union.map((place, i) => [place, i]));
  return {
    union,
    body: {
      locations: union.map((p) => locations[p]),
      metrics: ['duration', 'distance'],
      units: 'm',
      sources: block.sources.map((p) => String(position.get(p))),
      destinations: block.destinations.map((p) => String(position.get(p))),
    },
  };
}

/**
 * The flat row-major durations (whole seconds) and distances (metres) for `places`, asking `post`
 * (route, body) -> parsed response. An unreachable or missing pair stops the build with its
 * labels. The diagonal is 0.
 */
export async function buildMatrix({ post, route, places, locations, config }) {
  const n = places.length;
  const durations = new Array(n * n).fill(null);
  const distances = new Array(n * n).fill(null);
  let requests = 0;
  async function fill(blocks) {
    for (const block of blocks) {
      const { body } = blockRequest(block, locations);
      const res = await post(route, body);
      requests += 1;
      block.sources.forEach((s, r) =>
        block.destinations.forEach((d, c) => {
          durations[s * n + d] = res.durations?.[r]?.[c] ?? null;
          distances[s * n + d] = res.distances?.[r]?.[c] ?? null;
        }),
      );
    }
  }
  try {
    await fill(planBlocks(n, n));
  } catch (e) {
    if (!(e instanceof OrsError) || e.status !== 400 || ![6004, 6020].includes(e.code)) throw e;
    // The instance refused the full matrix (6004: over its limit; 6020: too many visited nodes).
    await fill(planBlocks(n, config.ors.matrixFallbackTile));
  }
  for (let i = 0; i < n; i++) {
    durations[i * n + i] = 0;
    distances[i * n + i] = 0;
    for (let j = 0; j < n; j++) {
      const d = durations[i * n + j];
      const m = distances[i * n + j];
      if (!Number.isFinite(d) || !Number.isFinite(m)) {
        throw new Error(
          `unreachable pair: ${places[i].label} (${i}) to ${places[j].label} (${j}) has no route; add its OSM id to config.exclude and rerun`,
        );
      }
      durations[i * n + j] = Math.round(d);
      distances[i * n + j] = Math.round(m);
    }
  }
  return { durations, distances, requests };
}

/** Whole minutes, rounded up from seconds, as rows (the shape the Rust reader loads). */
export function minutesRows(durations, n) {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : Math.ceil(durations[i * n + j] / 60))),
  );
}
