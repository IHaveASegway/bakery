#!/usr/bin/env node
// A kitchen-board socket client for the smoke test (scripts/smoke-orders.sh): Node 22's global
// WebSocket, no dependencies. It opens the socket the console opens, prints every frame the
// Kitchen sends as one JSON line, can send commands and wait for events, and exits when the
// server says `bye`.
//
// Run:   node scripts/ws-probe.mjs --url ws://127.0.0.1:8788/v1/sandboxes/<id>/kitchen/ws \
//          --jar <cookie file> --origin http://127.0.0.1:8787 [options]
//
//   --jar FILE          cookies as `name=value` lines (the smoke script's jars); sent as Cookie
//   --origin ORIGIN     the Origin header; leave it out to send none
//   --cmd ID:ORDER:ACTION   a `cmd` frame, sent after the snapshot; repeatable, each sent once
//                       the one before it is answered
//   --delay SECONDS     wait this long after the snapshot before sending anything, so an idle
//                       socket's first frame can wake a hibernated Kitchen
//   --raw TEXT          a frame sent as is after the snapshot (and after any --cmd)
//   --flood N           N copies of a `cmd` frame with no id, sent at once after the snapshot
//   --wait-evt TYPE[:N] exit 0 once N `evt` frames of TYPE arrived (N defaults to 1)
//   --evt-order ORDER   count only `evt` frames whose stream is that order's (`order:<s>:ORDER`)
//   --until KIND        exit 0 once a frame of this `t` arrived (snapshot, ack, nack, ...)
//   --hold SECONDS      stay open this long, then close with 1000; 0 holds until killed
//   --timeout SECONDS   exit 3 when the condition has not been met by then (default 10)
//
// Prints one JSON line per frame, {"at": <ms>, "frame": {...}}, then on the way out
// {"closed": {code, reason}} if the socket closed and {"board": {<order>: <state>}}: the board
// as this client holds it, the snapshot with every later `evt` folded in by the rules
// apps/web/src/lib/kitchen.ts follows. SIGTERM and SIGINT close with 1000 and exit 0.
//
// Exit codes: 0 done (a condition met, a hold ended, or `bye`), 3 timed out, 4 the socket
// never opened (an upgrade refused shows here: the WHATWG client hides the status), 2 usage.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opts = {
  cmds: [],
  raws: [],
  flood: 0,
  delay: 0,
  timeout: 10,
  hold: null,
  waitEvt: null,
  until: null,
};
for (let i = 0; i < args.length; i++) {
  const next = () => {
    if (i + 1 >= args.length) usage(`${args[i]} needs a value`);
    return args[++i];
  };
  switch (args[i]) {
    case '--url':
      opts.url = next();
      break;
    case '--jar':
      opts.jar = next();
      break;
    case '--origin':
      opts.origin = next();
      break;
    case '--cmd': {
      const [id, order, action] = next().split(':');
      if (!id || !order || !action) usage('--cmd is ID:ORDER:ACTION');
      opts.cmds.push({ id, order, action });
      break;
    }
    case '--raw':
      opts.raws.push(next());
      break;
    case '--delay':
      opts.delay = Number(next());
      break;
    case '--flood':
      opts.flood = Number(next());
      break;
    case '--wait-evt': {
      const [type, n] = next().split(':');
      opts.waitEvt = { type, n: n === undefined ? 1 : Number(n) };
      break;
    }
    case '--evt-order':
      opts.evtOrder = next();
      break;
    case '--until':
      opts.until = next();
      break;
    case '--hold':
      opts.hold = Number(next());
      break;
    case '--timeout':
      opts.timeout = Number(next());
      break;
    default:
      usage(`unknown option ${args[i]}`);
  }
}
if (!opts.url) usage('--url is required');

function usage(message) {
  console.error(`ws-probe: ${message}`);
  process.exit(2);
}

