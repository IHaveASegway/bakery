// Steps a and b: fetch the OpenStreetMap extract from the first reachable source, check its
// MD5 against the publisher's, and clip it with osmium.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { exec, hashFile, stamped, writeAtomic, exists, stableJson } from './proc.mjs';

async function curlText(url) {
  const { stdout } = await exec('curl', ['-sSfL', '--max-time', '30', url]);
  return stdout;
}

/**
 * The extract: from `localFile` when given (tests, or a file you already hold), else from the
 * first source whose file answers. Resumes a partial download. Returns the facts provenance keeps.
 */
export async function fetchExtract({ config, workDir, log, localFile }) {
  const infoFile = path.join(workDir, 'extract.json');
  if (localFile) {
    const info = {
      source: 'local file',
      name: path.basename(localFile),
      url: null,
      file: localFile,
      bytes: (await fsp.stat(localFile)).size,
      md5: await hashFile(localFile, 'md5'),
      sha256: await hashFile(localFile, 'sha256'),
      md5Checked: false,
    };
    return info;
  }
  const dir = path.join(workDir, 'downloads');
  await fsp.mkdir(dir, { recursive: true });
  for (const src of config.extractSources) {
    const file = path.join(dir, path.basename(src.url));
    let info = null;
    try {
      info = JSON.parse(await fsp.readFile(infoFile, 'utf8'));
    } catch {
      /* none yet */
    }
    if (
      info &&
      info.sourceId === src.id &&
      (await exists(file)) &&
      (await fsp.stat(file)).size === info.bytes
    ) {
      log(`extract: ${src.name}, already fetched and checked`);
      return info;
    }
    try {
      await exec('curl', ['-sSfI', '--max-time', '30', src.url]);
    } catch (e) {
      log(
        `extract: ${src.name} not reachable (${e.message.split('\n')[0].slice(0, 120)}); next source`,
      );
      continue;
    }
    log(`extract: fetching ${src.url}`);
    const wantMd5 = (await curlText(src.md5Url)).trim().split(/\s+/)[0];
    await exec(
      'curl',
      [
        '-sSfL',
        '--continue-at',
        '-',
        '--max-time',
        String(config.downloadTimeoutSeconds),
        '-o',
        file,
        src.url,
      ],
      { timeout: (config.downloadTimeoutSeconds + 60) * 1000 },
    );
    const md5 = await hashFile(file, 'md5');
    if (md5 !== wantMd5) {
      throw new Error(
        `${src.name}: MD5 ${md5} does not match the publisher's ${wantMd5}; delete ${file} and rerun`,
      );
    }
    let state = null;
    try {
      state = (await curlText(src.stateUrl)).trim();
    } catch {
      /* the header carries the timestamp too */
    }
    info = {
      source: src.name,
      sourceId: src.id,
      url: src.url,
      md5Url: src.md5Url,
      file,
      bytes: (await fsp.stat(file)).size,
      md5,
      sha256: await hashFile(file, 'sha256'),
      md5Checked: true,
      state,
    };
    await writeAtomic(infoFile, `${JSON.stringify(info, null, 2)}\n`);
    log(`extract: ${info.bytes} bytes, md5 matches the publisher's`);
    return info;
  }
  throw new Error(
    `no extract source answered (${config.extractSources.map((s) => s.name).join(', ')}). ` +
      'Download one by hand, then rerun with ROUTE_EXTRACT=/path/to/file.osm.pbf',
  );
}

/** The replication timestamp in the extract's header, or null. */
export async function extractTimestamp(file) {
  try {
    const { stdout } = await exec('osmium', [
      'fileinfo',
      '-g',
      'header.option.osmosis_replication_timestamp',
      file,
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function osmiumVersion() {
  const { stdout } = await exec('osmium', ['--version']);
  return stdout.split('\n')[0].trim();
}

/** Step b: clip `input` to the routing box and to the display box (for the places). */
export async function clipExtract({ routing, display, input, inputKey, workDir, log }) {
  const key = stableJson({ inputKey, routing, display });
  const routingOut = path.join(workDir, 'routing.osm.pbf');
  const placesOut = path.join(workDir, 'places-area.osm.pbf');
  const ran = await stamped(
    path.join(workDir, 'stamps', 'clip'),
    key,
    [routingOut, placesOut],
    async () => {
      log(`clip: routing box ${routing.join(',')}`);
      await exec('osmium', [
        'extract',
        '-b',
        routing.join(','),
        '--strategy=complete_ways',
        '--overwrite',
        '-o',
        routingOut,
        input,
      ]);
      log(`clip: display box ${display.join(',')}`);
      await exec('osmium', [
        'extract',
        '-b',
        display.join(','),
        '--strategy=smart',
        '--overwrite',
        '-o',
        placesOut,
        input,
      ]);
    },
  );
  if (!ran) log('clip: up to date');
  return { routingOut, placesOut };
}

/** Step c, first half: the tagged features of the display area as GeoJSON features. */
export async function exportPlaces({ config, placesArea, workDir, log }) {
  const filters = [];
  for (const pairs of Object.values(config.placeTags))
    for (const [k, v] of pairs) filters.push(`nwr/${k}=${v}`);
  const tagged = path.join(workDir, 'places-tagged.osm.pbf');
  const seq = path.join(workDir, 'places.geojsonseq');
  const ran = await stamped(
    path.join(workDir, 'stamps', 'places-export'),
    stableJson({ placesArea, filters }),
    [seq],
    async () => {
      log(`places: osmium tags-filter ${filters.join(' ')}`);
      await exec('osmium', ['tags-filter', placesArea, ...filters, '--overwrite', '-o', tagged]);
      await exec('osmium', [
        'export',
        tagged,
        '-f',
        'geojsonseq',
        '--geometry-types=point,polygon',
        '-a',
        'type,id',
        '--overwrite',
        '-o',
        seq,
      ]);
    },
  );
  if (!ran) log('places: export up to date');
  const text = await fsp.readFile(seq, 'utf8');
  return text
    .split('\n')
    .map((l) => l.replaceAll('\u001e', '').trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
