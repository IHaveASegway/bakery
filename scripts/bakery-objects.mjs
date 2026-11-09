#!/usr/bin/env node
// The morning object check's listing (docs/operations.md, "The nightly wipe"; ADR 0005): every
// Durable Object namespace of the Worker bakery-api, read through Cloudflare's account API with the
// read token, and the objects in each that hold stored data. `Control` and `Account` are skipped,
// as scripts/list-objects.mjs skips them on wrangler dev: they outlive every sandbox on purpose.
//
// Run:   node scripts/bakery-objects.mjs --out <listing.json> [--before <listing.json>]
//
// Environment: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (the bakery-objects job maps the read
// token, CLOUDFLARE_READ_TOKEN, to it, in one step's env). Neither is ever printed.
//
// The account API names objects by id only, and says whether each has stored data; it says
// nothing of when one was made. So an object holding data at 12:17 UTC may be a visitor's sandbox
// made after the 10:00 wipe. --before takes the listing the baseline run (04:47 UTC) wrote: an object that
// held data before the wipe and still does after it survived the wipe. Without --before, every
// object holding data is reported, and none can be told apart.
//
// The listing names no namespace or object id: the job's logs, artifacts and issues are public on
// this repository, so each object holding data is kept as a SHA-256 of "<namespace id>/<object
// id>", which is enough to find the same object in the next listing and nothing else. The ids
// themselves are in the dashboard (Workers & Pages, bakery-api, Durable Objects).
//
// Writes the listing to --out, prints a one-line JSON summary, and exits 0 when no survivor is
// found, 1 when one is (or, without --before, when any object holds data), 2 on a usage or API
// error. When nothing holds data it exits 0: a wiped account and an account the API was never
// deployed to answer the same, and the summary says so.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const KEPT_CLASSES = new Set(['Control', 'Account']);
const SCRIPT = 'bakery-api';
const DEFAULT_BASE = 'https://api.cloudflare.com/client/v4';

function fail(message) {
  console.error(`bakery-objects: ${message}`);
  process.exit(2);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? fail(`${name} needs a value`));
}

/** A base URL other than Cloudflare's is honored for a loopback host only, as a test fixture. */
function apiBase() {
  const override = process.env.CF_API_BASE;
  if (!override) return DEFAULT_BASE;
  const host = new URL(override).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost')
    fail('CF_API_BASE is honored for 127.0.0.1 and localhost only');
  return override.replace(/\/$/, '');
}

const out =
  arg('--out') ?? fail('usage: node scripts/bakery-objects.mjs --out <file> [--before <file>]');
const beforeFile = arg('--before');
const account = process.env.CLOUDFLARE_ACCOUNT_ID || fail('CLOUDFLARE_ACCOUNT_ID is not set');
const token = process.env.CLOUDFLARE_API_TOKEN || fail('CLOUDFLARE_API_TOKEN is not set');
const base = `${apiBase()}/accounts/${encodeURIComponent(account)}/workers/durable_objects/namespaces`;

async function get(url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  let body;
  try {
    body = await res.json();
  } catch {
    fail(`${res.status} with a body that is not JSON`);
  }
  if (!res.ok || body.success === false) {
    const codes = (body.errors ?? []).map((e) => `${e.code} ${e.message}`).join('; ');
    fail(`${res.status} from the account API${codes ? `: ${codes}` : ''}`);
  }
  return body;
}

async function namespaces() {
  const all = [];
  for (let page = 1; ; page += 1) {
    const body = await get(`${base}?page=${page}&per_page=100`);
    all.push(...body.result);
    const info = body.result_info ?? {};
    if (body.result.length === 0 || !info.total_pages || page >= info.total_pages) break;
  }
  return all.filter((n) => n.script === SCRIPT);
}

async function objectsWithData(namespaceId) {
  const held = [];
  let total = 0;
  let cursor = '';
  do {
    const body = await get(
      `${base}/${namespaceId}/objects?limit=10000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    total += body.result.length;
    for (const o of body.result) {
      if (o.hasStoredData)
        held.push(createHash('sha256').update(`${namespaceId}/${o.id}`).digest('hex'));
    }
    cursor = body.result_info?.cursor ?? '';
  } while (cursor);
  return { total, held: held.sort() };
}

const listing = { at: new Date().toISOString(), script: SCRIPT, namespaces: [] };
for (const ns of await namespaces()) {
  const cls = ns.class ?? ns.name;
  if (KEPT_CLASSES.has(cls)) continue;
  const { total, held } = await objectsWithData(ns.id);
  listing.namespaces.push({ class: cls, objects: total, with_data: held });
}
writeFileSync(out, `${JSON.stringify(listing, null, 2)}\n`);

const holding = listing.namespaces.flatMap((n) =>
  n.with_data.map((key) => ({ class: n.class, key })),
);
let surviving = holding;
if (beforeFile) {
  const before = JSON.parse(readFileSync(beforeFile, 'utf8'));
  const earlier = new Set(before.namespaces.flatMap((n) => n.with_data));
  surviving = holding.filter((o) => earlier.has(o.key));
}
/** Counts per class, the only form an object reaches a log or an issue in. */
const byClass = (objects) =>
  Object.fromEntries(
    [...new Set(objects.map((o) => o.class))]
      .sort()
      .map((c) => [c, objects.filter((o) => o.class === c).length]),
  );
const survivors = byClass(surviving);
const summary = {
  namespaces: listing.namespaces.length,
  objects: listing.namespaces.reduce((n, ns) => n + ns.objects, 0),
  holding_data: holding.length,
  holding_by_class: byClass(holding),
  compared_with_before: Boolean(beforeFile),
  survivors,
  note:
    holding.length === 0
      ? `nothing listed holds data (${listing.namespaces.length} namespaces): a wiped account and ` +
        'one the API was never deployed to answer the same'
      : undefined,
};
console.log(JSON.stringify(summary));
process.exit(surviving.length > 0 ? 1 : 0);
