#!/usr/bin/env node
// Writes the configuration that runs the API's scanned bundle as it is: `workers/api/wrangler.jsonc`
// with its `build` removed, `main` pointed at the bundle's `shim.js` and `no_bundle` set, so
// Wrangler neither compiles Rust nor bundles again. `verify` makes the bundle with
// `wrangler deploy --dry-run --outdir workers/api/dist`; `firewall` scans it; `deploy` uploads it
// and `e2e` runs it on `wrangler dev`, each through the file this script writes next to it
// (docs/delivery.md, "Shape": the scanned bundle is the published bundle). Every other field is
// copied unchanged, so the reviewed config is the deployed one.
//
// Run:   node scripts/api-deploy-config.mjs [workers/api/wrangler.jsonc] [workers/api/dist]
//
// Prints the path it wrote. Exits 2 when the bundle or the config is missing or unreadable.
//
// It also exports stripJsonc and durableObjectClasses, which `deploy` uses to tell a Durable
// Object class lifecycle change, the change that ships alone (ADR 0011, decision 9).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** JSONC to JSON: drops // and /* *\/ comments outside strings, then trailing commas. */
export function stripJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i === -1) throw new Error('an unterminated block comment');
      i += 1;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** The Durable Object classes a config declares, bound or exported, sorted. */
export function durableObjectClasses(jsoncText) {
  const config = JSON.parse(stripJsonc(jsoncText));
  const bound = (config.durable_objects?.bindings ?? []).map((b) => `bound:${b.class_name}`);
  const exported = Object.entries(config.exports ?? {})
    .filter(([, e]) => e?.type === 'durable-object')
    .map(([name, e]) => `exported:${name}:${e.storage ?? ''}`);
  return [...new Set([...bound, ...exported])].sort();
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = path.resolve(process.argv[2] ?? path.join(root, 'workers/api/wrangler.jsonc'));
  const outDir = path.resolve(process.argv[3] ?? path.join(root, 'workers/api/dist'));

  if (!existsSync(source)) fail(`no config at ${source}`);
  if (!existsSync(path.join(outDir, 'shim.js'))) {
    fail(
      `no bundle at ${path.join(outDir, 'shim.js')}: run worker-build --release, then ` +
        'pnpm exec wrangler deploy --dry-run --outdir dist, in workers/api',
    );
  }
  if (!readdirSync(outDir).some((f) => f.endsWith('.wasm'))) fail(`no .wasm module in ${outDir}`);

  let config;
  try {
    config = JSON.parse(stripJsonc(readFileSync(source, 'utf8')));
  } catch (e) {
    fail(`cannot read ${source}: ${e.message}`);
  }
  delete config.$schema;
  delete config.build; // the Rust build ran in verify, once
  config.main = 'shim.js';
  config.no_bundle = true; // upload and run the scanned bytes, not a rebuild of them

  const out = path.join(outDir, 'wrangler.json');
  writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
  console.log(out);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
