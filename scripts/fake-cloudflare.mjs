#!/usr/bin/env node
// A local stand-in for the two Cloudflare APIs the 15-minute breaker calls, so the breaker can be
// proven on `wrangler dev` with no Cloudflare account and no network. It is a test fixture for
// scripts/smoke-breaker.sh and for trying the breaker by hand. It is never Cloudflare: it does not
// parse GraphQL, it recognises each of the breaker's four datasets by the dataset name in the
// query text and answers the current usage set in the shape the GraphQL Analytics API uses, and
// it keeps one WAF custom rule in the shape the Rulesets API uses. It listens on 127.0.0.1 only,
// keeps everything in memory, and writes no token, no zone id, no rule id and no body to its log.
//
// Run:   node scripts/fake-cloudflare.mjs [--port 8793]      (Node 22 or later, no dependencies)
//
// Point the API at it with these lines in workers/api/.dev.vars (never committed). The base URL
// override is honored only for 127.0.0.1 and localhost hosts:
//
//   BREAKER_API_BASE=http://127.0.0.1:8793
//   BREAKER_API_TOKEN=fake-breaker-token
//   BREAKER_ZONE_ID=000000000000000000000000fakezone
//   BREAKER_RULE_ID=000000000000000000000000fakerule
//   ANALYTICS_ACCOUNT_ID=0000000000000000000000000000fake
//
// FAKE_CLOUDFLARE_TOKEN, FAKE_CLOUDFLARE_ZONE, FAKE_CLOUDFLARE_RULE and FAKE_CLOUDFLARE_ACCOUNT
// change the values it accepts; the defaults are the values above, fakes and not secrets. None of
// the default ids is 32 hexadecimal characters.
//
// The API:
//   POST  /graphql    Authorization: Bearer <token>; the body is { query, variables } and the query
//         names one dataset (workersInvocationsAdaptive, durableObjectsInvocationsAdaptiveGroups,
//         durableObjectsPeriodicGroups or queueMessageOperationsAdaptiveGroups). Answers
//         { data: { viewer: { accounts: [ { <dataset>: [ { sum: {...} } ] } ] } } } with the
//         current usage. 401 for a missing or wrong token. A request for another account answers
//         200 with an errors list and no data, as GraphQL does for a path the token cannot see.
//   GET   /zones/{zone}/rulesets/phases/http_request_firewall_custom/entrypoint
//         One ruleset holding the one rule, with `enabled` as currently stored, `action: "block"`,
//         an `expression` naming the API hostname and a `description`. 401 for a wrong token, 404
//         for another zone.
//   PATCH /zones/{zone}/rulesets/{ruleset}/rules/{rule}
//         Stores the body (a JSON object), takes `enabled` from it, and answers the Rulesets API's
//         { result: { ...ruleset... }, success: true, errors: [], messages: [] }. 401, 404 as
//         above; 404 too for another ruleset or rule.
//
// Test controls, all under /_ :
//   POST /_usage     JSON, any of { worker_requests, do_requests, rows_written, queue_operations }
//                    (whole numbers) and { do_gb_s } (a number); keys left out keep their value;
//                    answers the whole current set. The quiet default is a quiet window.
//   GET  /_usage     the current set.
//   POST /_fail      JSON { status, dataset? } (e.g. 500): every request, or only the one named
//                    (a dataset above, or `rule_get` or `rule_patch`), answers that status until
//                    /_fail with { status: 0 } or /_reset.
//   POST /_graphql_errors  JSON { dataset }: that dataset answers 200 with
//                    { errors: [ { message } ] } and no data, the validation-error shape. Send
//                    { dataset, off: true } to stop; /_reset clears it.
//   POST /_empty     JSON { dataset }: that dataset answers 200 with no groups. { dataset, off:
//                    true } to stop.
//   POST /_delay     JSON { ms, dataset? }: every request, or only that dataset's (or `rule_get`,
//                    `rule_patch`), waits that long before answering (0 to stop).
//   GET  /_rule      { enabled, patches }: the stored flag and every PATCH body seen (rule fields
//                    only, never a credential).
//   GET  /_requests  every request since the last reset: the method, the path's class (`graphql`,
//                    `rule_get`, `rule_patch`), whether the zone matched, the auth scheme, whether
//                    the token matched, the dataset it recognised, the window's start and end for a
//                    GraphQL request, and the status. Never the token, a zone, a rule or a body.
//   POST /_reset     the quiet usage, the rule disabled, no failure, no delay, no request log.
//   GET  /_health    { ok: true }.
import http from 'node:http';
import { URL } from 'node:url';

