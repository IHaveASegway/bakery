#!/usr/bin/env node
// Repeats the one Nominatim request that checked the city's box (config.mjs, `nominatim`) and says
// whether config.displayBox still contains Nominatim's boundingbox and sits within 0.001 degrees
// of it. One request, a descriptive User-Agent, nothing written.

import { CONFIG } from './config.mjs';

const { query, userAgent } = CONFIG.nominatim;
const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=jsonv2&limit=1`;
const res = await fetch(url, { headers: { 'User-Agent': userAgent } });
if (!res.ok) {
  console.error(`Nominatim answered ${res.status}`);
  process.exit(1);
}
const [hit] = await res.json();
const [south, north, west, east] = hit.boundingbox.map(Number);
const [w, s, e, n] = CONFIG.displayBox;
const ok =
  w <= west &&
  s <= south &&
  e >= east &&
  n >= north &&
  west - w < 1e-3 &&
  south - s < 1e-3 &&
  e - east < 1e-3 &&
  n - north < 1e-3;
console.log(`${hit.osm_type}/${hit.osm_id} ${hit.display_name}`);
console.log(`nominatim: west ${west}, south ${south}, east ${east}, north ${north}`);
console.log(`config:    west ${w}, south ${s}, east ${e}, north ${n}`);
console.log(ok ? 'the display box still matches' : 'the display box differs: review config.mjs');
process.exit(ok ? 0 : 1);
