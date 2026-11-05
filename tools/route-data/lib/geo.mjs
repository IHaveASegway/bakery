// Geometry: the site's equirectangular-in-Mercator projection of a box into a fixed-width viewBox,
// ring clipping and simplification, and the site's compact SVG path encoding (absolute M first,
// relative m after, relative l with implicit repetition, z for rings, integers only). Written
// afresh from the site's tools/route-data/pipeline/lib/geom.mjs (read for the formulas only).

const R = 6378137;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const mercX = (lon) => R * rad(lon);
const mercY = (lat) => R * Math.log(Math.tan(Math.PI / 4 + rad(lat) / 2));

/**
 * A projection from [lon, lat] to viewBox [x, y] (y down) for bbox [west, south, east, north],
 * `width` units wide. `metresPerUnit` is ground metres per unit at the box's middle latitude.
 */
export function makeProjection(bbox, width) {
  const [w, s, e, n] = bbox;
  const x0 = mercX(w);
  const y1 = mercY(n);
  const k = width / (mercX(e) - x0);
  const height = Math.round((y1 - mercY(s)) * k);
  return {
    width,
    height,
    metresPerUnit: Math.cos(rad((s + n) / 2)) / k,
    project: ([lon, lat]) => [(mercX(lon) - x0) * k, (y1 - mercY(lat)) * k],
    unproject: ([x, y]) => [
      deg(x / k / R + rad(w)),
      deg(2 * Math.atan(Math.exp((y1 - y / k) / R)) - Math.PI / 2),
    ],
  };
}

/** Haversine distance in metres. */
export function haversine([lon1, lat1], [lon2, lat2]) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(a));
}

/** Signed area of a ring (shoelace); the sign follows the winding. */
export function signedArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/** The centroid of a ring (area-weighted; the mean of its vertices when it has no area). */
export function ringCentroid(ring) {
  // Work relative to the first vertex: with longitudes near -112 the cross products cancel badly.
  const [ox, oy] = ring[0];
  const r = ring.map(([x, y]) => [x - ox, y - oy]);
  const a = signedArea(r);
  if (Math.abs(a) < 1e-18) {
    const n = r.length;
    return [ox + r.reduce((t, p) => t + p[0], 0) / n, oy + r.reduce((t, p) => t + p[1], 0) / n];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < r.length; i++) {
    const [x1, y1] = r[i];
    const [x2, y2] = r[(i + 1) % r.length];
    const cross = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  return [ox + cx / (6 * a), oy + cy / (6 * a)];
}

function pointSegDist(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function simplifyLine(points, tolerance) {
  if (points.length < 3) return points;
  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop();
    let worst = -1;
    let at = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = pointSegDist(points[i], points[lo], points[hi]);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tolerance) {
      keep[at] = true;
      stack.push([lo, at], [at, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Douglas-Peucker on a closed ring (no repeated closing vertex): split at the farthest vertex. */
export function simplifyRing(ring, tolerance) {
  if (ring.length < 4) return ring;
  let far = 0;
  let best = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const first = simplifyLine(ring.slice(0, far + 1), tolerance);
  const second = simplifyLine([...ring.slice(far), ring[0]], tolerance);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

/** Sutherland-Hodgman clip of a ring to the rectangle [minX, minY, maxX, maxY]. */
export function clipRing(ring, [minX, minY, maxX, maxY]) {
  const edges = [
    [(p) => p[0] >= minX, (a, b) => [minX, a[1] + ((b[1] - a[1]) * (minX - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= maxX, (a, b) => [maxX, a[1] + ((b[1] - a[1]) * (maxX - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= minY, (a, b) => [a[0] + ((b[0] - a[0]) * (minY - a[1])) / (b[1] - a[1]), minY]],
    [(p) => p[1] <= maxY, (a, b) => [a[0] + ((b[0] - a[0]) * (maxY - a[1])) / (b[1] - a[1]), maxY]],
  ];
  let out = ring;
  for (const [inside, cross] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      if (inside(cur)) {
        if (!inside(prev)) out.push(cross(prev, cur));
        out.push(cur);
      } else if (inside(prev)) {
        out.push(cross(prev, cur));
      }
    }
    if (out.length === 0) return [];
  }
  return out;
}

const samePoint = (a, b) => a[0] === b[0] && a[1] === b[1];

/** Drop consecutive duplicates, and a closing vertex equal to the first. */
export function dedupeRing(points) {
  const out = [];
  for (const p of points) if (out.length === 0 || !samePoint(out[out.length - 1], p)) out.push(p);
  while (out.length > 1 && samePoint(out[0], out[out.length - 1])) out.pop();
  return out;
}

/** Compact SVG path data for closed integer rings (open lists: no repeated closing vertex). */
export function pathData(rings) {
  let out = '';
  let cx = 0;
  let cy = 0;
  let first = true;
  const num = (n, prev) => (prev === undefined || n < 0 ? String(n) : ` ${n}`);
  for (const raw of rings) {
    const pts = dedupeRing(raw);
    if (pts.length < 3) continue;
    const [x0, y0] = pts[0];
    if (first) {
      out += `M${x0}${num(y0, x0)}`;
      first = false;
    } else {
      const dx = x0 - cx;
      out += `m${dx}${num(y0 - cy, dx)}`;
    }
    out += 'l';
    let px = x0;
    let py = y0;
    let prev;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - px;
      const dy = pts[i][1] - py;
      out += num(dx, prev) + num(dy, dx);
      prev = dy;
      px = pts[i][0];
      py = pts[i][1];
    }
    out += 'z';
    cx = x0;
    cy = y0;
  }
  return out;
}

/**
 * Parse path data written by `pathData` back into rings: [{points, closed}]. Throws on anything
 * else, so a test can say a path is exactly the shape the screen draws.
 */
export function parsePath(d) {
  const tokens = d.match(/[MmlLzZ]|-?\d+/g) ?? [];
  if (tokens.join('').length !== d.replace(/ /g, '').length)
    throw new Error('unexpected path text');
  const rings = [];
  let cur = null;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let i = 0;
  let mode = null;
  const int = () => {
    const t = tokens[i++];
    if (t === undefined || !/^-?\d+$/.test(t)) throw new Error('number expected');
    return Number(t);
  };
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === 'M' || t === 'm') {
      i++;
      const x = int();
      const y = int();
      cx = t === 'M' ? x : cx + x;
      cy = t === 'M' ? y : cy + y;
      sx = cx;
      sy = cy;
      cur = { points: [[cx, cy]], closed: false };
      rings.push(cur);
      mode = 'm';
    } else if (t === 'l') {
      i++;
      mode = 'l';
    } else if (t === 'z') {
      i++;
      if (!cur) throw new Error('z before M');
      cur.closed = true;
      cx = sx;
      cy = sy;
      mode = 'z';
    } else if (mode === 'l') {
      cx += int();
      cy += int();
      cur.points.push([cx, cy]);
    } else {
      throw new Error(`unexpected token ${t}`);
    }
  }
  return rings;
}

/** True when `p` is inside the rings by the even-odd rule, or within `tolerance` of an edge. */
export function insideOrNear(p, rings, tolerance) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (pointSegDist(p, a, b) <= tolerance) return true;
      if (
        a[1] > p[1] !== b[1] > p[1] &&
        p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
      )
        inside = !inside;
    }
  }
  return inside;
}
