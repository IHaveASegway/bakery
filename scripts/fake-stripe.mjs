#!/usr/bin/env node
// A local stand-in for the part of Stripe's REST API that the API Worker's payments use, and for
// the webhooks Stripe sends back, so the payment paths can be proven end to end on `wrangler dev`
// with no Stripe account and no network. It is a test fixture for scripts/smoke-payments.sh and
// for trying the flows by hand. It is never a Stripe: it models the happy path, a decline, a
// cancel and a refund, and it copies Stripe's request and response shapes where they are
// documented, not Stripe's behavior everywhere. It listens on 127.0.0.1 only, holds nothing real,
// keeps everything in memory, and writes no key or body to its log.
//
// What it models: payment intents (create, read, confirm with pm_card_visa or
// pm_card_chargeDeclined, cancel), refunds, and since PR 7 a catering balance's Stripe Invoicing
// path: customers (create, delete), invoice items, invoices (draft, finalize, pay on the test
// path, void, read), and the invoice.paid and invoice.voided webhooks.
//
// Known differences from Stripe, each a simplification a test may lean on:
//   - A refund's metadata is the intent's, not its own, so every event names its sandbox.
//   - It sends no email, ever: Stripe emails a send_invoice invoice to a customer that has an
//     email, and the bakery's customers have none (spike S3 confirms Stripe sends nothing).
//   - An invoice has no payment intent of its own. /pay takes a test payment method, as the
//     intent's confirm does, or paid_out_of_band=true; at Stripe the visitor pays the invoice's
//     payment with the Payment Element (spike S3). No payment_intent.* event is sent for it, and
//     a paid invoice cannot be refunded here.
//   - Finalizing sends no invoice.finalized event; pay and void send invoice.paid,
//     invoice.payment_failed and invoice.voided only.
//   - due_date is the finalize time plus days_until_due days, in wall time; there is no
//     invoice.overdue and nothing ever becomes uncollectible.
//   - Taxes, discounts, prices and products do not exist: an item is an amount and a currency.
//   - pending_invoice_items_behavior defaults to exclude, as in Stripe's current API versions.
//
// It exists because the real sandbox needs Joseph's account and key and cannot run in CI. Spike S3
// confirms against the real sandbox the two things only it can: that the Payment Element with
// `fields.billingDetails: 'never'` confirms a payment, and that a webhook reaches the Worker.
//
// Run:   node scripts/fake-stripe.mjs [--port 8791]      (Node 22 or later, no dependencies)
//
// Point the API at it with these lines in workers/api/.dev.vars (never committed). The base URL
// override is honored only for 127.0.0.1 and localhost hosts:
//
//   STRIPE_API_BASE=http://127.0.0.1:8791
//   STRIPE_SECRET_KEY=rk_test_fake000000000000000000000000
//   STRIPE_WEBHOOK_SECRET=whsec_fake0000000000000000000000000000
//
// These environment variables of this process change what it expects and where it sends; the
// defaults are the values above and the Worker's webhook route:
//
//   FAKE_STRIPE_SECRET_KEY      the one key it accepts, as "Authorization: Bearer <key>".
//   FAKE_STRIPE_WEBHOOK_SECRET  the secret it signs webhooks with.
//   FAKE_STRIPE_WEBHOOK_URL     where it posts them (default http://127.0.0.1:8788/v1/stripe/webhook,
//                               loopback hosts only).
//
// The API, under /v1, with form-encoded bodies and bracket notation (metadata[sandbox]=...):
//   POST /v1/payment_intents               amount, currency, metadata[...], automatic_payment_methods[enabled].
//   GET  /v1/payment_intents/{id}
//   POST /v1/payment_intents/{id}/confirm  payment_method=pm_card_visa succeeds; pm_card_chargeDeclined
//                                          declines with card_declined; any other id is resource_missing.
//   POST /v1/payment_intents/{id}/cancel
//   POST /v1/refunds                       payment_intent (or charge), optional amount and reason.
//   POST /v1/customers                     metadata[...], and optional email and name, which the
//                                          bakery never sends.
//   DELETE /v1/customers/{id}              { id, object, deleted: true }; no idempotency key.
//   POST /v1/invoiceitems                  customer, amount, currency, optional invoice (a draft)
//                                          and description; with no invoice it waits as pending.
//   POST /v1/invoices                      customer, collection_method (send_invoice needs
//                                          days_until_due), auto_advance, currency,
//                                          pending_invoice_items_behavior, metadata[...]: a draft.
//   POST /v1/invoices/{id}/finalize        draft to open.
//   POST /v1/invoices/{id}/pay             the test path: payment_method=pm_card_visa pays it
//                                          (invoice.paid), pm_card_chargeDeclined is a 402
//                                          card_declined (invoice.payment_failed); open only.
//   POST /v1/invoices/{id}/void            open to void (invoice.voided).
//   GET  /v1/invoices/{id}
// An Idempotency-Key on a POST replays the stored status and body; the same key with different
// parameters is a 400 idempotency_error. Errors use Stripe's shape: { error: { type, code, message } }.
//
// Webhooks. After a successful confirm, a decline, a cancel and a refund it posts the matching
// events (payment_intent.succeeded, payment_intent.payment_failed, payment_intent.canceled,
// charge.refunded then refund.created), and after an invoice is paid, declined or voided
// (invoice.paid, invoice.payment_failed, invoice.voided, each carrying the invoice and so its
// metadata), in the background, so the API call returns first, as it does at Stripe. Each carries
// Stripe-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">, and every fault
// below applies to invoice events as to the others.
// A delivery that is not answered 2xx, or not answered at all, is tried twice more after 500 ms.
//
// Test controls, all under /_ :
//   POST /_config      JSON { faults: { bad_signature, old_timestamp, tamper_body, livemode }, replay }.
//                      Stored for the webhooks that follow and until the next /_config or /_reset;
//                      keys left out keep their value; answers the whole current config. Each fault
//                      changes exactly one thing:
//     bad_signature    the first hex digit of v1 is changed.
//     old_timestamp    t is 360 seconds in the past, and the signature is valid for that t.
//     tamper_body      one byte of the body is flipped after it is signed.
//     livemode         the event and its object say livemode true.
//     replay: n        the next webhook is sent n times (the same event, a fresh t each time), then
//                      this goes back to 1.
//   GET  /_config      the current config.
//   GET  /_events      every event sent: id, type, the intent id (the invoice's id for an invoice
//                      event), the faults applied, and each delivery's attempt and status code (0
//                      means no answer).
//   POST /_send_event  JSON { event_id }. Sends a stored event once more, waits, and answers it.
//   GET  /_requests    every /v1 request since the last reset: shape only. Method, path, status,
//                      whether an Idempotency-Key came, the auth scheme, the Stripe-Version and the
//                      sorted body field names. Never a key, a body value or a client secret.
//   POST /_reset       clears intents, refunds, customers, invoice items, invoices, idempotency
//                      keys, events, requests and config.
//   GET  /_health      { ok: true }.
import crypto from 'node:crypto';
import http from 'node:http';
import querystring from 'node:querystring';
import { URL } from 'node:url';

