# Salt Lake City route data

Static data for the dispatch screen: 64 public places in Salt Lake City, Utah, the bakery being
one, the drive-time and distance matrix between them, and the areas the bakery reaches within
5, 10, 15, 20, 25, 30 minutes. Built on 2026-11-05 by `tools/route-data/build.mjs`
with a **self-hosted** openrouteservice (ORS v9.10.0) over an OpenStreetMap extract. No
API key, no third-party service at build time other than the extract's mirror; nothing is computed on a
server at runtime.

## Files

| File | What | Bytes |
| --- | --- | ---: |
| `route-data.json` | Points, the duration and distance matrices | 53382 |
| `isochrones.json` | Areas the bakery reaches within each band | 5521 |
| `matrix.json` | Whole minutes, for crates/domain | 19071 |
| `provenance.json` | Extract checksum, tool versions, every place with its OSM element (not served) | 20529 |
| `places.md` | The places for review (not served) | 8177 |

SHA-256 of the served files: `route-data.json` `024427fbd8930832fcf384cd0efb1ebf0908151b36b7f8a2d4eadf79845aab7d`; `isochrones.json` `e63066c710c831daacd7e6b83b7726a10fe949e714d19187d3b677b95cc0b363`; `matrix.json` `79d3a9b5475c4b175cdc6c44d1e4efded968c2e560b04dd9a303281c618542d1`.

## Sources, licences and attribution

- **Data:** © OpenStreetMap contributors, Open Database License 1.0 (https://opendatacommons.org/licenses/odbl/1-0/). The
  served JSON files are a derived database, so they carry `"license": "ODbL-1.0"`, the attribution and the
  link; the pipeline here is the method that made them. The screen shows "© OpenStreetMap contributors; routing by openrouteservice (self-hosted)"
  next to the map, linked to https://www.openstreetmap.org/copyright.
- **Extract:** openstreetmap.fr, US West, https://download.openstreetmap.fr/extracts/north-america/us-west-latest.osm.pbf; replication timestamp
  2026-11-05T00:58:30Z; 3778845964 bytes; MD5 `725b4651c9e2aa5cd7abc18e2efb9115` (matches the publisher's); SHA-256 `21759ea9c1d9ea4786bb9fc93c32df1fbc29d04de63a37147b88f07544b08f6d`.
- **Tools** (nothing from them ships): osmium-tool; openrouteservice v9.10.0 (GPL-3.0, with its engine
  under LGPL-3.0, as the tag's LICENSE and LICENSE.LESSER say; a build tool here, not part of the screen); Node.
- **Names:** place labels are OSM `name` tags (ODbL). The bakery and every order are made up.

## Region and projection

- Display box (west, south, east, north), in integer ten-thousandths of a degree: -1121014, 406999, -1117404, 408534;
  the Nominatim boundingbox of "Salt Lake City, Utah" (relation/198770) on 2026-11-05,
  rounded outward to four decimals. Like the served files, the build's own files keep integers, not decimal degrees.
- Routing box: the display box plus 0.035 degrees east and west and
  0.027 degrees north and south, so a route that leaves the city and returns has roads.
- Projection: Web Mercator, north up, into `viewBox="0 0 2000 1123"`. One unit is
  15.216 m on the ground at the box's middle latitude. Every served coordinate is
  an integer in these units; no served file has a longitude or a latitude.

## Places

64 places chosen from the named parks, gardens, libraries, stations, squares and viewpoints in the
display box (quota per kind: park 33, garden 8, library 7, station 14, viewpoint 1, square 1). The rule, exactly:

> Sort candidates by OSM id (number, then node, way, relation). Drop a repeated name, an excluded id and any place within the minimum separation of an earlier kept one. Per kind, take every k-th of the id-sorted list: item floor(i * n / q) for i = 0..q-1 (q the kind quota, shortfalls handed on in fill order). The depot is the selected square (else garden, else park) nearest the mean of all selected points, and takes index 0.

`places.md` lists them with a source line each; `provenance.json` holds each one's OSM element. Each place
is snapped to a road within 500 m by ORS's snap endpoint, and the matrix and isochrones run
from the snapped points. A place is a drop-off spot, never somebody's home; the screens show a made-up address.

## Formats

- `route-data.json`: one value per line (no line holds two numbers, so no run of digits reads as one longer
  number). `points`: `{i, label, kind, x, y}`, `i` the matrix index, 0 the bakery (`kind` depot, else stop).
  `serviceSeconds`: 180. `durations`, `distances`: 64 x 64, row-major (from i to j
  is `[i * 64 + j]`), whole seconds and metres, ORS's `driving-car` profile, 0 on the diagonal. These are
  free-flow times with no traffic; the page should say so. No `legs`: the dispatch map draws straight lines;
  the self-hosted Directions endpoint could add them in a later run. No `scenarios`: the bakery's days come
  from the seed.
- `isochrones.json`: `depot`: the bakery's [x, y]; `minutes`: [5, 10, 15, 20, 25, 30];
  `within[k]`: SVG path data for the area reachable within `minutes[k]`. Absolute `M` for the first
  subpath, relative `m` after, relative `l`, integers, `z` closes each ring; fill with
  `fill-rule="evenodd"`. The areas are nested, so draw them largest first. ORS returns each range's area
  whole, clipped here to the viewBox. Nesting check on this build: 100.0%, 100.0%, 100.0%, 100.0%, 100.0%
  of each band's vertices inside the next.
- `matrix.json`: `{city, built, source, depot, places: [{index, label}], minutes: [[...]]}`, minutes rounded up
  from the seconds, the shape `crates/domain`'s `TravelMatrix::from_json` loads. Matrix requests this build: 1.

## Rebuild

From `tools/route-data/`, Node 22 and osmium-tool installed. The first run downloads the extract (about 3.8 GB
from the fallback mirror, as of 2026-11-05; Geofabrik's Utah file, tried first, is much smaller) and builds a graph; reruns use `work/`.

Path 1, Docker (the documented path): `docker compose` and nothing else. `node build.mjs` prepares `work/ors/`
(config, the clipped extract) and starts `ors/compose.yml` itself when a Docker daemon answers; to start it by
hand, run `docker compose -f ors/compose.yml up -d` after the build has written `work/ors/`.

Path 2, no Docker: Java 21 and Maven. `sh ors/build-jar.sh` clones ORS v9.10.0 and builds `work/ors.jar`
(about 5 minutes on 4 CPUs, 2026-11-05); `node build.mjs` then runs it with `java -jar` and the same `ors/ors-config.yml`.

```sh
cd tools/route-data
npm run build          # picks Docker when a daemon answers, else the jar
npm test               # node --test "test/*.test.mjs"
```

A rerun over an intact `work/` sends no request and rewrites identical bytes (the tests prove it). A
fresh `work/` builds a fresh graph; ORS's graph build is deterministic enough for equal times on one machine,
but it is not promised across versions or machines, so the committed files are the record.

## Open questions

- **Squares** are `place=square` nodes and areas; OSM maps few of them. The depot falls back to a garden, then a
  park, if none is selected (this build: square).
- **Free-flow times.** ORS's car profile knows speed limits, not traffic. The page should say "minutes without
  traffic".
- **Docker image digest.** `ors/compose.yml` pins the tag; the digest waits for a machine with a Docker daemon.
- **Content firewall.** `places.md` and `provenance.json` hold OSM ids and coordinates-free names; Joseph reads
  the 64 names against the firewall's classes before the fixture is committed.