const DEFAULT_PORT = 8793;
const MAX_BODY_BYTES = 16 * 1024;
const TOKEN = process.env.FAKE_CLOUDFLARE_TOKEN || 'fake-breaker-token';
const ZONE = process.env.FAKE_CLOUDFLARE_ZONE || '000000000000000000000000fakezone';
const RULE = process.env.FAKE_CLOUDFLARE_RULE || '000000000000000000000000fakerule';
const ACCOUNT = process.env.FAKE_CLOUDFLARE_ACCOUNT || '0000000000000000000000000000fake';
const RULESET = 'fakeruleset0000000000000000000';

const DATASETS = [
  'workersInvocationsAdaptive',
  'durableObjectsInvocationsAdaptiveGroups',
  'durableObjectsPeriodicGroups',
  'queueMessageOperationsAdaptiveGroups',
];
const ROUTE_CLASSES = ['rule_get', 'rule_patch'];
const COUNTS = ['worker_requests', 'do_requests', 'rows_written', 'queue_operations'];

const QUIET_USAGE = {
  worker_requests: 20,
  do_requests: 20,
  rows_written: 500,
  do_gb_s: 0.1,
  queue_operations: 30,
};
const RULE_FIELDS = {
  action: 'block',
  expression: '(http.host eq "api.bakery.ihaveasegway.com")',
  description: 'Breaker kill rule: blocks the API hostname (pre-built, disabled)',
};

let usage = { ...QUIET_USAGE };
let ruleEnabled = false;
let rule = { ...RULE_FIELDS };
let patches = [];
let failStatus = 0;
let failTarget = null;
let delayMs = 0;
let delayTarget = null;
let graphqlErrors = new Set();
let empty = new Set();
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
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // answered below
  }
  writeJson(res, 400, { error: 'a JSON object is expected' });
  return undefined;
}

function authScheme(req) {
  const value = String(req.headers.authorization || '');
  return value ? value.split(' ')[0] : null;
}

function validTarget(name) {
  return typeof name === 'string' && (DATASETS.includes(name) || ROUTE_CLASSES.includes(name));
}

/** The dataset a GraphQL query is about, by the name in its text. */
function datasetOf(query) {
  return DATASETS.find((name) => new RegExp(`\\b${name}\\b`).test(query)) ?? null;
}

/** The groups a dataset answers for the current usage. Counts are split over two groups, as the
 * API returns several groups for a window, so the sum the breaker reads is the sum of both. */
function groupsFor(dataset) {
  const split = (n, field) =>
    n >= 2
      ? [{ sum: { [field]: Math.floor(n / 2) } }, { sum: { [field]: n - Math.floor(n / 2) } }]
      : [{ sum: { [field]: n } }];
  switch (dataset) {
    case 'workersInvocationsAdaptive':
      return split(usage.worker_requests, 'requests');
    case 'durableObjectsInvocationsAdaptiveGroups':
      return split(usage.do_requests, 'requests');
    case 'durableObjectsPeriodicGroups':
      return [{ sum: { rowsWritten: usage.rows_written, duration: usage.do_gb_s } }];
    case 'queueMessageOperationsAdaptiveGroups':
      return split(usage.queue_operations, 'billableOperations');
    default:
      return [];
  }
}

const matches = (target, name) => target === null || target === name;
async function maybeDelay(name) {
  if (delayMs > 0 && matches(delayTarget, name)) await new Promise((r) => setTimeout(r, delayMs));
}

function rulesetBody() {
  return {
    id: RULESET,
    name: 'default',
    kind: 'zone',
    phase: 'http_request_firewall_custom',
    version: '1',
    rules: [{ id: RULE, ...rule, enabled: ruleEnabled }],
  };
}

function record(req, cls, zoneOk) {
  const header = String(req.headers.authorization || '');
  const rec = {
    at: new Date().toISOString(),
    method: req.method,
    class: cls,
    zone: zoneOk === null ? null : zoneOk ? 'ok' : 'other',
    auth_scheme: authScheme(req),
    token_ok: header === `Bearer ${TOKEN}`,
    dataset: null,
    start: null,
    end: null,
    status: null,
  };
  requests.push(rec);
  return rec;
}

