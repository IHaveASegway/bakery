#!/usr/bin/env node
// Builds the Salt Lake City route data with a self-hosted openrouteservice. See README.md (written
// into out/ by this script) and ors/. Needs no API key and no secret. Node 22, osmium-tool, and
// either Docker or Java 21 + Maven.
//
// Environment (all optional):
//   ROUTE_EXTRACT   a local .osm.pbf to use instead of downloading one
//   ORS_URL         base URL of an ORS instance that is already running (never started or stopped)
//   ROUTE_WORK_DIR, ROUTE_OUT_DIR, ROUTE_SEED_DIR, ROUTE_WEB_DIR   where things go
//   ROUTE_CONFIG    path of a module whose default export overrides config.mjs (the tests use it)

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONFIG, routingBox, withOverrides } from './config.mjs';
import {
  clipExtract,
  exportPlaces,
  extractTimestamp,
  fetchExtract,
  osmiumVersion,
} from './lib/extract.mjs';
import { makeProjection } from './lib/geo.mjs';
import { bandsFromResponse, nesting } from './lib/isochrones.mjs';
import { buildMatrix } from './lib/matrix.mjs';
import { makeClient, makeInstance } from './lib/ors.mjs';
import {
  attributionText,
  isochronesFile,
  matrixFile,
  placesMarkdown,
  provenanceFile,
  readmeText,
  routeDataFile,
} from './lib/outputs.mjs';
import { candidatesFromFeatures, selectPlaces } from './lib/places.mjs';
import { sha256, writeAtomic } from './lib/proc.mjs';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.join(TOOL_DIR, '..', '..');

async function orsCommit(workDir) {
  try {
    return (await fsp.readFile(path.join(workDir, 'ors-commit.txt'), 'utf8')).trim();
  } catch {
    return null;
  }
}

