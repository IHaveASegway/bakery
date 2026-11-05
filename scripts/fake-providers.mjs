#!/usr/bin/env node
// A local stand-in for Google's OpenID Connect provider, GitHub's OAuth app endpoints and
// Turnstile's siteverify, so the API Worker's sign-in flows can be proven end to end on
// `wrangler dev` with no real account and no network. It is a test fixture for scripts/smoke-auth.sh
// and for trying the flows by hand. It listens on 127.0.0.1 only, holds nothing real, and
// generates its RSA signing key at startup, so no key is ever written down.
//
// It exists because the flows cannot be proven against the real providers: they need a real
// account, a public redirect URI and a person at a consent screen. Here the authorize endpoints
// consent on their own, and a test controls the identity and the faults.
//
// Run:   node scripts/fake-providers.mjs [--port 8790]      (Node 22 or later, no dependencies)
//
// Point the API at it with these lines in workers/api/.dev.vars (never committed). The provider
// overrides are honored only for 127.0.0.1 and localhost hosts:
//
//   GOOGLE_ISSUER=http://127.0.0.1:8790/google
//   GITHUB_AUTHORIZE_URL=http://127.0.0.1:8790/github/login/oauth/authorize
//   GITHUB_TOKEN_URL=http://127.0.0.1:8790/github/login/oauth/access_token
//   GITHUB_USER_URL=http://127.0.0.1:8790/github/user
//   TURNSTILE_SITEVERIFY_URL=http://127.0.0.1:8790/turnstile/siteverify
//   GOOGLE_CLIENT_ID=fake-google-client
//   GOOGLE_CLIENT_SECRET=fake-google-client-secret
//   GITHUB_CLIENT_ID=fake-github-client
//   GITHUB_CLIENT_SECRET=fake-github-client-secret
//
// The client secrets the fake expects are FAKE_GOOGLE_CLIENT_SECRET and FAKE_GITHUB_CLIENT_SECRET
// in this process's environment; the defaults are the values above.
//
// Test controls, all under /_ :
//   POST /_config    JSON { google: { sub, extra_claims, fault }, github: { id, fault } }.
//                    Stored for the flows that follow and until the next /_config or /_reset;
//                    answers the whole current config. Each fault changes exactly one thing:
//     google.fault   none          a valid token.
//                    wrong_nonce   the nonce claim is the recorded nonce with "wrong-" in front.
//                    wrong_iss     iss is <base>/other instead of <base>/google.
//                    wrong_aud     aud is "someone-else" instead of the client id.
//                    expired       exp is one hour in the past.
//                    bad_signature the signature's first byte is flipped; everything else is valid.
//                    alg_none      the header says alg "none" and the signature is empty.
//                    unknown_kid   the header kid is "fake-key-unknown"; the signature is valid.
//     github.fault   none          the code exchange works.
//                    bad_code      the exchange answers bad_verification_code.
//     google.extra_claims (default true) adds email, email_verified, name and picture to the
//                    token, which the API must drop. google.sub defaults to fake-sub-000001.
//     github.id      defaults to 1234567.
//   GET  /_requests  every provider request since the last reset: shape only. No Authorization
//                    value, client secret, code or verifier is ever recorded, nor any body value.
//   POST /_reset     clears requests, codes, tokens and config.
//   GET  /_health    { ok: true }.
import crypto from 'node:crypto';
import http from 'node:http';
import { URL } from 'node:url';

const DEFAULT_PORT = 8790;
const KID = 'fake-key-1';
const MAX_BODY_BYTES = 64 * 1024;
const GOOGLE_SECRET = process.env.FAKE_GOOGLE_CLIENT_SECRET || 'fake-google-client-secret';
const GITHUB_SECRET = process.env.FAKE_GITHUB_CLIENT_SECRET || 'fake-github-client-secret';
const GOOGLE_FAULTS = [
  'none',
  'wrong_nonce',
  'wrong_iss',
  'wrong_aud',
  'expired',
  'bad_signature',
  'alg_none',
  'unknown_kid',
];
const GITHUB_FAULTS = ['none', 'bad_code'];

function parsePort(argv) {
  const i = argv.indexOf('--port');
  if (i === -1) return DEFAULT_PORT;
  const port = Number(argv[i + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('usage: node scripts/fake-providers.mjs [--port 8790]');
    process.exit(2);
  }
  return port;
}

// The key lives in memory only. A new run means a new key, and the API fetches the JWKS afresh.
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: 'jwk' });

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

