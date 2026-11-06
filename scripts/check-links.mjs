#!/usr/bin/env node
// The external-link check (docs/roadmap.md, PR 12: "a link check resolves every one"). Node 22, no
// dependency. It reads every page of the built storefront, apps/web/dist, collects each href and
// src that leaves the site (the lab pages, the ADRs on GitHub, the essay's sources and the rest),
// fetches each once, following redirects, and exits 1 naming every one that does not answer 2xx.
//
// The tour's links are in that HTML too: every principle the tour links is a section of the How
// it's built page with the same lab and ADR URLs, made by the same function (src/lib/how-its-built.ts),
// and apps/web/test/dist.test.ts fails the build if a principle's links are missing from the page.
//
// The bakery's own hostnames are left out: whether they answer is prod-smoke's job, and before
// launch they do not resolve at all.
//
//   node scripts/check-links.mjs           check every link, exit 1 on any failure
//   node scripts/check-links.mjs --list    print the links and fetch nothing
//   node scripts/check-links.mjs --dist <dir>
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OWN_HOSTS = /(^|\.)bakery\.ihaveasegway\.com$/;
const TIMEOUT_MS = 20_000;
const CONCURRENCY = 4;
const USER_AGENT = 'bakery-link-check (+https://github.com/IHaveASegway/bakery)';

function parseArgs(argv) {
  const args = { list: false, dist: join(ROOT, 'apps/web/dist') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--list') args.list = true;
    else if (argv[i] === '--dist' && argv[i + 1]) args.dist = argv[++i];
    else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return args;
}

function htmlFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...htmlFiles(path));
    else if (name.endsWith('.html')) out.push(path);
  }
  return out;
}

const decode = (value) =>
  value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');

/** url (without its fragment) -> the pages that link it. */
function collect(dist) {
  const links = new Map();
  for (const file of htmlFiles(dist)) {
    const html = readFileSync(file, 'utf8');
    for (const match of html.matchAll(/\s(?:href|src)="(https?:\/\/[^"]+)"/g)) {
      let url;
      try {
        url = new URL(decode(match[1]));
      } catch {
        continue;
      }
      if (OWN_HOSTS.test(url.hostname)) continue;
      url.hash = '';
      const key = url.href;
      const pages = links.get(key) ?? new Set();
      pages.add(`/${relative(dist, file).replace(/index\.html$/, '')}`);
      links.set(key, pages);
    }
  }
  return new Map([...links.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** HEAD, then GET if the server refuses HEAD or answers it with anything but 2xx; one retry. */
async function check(url) {
  let last = 'no answer';
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const method of ['HEAD', 'GET']) {
      try {
        const res = await fetch(url, {
          method,
          redirect: 'follow',
          headers: { 'user-agent': USER_AGENT },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        await res.body?.cancel();
        if (res.ok) return { ok: true, status: res.status, final: res.url };
        last = `${res.status} to ${method}`;
      } catch (error) {
        last = `${method}: ${error.cause?.code ?? error.name ?? 'error'}`;
      }
    }
  }
  return { ok: false, status: last };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let links;
  try {
    links = collect(args.dist);
  } catch (error) {
    console.error(`cannot read ${args.dist}: ${error.message}. Run pnpm --filter web build first.`);
    process.exit(2);
  }
  if (links.size === 0) {
    console.error(`no external link in ${args.dist}: is it the built storefront?`);
    process.exit(2);
  }
  if (args.list) {
    for (const [url, pages] of links) console.log(`${url}  (${[...pages].join(', ')})`);
    console.log(`${links.size} external links.`);
    return;
  }
  const urls = [...links.keys()];
  const results = new Map();
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < urls.length) {
        const url = urls[next++];
        results.set(url, await check(url));
      }
    }),
  );
  const failed = [];
  for (const url of urls) {
    const result = results.get(url);
    const moved = result.ok && result.final && result.final !== url ? ` -> ${result.final}` : '';
    console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.status} ${url}${moved}`);
    if (!result.ok) failed.push(url);
  }
  if (failed.length > 0) {
    console.error(`\n${failed.length} of ${urls.length} external links did not answer 2xx:`);
    for (const url of failed) {
      console.error(
        `- ${url} (${results.get(url).status}), linked from ${[...links.get(url)].join(', ')}`,
      );
    }
    process.exit(1);
  }
  console.log(`\nAll ${urls.length} external links answered 2xx.`);
}

await main();
