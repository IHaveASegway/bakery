// Everything the build decides, in one place. The numbers and tags here are the build's inputs:
// change one and the stamps in work/ make the build redo the steps that read it.
//
// Nothing here is a secret: the build talks only to an openrouteservice (ORS) instance it starts
// itself, on this machine, with no API key.

// The display box [west, south, east, north] in integer ten-thousandths of a degree.
const DISPLAY_BOX_1E4 = [-1121014, 406999, -1117404, 408534];

export const CONFIG = {
  city: 'salt-lake-city',
  cityName: 'Salt Lake City, Utah',

  // WGS84 [west, south, east, north], kept as integer ten-thousandths of a degree (DISPLAY_BOX_1E4),
  // as the served files keep integer view units: no file here holds a decimal longitude or latitude.
  // The display box is what the dispatch screen draws: Nominatim's boundingbox for "Salt Lake City,
  // Utah" (relation 198770, fetched 2026-11-05) rounded outward to four decimals. `npm run
  // check-box` repeats the one request and compares.
  displayBox: DISPLAY_BOX_1E4.map((v) => v / 1e4),
  nominatim: {
    query: 'Salt Lake City, Utah',
    osm: 'relation/198770',
    checkedOn: '2026-11-05',
    // Nominatim's raw box as it answered, in integer ten-millionths of a degree.
    boundingbox1e7: { south: 406999263, north: 408533905, west: -1121013916, east: -1117404843 },
    userAgent:
      'ProofOfConceptBakery-route-data/1.0 (open-source demo data build; https://github.com/IHaveASegway/bakery)',
  },
  // The roads ORS uses: the display box plus this margin on every side, as the site's routing box
  // is wider than its display box, so a route that leaves the city and comes back still has roads.
  routingMarginDegrees: { lon: 0.035, lat: 0.027 },

  // Extract sources, tried in order; the first whose file can be fetched wins. `md5Url` is the
  // publisher's checksum file; `stateUrl` its replication state (the extract's data timestamp).
  extractSources: [
    {
      id: 'geofabrik-utah',
      name: 'Geofabrik, Utah',
      url: 'https://download.geofabrik.de/north-america/us/utah-latest.osm.pbf',
      md5Url: 'https://download.geofabrik.de/north-america/us/utah-latest.osm.pbf.md5',
      stateUrl: 'https://download.geofabrik.de/north-america/us/utah-updates/state.txt',
    },
    {
      id: 'openstreetmap-fr-us-west',
      name: 'openstreetmap.fr, US West',
      url: 'https://download.openstreetmap.fr/extracts/north-america/us-west-latest.osm.pbf',
      // The checksum file sits beside the dated name, not the -latest one; the two are the same file.
      md5Url: 'https://download.openstreetmap.fr/extracts/north-america/us-west.osm.pbf.md5',
      stateUrl: 'https://download.openstreetmap.fr/extracts/north-america/us-west.state.txt',
    },
  ],
  downloadTimeoutSeconds: 2700,

  // Place tags, in the order a feature is classified. Only named features count.
  placeTags: {
    square: [['place', 'square']],
    library: [['amenity', 'library']],
    station: [
      ['railway', 'station'],
      ['public_transport', 'station'],
    ],
    viewpoint: [['tourism', 'viewpoint']],
    garden: [['leisure', 'garden']],
    park: [['leisure', 'park']],
  },
  // Not public places: access restricted, or tagged as a shop, an office or a brand.
  notPublicAccess: ['private', 'no', 'customers', 'permit', 'members'],
  notPublicTags: ['shop', 'office', 'brand', 'building:use'],
  // Run by a business, a church or a school: not a public place, however open its doors.
  notPublicOperatorTypes: ['private', 'commercial', 'religious', 'university', 'school', 'college'],
  notPublicOperatorPattern: /\b(university|college|church|school district)\b/i,
  // A business or a residence by its name: dropped, and counted in provenance.
  businessPattern:
    /\b(inc|llc|ltd|corp|corporation|company|co\.|apartments?|apts?|condos?|condominiums?|townhomes?|residences?|villas?|estates|mobile home|trailer|hotel|motel|suites|inn|restaurant|cafe|café|grill|pizza|bakery|brewery|bar|store|shop|salon|clinic|dental|bank|church|school|hospital|mortuary|cemetery)\b/i,

  placeCount: 64,
  // Per-kind quotas (they add up to placeCount); a kind with fewer candidates hands its shortfall
  // to the others in fillOrder. The depot comes from depotKinds, in that order.
  quotas: { park: 22, garden: 6, library: 10, station: 12, viewpoint: 6, square: 8 },
  fillOrder: ['park', 'library', 'station', 'garden', 'viewpoint', 'square'],
  depotKinds: ['square', 'garden', 'park'],
  depotLabel: 'The bakery',
  minSeparationMetres: 450,
  // "type/id" of places to drop by hand, for example one the routing graph cannot reach.
  exclude: [],
  // A candidate must snap to a road within this many metres, or it is not a drop-off spot.
  maxSnapMetres: 500,
  // A viewpoint is often up a trail: it may snap farther (ORS's snapping radius is raised to 1000 m).
  snapMetresByKind: { viewpoint: 1000 },

  viewWidth: 2000,
  isochroneMinutes: [5, 10, 15, 20, 25, 30],
  serviceSeconds: 180,
  profile: 'driving-car',
  simplifyUnits: 0.8,

  ors: {
    // The pin: the newest v9.x tag on 2026-11-05 (v10.x exists; the brief pins v9).
    tag: 'v9.10.0',
    repo: 'https://github.com/GIScience/openrouteservice',
    // Set once a stranger with Docker has pulled the tag; empty until then (see ors/compose.yml).
    imageDigest: '',
    port: 8082,
    heapMegabytes: 6144,
    startupTimeoutSeconds: 1800,
    // One 64 x 64 matrix is 4,096 routes; ors/ors-config.yml allows 10,000. If a server refuses,
    // the build falls back to square blocks of this many places on a side.
    matrixFallbackTile: 32,
  },
  kindWhy: {
    park: 'A public park, mapped leisure=park.',
    garden: 'A public garden, mapped leisure=garden, with no access restriction.',
    library: 'A public library, mapped amenity=library.',
    station: 'A railway or transit station, mapped railway=station or public_transport=station.',
    viewpoint: 'A public viewpoint, mapped tourism=viewpoint.',
    square: 'A public square or plaza, mapped place=square.',
  },
  licenseText: {
    license: 'ODbL-1.0',
    licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
    attribution: '© OpenStreetMap contributors; routing by openrouteservice (self-hosted)',
    copyright: 'https://www.openstreetmap.org/copyright',
  },
};

/** The routing box: the display box plus the margin on each side. */
export function routingBox(config = CONFIG) {
  const [w, s, e, n] = config.displayBox;
  const { lon, lat } = config.routingMarginDegrees;
  return [w - lon, s - lat, e + lon, n + lat].map((v) => Math.round(v * 1e4) / 1e4);
}

/** The config with overrides merged one level deep, for tests (ROUTE_CONFIG names the module). */
export function withOverrides(base, overrides) {
  const out = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof RegExp)
        ? { ...base[k], ...v }
        : v;
  }
  return out;
}