function unauthorized(res) {
  writeJson(res, 401, {
    success: false,
    errors: [{ code: 10000, message: 'Authentication error' }],
    messages: [],
    result: null,
  });
  return 401;
}

function notFound(res) {
  writeJson(res, 404, {
    success: false,
    errors: [{ code: 7003, message: 'Could not route to the resource' }],
    messages: [],
    result: null,
  });
  return 404;
}

async function handleGraphql(req, res) {
  const rec = record(req, 'graphql', null);
  const text = await readBody(req);
  let query = '';
  let variables = {};
  try {
    const body = JSON.parse(text ?? '');
    if (typeof body?.query === 'string') query = body.query;
    if (body?.variables && typeof body.variables === 'object') variables = body.variables;
  } catch {
    // an unreadable body is a query that names no dataset
  }
  const dataset = datasetOf(query);
  rec.dataset = dataset;
  rec.start = typeof variables.start === 'string' ? variables.start : null;
  rec.end = typeof variables.end === 'string' ? variables.end : null;
  await maybeDelay(dataset);
  if (res.destroyed) {
    rec.status = 0;
    return;
  }
  let status;
  if (!rec.token_ok) {
    status = unauthorized(res);
  } else if (failStatus && matches(failTarget, dataset)) {
    status = failStatus;
    writeText(res, status, 'fake failure');
  } else if (dataset === null) {
    status = 200;
    writeJson(res, status, {
      data: null,
      errors: [{ message: 'the fake does not know this query' }],
    });
  } else if (graphqlErrors.has(dataset)) {
    status = 200;
    writeJson(res, status, {
      data: null,
      errors: [{ message: `unknown field in ${dataset}`, path: ['viewer', 'accounts'] }],
    });
  } else if (variables.accountTag !== ACCOUNT) {
    status = 200;
    writeJson(res, status, {
      data: { viewer: { accounts: [] } },
      errors: [{ message: 'does not have access to the path' }],
    });
  } else {
    status = 200;
    const groups = empty.has(dataset) ? [] : groupsFor(dataset);
    writeJson(res, status, {
      data: { viewer: { accounts: [{ [dataset]: groups }] } },
      errors: null,
    });
  }
  rec.status = status;
}

async function handleRule(req, res, cls, zone, ruleset, ruleId) {
  const rec = record(req, cls, zone === ZONE);
  const bodyText = cls === 'rule_patch' ? await readBody(req) : '';
  await maybeDelay(cls);
  if (res.destroyed) {
    rec.status = 0;
    return;
  }
  let status;
  if (!rec.token_ok) {
    status = unauthorized(res);
  } else if (zone !== ZONE) {
    status = notFound(res);
  } else if (failStatus && matches(failTarget, cls)) {
    status = failStatus;
    writeText(res, status, 'fake failure');
  } else if (cls === 'rule_get') {
    status = 200;
    writeJson(res, status, { result: rulesetBody(), success: true, errors: [], messages: [] });
  } else if (ruleset !== RULESET || ruleId !== RULE) {
    status = notFound(res);
  } else {
    let body = null;
    try {
      const value = JSON.parse(bodyText ?? '');
      if (value && typeof value === 'object' && !Array.isArray(value)) body = value;
    } catch {
      // answered below
    }
    if (body === null || typeof body.enabled !== 'boolean') {
      status = 400;
      writeJson(res, status, {
        success: false,
        errors: [{ code: 20012, message: 'the rule needs a boolean enabled' }],
        messages: [],
        result: null,
      });
    } else {
      patches.push(body);
      ruleEnabled = body.enabled;
      for (const key of Object.keys(RULE_FIELDS)) {
        if (typeof body[key] === 'string') rule[key] = body[key];
      }
      status = 200;
      writeJson(res, status, { result: rulesetBody(), success: true, errors: [], messages: [] });
    }
  }
  rec.status = status;
}

