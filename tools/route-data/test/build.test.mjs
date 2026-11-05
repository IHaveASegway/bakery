// The whole build against a fake ORS and a tiny hand-written OSM file converted with osmium.
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from '../build.mjs';
import { CONFIG } from '../config.mjs';
import { parsePath } from '../lib/geo.mjs';
import { nesting } from '../lib/isochrones.mjs';
import { fakeLeg, startFakeOrs } from './fake-ors.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, '..');

let osmium = true;
try {
  await run('osmium', ['--version']);
} catch {
  osmium = false;
}
const opts = { skip: osmium ? false : 'osmium-tool is not installed' };

let tmp;
let pbf;
const quiet = () => {};

function envFor(root, extra = {}) {
  return {
    ROUTE_EXTRACT: pbf,
    ROUTE_CONFIG: path.join(HERE, 'test-config.mjs'),
    ROUTE_WORK_DIR: path.join(root, 'work'),
    ROUTE_OUT_DIR: path.join(root, 'out'),
    ROUTE_SEED_DIR: path.join(root, 'seed'),
    ROUTE_WEB_DIR: path.join(root, 'web'),
    ...extra,
  };
}

async function readAll(dir) {
  const out = {};
  for (const name of await fsp.readdir(dir, { recursive: true })) {
    const full = path.join(dir, name);
    if ((await fsp.stat(full)).isFile()) out[name] = await fsp.readFile(full);
  }
  return out;
}

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'route-data-test-'));
  pbf = path.join(tmp, 'sample.osm.pbf');
  if (osmium)
    await run('osmium', ['sort', path.join(HERE, 'fixtures/sample.osm'), '-o', pbf, '--overwrite']);
});
after(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

test('a build over the sample writes the files the dispatch screen reads', opts, async () => {
  const fake = await startFakeOrs();
  const root = path.join(tmp, 'a');
  const logs = [];
  try {
    await build(envFor(root, { ORS_URL: fake.url }), (m) => logs.push(m));
    const out = path.join(root, 'out');
    const rd = JSON.parse(await fsp.readFile(path.join(out, 'route-data.json'), 'utf8'));
    assert.deepEqual(Object.keys(rd), [
      'license',
      'licenseUrl',
      'attribution',
      'copyright',
      'viewBox',
      'serviceSeconds',
      'points',
      'durations',
      'distances',
    ]);
    assert.equal(rd.license, 'ODbL-1.0');
    assert.match(rd.attribution, /OpenStreetMap contributors/);
    assert.match(rd.attribution, /openrouteservice/);
    assert.equal(rd.serviceSeconds, 180);
    assert.deepEqual(rd.viewBox.slice(0, 3), [0, 0, 2000]);
    assert.ok(!('legs' in rd) && !('scenarios' in rd));
    assert.deepEqual(
      rd.points.map((p) => p.label),
      [
        'The bakery',
        'Fixture Park A',
        'Fixture Garden',
        'Fixture Library',
        'Fixture Station',
        'Fixture Overlook',
      ],
    );
    assert.deepEqual(
      rd.points.map((p) => p.kind),
      ['depot', 'stop', 'stop', 'stop', 'stop', 'stop'],
    );
    assert.ok(
      rd.points.every(
        (p, i) =>
          p.i === i &&
          Number.isInteger(p.x) &&
          Number.isInteger(p.y) &&
          p.x >= 0 &&
          p.x <= 2000 &&
          p.y >= 0 &&
          p.y <= rd.viewBox[3],
      ),
    );
    assert.ok(
      !JSON.stringify(rd.points).includes('Plaza'),
      'the depot’s real name stays out of the screen data',
    );

    // Row-major with zero diagonals, equal to the fake’s legs between the points it was asked about.
    const asked = fake.posts('/matrix/driving-car')[0].body.locations;
    assert.equal(fake.posts('/matrix/driving-car').length, 1, 'one request for the whole matrix');
    assert.equal(rd.durations.length, 36);
    assert.equal(rd.distances.length, 36);
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        const leg = fakeLeg(asked[i], asked[j]);
        assert.equal(rd.durations[i * 6 + j], i === j ? 0 : Math.round(leg.seconds));
        assert.equal(rd.distances[i * 6 + j], i === j ? 0 : Math.round(leg.metres));
      }
    }
    // The one-per-line layout: no line holds two numbers.
    const text = await fsp.readFile(path.join(out, 'route-data.json'), 'utf8');
    assert.ok(
      text
        .split('\n')
        .every((l) => (l.match(/\d+/g) ?? []).length <= 1 || /"[^"]*\d[^"]*"/.test(l)),
    );

    // Isochrones: six closed, nested bands in the site’s shape.
    const iso = JSON.parse(await fsp.readFile(path.join(out, 'isochrones.json'), 'utf8'));
    assert.deepEqual(iso.minutes, [5, 10, 15, 20, 25, 30]);
    assert.deepEqual(iso.depot, [rd.points[0].x, rd.points[0].y]);
    assert.equal(iso.within.length, 6);
    for (const d of iso.within)
      assert.ok(parsePath(d).every((r) => r.closed && r.points.length >= 3));
    assert.ok(nesting(iso.within).every((p) => p.inside === 1 && p.grows));
    assert.deepEqual(
      fake.posts('/isochrones/driving-car')[0].body.range,
      [300, 600, 900, 1200, 1500, 1800],
    );

    // matrix.json in the shape crates/domain loads.
    const mx = JSON.parse(await fsp.readFile(path.join(out, 'matrix.json'), 'utf8'));
    assert.equal(mx.city, 'salt-lake-city');
    assert.equal(mx.depot, 0);
    assert.match(mx.built, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(
      mx.places.map((p) => p.index),
      [0, 1, 2, 3, 4, 5],
    );
    assert.deepEqual(mx.places[0], { index: 0, label: 'The bakery' });
    for (let i = 0; i < 6; i++) {
      assert.equal(mx.minutes[i][i], 0);
      for (let j = 0; j < 6; j++)
        if (i !== j) assert.equal(mx.minutes[i][j], Math.ceil(rd.durations[i * 6 + j] / 60));
    }

    // Provenance names every place, its OSM element and the source line; the depot’s real name is there.
    const pv = JSON.parse(await fsp.readFile(path.join(out, 'provenance.json'), 'utf8'));
    assert.equal(pv.places.length, 6);
    assert.ok(
      pv.places.every(
        (p) => p.source === 'OpenStreetMap, ODbL' && /^(node|way|relation)\/\d+$/.test(p.osm),
      ),
    );
    assert.equal(pv.places[0].name, 'Fixture Plaza');
    assert.equal(pv.places[0].osm, 'node/401');
    assert.deepEqual(
      pv.places.map((p) => p.osm),
      ['node/401', 'way/101', 'way/103', 'node/201', 'node/301', 'node/501'],
    );
    assert.equal(pv.tools.orsStatus.engine.version, '9.10.0-fake');
    assert.equal(pv.selection.dropped['business-like'], 2);
    assert.equal(pv.selection.dropped['not-public'], 1);
    assert.ok(
      !JSON.stringify(pv).includes('Far Park'),
      'the clip to the display box keeps outside places out',
    );
    assert.equal(pv.selection.dropped['duplicate-name'], 1);
    assert.equal(pv.selection.dropped['too-close'], 1);
    assert.equal(pv.extract.sha256.length, 64);
    const md = await fsp.readFile(path.join(out, 'places.md'), 'utf8');
    assert.match(
      md,
      /\| 0 \| The bakery \| square \(place=square\) \| node\/401 \| Placed at Fixture Plaza/,
    );
    assert.equal(md.split('\n').filter((l) => /^\| \d+ \|/.test(l)).length, 6);
    assert.match(await fsp.readFile(path.join(out, 'README.md'), 'utf8'), /Rebuild/);

    // The copy targets hold the same bytes.
    for (const name of ['route-data.json', 'isochrones.json', 'matrix.json']) {
      assert.deepEqual(
        await fsp.readFile(path.join(root, 'seed', name)),
        await fsp.readFile(path.join(out, name)),
      );
    }
    for (const name of ['route-data.json', 'isochrones.json']) {
      assert.deepEqual(
        await fsp.readFile(path.join(root, 'web', name)),
        await fsp.readFile(path.join(out, name)),
      );
    }
    assert.match(
      await fsp.readFile(path.join(root, 'web', 'ATTRIBUTION.txt'), 'utf8'),
      /OpenStreetMap contributors/,
    );
    assert.ok(logs.some((l) => l.includes('matrix: 1 request')));
  } finally {
    await fake.close();
  }
});