const DEFAULT_PORT = 8791;
const MAX_BODY_BYTES = 64 * 1024;
const RETRIES = 2;
const RETRY_DELAY_MS = 500;
const DELIVERY_TIMEOUT_MS = 5000;
const OLD_TIMESTAMP_SKEW_S = 360;
const MAX_REPLAY = 50;
const SECRET_KEY = process.env.FAKE_STRIPE_SECRET_KEY || 'rk_test_fake000000000000000000000000';
const WEBHOOK_SECRET =
  process.env.FAKE_STRIPE_WEBHOOK_SECRET || 'whsec_fake0000000000000000000000000000';
const WEBHOOK_URL =
  process.env.FAKE_STRIPE_WEBHOOK_URL || 'http://127.0.0.1:8788/v1/stripe/webhook';
const FAULTS = ['bad_signature', 'old_timestamp', 'tamper_body', 'livemode'];
const REFUND_REASONS = ['duplicate', 'fraudulent', 'requested_by_customer'];
const CANCEL_REASONS = ['duplicate', 'fraudulent', 'requested_by_customer', 'abandoned'];

function parsePort(argv) {
  const i = argv.indexOf('--port');
  if (i === -1) return DEFAULT_PORT;
  const port = Number(argv[i + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('usage: node scripts/fake-stripe.mjs [--port 8791]');
    process.exit(2);
  }
  return port;
}

// The webhook target is checked once, so a typo cannot point test events at a real host.
function checkWebhookUrl() {
  let target;
  try {
    target = new URL(WEBHOOK_URL);
  } catch {
    target = null;
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'];
  if (!target || target.protocol !== 'http:' || !loopback.includes(target.hostname)) {
    console.error('FAKE_STRIPE_WEBHOOK_URL must be an http URL on 127.0.0.1, localhost or [::1]');
    process.exit(2);
  }
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
const newId = (prefix) => `${prefix}${crypto.randomBytes(12).toString('hex')}`;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(String(a ?? '')), sha256(String(b ?? '')));
}

function defaultConfig() {
  return {
    faults: { bad_signature: false, old_timestamp: false, tamper_body: false, livemode: false },
    replay: 1,
  };
}

let config = defaultConfig();
let requests = [];
let intents = new Map(); // id -> { pi, refunded, chargeId }
let refunds = new Map(); // id -> refund object
let customers = new Map(); // id -> customer object
let invoiceItems = new Map(); // id -> invoice item object
let invoices = new Map(); // id -> invoice object, its lines included
let idempotency = new Map(); // key -> { fingerprint, status, body }
let events = []; // one record per event: { id, type, intent, payload, sends, deliveries }
let queue = Promise.resolve(); // webhook deliveries run one after another, in order

function reset() {
  config = defaultConfig();
  requests = [];
  intents = new Map();
  refunds = new Map();
  customers = new Map();
  invoiceItems = new Map();
  invoices = new Map();
  idempotency = new Map();
  events = [];
}

// ---------- Responses ----------

function writeJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    'request-id': newId('req_fake'),
    ...headers,
  });
  res.end(text);
}

