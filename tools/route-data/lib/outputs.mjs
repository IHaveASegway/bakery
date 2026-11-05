// Step h: the files. Every function here is pure: values in, text out.

import { formatOnePerLine, formatReadable } from './format.mjs';
import { minutesRows } from './matrix.mjs';

const SOURCE_LINE = 'OpenStreetMap, ODbL';

export function routeDataFile({ config, projection, places, durations, distances }) {
  const { license, licenseUrl, attribution, copyright } = config.licenseText;
  return formatOnePerLine({
    license,
    licenseUrl,
    attribution,
    copyright,
    viewBox: [0, 0, projection.width, projection.height],
    serviceSeconds: config.serviceSeconds,
    points: places.map((p) => ({
      i: p.index,
      label: p.isDepot ? config.depotLabel : p.name,
      kind: p.isDepot ? 'depot' : 'stop',
      x: p.x,
      y: p.y,
    })),
    durations,
    distances,
  });
}

export function isochronesFile({ config, projection, depot, minutes, bands }) {
  const { license, licenseUrl, attribution, copyright } = config.licenseText;
  return `${JSON.stringify({
    license,
    licenseUrl,
    attribution,
    copyright,
    viewBox: [0, 0, projection.width, projection.height],
    depot: [depot.x, depot.y],
    minutes,
    within: bands.map((b) => b.path),
  })}\n`;
}

/** The shape crates/domain's TravelMatrix::from_json reads, with extra fields it ignores. */
export function matrixFile({ config, places, durations, built }) {
  return formatOnePerLine({
    city: config.city,
    built,
    source: 'OpenStreetMap contributors (ODbL), openrouteservice driving-car (self-hosted)',
    depot: 0,
    places: places.map((p) => ({ index: p.index, label: p.isDepot ? config.depotLabel : p.name })),
    minutes: minutesRows(durations, places.length),
  });
}

export function attributionText(config) {
  return (
    `Map and route data: ${config.licenseText.attribution.split(';')[0]}, under the Open Database License 1.0\n` +
    `(${config.licenseText.licenseUrl}); see ${config.licenseText.copyright}.\n` +
    `Travel times and reachable areas were computed offline with openrouteservice ${config.ors.tag}, run\n` +
    'on this machine over an OpenStreetMap extract, by tools/route-data/ in the Proof of Concept Bakery\n' +
    'repository. Free-flow times: no traffic. The places are public places; the bakery is made up.\n'
  );
}

export function provenanceFile(p) {
  const {
    config,
    runDate,
    extract,
    extractTimestamp,
    osmiumVersion,
    boxes,
    projection,
    selection,
    places,
    snapInfo,
    orsStatus,
    orsCommit,
    requestCounts,
    matrixInfo,
    nestingPairs,
    nodeVersion,
  } = p;
  return formatReadable({
    built: runDate,
    city: config.cityName,
    extract: {
      source: extract.source,
      url: extract.url,
      bytes: extract.bytes,
      md5: extract.md5,
      md5MatchesPublisher: extract.md5Checked,
      sha256: extract.sha256,
      replicationTimestamp: extractTimestamp,
      state: extract.state ?? null,
    },
    boxes: {
      display: boxes.display,
      routing: boxes.routing,
      nominatimCheck: config.nominatim,
    },
    tools: {
      osmium: osmiumVersion,
      node: nodeVersion,
      orsTag: config.ors.tag,
      orsCommit,
      orsStatus,
    },
    config: {
      profile: config.profile,
      placeCount: config.placeCount,
      isochroneMinutes: config.isochroneMinutes,
      serviceSeconds: config.serviceSeconds,
      viewWidth: config.viewWidth,
      quotas: config.quotas,
      minSeparationMetres: config.minSeparationMetres,
      maxSnapMetres: config.maxSnapMetres,
      snapMetresByKind: config.snapMetresByKind,
      placeTags: config.placeTags,
      exclude: config.exclude,
    },
    projection: {
      kind: 'Web Mercator (equirectangular in metres), north up',
      viewBox: [0, 0, projection.width, projection.height],
      metresPerUnit: Number(projection.metresPerUnit.toFixed(3)),
    },
    requests: { distinctAnswersUsed: requestCounts, matrixRequests: matrixInfo.requests },
    isochroneNesting: nestingPairs,
    selection: {
      rule: SELECTION_RULE,
      ...selection.stats,
      snapped: snapInfo,
    },
    places: places.map((x) => ({
      index: x.index,
      label: x.isDepot ? config.depotLabel : x.name,
      name: x.name,
      depot: x.isDepot,
      osm: `${x.osmType}/${x.osmId}`,
      kind: x.kind,
      tag: x.tag,
      source: SOURCE_LINE,
    })),
  });
}