function cookieHeader(file) {
  if (!file) return null;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const pairs = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('='));
  return pairs.length ? pairs.join('; ') : null;
}

const headers = {};
const cookie = cookieHeader(opts.jar);
if (cookie) headers.Cookie = cookie;
if (opts.origin) headers.Origin = opts.origin;

const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

// The board as this client holds it: order → card state.
const board = {};
const heads = {};
const MOVES = {
  OrderPaid: 'confirmed',
  OrderProductionStarted: 'in_production',
  OrderReady: 'ready',
  OrderOutForDelivery: 'out_for_delivery',
};
const LEAVES = new Set(['OrderPickedUp', 'OrderDelivered', 'OrderExpired', 'OrderCancelled']);

function fold(env) {
  const order = String(env.stream ?? '')
    .split(':')
    .pop();
  if (!order || (heads[order] !== undefined && env.seq <= heads[order])) return;
  heads[order] = env.seq;
  if (env.type === 'OrderPlaced') board[order] = 'pending';
  else if (board[order] === undefined) return;
  else if (LEAVES.has(env.type)) delete board[order];
  else if (MOVES[env.type]) board[order] = MOVES[env.type];
}

let opened = false;
let closed = null;
let finished = false;
let evts = 0;
const pending = [...opts.cmds];
let awaiting = null;

const ws = new WebSocket(opts.url, { headers });

function finish(code) {
  if (finished) return;
  finished = true;
  if (closed) print({ closed });
  print({ board });
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    try {
      ws.close(1000, 'probe done');
    } catch {
      // closing a socket that never opened
    }
  }
  // Let the close frame go out before the process ends.
  setTimeout(() => process.exit(code), 100);
}

function sendNextCmd() {
  const cmd = pending.shift();
  if (!cmd) {
    awaiting = null;
    for (const raw of opts.raws) ws.send(raw);
    if (opts.flood > 0) {
      const frame = JSON.stringify({ t: 'cmd', v: 1, id: '', order: '', action: 'mark_ready' });
      for (let n = 0; n < opts.flood; n++) ws.send(frame);
    }
    return;
  }
  awaiting = cmd.id;
  ws.send(JSON.stringify({ t: 'cmd', v: 1, ...cmd }));
}

ws.onopen = () => {
  opened = true;
};
ws.onmessage = (message) => {
  if (typeof message.data !== 'string') return;
  let frame;
  try {
    frame = JSON.parse(message.data);
  } catch {
    print({ at: Date.now(), unreadable: message.data.length });
    return;
  }
  print({ at: Date.now(), frame });
  switch (frame.t) {
    case 'snapshot':
      for (const key of Object.keys(board)) delete board[key];
      for (const card of frame.board?.cards ?? []) {
        board[card.order] = card.state;
        heads[card.order] = card.updated_seq;
      }
      if (opts.delay > 0) setTimeout(sendNextCmd, opts.delay * 1000);
      else sendNextCmd();
      break;
    case 'evt':
      fold(frame.env);
      if (
        opts.waitEvt &&
        frame.env?.type === opts.waitEvt.type &&
        (!opts.evtOrder || String(frame.env?.stream ?? '').endsWith(`:${opts.evtOrder}`))
      ) {
        evts += 1;
        if (evts >= opts.waitEvt.n) finish(0);
      }
      break;
    case 'ack':
    case 'nack':
      if (frame.id === awaiting) sendNextCmd();
      break;
    case 'bye':
      // The close frame follows; wait for it so its code is printed.
      break;
  }
  if (opts.until && frame.t === opts.until) finish(0);
};
ws.onerror = () => undefined;
ws.onclose = (event) => {
  closed = { code: event.code, reason: event.reason };
  finish(opened ? 0 : 4);
};

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => finish(0));
if (opts.hold !== null) {
  if (opts.hold > 0) setTimeout(() => finish(0), opts.hold * 1000);
} else {
  setTimeout(() => finish(3), opts.timeout * 1000);
}