function errorBody(type, message, code, param) {
  const error = { type };
  if (code) error.code = code;
  error.message = message;
  if (param) error.param = param;
  return { error };
}

// A handler's answer: a status and a body, and any events to send once the response has gone.
const fail = (status, type, message, code, param) => ({
  status,
  body: errorBody(type, message, code, param),
});
const noSuchIntent = (id) =>
  fail(
    404,
    'invalid_request_error',
    `No such payment_intent: '${id}'`,
    'resource_missing',
    'intent',
  );

// ---------- Request bodies ----------

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

// Stripe's bracket notation: a[b][c]=1 is { a: { b: { c: '1' } } } and a[]=1 appends to an array.
// The containers have no prototype, so a key such as __proto__ is only a key.
function assign(root, parts, value) {
  let node = root;
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const key = Array.isArray(node) && parts[i] === '' ? node.length : parts[i];
    if (last) {
      node[key] = value;
      return;
    }
    let child = node[key];
    if (child === null || typeof child !== 'object') {
      child = parts[i + 1] === '' ? [] : Object.create(null);
      node[key] = child;
    }
    node = child;
  }
}

function decodeForm(text) {
  const fields = Object.create(null);
  const rawKeys = new Set();
  const pairs = querystring.parse(text, '&', '=', { maxKeys: 200 });
  for (const [rawKey, raw] of Object.entries(pairs)) {
    rawKeys.add(rawKey);
    const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
    const m = /^([^[\]]+)((?:\[[^[\]]*\])*)$/.exec(rawKey);
    if (!m) {
      fields[rawKey] = value;
      continue;
    }
    const parts = [m[1], ...[...m[2].matchAll(/\[([^[\]]*)\]/g)].map((x) => x[1])];
    assign(fields, parts, value);
  }
  return { fields, bodyKeys: [...rawKeys].sort() };
}

// Sorted keys at every level, so the same parameters in another order are the same request.
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function metadataOf(value) {
  const out = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v;
  }
  return out;
}

const isAmount = (v) => typeof v === 'string' && /^\d{1,8}$/.test(v) && Number(v) > 0;

// ---------- Objects ----------

function chargeOf(entry) {
  const { pi } = entry;
  return {
    id: entry.chargeId,
    object: 'charge',
    amount: pi.amount,
    amount_captured: pi.amount,
    amount_refunded: entry.refunded,
    created: entry.chargedAt,
    currency: pi.currency,
    livemode: false,
    metadata: { ...pi.metadata },
    paid: true,
    payment_intent: pi.id,
    refunded: entry.refunded >= pi.amount,
    status: 'succeeded',
  };
}

const snapshot = (value) => JSON.parse(JSON.stringify(value));

// ---------- Webhooks ----------