test('a rerun over the cache reproduces identical bytes and sends nothing', opts, async () => {
  const root = path.join(tmp, 'b');
  const fake = await startFakeOrs();
  await build(envFor(root, { ORS_URL: fake.url }), quiet).catch(async (e) => {
    await fake.close();
    throw e;
  });
  const first = {
    out: await readAll(path.join(root, 'out')),
    seed: await readAll(path.join(root, 'seed')),
    web: await readAll(path.join(root, 'web')),
  };
  const sent = fake.log.length;
  assert.ok(sent > 0);
  // Same cache, outputs deleted, and the instance gone: the answers come from work/cache.
  await fsp.rm(path.join(root, 'out'), { recursive: true });
  await fsp.rm(path.join(root, 'seed'), { recursive: true });
  await fsp.rm(path.join(root, 'web'), { recursive: true });
  await fake.close();
  await build(envFor(root, { ORS_URL: 'http://127.0.0.1:9' }), quiet);
  assert.deepEqual(await readAll(path.join(root, 'out')), first.out);
  assert.deepEqual(await readAll(path.join(root, 'seed')), first.seed);
  assert.deepEqual(await readAll(path.join(root, 'web')), first.web);
  // A third run with the outputs in place changes nothing either.
  await build(envFor(root, { ORS_URL: 'http://127.0.0.1:9' }), quiet);
  assert.deepEqual(await readAll(path.join(root, 'out')), first.out);
});