export const SELECTION_RULE =
  'Sort candidates by OSM id (number, then node, way, relation). Drop a repeated name, an excluded id and any ' +
  'place within the minimum separation of an earlier kept one. Per kind, take every k-th of the id-sorted list: ' +
  'item floor(i * n / q) for i = 0..q-1 (q the kind quota, shortfalls handed on in fill order). The depot is the ' +
  'selected square (else garden, else park) nearest the mean of all selected points, and takes index 0.';

export function placesMarkdown({ config, places }) {
  const rows = places.map((x) => {
    const label = x.isDepot ? config.depotLabel : x.name;
    const why = x.isDepot
      ? `Placed at ${x.name}, which is ${config.kindWhy[x.kind].charAt(0).toLowerCase()}${config.kindWhy[x.kind].slice(1)} The bakery itself is made up.`
      : config.kindWhy[x.kind];
    return `| ${x.index} | ${label} | ${x.kind} (${x.tag}) | ${x.osmType}/${x.osmId} | ${why} |`;
  });
  return [
    `# Places (${places.length})`,
    '',
    `Source for every row: ${SOURCE_LINE}, via the extract named in provenance.json. For review: each is a`,
    'named public place; none is a business, a residence or a person. Index 0 is the bakery.',
    '',
    '| Index | Label | Category | OSM | Why it is public |',
    '| ---: | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

export function readmeText({
  config,
  runDate,
  projection,
  places,
  files,
  selection,
  extract,
  extractTimestamp,
  nestingPairs,
  matrixInfo,
}) {
  const kinds = Object.entries(selection.stats.quota)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  return `# Salt Lake City route data

Static data for the dispatch screen: ${places.length} public places in ${config.cityName}, the bakery being
one, the drive-time and distance matrix between them, and the areas the bakery reaches within
${config.isochroneMinutes.join(', ')} minutes. Built on ${runDate} by \`tools/route-data/build.mjs\`
with a **self-hosted** openrouteservice (ORS ${config.ors.tag}) over an OpenStreetMap extract. No
API key, no third-party service at build time other than the extract's mirror; nothing is computed on a
server at runtime.

## Files

| File | What | Bytes |
| --- | --- | ---: |
${files.map((f) => `| \`${f.name}\` | ${f.what} | ${f.bytes} |`).join('\n')}

SHA-256 of the served files: ${files
    .filter((f) => f.served)
    .map((f) => `\`${f.name}\` \`${f.sha256}\``)
    .join('; ')}.

## Sources, licences and attribution

- **Data:** © OpenStreetMap contributors, Open Database License 1.0 (${config.licenseText.licenseUrl}). The
  served JSON files are a derived database, so they carry \`"license": "ODbL-1.0"\`, the attribution and the
  link; the pipeline here is the method that made them. The screen shows "${config.licenseText.attribution}"
  next to the map, linked to ${config.licenseText.copyright}.
- **Extract:** ${extract.source}${extract.url ? `, ${extract.url}` : ''}; replication timestamp
  ${extractTimestamp ?? 'not in the header'}; ${extract.bytes} bytes; MD5 \`${extract.md5}\`${extract.md5Checked ? " (matches the publisher's)" : ''}; SHA-256 \`${extract.sha256}\`.
- **Tools** (nothing from them ships): osmium-tool; openrouteservice ${config.ors.tag} (GPL-3.0, with its engine
  under LGPL-3.0, as the tag's LICENSE and LICENSE.LESSER say; a build tool here, not part of the screen); Node.
- **Names:** place labels are OSM \`name\` tags (ODbL). The bakery and every order are made up.

## Region and projection

- Display box (west, south, east, north): ${config.displayBox.join(', ')}; the Nominatim boundingbox of
  "${config.nominatim.query}" (${config.nominatim.osm}) on ${config.nominatim.checkedOn}, rounded outward.
- Routing box: the display box plus ${config.routingMarginDegrees.lon} degrees east and west and
  ${config.routingMarginDegrees.lat} degrees north and south, so a route that leaves the city and returns has roads.
- Projection: Web Mercator, north up, into \`viewBox="0 0 ${projection.width} ${projection.height}"\`. One unit is
  ${projection.metresPerUnit.toFixed(3)} m on the ground at the box's middle latitude. Every served coordinate is
  an integer in these units; no served file has a longitude or a latitude.

## Places

${places.length} places chosen from the named parks, gardens, libraries, stations, squares and viewpoints in the
display box (quota per kind: ${kinds}). The rule, exactly:

> ${SELECTION_RULE}

\`places.md\` lists them with a source line each; \`provenance.json\` holds each one's OSM element. Each place
is snapped to a road within ${config.maxSnapMetres} m by ORS's snap endpoint, and the matrix and isochrones run
from the snapped points. A place is a drop-off spot, never somebody's home; the screens show a made-up address.

## Formats

- \`route-data.json\`: one value per line (no line holds two numbers, so no run of digits reads as one longer
  number). \`points\`: \`{i, label, kind, x, y}\`, \`i\` the matrix index, 0 the bakery (\`kind\` depot, else stop).
  \`serviceSeconds\`: ${config.serviceSeconds}. \`durations\`, \`distances\`: ${places.length} x ${places.length}, row-major (from i to j
  is \`[i * ${places.length} + j]\`), whole seconds and metres, ORS's \`${config.profile}\` profile, 0 on the diagonal. These are
  free-flow times with no traffic; the page should say so. No \`legs\`: the dispatch map draws straight lines;
  the self-hosted Directions endpoint could add them in a later run. No \`scenarios\`: the bakery's days come
  from the seed.
- \`isochrones.json\`: \`depot\`: the bakery's [x, y]; \`minutes\`: [${config.isochroneMinutes.join(', ')}];
  \`within[k]\`: SVG path data for the area reachable within \`minutes[k]\`. Absolute \`M\` for the first
  subpath, relative \`m\` after, relative \`l\`, integers, \`z\` closes each ring; fill with
  \`fill-rule="evenodd"\`. The areas are nested, so draw them largest first. ORS returns each range's area
  whole, clipped here to the viewBox. Nesting check on this build: ${nestingPairs.map((p) => `${(p.inside * 100).toFixed(1)}%`).join(', ')}
  of each band's vertices inside the next.
- \`matrix.json\`: \`{city, built, source, depot, places: [{index, label}], minutes: [[...]]}\`, minutes rounded up
  from the seconds, the shape \`crates/domain\`'s \`TravelMatrix::from_json\` loads. Matrix requests this build: ${matrixInfo.requests}.

## Rebuild

From \`tools/route-data/\`, Node 22 and osmium-tool installed. The first run downloads the extract (about 3.8 GB
from the fallback mirror, as of 2026-11-05; Geofabrik's Utah file, tried first, is much smaller) and builds a graph; reruns use \`work/\`.

Path 1, Docker (the documented path): \`docker compose\` and nothing else. \`node build.mjs\` prepares \`work/ors/\`
(config, the clipped extract) and starts \`ors/compose.yml\` itself when a Docker daemon answers; to start it by
hand, run \`docker compose -f ors/compose.yml up -d\` after the build has written \`work/ors/\`.

Path 2, no Docker: Java 21 and Maven. \`sh ors/build-jar.sh\` clones ORS ${config.ors.tag} and builds \`work/ors.jar\`
(about 5 minutes on 4 CPUs, 2026-11-05); \`node build.mjs\` then runs it with \`java -jar\` and the same \`ors/ors-config.yml\`.

\`\`\`sh
cd tools/route-data
npm run build          # picks Docker when a daemon answers, else the jar
npm test               # node --test "test/*.test.mjs"
\`\`\`

A rerun over an intact \`work/\` sends no request and rewrites identical bytes (the tests prove it). A
fresh \`work/\` builds a fresh graph; ORS's graph build is deterministic enough for equal times on one machine,
but it is not promised across versions or machines, so the committed files are the record.

## Open questions

- **Squares** are \`place=square\` nodes and areas; OSM maps few of them. The depot falls back to a garden, then a
  park, if none is selected (this build: ${selection.stats.depotKind}).
- **Free-flow times.** ORS's car profile knows speed limits, not traffic. The page should say "minutes without
  traffic".
- **Docker image digest.** \`ors/compose.yml\` pins the tag; the digest waits for a machine with a Docker daemon.
- **Content firewall.** \`places.md\` and \`provenance.json\` hold OSM ids and coordinates-free names; Joseph reads
  the 64 names against the firewall's classes before the fixture is committed.
`;
}