function safeEqual(a, b) {
  const x = sha256(String(a ?? ''));
  const y = sha256(String(b ?? ''));
  return crypto.timingSafeEqual(x, y);
}

function defaultConfig() {
  return {
    google: { sub: 'fake-sub-000001', extra_claims: true, fault: 'none' },
    github: { id: 1234567, fault: 'none' },
  };
}

let config = defaultConfig();
let requests = [];
let codes = new Map(); // code -> { provider, client_id, redirect_uri, nonce, challenge, used }
let githubTokens = new Map(); // token -> { used }
let base = '';

function reset() {
  config = defaultConfig();
  requests = [];
  codes = new Map();
  githubTokens = new Map();
}

function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function sendText(res, status, text, contentType) {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Form or JSON, by content type. Anything unparseable reads as no fields.
async function readFields(req) {
  const text = await readBody(req);
  if (!text) return {};
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (type.includes('application/json')) {
    try {
      const value = JSON.parse(text);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

function authScheme(req) {
  const header = String(req.headers.authorization || '');
  if (/^bearer\s+\S/i.test(header)) return 'Bearer';
  if (/^token\s+\S/i.test(header)) return 'token';
  return null;
}

function bearerValue(req) {
  const m = /^(?:bearer|token)\s+(\S+)\s*$/i.exec(String(req.headers.authorization || ''));
  return m ? m[1] : null;
}

function invalidRequest(res, description) {
  sendJson(res, 400, { error: 'invalid_request', description });
}

function missing(params, names) {
  return names.filter((name) => !params.get(name));
}

function pkceMatches(verifier, challenge) {
  if (!verifier || !challenge) return false;
  return safeEqual(b64u(sha256(verifier)), challenge);
}

// Both authorize endpoints end the same way: a single-use code, then a 302 back with the state
// untouched. There is no consent page, because a test wants the flow to run by itself.
function mintCodeAndRedirect(res, provider, params) {
  let target;
  try {
    target = new URL(params.get('redirect_uri'));
  } catch {
    return invalidRequest(res, 'redirect_uri is not a URL');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return invalidRequest(res, 'redirect_uri must be http or https');
  }
  const code = randomToken();
  codes.set(code, {
    provider,
    client_id: params.get('client_id'),
    redirect_uri: params.get('redirect_uri'),
    nonce: params.get('nonce'),
    challenge: params.get('code_challenge'),
    used: false,
  });
  target.searchParams.set('code', code);
  target.searchParams.set('state', params.get('state'));
  return redirect(res, target.toString());
}

// ---------- Google ----------

function discoveryDocument() {
  return {
    issuer: `${base}/google`,
    authorization_endpoint: `${base}/google/authorize`,
    token_endpoint: `${base}/google/token`,
    jwks_uri: `${base}/google/jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid'],
    code_challenge_methods_supported: ['S256'],
  };
}

function googleAuthorize(res, params) {
  const gone = missing(params, [
    'client_id',
    'redirect_uri',
    'response_type',
    'scope',
    'state',
    'nonce',
    'code_challenge',
    'code_challenge_method',
  ]);
  if (gone.length) return invalidRequest(res, `missing: ${gone.join(', ')}`);
  if (params.get('response_type') !== 'code')
    return invalidRequest(res, 'response_type must be code');
  if (params.get('code_challenge_method') !== 'S256') {
    return invalidRequest(res, 'code_challenge_method must be S256');
  }
  return mintCodeAndRedirect(res, 'google', params);
}

function mintIdToken({ clientId, nonce, accessToken }) {
  const { sub, extra_claims: extra, fault } = config.google;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: KID, typ: 'JWT' };
  const claims = {
    iss: `${base}/google`,
    aud: clientId,
    azp: clientId,
    sub,
    iat: now,
    exp: now + 3600,
    nonce,
    at_hash: b64u(sha256(accessToken).subarray(0, 16)),
  };
  if (extra) {
    // On purpose: the API asks for the openid scope alone and must drop all of these.
    claims.email = 'fake-sub-000001@example.com';
    claims.email_verified = true;
    claims.name = 'Fake Person';
    claims.picture = 'https://example.com/fake.png';
  }
  if (fault === 'wrong_nonce') claims.nonce = `wrong-${nonce}`;
  if (fault === 'wrong_iss') claims.iss = `${base}/other`;
  if (fault === 'wrong_aud') claims.aud = 'someone-else';
  if (fault === 'expired') claims.exp = now - 3600;
  if (fault === 'unknown_kid') header.kid = 'fake-key-unknown';
  if (fault === 'alg_none') header.alg = 'none';

  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  if (fault === 'alg_none') return `${signingInput}.`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  });
  if (fault === 'bad_signature') signature[0] ^= 0xff;
  return `${signingInput}.${b64u(signature)}`;
}

async function googleToken(req, res, rec) {
  const f = await readFields(req);
  rec.body_keys = Object.keys(f).sort();
  const grant = codes.get(f.code);
  const ok =
    f.grant_type === 'authorization_code' &&
    grant &&
    grant.provider === 'google' &&
    !grant.used &&
    grant.redirect_uri === f.redirect_uri &&
    grant.client_id === f.client_id &&
    safeEqual(f.client_secret, GOOGLE_SECRET) &&
    pkceMatches(f.code_verifier, grant.challenge);
  if (grant) grant.used = true; // a code is spent by any attempt, as at a real provider
  if (!ok) return sendJson(res, 400, { error: 'invalid_grant' });
  const accessToken = randomToken();
  return sendJson(res, 200, {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3599,
    scope: 'openid',
    id_token: mintIdToken({ clientId: grant.client_id, nonce: grant.nonce, accessToken }),
  });
}

// ---------- GitHub ----------

function githubAuthorize(res, rec, params) {
  rec.has_scope_param = params.has('scope');
  const gone = missing(params, [
    'client_id',
    'redirect_uri',
    'state',
    'code_challenge',
    'code_challenge_method',
  ]);
  if (gone.length) return invalidRequest(res, `missing: ${gone.join(', ')}`);
  if (params.get('code_challenge_method') !== 'S256') {
    return invalidRequest(res, 'code_challenge_method must be S256');
  }
  return mintCodeAndRedirect(res, 'github', params);
}

// GitHub answers a failed code exchange with status 200 and an error object, not a 4xx, and it
// answers form-encoded unless the request says Accept: application/json. This copies that.
function githubExchangeAnswer(req, res, body) {
  if (String(req.headers.accept || '').includes('application/json')) {
    return sendJson(res, 200, body);
  }
  return sendText(
    res,
    200,
    new URLSearchParams(body).toString(),
    'application/x-www-form-urlencoded; charset=utf-8',
  );
}

async function githubToken(req, res, rec) {
  const f = await readFields(req);
  rec.body_keys = Object.keys(f).sort();
  const grant = codes.get(f.code);
  const ok =
    config.github.fault !== 'bad_code' &&
    grant &&
    grant.provider === 'github' &&
    !grant.used &&
    grant.client_id === f.client_id &&
    (!f.redirect_uri || grant.redirect_uri === f.redirect_uri) &&
    safeEqual(f.client_secret, GITHUB_SECRET) &&
    pkceMatches(f.code_verifier, grant.challenge);
  if (grant) grant.used = true;
  if (!ok) {
    return githubExchangeAnswer(req, res, {
      error: 'bad_verification_code',
      error_description: 'The code passed is incorrect or expired.',
    });
  }
  const token = `gho_fake_${randomToken(18)}`;
  githubTokens.set(token, { used: false });
  return githubExchangeAnswer(req, res, { access_token: token, token_type: 'bearer', scope: '' });
}

// Each token answers once. The API uses it exactly once, so a second call is a bug it should see.
function githubUser(req, res) {
  if (!req.headers['user-agent']) {
    return sendJson(res, 403, {
      message:
        'Request forbidden by administrative rules. Please make sure your request has a User-Agent header.',
    });
  }
  const token = bearerValue(req);
  const entry = token ? githubTokens.get(token) : undefined;
  if (!entry || entry.used) return sendJson(res, 401, { message: 'Bad credentials' });
  entry.used = true;
  return sendJson(res, 200, {
    login: 'fake-login',
    id: config.github.id,
    node_id: 'fake',
    avatar_url: 'https://example.com/fake.png',
    name: 'Fake Person',
    email: 'fake-login@example.com',
    type: 'User',
  });
}

// ---------- Turnstile ----------

async function siteverify(req, res, rec) {
  const f = await readFields(req);
  rec.body_keys = Object.keys(f).sort();
  rec.has_remoteip = Object.hasOwn(f, 'remoteip');
  if (!f.secret)
    return sendJson(res, 200, { success: false, 'error-codes': ['missing-input-secret'] });
  if (typeof f.response === 'string' && f.response.startsWith('pass')) {
    return sendJson(res, 200, {
      success: true,
      challenge_ts: new Date().toISOString(),
      hostname: '127.0.0.1',
    });
  }
  return sendJson(res, 200, { success: false, 'error-codes': ['invalid-input-response'] });
}

// ---------- Test controls ----------

async function postConfig(req, res) {
  let input;
  try {
    input = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return invalidRequest(res, 'body is not JSON');
  }
  const g = input?.google ?? {};
  const h = input?.github ?? {};
  if (g.fault !== undefined && !GOOGLE_FAULTS.includes(g.fault)) {
    return invalidRequest(res, `google.fault must be one of ${GOOGLE_FAULTS.join(', ')}`);
  }
  if (h.fault !== undefined && !GITHUB_FAULTS.includes(h.fault)) {
    return invalidRequest(res, `github.fault must be one of ${GITHUB_FAULTS.join(', ')}`);
  }
  if (g.sub !== undefined && (typeof g.sub !== 'string' || !g.sub)) {
    return invalidRequest(res, 'google.sub must be a non-empty string');
  }
  if (g.extra_claims !== undefined && typeof g.extra_claims !== 'boolean') {
    return invalidRequest(res, 'google.extra_claims must be a boolean');
  }
  if (h.id !== undefined && !Number.isSafeInteger(h.id)) {
    return invalidRequest(res, 'github.id must be an integer');
  }
  for (const key of ['sub', 'extra_claims', 'fault']) {
    if (g[key] !== undefined) config.google[key] = g[key];
  }
  for (const key of ['id', 'fault']) {
    if (h[key] !== undefined) config.github[key] = h[key];
  }
  return sendJson(res, 200, config);
}

// ---------- Routing ----------

const PROVIDER_PREFIXES = ['/google/', '/github/', '/turnstile/'];

async function route(req, res, url, rec) {
  const { pathname } = url;
  const { method } = req;

  if (pathname === '/_health' && method === 'GET') return sendJson(res, 200, { ok: true });
  if (pathname === '/_requests' && method === 'GET') return sendJson(res, 200, requests);
  if (pathname === '/_reset' && method === 'POST') {
    reset();
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/_config' && method === 'POST') return postConfig(req, res);

  if (pathname === '/google/.well-known/openid-configuration' && method === 'GET') {
    return sendJson(res, 200, discoveryDocument());
  }
  if (pathname === '/google/authorize' && method === 'GET') {
    rec.has_scope_param = url.searchParams.has('scope');
    return googleAuthorize(res, url.searchParams);
  }
  if (pathname === '/google/token' && method === 'POST') return googleToken(req, res, rec);
  if (pathname === '/google/jwks' && method === 'GET') {
    return sendJson(res, 200, {
      keys: [{ kty: 'RSA', kid: KID, use: 'sig', alg: 'RS256', n: publicJwk.n, e: publicJwk.e }],
    });
  }

  if (pathname === '/github/login/oauth/authorize' && method === 'GET') {
    return githubAuthorize(res, rec, url.searchParams);
  }
  if (pathname === '/github/login/oauth/access_token' && method === 'POST') {
    return githubToken(req, res, rec);
  }
  if (pathname === '/github/user' && method === 'GET') return githubUser(req, res);

  if (pathname === '/turnstile/siteverify' && method === 'POST') return siteverify(req, res, rec);

  return sendJson(res, 404, { error: 'not_found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  // Only the providers' own endpoints are recorded; the controls are not provider traffic.
  const isProvider = PROVIDER_PREFIXES.some((p) => url.pathname.startsWith(p));
  const rec = {
    at: new Date().toISOString(),
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    has_user_agent: Boolean(req.headers['user-agent']),
    auth_scheme: authScheme(req),
  };
  if (isProvider) requests.push(rec);
  res.on('finish', () => {
    console.log(JSON.stringify({ method: req.method, path: url.pathname, status: res.statusCode }));
  });
  try {
    await route(req, res, url, rec);
  } catch {
    if (!res.headersSent) sendJson(res, 500, { error: 'server_error' });
    else res.end();
  }
});

const port = parsePort(process.argv.slice(2));
server.listen(port, '127.0.0.1', () => {
  base = `http://127.0.0.1:${server.address().port}`;
  console.log(`fake providers listening on ${base}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