test(
  'a fresh work directory against the same answers writes the same data files',
  opts,
  async () => {
    const fake = await startFakeOrs();
    try {
      await build(envFor(path.join(tmp, 'c1'), { ORS_URL: fake.url }), quiet);
      await build(envFor(path.join(tmp, 'c2'), { ORS_URL: fake.url }), quiet);
      for (const name of ['route-data.json', 'isochrones.json', 'matrix.json', 'places.md']) {
        assert.deepEqual(
          await fsp.readFile(path.join(tmp, 'c1', 'out', name)),
          await fsp.readFile(path.join(tmp, 'c2', 'out', name)),
          name,
        );
      }
    } finally {
      await fake.close();
    }
  },
);

test(
  'an instance that refuses the whole matrix gets square blocks covering every pair once',
  opts,
  async () => {
    const fake = await startFakeOrs({ maxRoutes: 9 });
    try {
      const root = path.join(tmp, 'd');
      await build(envFor(root, { ORS_URL: fake.url }), quiet);
      const posts = fake.posts('/matrix/driving-car');
      assert.equal(posts.length, 5, 'one refused request, then 2 x 2 blocks of 3');
      const seen = new Set();
      for (const p of posts.slice(1)) {
        assert.ok(p.body.sources.length * p.body.destinations.length <= 9);
        for (const s of p.body.sources)
          for (const d of p.body.destinations) {
            const key = `${JSON.stringify(p.body.locations[+s])}>${JSON.stringify(p.body.locations[+d])}`;
            assert.ok(!seen.has(key));
            seen.add(key);
          }
      }
      assert.equal(seen.size, 36);
      const rd = JSON.parse(await fsp.readFile(path.join(root, 'out', 'route-data.json'), 'utf8'));
      assert.equal(rd.durations.length, 36);
    } finally {
      await fake.close();
    }
  },
);

test(
  'a place the road network cannot reach within the snap radius is not chosen',
  opts,
  async () => {
    // Fixture Park A (way 101) centroid is -111.919, 40.761.
    const fake = await startFakeOrs({ unsnappable: [[-111.919, 40.761]] });
    try {
      const root = path.join(tmp, 'e');
      await build(envFor(root, { ORS_URL: fake.url }), quiet);
      const pv = JSON.parse(await fsp.readFile(path.join(root, 'out', 'provenance.json'), 'utf8'));
      assert.ok(!pv.places.some((p) => p.osm === 'way/101'));
      assert.equal(pv.places.length, 6);
      assert.equal(pv.selection.dropped.unsnappable, 1);
    } finally {
      await fake.close();
    }
  },
);

test('an unreachable pair stops the whole build and names it', opts, async () => {
  const fake = await startFakeOrs({
    nullPair: [
      [-111.8999, 40.7651],
      [-111.9189, 40.7611],
    ],
  });
  try {
    await assert.rejects(
      build(envFor(path.join(tmp, 'f'), { ORS_URL: fake.url }), quiet),
      /unreachable pair: The bakery \(0\) to Fixture Park A \(1\)/,
    );
    await assert.rejects(fsp.access(path.join(tmp, 'f', 'out', 'route-data.json')));
  } finally {
    await fake.close();
  }
});

test('the build needs no key and calls no hosted service', async () => {
  const files = [];
  for (const name of await fsp.readdir(TOOL, { recursive: true })) {
    if (/^(work|out|test|node_modules)([/\\]|$)/.test(name)) continue;
    const full = path.join(TOOL, name);
    if ((await fsp.stat(full)).isFile() && /\.(mjs|yml|sh|json)$/.test(name))
      files.push([name, await fsp.readFile(full, 'utf8')]);
  }
  assert.ok(files.length >= 10);
  for (const [name, text] of files) {
    assert.ok(!/api\.openrouteservice\.org/.test(text), `${name} names the hosted API`);
    assert.ok(!/ORS_API_KEY|api[_-]?key|Authorization/i.test(text), `${name} mentions a key`);
  }
  // The only hosts the code reaches: the extract mirrors, ORS’s repository, Nominatim, loopback.
  const hosts = new Set();
  for (const [, text] of files)
    for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) hosts.add(m[1].toLowerCase());
  const allowed = [
    'download.geofabrik.de',
    'download.openstreetmap.fr',
    'github.com',
    'nominatim.openstreetmap.org',
    'opendatacommons.org',
    'www.openstreetmap.org',
    'giscience.github.io',
    'localhost',
    '127.0.0.1',
    'openrouteservice.org',
    'registry-1.docker.io',
  ];
  for (const h of hosts) assert.ok(allowed.includes(h), `unexpected host ${h}`);
  assert.equal(CONFIG.extractSources[0].url.startsWith('https://download.geofabrik.de/'), true);
});