function signedDelivery(record, faults) {
  const payload = snapshot(record.payload);
  if (faults.livemode) {
    payload.livemode = true;
    if (payload.data?.object) payload.data.object.livemode = true;
  }
  const t = nowSeconds() - (faults.old_timestamp ? OLD_TIMESTAMP_SKEW_S : 0);
  let body = Buffer.from(JSON.stringify(payload), 'utf8');
  let v1 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.`).update(body).digest('hex');
  if (faults.bad_signature) v1 = `${v1[0] === '0' ? '1' : '0'}${v1.slice(1)}`;
  if (faults.tamper_body) {
    // One character of the event id, so the body is still JSON but no longer what was signed.
    body = Buffer.from(body);
    const at = body.indexOf('evt_fake') + 'evt_fake'.length;
    body[at] ^= 0x01;
  }
  return { body, signature: `t=${t},v1=${v1}` };
}

async function deliverOnce(record, faults) {
  const send = ++record.sends;
  const fault = FAULTS.filter((name) => faults[name]);
  for (let attempt = 1; attempt <= 1 + RETRIES; attempt++) {
    let status;
    try {
      const { body, signature } = signedDelivery(record, faults);
      const answer = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': signature,
          'user-agent': 'fake-stripe/1',
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      status = answer.status;
      await answer.body?.cancel();
    } catch {
      status = 0;
    }
    record.deliveries.push({ send, attempt, status, fault });
    if (status >= 200 && status < 300) return;
    if (attempt <= RETRIES) await sleep(RETRY_DELAY_MS);
  }
}

function enqueue(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

// The faults and the replay count are read when the event is made, so a test can set them, call
// the API and clear them again without racing the background delivery.
function emit(type, object, intentId) {
  const faults = { ...config.faults };
  const times = config.replay;
  config.replay = 1;
  const record = {
    id: newId('evt_fake'),
    type,
    intent: intentId,
    payload: null,
    sends: 0,
    deliveries: [],
  };
  record.payload = {
    id: record.id,
    object: 'event',
    created: nowSeconds(),
    livemode: false,
    type,
    pending_webhooks: 1,
    data: { object: snapshot(object) },
  };
  events.push(record);
  enqueue(async () => {
    for (let n = 0; n < times; n++) await deliverOnce(record, faults);
  });
}

// ---------- Payment intents and refunds ----------

function createIntent(f) {
  if (f.amount === undefined) {
    return fail(
      400,
      'invalid_request_error',
      'Missing required param: amount.',
      'parameter_missing',
      'amount',
    );
  }
  if (!isAmount(f.amount)) {
    return fail(
      400,
      'invalid_request_error',
      'Invalid positive integer',
      'parameter_invalid_integer',
      'amount',
    );
  }
  if (typeof f.currency !== 'string' || !f.currency) {
    return fail(
      400,
      'invalid_request_error',
      'Missing required param: currency.',
      'parameter_missing',
      'currency',
    );
  }
  const id = newId('pi_fake');
  const apm = f.automatic_payment_methods;
  const pi = {
    id,
    object: 'payment_intent',
    amount: Number(f.amount),
    amount_received: 0,
    automatic_payment_methods: apm ? { enabled: apm.enabled === 'true' } : null,
    cancellation_reason: null,
    canceled_at: null,
    capture_method: 'automatic',
    client_secret: `${id}_secret_${crypto.randomBytes(12).toString('hex')}`,
    created: nowSeconds(),
    currency: f.currency.toLowerCase(),
    last_payment_error: null,
    latest_charge: null,
    livemode: false,
    metadata: metadataOf(f.metadata),
    payment_method: typeof f.payment_method === 'string' ? f.payment_method : null,
    status: 'requires_payment_method',
  };
  intents.set(id, { pi, refunded: 0, chargeId: null, chargedAt: 0 });
  return { status: 200, body: pi };
}

function unexpectedState(pi, verb) {
  return fail(
    400,
    'invalid_request_error',
    `You cannot ${verb} this PaymentIntent because it has a status of ${pi.status}.`,
    'payment_intent_unexpected_state',
  );
}

function confirmIntent(id, f) {
  const entry = intents.get(id);
  if (!entry) return noSuchIntent(id);
  const { pi } = entry;
  if (pi.status !== 'requires_payment_method') return unexpectedState(pi, 'confirm');
  const method = typeof f.payment_method === 'string' ? f.payment_method : pi.payment_method;
  if (!method) {
    return fail(
      400,
      'invalid_request_error',
      'Missing required param: payment_method.',
      'parameter_missing',
      'payment_method',
    );
  }
  if (method === 'pm_card_visa') {
    entry.chargeId = newId('ch_fake');
    entry.chargedAt = nowSeconds();
    Object.assign(pi, {
      status: 'succeeded',
      amount_received: pi.amount,
      latest_charge: entry.chargeId,
      payment_method: method,
      last_payment_error: null,
    });
    return {
      status: 200,
      body: pi,
      events: [['payment_intent.succeeded', pi, id]],
    };
  }
  if (method === 'pm_card_chargeDeclined') {
    Object.assign(pi, {
      status: 'requires_payment_method',
      payment_method: null,
      last_payment_error: {
        type: 'card_error',
        code: 'card_declined',
        decline_code: 'generic_decline',
        message: 'Your card was declined.',
      },
    });
    return { status: 200, body: pi, events: [['payment_intent.payment_failed', pi, id]] };
  }
  return fail(
    400,
    'invalid_request_error',
    `No such PaymentMethod: '${method}'`,
    'resource_missing',
    'payment_method',
  );
}

function cancelIntent(id, f) {
  const entry = intents.get(id);
  if (!entry) return noSuchIntent(id);
  const { pi } = entry;
  if (pi.status !== 'requires_payment_method') return unexpectedState(pi, 'cancel');
  if (f.cancellation_reason !== undefined && !CANCEL_REASONS.includes(f.cancellation_reason)) {
    return fail(
      400,
      'invalid_request_error',
      'Invalid cancellation_reason',
      'parameter_invalid_enum',
      'cancellation_reason',
    );
  }
  Object.assign(pi, {
    status: 'canceled',
    canceled_at: nowSeconds(),
    cancellation_reason: f.cancellation_reason ?? null,
  });
  return { status: 200, body: pi, events: [['payment_intent.canceled', pi, id]] };
}

function createRefund(f) {
  let intentId = f.payment_intent;
  if (intentId === undefined && typeof f.charge === 'string') {
    intentId = [...intents.values()].find((e) => e.chargeId === f.charge)?.pi.id ?? f.charge;
  }
  if (typeof intentId !== 'string' || !intentId) {
    return fail(
      400,
      'invalid_request_error',
      'Missing required param: payment_intent.',
      'parameter_missing',
      'payment_intent',
    );
  }
  const entry = intents.get(intentId);
  if (!entry) {
    return fail(
      400,
      'invalid_request_error',
      `No such payment_intent: '${intentId}'`,
      'resource_missing',
      'payment_intent',
    );
  }
  const { pi } = entry;
  if (!entry.chargeId) {
    return fail(
      400,
      'invalid_request_error',
      `The PaymentIntent ${pi.id} has no successful charge to refund.`,
      'charge_not_refundable',
    );
  }
  if (f.reason !== undefined && !REFUND_REASONS.includes(f.reason)) {
    return fail(400, 'invalid_request_error', 'Invalid reason', 'parameter_invalid_enum', 'reason');
  }
  const remaining = pi.amount - entry.refunded;
  if (f.amount !== undefined && !isAmount(f.amount)) {
    return fail(
      400,
      'invalid_request_error',
      'Invalid positive integer',
      'parameter_invalid_integer',
      'amount',
    );
  }
  if (remaining === 0) {
    return fail(
      400,
      'invalid_request_error',
      `Charge ${entry.chargeId} has already been refunded.`,
      'charge_already_refunded',
    );
  }
  const amount = f.amount === undefined ? remaining : Number(f.amount);
  if (amount > remaining) {
    return fail(
      400,
      'invalid_request_error',
      `Refund amount (${amount}) is greater than unrefunded amount on charge (${remaining}).`,
      'amount_too_large',
      'amount',
    );
  }
  entry.refunded += amount;
  const refund = {
    id: newId('re_fake'),
    object: 'refund',
    amount,
    charge: entry.chargeId,
    created: nowSeconds(),
    currency: pi.currency,
    // Stripe's refund has its own metadata. This one carries the intent's, so every event's
    // object names its sandbox, as the Worker expects.
    metadata: { ...pi.metadata },
    payment_intent: pi.id,
    reason: f.reason ?? null,
    status: 'succeeded',
  };
  refunds.set(refund.id, refund);
  return {
    status: 200,
    body: refund,
    events: [
      ['charge.refunded', chargeOf(entry), pi.id],
      ['refund.created', refund, pi.id],
    ],
  };
}

function getIntent(id) {
  const entry = intents.get(id);
  return entry ? { status: 200, body: entry.pi } : noSuchIntent(id);
}

// ---------- Customers and invoices ----------

const noSuch = (kind, id, param) =>
  fail(404, 'invalid_request_error', `No such ${kind}: '${id}'`, 'resource_missing', param);
const missing = (param) =>
  fail(
    400,
    'invalid_request_error',
    `Missing required param: ${param}.`,
    'parameter_missing',
    param,
  );
const optionalString = (v) => (typeof v === 'string' && v !== '' ? v : null);

function createCustomer(f) {
  const customer = {
    id: newId('cus_fake'),
    object: 'customer',
    created: nowSeconds(),
    email: optionalString(f.email),
    livemode: false,
    metadata: metadataOf(f.metadata),
    name: optionalString(f.name),
  };
  customers.set(customer.id, customer);
  return { status: 200, body: customer };
}

function deleteCustomer(id) {
  if (!customers.has(id)) return noSuch('customer', id, 'id');
  customers.delete(id);
  return { status: 200, body: { id, object: 'customer', deleted: true } };
}

// The totals Stripe derives from the lines, kept on the object so a read sees them.
function retotal(invoice) {
  const total = invoice.lines.data.reduce((sum, line) => sum + line.amount, 0);
  invoice.subtotal = total;
  invoice.total = total;
  invoice.amount_due = total;
  invoice.amount_remaining = invoice.status === 'paid' ? 0 : total - invoice.amount_paid;
}

function createInvoiceItem(f) {
  if (typeof f.customer !== 'string' || !f.customer) return missing('customer');
  if (!customers.has(f.customer)) return noSuch('customer', f.customer, 'customer');
  if (f.amount === undefined) return missing('amount');
  if (!isAmount(f.amount)) {
    return fail(
      400,
      'invalid_request_error',
      'Invalid positive integer',
      'parameter_invalid_integer',
      'amount',
    );
  }
  if (typeof f.currency !== 'string' || !f.currency) return missing('currency');
  let invoice = null;
  if (f.invoice !== undefined) {
    invoice = invoices.get(f.invoice);
    if (!invoice) return noSuch('invoice', f.invoice, 'invoice');
    if (invoice.status !== 'draft') {
      return fail(
        400,
        'invalid_request_error',
        `You can only add invoice items to draft invoices; ${invoice.id} is ${invoice.status}.`,
        'invoice_not_editable',
        'invoice',
      );
    }
    if (invoice.customer !== f.customer) {
      return fail(
        400,
        'invalid_request_error',
        'The invoice item and its invoice must have the same customer.',
        'parameter_invalid_string',
        'invoice',
      );
    }
  }
  const item = {
    id: newId('ii_fake'),
    object: 'invoiceitem',
    amount: Number(f.amount),
    currency: f.currency.toLowerCase(),
    customer: f.customer,
    date: nowSeconds(),
    description: optionalString(f.description),
    invoice: invoice ? invoice.id : null,
    livemode: false,
    metadata: metadataOf(f.metadata),
  };
  invoiceItems.set(item.id, item);
  if (invoice) {
    invoice.lines.data.push(snapshot(item));
    retotal(invoice);
  }
  return { status: 200, body: item };
}

function createInvoice(f) {
  if (typeof f.customer !== 'string' || !f.customer) return missing('customer');
  if (!customers.has(f.customer)) return noSuch('customer', f.customer, 'customer');
  const method = f.collection_method ?? 'charge_automatically';
  if (!['charge_automatically', 'send_invoice'].includes(method)) {
    return fail(
      400,
      'invalid_request_error',
      'Invalid collection_method',
      'parameter_invalid_enum',
      'collection_method',
    );
  }
  let days = null;
  if (f.days_until_due !== undefined) {
    if (!/^\d{1,4}$/.test(f.days_until_due)) {
      return fail(
        400,
        'invalid_request_error',
        'Invalid integer',
        'parameter_invalid_integer',
        'days_until_due',
      );
    }
    days = Number(f.days_until_due);
  }
  if (method === 'send_invoice' && days === null) {
    return fail(
      400,
      'invalid_request_error',
      'Invoices with collection_method=send_invoice need days_until_due or due_date.',
      'parameter_missing',
      'days_until_due',
    );
  }
  const behavior = f.pending_invoice_items_behavior ?? 'exclude';
  if (!['include', 'exclude'].includes(behavior)) {
    return fail(
      400,
      'invalid_request_error',
      'Invalid pending_invoice_items_behavior',
      'parameter_invalid_enum',
      'pending_invoice_items_behavior',
    );
  }
  const invoice = {
    id: newId('in_fake'),
    object: 'invoice',
    amount_due: 0,
    amount_paid: 0,
    amount_remaining: 0,
    auto_advance: f.auto_advance === 'true',
    collection_method: method,
    created: nowSeconds(),
    currency: typeof f.currency === 'string' && f.currency ? f.currency.toLowerCase() : 'usd',
    customer: f.customer,
    customer_email: customers.get(f.customer).email,
    days_until_due: days,
    due_date: null,
    lines: { object: 'list', data: [], has_more: false },
    livemode: false,
    metadata: metadataOf(f.metadata),
    status: 'draft',
    status_transitions: { finalized_at: null, paid_at: null, voided_at: null },
    subtotal: 0,
    total: 0,
  };
  if (behavior === 'include') {
    for (const item of invoiceItems.values()) {
      if (item.customer === f.customer && item.invoice === null) {
        item.invoice = invoice.id;
        invoice.lines.data.push(snapshot(item));
      }
    }
  }
  retotal(invoice);
  invoices.set(invoice.id, invoice);
  return { status: 200, body: invoice };
}

function invoiceState(invoice, verb) {
  return fail(
    400,
    'invalid_request_error',
    `You cannot ${verb} this invoice because it has a status of ${invoice.status}.`,
    'invoice_unexpected_state',
  );
}

function finalizeInvoice(id, f) {
  const invoice = invoices.get(id);
  if (!invoice) return noSuch('invoice', id, 'invoice');
  if (invoice.status !== 'draft') return invoiceState(invoice, 'finalize');
  const at = nowSeconds();
  if (f.auto_advance !== undefined) invoice.auto_advance = f.auto_advance === 'true';
  invoice.status = 'open';
  invoice.status_transitions.finalized_at = at;
  if (invoice.days_until_due !== null) invoice.due_date = at + invoice.days_until_due * 86400;
  retotal(invoice);
  return { status: 200, body: invoice };
}

function markPaid(invoice) {
  invoice.status = 'paid';
  invoice.amount_paid = invoice.amount_due;
  invoice.status_transitions.paid_at = nowSeconds();
  retotal(invoice);
}

function payInvoice(id, f) {
  const invoice = invoices.get(id);
  if (!invoice) return noSuch('invoice', id, 'invoice');
  if (invoice.status !== 'open') return invoiceState(invoice, 'pay');
  if (f.paid_out_of_band === 'true') {
    markPaid(invoice);
    return { status: 200, body: invoice, events: [['invoice.paid', invoice, id]] };
  }
  const method = f.payment_method;
  if (typeof method !== 'string' || !method) return missing('payment_method');
  if (method === 'pm_card_visa') {
    markPaid(invoice);
    return { status: 200, body: invoice, events: [['invoice.paid', invoice, id]] };
  }
  if (method === 'pm_card_chargeDeclined') {
    return {
      ...fail(402, 'card_error', 'Your card was declined.', 'card_declined'),
      events: [['invoice.payment_failed', invoice, id]],
    };
  }
  return noSuch('PaymentMethod', method, 'payment_method');
}

function voidInvoice(id) {
  const invoice = invoices.get(id);
  if (!invoice) return noSuch('invoice', id, 'invoice');
  if (!['open', 'uncollectible'].includes(invoice.status)) return invoiceState(invoice, 'void');
  invoice.status = 'void';
  invoice.status_transitions.voided_at = nowSeconds();
  retotal(invoice);
  return { status: 200, body: invoice, events: [['invoice.voided', invoice, id]] };
}

function getInvoice(id) {
  const invoice = invoices.get(id);
  return invoice ? { status: 200, body: invoice } : noSuch('invoice', id, 'invoice');
}

// ---------- Routing ----------

function matchBilling(method, pathname) {
  if (method === 'POST' && pathname === '/v1/customers') return (f) => createCustomer(f);
  if (method === 'POST' && pathname === '/v1/invoiceitems') return (f) => createInvoiceItem(f);
  if (method === 'POST' && pathname === '/v1/invoices') return (f) => createInvoice(f);
  const c = /^\/v1\/customers\/([^/]+)$/.exec(pathname);
  if (c && method === 'DELETE') {
    const id = decodeURIComponent(c[1]);
    return () => deleteCustomer(id);
  }
  const m = /^\/v1\/invoices\/([^/]+)(?:\/(finalize|pay|void))?$/.exec(pathname);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  if (method === 'GET' && !m[2]) return () => getInvoice(id);
  if (method === 'POST' && m[2] === 'finalize') return (f) => finalizeInvoice(id, f);
  if (method === 'POST' && m[2] === 'pay') return (f) => payInvoice(id, f);
  if (method === 'POST' && m[2] === 'void') return () => voidInvoice(id);
  return null;
}

function matchApi(method, pathname) {
  if (method === 'POST' && pathname === '/v1/payment_intents') return (f) => createIntent(f);
  if (method === 'POST' && pathname === '/v1/refunds') return (f) => createRefund(f);
  const billing = matchBilling(method, pathname);
  if (billing) return billing;
  const m = /^\/v1\/payment_intents\/([^/]+)(?:\/(confirm|cancel))?$/.exec(pathname);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  if (method === 'GET' && !m[2]) return () => getIntent(id);
  if (method === 'POST' && m[2] === 'confirm') return (f) => confirmIntent(id, f);
  if (method === 'POST' && m[2] === 'cancel') return (f) => cancelIntent(id, f);
  return null;
}

function authScheme(req) {
  const word = /^(\S+)\s+\S/.exec(String(req.headers.authorization || ''))?.[1]?.toLowerCase();
  if (word === 'bearer') return 'Bearer';
  if (word === 'basic') return 'Basic';
  return word ? 'other' : null;
}

function bearerValue(req) {
  const m = /^bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization || ''));
  return m ? m[1] : null;
}

function notFound(res, method, pathname) {
  writeJson(
    res,
    404,
    errorBody(
      'invalid_request_error',
      `Unrecognized request URL (${method}: ${pathname}). Please see https://stripe.com/docs or we can help at https://support.stripe.com/.`,
    ),
  );
}

