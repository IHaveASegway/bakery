#!/usr/bin/env node
// A local stand-in for the Workers Analytics Engine SQL API, so the status page's refresh can be
// proven on `wrangler dev` with no Cloudflare account and no network. It is a test fixture for
// scripts/smoke-status.sh and for trying the refresh by hand. It is never Analytics Engine: it
// does not parse SQL. It recognises each of the bakery's kept queries (crates/app/src/analytics.rs)
// (`counts_24h` and `last_wipe`) by the event names in its text and answers canned rows in the SQL API's `FORMAT JSON` shape,
// `{ meta, data, rows }`. It listens on 127.0.0.1 only, keeps everything in memory, and writes no
// token and no query text to its log.
//
// Run:   node scripts/fake-analytics.mjs [--port 8792]      (Node 22 or later, no dependencies)
//
// Point the API at it with these lines in workers/api/.dev.vars (never committed). The base URL
// override is honored only for 127.0.0.1 and localhost hosts:
//
//   ANALYTICS_API_BASE=http://127.0.0.1:8792
//   ANALYTICS_API_TOKEN=fake-analytics-token
//   ANALYTICS_ACCOUNT_ID=0000000000000000000000000000fake
//
// FAKE_ANALYTICS_TOKEN and FAKE_ANALYTICS_ACCOUNT change the token and account it accepts; the
// defaults are the values above, fakes and not secrets.
//
// The API:
//   POST /accounts/{account}/analytics_engine/sql   the query as the body; Authorization: Bearer
//        <token>. 401 for a missing or wrong token, 404 for another account, 422 with a plain-text
//        message for a query it does not recognise (as the SQL API answers a bad query).
//
// Test controls, all under /_ :
//   POST /_rows      JSON, any of { sandboxes_24h, orders_24h, payments_24h, payment_failures_24h,
//                    refunds_24h, dlq_24h } (numbers) and last_wipe ({ at: "YYYY-MM-DD HH:MM:SS",
//                    sandboxes, objects, ms } or null). Keys left out keep their value; answers the
//                    whole current set.
//   GET  /_rows      the current set.
//   POST /_fail      JSON { status, query? } (e.g. 500): every query, or only the kept query named
//                    (`counts_24h` or `last_wipe`), answers that status until /_fail with
//                    { status: 0 } or /_reset.
//   POST /_delay     JSON { ms }: every query waits that long before answering (0 to stop).
//   GET  /_requests  every SQL request since the last reset: the method, the path's account
//                    (`ok` or `other`), the auth scheme, whether the token matched, the kept query
//                    it recognised, the query text, and the status. Never the token itself.
//   POST /_reset     the default rows, no failure, no delay, no requests.
//   GET  /_health    { ok: true }.
import http from 'node:http';
import { URL } from 'node:url';

const DEFAULT_PORT = 8792;
const MAX_BODY_BYTES = 16 * 1024;
const TOKEN = process.env.FAKE_ANALYTICS_TOKEN || 'fake-analytics-token';
const ACCOUNT = process.env.FAKE_ANALYTICS_ACCOUNT || '0000000000000000000000000000fake';
const COUNTS = [
  'sandboxes_24h',
  'orders_24h',
  'payments_24h',
  'payment_failures_24h',
  'refunds_24h',
  'dlq_24h',
];

const DEFAULT_ROWS = {
  sandboxes_24h: 7,
  orders_24h: 12,
  payments_24h: 10,
  payment_failures_24h: 2,
  refunds_24h: 1,
  dlq_24h: 0,
  last_wipe: { at: '2026-11-06 10:00:04', sandboxes: 7, objects: 133, ms: 4210 },
};

let rows = structuredClone(DEFAULT_ROWS);
let failStatus = 0;
let failQuery = null;
let delayMs = 0;
let requests = [];