async function postUsage(req, res) {
  const input = await readJson(req, res);
  if (input === undefined) return;
  for (const key of COUNTS) {
    if (key in input && (!Number.isInteger(input[key]) || input[key] < 0)) {
      return writeJson(res, 400, { error: `${key} is a whole number` });
    }
  }
  if ('do_gb_s' in input && (typeof input.do_gb_s !== 'number' || !(input.do_gb_s >= 0))) {
    return writeJson(res, 400, { error: 'do_gb_s is a number, zero or more' });
  }
  for (const key of [...COUNTS, 'do_gb_s']) {
    if (key in input) usage[key] = input[key];
  }
  return writeJson(res, 200, usage);
}

async function setDatasetFlag(req, res, set) {
  const input = await readJson(req, res);
  if (input === undefined) return;
  if (!DATASETS.includes(input.dataset)) {
    return writeJson(res, 400, { error: `dataset is one of ${DATASETS.join(', ')}` });
  }
  if (input.off === true) set.delete(input.dataset);
  else set.add(input.dataset);
  return writeJson(res, 200, { datasets: [...set] });
}

function reset() {
  usage = { ...QUIET_USAGE };
  ruleEnabled = false;
  rule = { ...RULE_FIELDS };
  patches = [];
  failStatus = 0;
  failTarget = null;
  delayMs = 0;
  delayTarget = null;
  graphqlErrors = new Set();
  empty = new Set();
  requests = [];
}

async function route(req, res, url) {
  const { pathname } = url;
  const { method } = req;
  if (pathname === '/_health' && method === 'GET') return writeJson(res, 200, { ok: true });
  if (pathname === '/_requests' && method === 'GET') return writeJson(res, 200, requests);
  if (pathname === '/_usage' && method === 'GET') return writeJson(res, 200, usage);
  if (pathname === '/_usage' && method === 'POST') return postUsage(req, res);
  if (pathname === '/_rule' && method === 'GET') {
    return writeJson(res, 200, { enabled: ruleEnabled, patches });
  }
  if (pathname === '/_fail' && method === 'POST') {
    const input = await readJson(req, res);
    if (input === undefined) return;
    if (input.dataset !== undefined && !validTarget(input.dataset)) {
      return writeJson(res, 400, { error: 'dataset is a dataset name, rule_get or rule_patch' });
    }
    failStatus = Number.isInteger(input.status) ? input.status : 0;
    failTarget = typeof input.dataset === 'string' ? input.dataset : null;
    return writeJson(res, 200, { status: failStatus, dataset: failTarget });
  }
  if (pathname === '/_delay' && method === 'POST') {
    const input = await readJson(req, res);
    if (input === undefined) return;
    if (input.dataset !== undefined && !validTarget(input.dataset)) {
      return writeJson(res, 400, { error: 'dataset is a dataset name, rule_get or rule_patch' });
    }
    delayMs = Number.isInteger(input.ms) && input.ms > 0 ? input.ms : 0;
    delayTarget = typeof input.dataset === 'string' ? input.dataset : null;
    return writeJson(res, 200, { ms: delayMs, dataset: delayTarget });
  }
  if (pathname === '/_graphql_errors' && method === 'POST')
    return setDatasetFlag(req, res, graphqlErrors);
  if (pathname === '/_empty' && method === 'POST') return setDatasetFlag(req, res, empty);
  if (pathname === '/_reset' && method === 'POST') {
    reset();
    return writeJson(res, 200, { ok: true });
  }
  if (pathname === '/graphql' && method === 'POST') return handleGraphql(req, res);
  let m = /^\/zones\/([^/]+)\/rulesets\/phases\/http_request_firewall_custom\/entrypoint$/.exec(
    pathname,
  );
  if (m && method === 'GET') return handleRule(req, res, 'rule_get', m[1], null, null);
  m = /^\/zones\/([^/]+)\/rulesets\/([^/]+)\/rules\/([^/]+)$/.exec(pathname);
  if (m && method === 'PATCH') return handleRule(req, res, 'rule_patch', m[1], m[2], m[3]);
  return writeJson(res, 404, {
    error: `no ${method} ${pathname.startsWith('/zones/') ? '/zones/…' : pathname}`,
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  res.on('finish', () => {
    // The path carries the zone, ruleset and rule ids, so only its class is logged.
    const path = url.pathname.startsWith('/zones/') ? '/zones/…' : url.pathname;
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
  console.log(`fake cloudflare listening on http://127.0.0.1:${server.address().port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