async function handleApi(req, res, url, rec) {
  const { method } = req;
  const key = bearerValue(req);
  if (authScheme(req) !== 'Bearer' || !key || !safeEqual(key, SECRET_KEY)) {
    return writeJson(res, 401, errorBody('invalid_request_error', 'Invalid API Key provided'));
  }
  const run = matchApi(method, url.pathname);
  if (!run) return notFound(res, method, url.pathname);

  let fields = Object.create(null);
  if (method === 'POST') {
    const decoded = decodeForm(await readBody(req));
    fields = decoded.fields;
    rec.body_keys = decoded.bodyKeys;
  }

  const idemKey = method === 'POST' ? req.headers['idempotency-key'] : undefined;
  const fingerprint = `${method} ${url.pathname} ${stable(fields)}`;
  if (idemKey) {
    const prior = idempotency.get(idemKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        return writeJson(
          res,
          400,
          errorBody(
            'idempotency_error',
            'Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a different key for this request if you are trying to create a new object.',
          ),
        );
      }
      return writeJson(res, prior.status, prior.body, { 'idempotent-replayed': 'true' });
    }
  }

  const answer = run(fields);
  if (idemKey) {
    idempotency.set(idemKey, { fingerprint, status: answer.status, body: snapshot(answer.body) });
  }
  writeJson(res, answer.status, answer.body);
  // After the response, as at Stripe: the caller has its answer before the event can arrive.
  for (const [type, object, intentId] of answer.events ?? []) emit(type, object, intentId);
}