export async function build(env = process.env, log = (m) => console.log(m)) {
  let config = CONFIG;
  if (env.ROUTE_CONFIG) {
    config = withOverrides(
      CONFIG,
      (await import(pathToFileURL(path.resolve(env.ROUTE_CONFIG)).href)).default,
    );
  }
  const workDir = path.resolve(env.ROUTE_WORK_DIR ?? path.join(TOOL_DIR, 'work'));
  const outDir = path.resolve(env.ROUTE_OUT_DIR ?? path.join(TOOL_DIR, 'out'));
  const seedDir = path.resolve(
    env.ROUTE_SEED_DIR ?? path.join(REPO_DIR, 'crates/seed/data', config.city),
  );
  const webDir = path.resolve(
    env.ROUTE_WEB_DIR ?? path.join(REPO_DIR, 'apps/web/public/app/dispatch/data'),
  );
  await fsp.mkdir(workDir, { recursive: true });

  // The build date is fixed when the work directory is first used, so a rerun writes the same bytes.
  const runFile = path.join(workDir, 'run.json');
  let runDate;
  try {
    runDate = JSON.parse(await fsp.readFile(runFile, 'utf8')).date;
  } catch {
    runDate = new Date().toISOString().slice(0, 10);
    await writeAtomic(runFile, `${JSON.stringify({ date: runDate })}\n`);
  }

  // a, b: the extract and the clips.
  const extract = await fetchExtract({ config, workDir, log, localFile: env.ROUTE_EXTRACT });
  const { routingOut, placesOut } = await clipExtract({
    routing: routingBox(config),
    display: config.displayBox,
    input: extract.file,
    inputKey: extract.sha256,
    workDir,
    log,
  });
  const timestamp = await extractTimestamp(extract.file);

  // c, first half: candidates from the tags.
  const features = await exportPlaces({ config, placesArea: placesOut, workDir, log });
  const { candidates, dropped } = candidatesFromFeatures(features, config);
  log(`places: ${features.length} tagged features, ${candidates.length} candidates`);

  // d: the instance, started only when an answer is not already cached.
  const instance = makeInstance({ config, workDir, routingPbf: routingOut, url: env.ORS_URL, log });
  const client = makeClient({ instance, cacheDir: path.join(workDir, 'cache') });
  try {
    const status = await client.get('/ors/v2/status');
    const route = (name) => `/ors/v2/${name}/${config.profile}`;

    // Snap every candidate to the road network; one that is too far from a road is not a drop-off spot.
    const pool = [...candidates].sort(
      (a, b) => a.osmId - b.osmId || (a.osmType < b.osmType ? -1 : 1),
    );
    const eligible = [];
    let unsnapped = 0;
    for (let i = 0; i < pool.length; i += 500) {
      const chunk = pool.slice(i, i + 500);
      const res = await client.post(route('snap'), {
        locations: chunk.map((c) => [c.lon, c.lat]),
        radius: Math.max(config.maxSnapMetres, ...Object.values(config.snapMetresByKind)),
      });
      chunk.forEach((c, j) => {
        const hit = res.locations?.[j];
        const limit = config.snapMetresByKind[c.kind] ?? config.maxSnapMetres;
        if (!hit || (hit.snapped_distance ?? 0) > limit) {
          unsnapped += 1;
          return;
        }
        const [lon, lat] = hit.location.map((v) => Math.round(v * 1e6) / 1e6);
        eligible.push({
          ...c,
          origin: [c.lon, c.lat],
          lon,
          lat,
          snapMetres: Math.round(hit.snapped_distance ?? 0),
        });
      });
    }
    log(
      `places: ${eligible.length} snap to a road within ${config.maxSnapMetres} m, ${unsnapped} do not`,
    );

    // c, second half: the selection.
    const selection = selectPlaces(eligible, config);
    selection.stats.dropped = { ...dropped, ...selection.stats.dropped, unsnappable: unsnapped };

    // g: the projection of the display box; points on the snapped road position.
    const projection = makeProjection(config.displayBox, config.viewWidth);
    const places = selection.places.map((p) => {
      const [x, y] = projection.project([p.lon, p.lat]).map(Math.round);
      return { ...p, label: p.isDepot ? config.depotLabel : p.name, x, y };
    });
    const locations = places.map((p) => [p.lon, p.lat]);

    // e: the matrix.
    log(`matrix: ${places.length} places`);
    const matrixInfo = await buildMatrix({
      post: (r, b) => client.post(r, b),
      route: route('matrix'),
      places,
      locations,
      config,
    });
    log(`matrix: ${matrixInfo.requests} request(s)`);

    // f: the isochrones from the depot.
    const isoResponse = await client.post(route('isochrones'), {
      locations: [locations[0]],
      range: config.isochroneMinutes.map((m) => m * 60),
      range_type: 'time',
    });
    const bands = bandsFromResponse(
      isoResponse,
      config.isochroneMinutes,
      projection,
      config.simplifyUnits,
    );
    const nestingPairs = nesting(bands.map((b) => b.path));
    for (const pair of nestingPairs) {
      if (pair.inside < 0.98 || !pair.grows) {
        throw new Error(
          `isochrones ${config.isochroneMinutes[pair.from]} and ${config.isochroneMinutes[pair.to]} min are not nested (${(pair.inside * 100).toFixed(1)}% inside)`,
        );
      }
    }

    // h: write.
    const common = {
      config,
      projection,
      places,
      durations: matrixInfo.durations,
      distances: matrixInfo.distances,
    };
    const routeData = routeDataFile(common);
    const isochrones = isochronesFile({
      config,
      projection,
      depot: places[0],
      minutes: config.isochroneMinutes,
      bands,
    });
    const matrix = matrixFile({ config, places, durations: matrixInfo.durations, built: runDate });
    const provenance = provenanceFile({
      config,
      runDate,
      extract,
      extractTimestamp: timestamp,
      osmiumVersion: await osmiumVersion(),
      boxes: { display: config.displayBox, routing: routingBox(config) },
      projection,
      selection,
      places,
      snapInfo: { candidatesSnapped: eligible.length, unsnapped },
      orsStatus: { engine: status.engine, profiles: Object.keys(status.profiles ?? {}) },
      orsCommit: await orsCommit(workDir),
      requestCounts: client.requestCounts(),
      matrixInfo,
      nestingPairs,
      nodeVersion: process.version,
    });
    const placesMd = placesMarkdown({ config, places });
    const attribution = attributionText(config);
    const entry = (name, what, text, served) => ({
      name,
      what,
      text,
      served,
      bytes: Buffer.byteLength(text),
      sha256: sha256(text),
    });
    const files = [
      entry('route-data.json', 'Points, the duration and distance matrices', routeData, true),
      entry('isochrones.json', 'Areas the bakery reaches within each band', isochrones, true),
      entry('matrix.json', 'Whole minutes, for crates/domain', matrix, true),
      entry(
        'provenance.json',
        'Extract checksum, tool versions, every place with its OSM element (not served)',
        provenance,
        false,
      ),
      entry('places.md', 'The places for review (not served)', placesMd, false),
    ];
    const readme = readmeText({
      config,
      runDate,
      projection,
      places,
      files,
      selection,
      extract,
      extractTimestamp: timestamp,
      nestingPairs,
      matrixInfo,
    });
    for (const f of files) await writeAtomic(path.join(outDir, f.name), f.text);
    await writeAtomic(path.join(outDir, 'README.md'), readme);
    await writeAtomic(path.join(outDir, 'ATTRIBUTION.txt'), attribution);
    const get = (name) => files.find((f) => f.name === name).text;
    for (const name of ['route-data.json', 'isochrones.json', 'matrix.json'])
      await writeAtomic(path.join(seedDir, name), get(name));
    for (const name of ['route-data.json', 'isochrones.json'])
      await writeAtomic(path.join(webDir, name), get(name));
    await writeAtomic(path.join(webDir, 'ATTRIBUTION.txt'), attribution);
    log(`done: ${places.length} places, out/ and the two copy targets written`);
    return { places, files };
  } finally {
    await instance.stop();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build().catch((e) => {
    console.error(`build failed: ${e.message}`);
    process.exit(1);
  });
}