function parsePort(argv) {
  const i = argv.indexOf('--port');
  if (i === -1) return DEFAULT_PORT;
  const port = Number(argv[i + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('--port takes a number from 0 to 65535');
    process.exit(2);
  }
  return port;
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function writeText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req, res) {
  const text = await readBody(req);
  try {
    const value = JSON.parse(text ?? '');
    if (value && typeof value === 'object') return value;
  } catch {
    // answered below
  }
  writeJson(res, 400, { error: 'a JSON object is expected' });
  return undefined;
}

// The event name each count row carries, as the bakery's points write it.
const EVENTS = {
  sandboxes_24h: 'sandbox_created',
  orders_24h: 'order_placed',
  payments_24h: 'payment_succeeded',
  payment_failures_24h: 'payment_failed',
  refunds_24h: 'refund_issued',
  dlq_24h: 'dlq',
};

/** The kept query a body is, by the event names in it, and its canned answer. */
function answer(sql) {
  const has = (e) => sql.includes(`'${e}'`);
  if (!/FROM bakery_events\b/.test(sql)) return null;
  if (Object.values(EVENTS).every(has) && /GROUP BY index1/.test(sql)) {
    // One row per event that has points, as GROUP BY gives: an event at 0 has no row. The sum
    // is a 64-bit integer, quoted as ClickHouse quotes one in JSON.
    const data = COUNTS.filter((key) => rows[key] > 0).map((key) => ({
      event: EVENTS[key],
      n: String(rows[key]),
    }));
    return {
      query: 'counts_24h',
      body: {
        meta: [
          { name: 'event', type: 'String' },
          { name: 'n', type: 'UInt64' },
        ],
        data,
        rows: data.length,
        rows_before_limit_at_least: data.length,
      },
    };
  }
  if (has('wipe')) {
    const w = rows.last_wipe;
    return {
      query: 'last_wipe',
      body: {
        meta: [
          { name: 'at', type: 'DateTime' },
          { name: 'sandboxes', type: 'Float64' },
          { name: 'objects', type: 'Float64' },
          { name: 'ms', type: 'Float64' },
        ],
        data: w ? [{ at: w.at, sandboxes: w.sandboxes, objects: w.objects, ms: w.ms }] : [],
        rows: w ? 1 : 0,
        rows_before_limit_at_least: w ? 1 : 0,
      },
    };
  }
  return null;
}

function authScheme(req) {
  const value = String(req.headers.authorization || '');
  return value ? value.split(' ')[0] : null;
}

async function handleSql(req, res, account) {
  const header = String(req.headers.authorization || '');
  const rec = {
    at: new Date().toISOString(),
    method: req.method,
    account: account === ACCOUNT ? 'ok' : 'other',
    auth_scheme: authScheme(req),
    token_ok: header === `Bearer ${TOKEN}`,
    query: null,
    sql: null,
    status: null,
  };
  requests.push(rec);
  const sql = await readBody(req);
  rec.sql = sql === null ? null : sql.slice(0, 1024);
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  if (res.destroyed) {
    rec.status = 0;
    return;
  }
  let status;
  if (!rec.token_ok) {
    status = 401;
    writeJson(res, status, {
      success: false,
      errors: [{ code: 10000, message: 'Authentication error' }],
    });
  } else if (rec.account !== 'ok') {
    status = 404;
    writeJson(res, status, { success: false, errors: [{ code: 7003, message: 'Not found' }] });
  } else {
    const a = answer(sql ?? '');
    if (failStatus && (!failQuery || a?.query === failQuery)) {
      status = failStatus;
      rec.query = a?.query ?? null;
      writeText(res, status, 'fake failure');
    } else if (!a) {
      status = 422;
      writeText(res, status, 'the fake does not know this query');
    } else {
      status = 200;
      rec.query = a.query;
      writeJson(res, status, a.body);
    }
  }
  rec.status = status;
}

async function postRows(req, res) {
  const input = await readJson(req, res);
  if (input === undefined) return;
  for (const key of COUNTS) {
    if (key in input) {
      if (!Number.isInteger(input[key]) || input[key] < 0) {
        return writeJson(res, 400, { error: `${key} is a whole number` });
      }
      rows[key] = input[key];
    }
  }
  if ('last_wipe' in input) rows.last_wipe = input.last_wipe;
  return writeJson(res, 200, rows);
}

async function route(req, res, url) {
  const { pathname } = url;
  const { method } = req;
  if (pathname === '/_health' && method === 'GET') return writeJson(res, 200, { ok: true });
  if (pathname === '/_requests' && method === 'GET') return writeJson(res, 200, requests);
  if (pathname === '/_rows' && method === 'GET') return writeJson(res, 200, rows);
  if (pathname === '/_rows' && method === 'POST') return postRows(req, res);
  if (pathname === '/_fail' && method === 'POST') {
    const input = await readJson(req, res);
    if (input === undefined) return;
    failStatus = Number.isInteger(input.status) ? input.status : 0;
    failQuery = typeof input.query === 'string' ? input.query : null;
    return writeJson(res, 200, { status: failStatus, query: failQuery });
  }
  if (pathname === '/_delay' && method === 'POST') {
    const input = await readJson(req, res);
    if (input === undefined) return;
    delayMs = Number.isInteger(input.ms) && input.ms > 0 ? input.ms : 0;
    return writeJson(res, 200, { ms: delayMs });
  }
  if (pathname === '/_reset' && method === 'POST') {
    rows = structuredClone(DEFAULT_ROWS);
    failStatus = 0;
    failQuery = null;
    delayMs = 0;
    requests = [];
    return writeJson(res, 200, { ok: true });
  }
  const m = /^\/accounts\/([^/]+)\/analytics_engine\/sql$/.exec(pathname);
  if (m && method === 'POST') return handleSql(req, res, m[1]);
  return writeJson(res, 404, { error: `no ${method} ${pathname}` });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  res.on('finish', () => {
    // The path names the account, so only whether it is one is logged.
    const path = url.pathname.startsWith('/accounts/')
      ? '/accounts/…/analytics_engine/sql'
      : url.pathname;
    console.log(JSON.stringify({ method: req.method, path, status: res.statusCode }));
  });
  try {
    await route(req, res, url);
  } catch {
    if (!res.headersSent) writeJson(res, 500, { error: 'fake server error' });
    else res.end();
  }
});

const port = parsePort(process.argv.slice(2));
server.listen(port, '127.0.0.1', () => {
  console.log(`fake analytics listening on http://127.0.0.1:${server.address().port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