// ---------- Test controls ----------

function controlError(res, message) {
  writeJson(res, 400, errorBody('invalid_request_error', message));
}

async function readJsonBody(req, res) {
  try {
    return JSON.parse((await readBody(req)) || '{}');
  } catch {
    controlError(res, 'body is not JSON');
    return undefined;
  }
}

async function postConfig(req, res) {
  const input = await readJsonBody(req, res);
  if (input === undefined) return;
  const faults = input?.faults ?? {};
  for (const [name, value] of Object.entries(faults)) {
    if (!FAULTS.includes(name)) return controlError(res, `faults.${name} is not a fault`);
    if (typeof value !== 'boolean') return controlError(res, `faults.${name} must be a boolean`);
  }
  const replay = input?.replay;
  if (replay !== undefined && !(Number.isInteger(replay) && replay >= 1 && replay <= MAX_REPLAY)) {
    return controlError(res, `replay must be an integer from 1 to ${MAX_REPLAY}`);
  }
  Object.assign(config.faults, faults);
  if (replay !== undefined) config.replay = replay;
  return writeJson(res, 200, config);
}

function eventSummary(record) {
  const applied = new Set(record.deliveries.flatMap((d) => d.fault));
  return {
    id: record.id,
    type: record.type,
    intent: record.intent,
    fault: FAULTS.filter((name) => applied.has(name)),
    deliveries: record.deliveries,
  };
}

