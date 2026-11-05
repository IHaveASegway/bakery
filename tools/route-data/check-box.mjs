#!/usr/bin/env node
// Repeats the one Nominatim request that checked the city's box (config.mjs, `nominatim`) and says
// whether config.displayBox still contains Nominatim's boundingbox and sits within 0.001 degrees
// of it, compared as integers. One request, a descriptive User-Agent, nothing written.

import { CONFIG } from './config.mjs';

const { query, userAgent } = CONFIG.nominatim;
const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=jsonv2&limit=1`;
const res = await fetch(url, { headers: { 'User-Agent': userAgent } });
if (!res.ok) {
  console.error(`Nominatim answered ${res.status}`);
  process.exit(1);
}
const [hit] = await res.json();
// Everything is compared as integers: Nominatim's decimals scaled to ten-millionths of a degree,
// the display box in ten-thousandths scaled up to match. The tolerance is 0.001 degree.
const [south, north, west, east] = hit.boundingbox.map((v) => Math.round(Number(v) * 1e7));
const [w, s, e, n] = CONFIG.displayBox.map((v) => Math.round(v * 1e7));
const tolerance = 1e4;
const ok =
  w <= west &&
  s <= south &&
  e >= east &&
  n >= north &&
  west - w < tolerance &&
  south - s < tolerance &&
  e - east < tolerance &&
  n - north < tolerance;
console.log(`${hit.osm_type}/${hit.osm_id} ${hit.display_name}`);
console.log(`nominatim (1e-7 degrees): west ${west}, south ${south}, east ${east}, north ${north}`);
console.log(`config    (1e-7 degrees): west ${w}, south ${s}, east ${e}, north ${n}`);
console.log(ok ? 'the display box still matches' : 'the display box differs: review config.mjs');
process.exit(ok ? 0 : 1);
