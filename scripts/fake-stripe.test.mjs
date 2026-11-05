// A node-level check of scripts/fake-stripe.mjs with no Worker and no wrangler: it starts the
// fake on a free port with its webhooks pointed at a receiver here, and drives the payment paths
// smoke-payments.sh uses and the invoice paths PR 7 adds. Run: node --test scripts/
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The fake's own test-shaped defaults, not secrets.
const KEY = 'rk_test_not_a_key';
const WEBHOOK_SECRET = 'whsec_not_a_secret';
const SANDBOX = '01JC8YV2D4QK7S1M9E3PZ6W8AN';

let fake;
let base;
let receiver;
const received = [];

function verified(signature, body) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signature ?? '');
  if (!m) return false;
  const mac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${m[1]}.`).update(body);
  return crypto.timingSafeEqual(Buffer.from(m[2], 'hex'), mac.digest());
}

before(async () => {
  receiver = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      let event;
      try {
        event = JSON.parse(body.toString('utf8'));
      } catch {
        event = null;
      }
      received.push({ ok: verified(req.headers['stripe-signature'], body), event });
      res.writeHead(200).end();
    });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const hook = `http://127.0.0.1:${receiver.address().port}/v1/stripe/webhook`;
  const script = fileURLToPath(new URL('./fake-stripe.mjs', import.meta.url));
  fake = spawn(process.execPath, [script, '--port', '0'], {
    env: { ...process.env, FAKE_STRIPE_WEBHOOK_URL: hook },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  base = await new Promise((resolve, reject) => {
    let out = '';
    fake.stdout.on('data', (chunk) => {
      out += chunk;
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m) resolve(m[1]);
    });
    fake.on('exit', (code) => reject(new Error(`the fake exited with ${code}`)));
  });
});

after(() => {
  fake?.kill();
  receiver?.close();
});

async function api(method, path, fields, key) {
  const headers = { authorization: `Bearer ${KEY}` };
  let body;
  if (fields) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(fields).toString().replaceAll('%5B', '[').replaceAll('%5D', ']');
  }
  if (key) headers['idempotency-key'] = key;
  const res = await fetch(`${base}${path}`, { method, headers, body });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