async function postSendEvent(req, res) {
  const input = await readJsonBody(req, res);
  if (input === undefined) return;
  const record = events.find((e) => e.id === input?.event_id);
  if (!record) {
    return writeJson(
      res,
      404,
      errorBody('invalid_request_error', 'No such event', 'resource_missing', 'event_id'),
    );
  }
  const faults = { ...config.faults };
  await enqueue(() => deliverOnce(record, faults));
  return writeJson(res, 200, eventSummary(record));
}

async function route(req, res, url, rec) {
  const { pathname } = url;
  const { method } = req;

  if (pathname === '/_health' && method === 'GET') return writeJson(res, 200, { ok: true });
  if (pathname === '/_requests' && method === 'GET') return writeJson(res, 200, requests);
  if (pathname === '/_events' && method === 'GET') {
    return writeJson(res, 200, events.map(eventSummary));
  }
  if (pathname === '/_config' && method === 'GET') return writeJson(res, 200, config);
  if (pathname === '/_config' && method === 'POST') return postConfig(req, res);
  if (pathname === '/_send_event' && method === 'POST') return postSendEvent(req, res);
  if (pathname === '/_reset' && method === 'POST') {
    reset();
    return writeJson(res, 200, { ok: true });
  }
  if (pathname.startsWith('/v1/')) return handleApi(req, res, url, rec);
  return notFound(res, method, pathname);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  // Only the Stripe API paths are recorded; the controls are not Stripe traffic.
  const rec = {
    at: new Date().toISOString(),
    method: req.method,
    path: url.pathname,
    status: null,
    idempotency_key_present: Boolean(req.headers['idempotency-key']),
    auth_scheme: authScheme(req),
    stripe_version: String(req.headers['stripe-version'] || '').slice(0, 32) || null,
    body_keys: [],
  };
  if (url.pathname.startsWith('/v1/')) requests.push(rec);
  res.on('finish', () => {
    rec.status = res.statusCode;
    console.log(JSON.stringify({ method: req.method, path: url.pathname, status: res.statusCode }));
  });
  try {
    await route(req, res, url, rec);
  } catch {
    if (!res.headersSent) writeJson(res, 500, errorBody('api_error', 'Fake server error'));
    else res.end();
  }
});

checkWebhookUrl();
const port = parsePort(process.argv.slice(2));
server.listen(port, '127.0.0.1', () => {
  console.log(`fake stripe listening on http://127.0.0.1:${server.address().port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
