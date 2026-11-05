// The openrouteservice instance this build runs, and a cached client for it. The instance is
// local and needs no API key. Every answer the build uses is cached under work/cache/ by the
// request, so a rerun over the same cache starts no instance and sends no request.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, exists, sha256, stableJson, writeAtomic } from './proc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_DIR = path.join(HERE, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class OrsError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function dockerAnswers() {
  try {
    await exec('docker', ['info'], { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

async function healthy(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/ors/v2/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    return (await res.json()).status === 'ready';
  } catch {
    return false;
  }
}

/**
 * Starts the instance on first use and stops it at `stop()`. With `url` given (ORS_URL), uses
 * that instance as it is and never starts or stops anything.
 */
export function makeInstance({ config, workDir, routingPbf, url, log }) {
  let baseUrl = url ?? null;
  let child = null;
  let mode = url ? 'external' : null;
  let starting = null;
  let stopping = false;

  async function start() {
    const port = config.ors.port;
    const candidate = `http://127.0.0.1:${port}`;
    if (await healthy(candidate)) {
      log(`ors: using the instance already answering on ${candidate}`);
      baseUrl = candidate;
      mode = 'already running';
      return;
    }
    const orsDir = path.join(workDir, 'ors');
    await fsp.mkdir(path.join(orsDir, 'config'), { recursive: true });
    await fsp.mkdir(path.join(orsDir, 'files'), { recursive: true });
    await fsp.copyFile(
      path.join(TOOL_DIR, 'ors', 'ors-config.yml'),
      path.join(orsDir, 'config', 'ors-config.yml'),
    );
    const pbfLink = path.join(orsDir, 'files', 'routing.osm.pbf');
    await fsp.rm(pbfLink, { force: true });
    await fsp.copyFile(routingPbf, pbfLink);
    const logFile = path.join(orsDir, 'ors-start.log');
    if (await dockerAnswers()) {
      mode = 'docker';
      log('ors: starting the pinned image with docker compose');
      await exec('docker', [
        'compose',
        '-f',
        path.join(TOOL_DIR, 'ors', 'compose.yml'),
        'up',
        '-d',
      ]);
    } else {
      mode = 'jar';
      const jar = path.join(workDir, 'ors.jar');
      if (!(await exists(jar))) {
        log('ors: no Docker daemon and no work/ors.jar; building the jar (ors/build-jar.sh)');
        await exec('sh', [path.join(TOOL_DIR, 'ors', 'build-jar.sh')], { timeout: 3600000 });
      }
      log(
        `ors: starting ${path.relative(TOOL_DIR, jar)} (java, ${config.ors.heapMegabytes} MB heap)`,
      );
      const out = fs.openSync(logFile, 'a');
      child = spawn(
        'java',
        [`-Xmx${config.ors.heapMegabytes}m`, `-Dserver.port=${config.ors.port}`, '-jar', jar],
        {
          cwd: orsDir,
          env: {
            ...process.env,
            ORS_CONFIG_LOCATION: path.join(orsDir, 'config', 'ors-config.yml'),
          },
          stdio: ['ignore', out, out],
        },
      );
      child.on('exit', (code) => {
        child = null;
        if (code && !stopping)
          log(`ors: the java process exited with code ${code} (see work/ors/ors-start.log)`);
      });
    }
    baseUrl = candidate;
    const deadline = Date.now() + config.ors.startupTimeoutSeconds * 1000;
    let waited = 0;
    while (!(await healthy(baseUrl))) {
      if (mode === 'jar' && child === null)
        throw new Error('the ORS process stopped before it was ready: see work/ors/ors-start.log');
      if (Date.now() > deadline)
        throw new Error(`ORS not ready after ${config.ors.startupTimeoutSeconds} s: see work/ors/`);
      await sleep(5000);
      waited += 5;
      if (waited % 60 === 0) log(`ors: building the graph or starting, ${waited} s`);
    }
    log(`ors: ready after about ${waited} s (${mode})`);
  }

  return {
    get mode() {
      return mode;
    },
    async ensure() {
      if (mode === 'external') return baseUrl;
      starting ??= start();
      await starting;
      return baseUrl;
    },
    async stop() {
      stopping = true;
      if (child) {
        child.kill('SIGTERM');
        await sleep(2000);
      } else if (mode === 'docker') {
        await exec('docker', [
          'compose',
          '-f',
          path.join(TOOL_DIR, 'ors', 'compose.yml'),
          'down',
        ]).catch(() => {});
      }
    },
  };
}

/**
 * A client whose answers are cached by request. `get`/`post` return the parsed body. An error
 * answer throws an OrsError (400s carry the ORS error code) and is never cached.
 */
export function makeClient({ instance, cacheDir }) {
  const used = new Map();
  async function call(method, route, body) {
    const key = sha256(`${method} ${route} ${stableJson(body ?? null)}`).slice(0, 24);
    const file = path.join(
      cacheDir,
      `${route.split('/').filter(Boolean).slice(-2).join('-')}-${key}.json`,
    );
    let entry = null;
    try {
      entry = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {
      /* miss */
    }
    if (!entry) {
      const base = await instance.ensure();
      const res = await fetch(`${base}${route}`, {
        method,
        headers: body
          ? {
              'Content-Type': 'application/json; charset=utf-8',
              Accept: 'application/json, application/geo+json',
            }
          : { Accept: 'application/json, application/geo+json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      if (!res.ok) {
        const err = parsed?.error;
        const code = typeof err === 'object' ? err?.code : undefined;
        const message = typeof err === 'object' ? err?.message : (err ?? text.slice(0, 300));
        throw new OrsError(`ORS ${method} ${route} answered ${res.status}: ${message}`, {
          status: res.status,
          code,
        });
      }
      entry = { method, route, body: parsed };
      await writeAtomic(file, JSON.stringify(entry));
    }
    used.set(file, route);
    return entry.body;
  }
  return {
    get: (route) => call('GET', route),
    post: (route, body) => call('POST', route, body),
    /** Distinct cached answers used so far, by endpoint. */
    requestCounts() {
      const counts = {};
      for (const route of used.values()) {
        const name = route.replace(/^\/ors\/v2\//, '').replace(/\/[^/]+$/, '') || route;
        counts[name] = (counts[name] ?? 0) + 1;
      }
      return Object.fromEntries(Object.entries(counts).sort());
    },
  };
}