/** Waits for a delivered event of `type` about `id`, its signature checked. */
async function delivered(type, id) {
  for (let i = 0; i < 100; i++) {
    const hit = received.find((r) => r.event?.type === type && r.event.data.object.id === id);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no ${type} for ${id}`);
}

const meta = (extra = {}) => ({ 'metadata[sandbox]': SANDBOX, ...extra });

test('the payment paths are as they were', async () => {
  const pi = await api(
    'POST',
    '/v1/payment_intents',
    { amount: '2090', currency: 'usd', ...meta() },
    'k-pi',
  );
  assert.equal(pi.status, 200);
  assert.match(pi.body.id, /^pi_fake/);
  const again = await api(
    'POST',
    '/v1/payment_intents',
    { amount: '2090', currency: 'usd', ...meta() },
    'k-pi',
  );
  assert.equal(again.headers.get('idempotent-replayed'), 'true');
  assert.equal(again.body.id, pi.body.id);
  const other = await api(
    'POST',
    '/v1/payment_intents',
    { amount: '2091', currency: 'usd' },
    'k-pi',
  );
  assert.equal(other.body.error.type, 'idempotency_error');
  const paid = await api('POST', `/v1/payment_intents/${pi.body.id}/confirm`, {
    payment_method: 'pm_card_visa',
  });
  assert.equal(paid.body.status, 'succeeded');
  const hit = await delivered('payment_intent.succeeded', pi.body.id);
  assert.ok(hit.ok, 'signed');
  assert.equal(hit.event.data.object.metadata.sandbox, SANDBOX);
  const refund = await api('POST', '/v1/refunds', { payment_intent: pi.body.id, amount: '500' });
  assert.equal(refund.body.status, 'succeeded');
  await delivered('refund.created', refund.body.id);
  const events = await (await fetch(`${base}/_events`)).json();
  assert.ok(events.some((e) => e.type === 'charge.refunded' && e.intent === pi.body.id));
});

test('a customer carries metadata and nothing else, and is deleted once', async () => {
  const c = await api('POST', '/v1/customers', meta({ 'metadata[persona]': 'p1' }), 'k-c');
  assert.equal(c.status, 200);
  assert.match(c.body.id, /^cus_fake/);
  assert.equal(c.body.email, null);
  assert.equal(c.body.name, null);
  assert.deepEqual(c.body.metadata, { sandbox: SANDBOX, persona: 'p1' });
  const replay = await api('POST', '/v1/customers', meta({ 'metadata[persona]': 'p1' }), 'k-c');
  assert.equal(replay.body.id, c.body.id);
  const gone = await api('DELETE', `/v1/customers/${c.body.id}`);
  assert.deepEqual(gone.body, { id: c.body.id, object: 'customer', deleted: true });
  const twice = await api('DELETE', `/v1/customers/${c.body.id}`);
  assert.equal(twice.status, 404);
  assert.equal(twice.body.error.code, 'resource_missing');
});

async function openInvoice(key, amount = '43500') {
  const c = await api('POST', '/v1/customers', meta({ 'metadata[persona]': key }), `${key}-c`);
  const draft = await api(
    'POST',
    '/v1/invoices',
    {
      customer: c.body.id,
      currency: 'usd',
      collection_method: 'send_invoice',
      days_until_due: '7',
      auto_advance: 'false',
      pending_invoice_items_behavior: 'exclude',
      ...meta({ 'metadata[invoice]': key, 'metadata[purpose]': 'balance' }),
    },
    key,
  );
  assert.equal(draft.status, 200);
  assert.equal(draft.body.status, 'draft');
  const item = await api(
    'POST',
    '/v1/invoiceitems',
    { customer: c.body.id, invoice: draft.body.id, amount, currency: 'usd', ...meta() },
    `${key}:item`,
  );
  assert.equal(item.status, 200);
  assert.equal(item.body.invoice, draft.body.id);
  const open = await api(
    'POST',
    `/v1/invoices/${draft.body.id}/finalize`,
    { auto_advance: 'false' },
    `${key}:finalize`,
  );
  assert.equal(open.status, 200);
  return { customer: c.body, invoice: open.body };
}

test('an invoice is drafted, given its item, finalized and paid, and invoice.paid is signed', async () => {
  const { customer, invoice } = await openInvoice('k-inv-1');
  assert.equal(invoice.status, 'open');
  assert.equal(invoice.collection_method, 'send_invoice');
  assert.equal(invoice.auto_advance, false);
  assert.equal(invoice.amount_due, 43500);
  assert.equal(invoice.customer_email, null);
  assert.equal(invoice.due_date, invoice.status_transitions.finalized_at + 7 * 86400);
  const read = await api('GET', `/v1/invoices/${invoice.id}`);
  assert.equal(read.body.lines.data.length, 1);
  const late = await api('POST', '/v1/invoiceitems', {
    customer: customer.id,
    invoice: invoice.id,
    amount: '1',
    currency: 'usd',
  });
  assert.equal(late.body.error.code, 'invoice_not_editable');
  const declined = await api('POST', `/v1/invoices/${invoice.id}/pay`, {
    payment_method: 'pm_card_chargeDeclined',
  });
  assert.equal(declined.status, 402);
  assert.equal(declined.body.error.code, 'card_declined');
  await delivered('invoice.payment_failed', invoice.id);
  const paid = await api(
    'POST',
    `/v1/invoices/${invoice.id}/pay`,
    { payment_method: 'pm_card_visa' },
    'k-pay',
  );
  assert.equal(paid.body.status, 'paid');
  assert.equal(paid.body.amount_paid, 43500);
  const replay = await api(
    'POST',
    `/v1/invoices/${invoice.id}/pay`,
    { payment_method: 'pm_card_visa' },
    'k-pay',
  );
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  const reused = await api('POST', `/v1/invoices/${invoice.id}/void`, {}, 'k-pay');
  assert.equal(reused.body.error.type, 'idempotency_error');
  const hit = await delivered('invoice.paid', invoice.id);
  assert.ok(hit.ok, 'signed');
  assert.equal(hit.event.livemode, false);
  assert.equal(hit.event.data.object.amount_paid, 43500);
  assert.deepEqual(hit.event.data.object.metadata, {
    sandbox: SANDBOX,
    invoice: 'k-inv-1',
    purpose: 'balance',
  });
  const voidPaid = await api('POST', `/v1/invoices/${invoice.id}/void`, {});
  assert.equal(voidPaid.body.error.code, 'invoice_unexpected_state');
});

test('an open invoice is voided, and the faults apply to its event', async () => {
  const { invoice } = await openInvoice('k-inv-2');
  await fetch(`${base}/_config`, {
    method: 'POST',
    body: JSON.stringify({ faults: { livemode: true, bad_signature: true } }),
  });
  const voided = await api('POST', `/v1/invoices/${invoice.id}/void`, {}, 'k-void');
  assert.equal(voided.body.status, 'void');
  await fetch(`${base}/_config`, {
    method: 'POST',
    body: JSON.stringify({ faults: { livemode: false, bad_signature: false } }),
  });
  const hit = await delivered('invoice.voided', invoice.id);
  assert.equal(hit.ok, false, 'bad_signature changed the signature');
  assert.equal(hit.event.livemode, true);
  const pay = await api('POST', `/v1/invoices/${invoice.id}/pay`, {
    payment_method: 'pm_card_visa',
  });
  assert.equal(pay.body.error.code, 'invoice_unexpected_state');
  const summary = (await (await fetch(`${base}/_events`)).json()).find(
    (e) => e.type === 'invoice.voided',
  );
  assert.equal(summary.intent, invoice.id);
  assert.deepEqual(summary.fault, ['bad_signature', 'livemode']);
});

test('invoice rules: send_invoice needs days, pending items wait unless included', async () => {
  const c = await api('POST', '/v1/customers', meta());
  const noDays = await api('POST', '/v1/invoices', {
    customer: c.body.id,
    collection_method: 'send_invoice',
  });
  assert.equal(noDays.status, 400);
  assert.equal(noDays.body.error.param, 'days_until_due');
  const unknown = await api('POST', '/v1/invoices', { customer: 'cus_fake_nope' });
  assert.equal(unknown.status, 404);
  const pending = await api('POST', '/v1/invoiceitems', {
    customer: c.body.id,
    amount: '700',
    currency: 'usd',
  });
  assert.equal(pending.body.invoice, null);
  const excluded = await api('POST', '/v1/invoices', {
    customer: c.body.id,
    collection_method: 'send_invoice',
    days_until_due: '7',
  });
  assert.equal(excluded.body.amount_due, 0);
  const included = await api('POST', '/v1/invoices', {
    customer: c.body.id,
    collection_method: 'send_invoice',
    days_until_due: '7',
    pending_invoice_items_behavior: 'include',
  });
  assert.equal(included.body.amount_due, 700);
  const missingInvoice = await api('GET', '/v1/invoices/in_fake_nope');
  assert.equal(missingInvoice.status, 404);
  const requests = await (await fetch(`${base}/_requests`)).json();
  const del = requests.find((r) => r.method === 'DELETE');
  assert.equal(del.idempotency_key_present, false);
  assert.ok(requests.every((r) => r.auth_scheme === 'Bearer'));
});
