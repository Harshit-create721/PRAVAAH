import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { createRelayServer } from './server.js';

// The real client (web/app.js) assigns `ws.onmessage` synchronously right
// after `new WebSocket(...)`, before any 'open' handshake completes - so its
// 'message' handler is wired up before the server can possibly have sent
// anything. `subscribe()` mirrors that: it attaches a single 'message'
// listener at construction time, which either satisfies whichever
// `nextMessage()` call is currently waiting for that message's type, or
// (if nothing is waiting yet) buffers it, so a snapshot replayed
// synchronously during the WS handshake is never missed regardless of when a
// test later comes looking for it.
function subscribe(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    const i = waiters.findIndex((w) => !w.type || w.type === msg.type);
    if (i === -1) { messages.push(msg); return; }
    const [waiter] = waiters.splice(i, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(msg);
  });
  return { ws, messages, waiters };
}

// Wait for the next message of a given type: served from the buffer if one
// already arrived, otherwise from the next matching 'message' event - with a
// timeout so a hang fails loudly instead of stalling the whole suite.
function nextMessage({ messages, waiters }, type, timeoutMs = 2000) {
  const bufferedIndex = messages.findIndex((msg) => !type || msg.type === type);
  if (bufferedIndex !== -1) return Promise.resolve(messages.splice(bufferedIndex, 1)[0]);

  return new Promise((resolve, reject) => {
    const waiter = {
      type,
      resolve,
      timer: setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i !== -1) waiters.splice(i, 1);
        reject(new Error(`timed out waiting for "${type}"`));
      }, timeoutMs),
    };
    waiters.push(waiter);
  });
}

async function startRelay(options = {}) {
  const relay = createRelayServer(options);
  const port = await relay.listen(0);
  return { relay, port, url: `ws://127.0.0.1:${port}`, http: `http://127.0.0.1:${port}` };
}

// Poll the buffered messages for one matching an arbitrary predicate. The
// type-keyed `nextMessage` cannot express "a snapshot whose stale flag is true".
async function waitForMessage(sub, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const i = sub.messages.findIndex(predicate);
    if (i !== -1) return sub.messages.splice(i, 1)[0];
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out waiting for a matching message');
}

// A hand-rolled WebSocket handshake over a raw TCP socket.
//
// `ws` is a well-behaved client: it will not send an unmasked frame and it will
// not emit a request target that WHATWG URL rejects. Both are exactly what an
// attacker sends, so testing those paths means writing the bytes by hand.
function rawUpgrade(port, target, extraHeaders = '') {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let buf = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ socket, response: buf });
    };
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('raw upgrade timed out')); });
    socket.on('error', () => finish());   // a destroyed upgrade is a valid outcome
    socket.on('close', () => finish());
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      if (buf.includes('\r\n\r\n')) finish();
    });
    socket.on('connect', () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n` +
        'Sec-WebSocket-Version: 13\r\n' +
        extraHeaders +
        '\r\n'
      );
    });
  });
}

// Same idea for a plain request: Node's HTTP parser accepts request targets
// that `new URL()` throws on, and `fetch` will not produce one.
function rawRequest(port, target) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let buf = '';
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('raw request timed out')); });
    socket.on('error', () => resolve(buf));
    socket.on('close', () => resolve(buf));
    socket.on('data', (chunk) => { buf += chunk.toString('latin1'); });
    socket.on('connect', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
  });
}

// Liveness is the assertion in every crash regression below: not "the right
// error came back" but "the process is still answering afterwards".
async function stillServing(http) {
  const body = await (await fetch(`${http}/health`)).json();
  return body.ok === true;
}

test('publisher snapshot reaches a subscriber over real sockets', async (t) => {
  const { relay, port, url } = await startRelay();
  t.after(() => relay.close());

  const pub = new WebSocket(`${url}/publish`);
  await once(pub, 'open');
  const sub = subscribe(`${url}/subscribe`);
  await once(sub.ws, 'open');

  pub.send(JSON.stringify({ type: 'snapshot', conveyors: [{ id: 'CV-01', risk: 'healthy' }] }));

  const snap = await nextMessage(sub, 'snapshot');
  assert.equal(snap.conveyors[0].id, 'CV-01');
  assert.equal(snap.stale, false);
  assert.equal(typeof snap.serverTs, 'number');
  assert.ok(port > 0);

  pub.close(); sub.ws.close();
});

test('a late subscriber is replayed the cached snapshot', async (t) => {
  const { relay, url } = await startRelay();
  t.after(() => relay.close());

  const pub = new WebSocket(`${url}/publish`);
  await once(pub, 'open');
  pub.send(JSON.stringify({ type: 'snapshot', conveyors: [{ id: 'CV-01' }] }));
  await new Promise((r) => setTimeout(r, 50));

  const sub = subscribe(`${url}/subscribe`);
  await once(sub.ws, 'open');
  const snap = await nextMessage(sub, 'snapshot');
  assert.equal(snap.conveyors[0].id, 'CV-01');

  pub.close(); sub.ws.close();
});

test('subscribers are told when the gateway disconnects', async (t) => {
  const { relay, url } = await startRelay();
  t.after(() => relay.close());

  const pub = new WebSocket(`${url}/publish`);
  await once(pub, 'open');
  const sub = subscribe(`${url}/subscribe`);
  await once(sub.ws, 'open');
  await nextMessage(sub, 'gatewayState');

  pub.close();
  const state = await nextMessage(sub, 'gatewayState');
  assert.equal(state.online, false);

  sub.ws.close();
});

test('publish requires the secret when one is configured', async (t) => {
  const { relay, url } = await startRelay({ publishSecret: 's3cret' });
  t.after(() => relay.close());

  const bad = new WebSocket(`${url}/publish`);
  // ws emits 'error' before 'close' on a destroyed socket, and an unhandled
  // 'error' on an EventEmitter throws. Without this the test fails for the
  // wrong reason instead of asserting the rejection.
  bad.on('error', () => {});
  const [code] = await once(bad, 'close');
  assert.equal(code >= 4000 || code === 1006, true, 'unauthenticated publisher must be rejected');

  const good = new WebSocket(`${url}/publish?token=s3cret`);
  await once(good, 'open');
  good.close();
});

test('health endpoint reports liveness and subscriber count', async (t) => {
  const { relay, url, http } = await startRelay();
  t.after(() => relay.close());

  const sub = subscribe(`${url}/subscribe`);
  await once(sub.ws, 'open');
  await new Promise((r) => setTimeout(r, 30));

  const body = await (await fetch(`${http}/health`)).json();
  assert.equal(body.ok, true);
  assert.equal(body.gatewayOnline, false);
  assert.equal(body.subscribers, 1);

  sub.ws.close();
});

test('GET /state returns 503 before any snapshot, then the snapshot', async (t) => {
  const { relay, url, http } = await startRelay();
  t.after(() => relay.close());

  assert.equal((await fetch(`${http}/state`)).status, 503);

  const pub = new WebSocket(`${url}/publish`);
  await once(pub, 'open');
  pub.send(JSON.stringify({ type: 'snapshot', conveyors: [{ id: 'CV-01' }] }));
  await new Promise((r) => setTimeout(r, 50));

  const res = await fetch(`${http}/state`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).conveyors[0].id, 'CV-01');

  pub.close();
});

test('an unknown path is refused rather than upgraded', async (t) => {
  const { relay, url } = await startRelay();
  t.after(() => relay.close());

  const ws = new WebSocket(`${url}/nope`);
  ws.on('error', () => {});   // same reason as the rejected-publisher test above
  const [code] = await once(ws, 'close');
  assert.ok(code, 'unknown upgrade paths must not become subscribers');
});

test('listen defaults to loopback (127.0.0.1) for safety', async (t) => {
  const relay = createRelayServer();
  await relay.listen(0);
  t.after(() => relay.close());

  const addr = relay.server.address();
  assert.equal(addr.address, '127.0.0.1', 'default bind must be loopback only');
});

test('listen accepts a host override', async (t) => {
  const relay = createRelayServer();
  await relay.listen(0, '0.0.0.0');
  t.after(() => relay.close());

  const addr = relay.server.address();
  assert.equal(addr.address, '0.0.0.0', 'host parameter must be respected');
});


// ------------------------------------------------- crash regressions
//
// Everything below is about ONE property: an anonymous, unauthenticated client
// on a public endpoint must not be able to stop the relay answering. The
// assertion is always "is it still serving afterwards", never "did it return a
// tidy error".

test('a rejected upgrade cannot kill the relay with a malformed frame', async (t) => {
  const { relay, port, http } = await startRelay();
  t.after(() => relay.close());

  // The relay finishes the opening handshake and then closes with a code, so
  // between the 101 and the close this is a live WebSocket we can write to.
  const { socket, response } = await rawUpgrade(port, '/nope');
  assert.match(response, /HTTP\/1\.1 101/, 'the rejection path completes the handshake first');

  // A client->server frame MUST be masked. This one is not, so ws's Receiver
  // rejects it and emits 'error' on the WebSocket. `rejectUpgrade` used to
  // attach no 'error' listener, and an EventEmitter with no 'error' listener
  // THROWS - killing the whole relay with five bytes from an anonymous client.
  socket.write(Buffer.from([0x81, 0x03, 0x61, 0x62, 0x63]));
  await new Promise((r) => setTimeout(r, 200));
  socket.destroy();

  assert.equal(await stillServing(http), true,
    'the relay must still be serving after a rejected client sends garbage');
});

test('a publisher rejected for a bad token cannot kill the relay either', async (t) => {
  const { relay, port, http } = await startRelay({ publishSecret: 's3cret' });
  t.after(() => relay.close());

  const { socket } = await rawUpgrade(port, '/publish?token=wrong');
  socket.write(Buffer.from([0x81, 0x03, 0x61, 0x62, 0x63]));
  await new Promise((r) => setTimeout(r, 200));
  socket.destroy();

  assert.equal(await stillServing(http), true);
});

test('a request target the URL parser rejects gets a 400, not a crash', async (t) => {
  const { relay, port, http } = await startRelay();
  t.after(() => relay.close());

  // Node's HTTP parser accepts all of these; `new URL(target, base)` throws on
  // every one of them.
  for (const target of ['//[', '//user:pass@[bad', '//:99999/x']) {
    const response = await rawRequest(port, target);
    assert.match(response, /HTTP\/1\.1 400/, `"${target}" must be refused, not thrown on`);
    assert.equal(await stillServing(http), true, `the relay must survive "${target}"`);
  }
});

test('an upgrade with an unparseable target is destroyed, not thrown on', async (t) => {
  const { relay, port, http } = await startRelay();
  t.after(() => relay.close());

  for (const target of ['//[', '//user:pass@[bad', '//:99999/x']) {
    const { socket, response } = await rawUpgrade(port, target);
    assert.doesNotMatch(response, /101/, `"${target}" must never be upgraded`);
    socket.destroy();
    assert.equal(await stillServing(http), true, `the relay must survive an upgrade to "${target}"`);
  }
});

// --------------------------------------------------------------- heartbeat
//
// The dangerous failure is not an error message, it is frozen numbers that look
// live. A laptop that drops off without a FIN never produces a 'close', so
// without a heartbeat the relay keeps saying the gateway is online and an
// ALREADY-connected subscriber's last message stays `stale:false` forever.

test('an already-connected subscriber is told when the gateway goes stale', async (t) => {
  const { relay, url } = await startRelay({ staleAfterMs: 40, heartbeatMs: 25 });
  t.after(() => relay.close());

  const pub = new WebSocket(`${url}/publish`);
  await once(pub, 'open');
  const sub = subscribe(`${url}/subscribe`);
  await once(sub.ws, 'open');

  pub.send(JSON.stringify({ type: 'snapshot', conveyors: [{ id: 'CV-01' }] }));
  const fresh = await waitForMessage(sub, (m) => m.type === 'snapshot');
  assert.equal(fresh.stale, false);

  // The publisher's socket stays open and answers pings (ws does that for us),
  // but it stops publishing - which is precisely the half-open gateway.
  const stale = await waitForMessage(sub, (m) => m.type === 'snapshot' && m.stale === true);
  assert.equal(stale.stale, true,
    'a subscriber that connected while things were healthy must be told they no longer are');
  assert.equal(stale.conveyors[0].id, 'CV-01', 'the last known values still travel, flagged as stale');

  pub.close(); sub.ws.close();
});

test('a socket that never answers a ping is reaped', async (t) => {
  const { relay, port, http } = await startRelay({ heartbeatMs: 25 });
  t.after(() => relay.close());

  // A raw TCP socket completes the handshake but has no WebSocket
  // implementation behind it, so it never sends a pong. Left alone, these
  // accumulate without bound in a 128 MB container on a public endpoint.
  const { socket, response } = await rawUpgrade(port, '/subscribe');
  assert.match(response, /HTTP\/1\.1 101/);
  socket.on('data', () => { /* discard the pings */ });

  assert.equal((await (await fetch(`${http}/health`)).json()).subscribers, 1);

  const deadline = Date.now() + 3000;
  let subscribers = 1;
  while (Date.now() < deadline && subscribers !== 0) {
    await new Promise((r) => setTimeout(r, 25));
    subscribers = (await (await fetch(`${http}/health`)).json()).subscribers;
  }
  assert.equal(subscribers, 0, 'a socket that never pongs must be terminated, not accumulated');

  socket.destroy();
});

// ---------------------------------------------------------------- resource caps

test('an oversized subscriber frame closes that socket rather than the container', async (t) => {
  const { relay, url, http } = await startRelay();
  t.after(() => relay.close());

  const sub = new WebSocket(`${url}/subscribe`);
  await once(sub, 'open');
  sub.on('error', () => {});

  // ws defaults to a 100 MiB frame limit. Against a 128 MB hard mem_limit with
  // no swap that is a single-frame OOM kill of a box hosting five other
  // production services.
  sub.send('x'.repeat(256 * 1024));
  const [code] = await once(sub, 'close');
  assert.equal(code, 1009, 'the frame must be refused as too big');
  assert.equal(await stillServing(http), true);
});

test('subscribers are capped, and the cap is refused with a code', async (t) => {
  const { relay, url } = await startRelay({ maxSubscribers: 2 });
  t.after(() => relay.close());

  const a = new WebSocket(`${url}/subscribe`);
  await once(a, 'open');
  const b = new WebSocket(`${url}/subscribe`);
  await once(b, 'open');

  const c = new WebSocket(`${url}/subscribe`);
  c.on('error', () => {});
  const [code] = await once(c, 'close');
  assert.equal(code, 4009, 'the relay must refuse rather than grow without bound');

  a.close(); b.close();
});

// -------------------------------------------------------------- credentials
//
// A token in a query string is logged verbatim by every proxy in the path.

test('the publish secret is accepted from an Authorization header', async (t) => {
  const { relay, url } = await startRelay({ publishSecret: 's3cret' });
  t.after(() => relay.close());

  const good = new WebSocket(`${url}/publish`, { headers: { authorization: 'Bearer s3cret' } });
  await once(good, 'open');
  good.close();

  const bad = new WebSocket(`${url}/publish`, { headers: { authorization: 'Bearer nope' } });
  bad.on('error', () => {});
  const [code] = await once(bad, 'close');
  assert.equal(code >= 4000 || code === 1006, true, 'a wrong header must be refused too');
});

test('the write token is accepted from an Authorization header', async (t) => {
  const { relay, url } = await startRelay({ writeToken: 'w0rk' });
  t.after(() => relay.close());

  const pub = new WebSocket(`${url}/publish`);
  await once(pub, 'open');

  const withHeader = new WebSocket(`${url}/subscribe`, { headers: { authorization: 'Bearer w0rk' } });
  await once(withHeader, 'open');

  const results = [];
  withHeader.on('message', (d) => results.push(JSON.parse(d.toString())));
  withHeader.send(JSON.stringify({ type: 'command', id: 'h1', action: 'ack', payload: { alarmId: 1 } }));

  const forwarded = await once(pub, 'message');
  const cmd = JSON.parse(forwarded[0].toString());
  assert.equal(cmd.action, 'ack', 'a header-authenticated write must reach the gateway');
  assert.equal(results.some((m) => m.type === 'commandResult' && /unauthor/i.test(m.error ?? '')), false);

  withHeader.close(); pub.close();
});

test('a subscriber with no credential still reads, but cannot write', async (t) => {
  const { relay, url } = await startRelay({ writeToken: 'w0rk' });
  t.after(() => relay.close());

  const pub = new WebSocket(`${url}/publish`);
  await once(pub, 'open');
  const sub = subscribe(`${url}/subscribe`);
  await once(sub.ws, 'open');

  // Reads are unauthenticated BY DESIGN.
  pub.send(JSON.stringify({ type: 'snapshot', conveyors: [{ id: 'CV-01' }] }));
  const snap = await nextMessage(sub, 'snapshot');
  assert.equal(snap.conveyors[0].id, 'CV-01');

  sub.ws.send(JSON.stringify({ type: 'command', id: 'w1', action: 'close', payload: { alarmId: 1 } }));
  const denied = await nextMessage(sub, 'commandResult');
  assert.equal(denied.ok, false);
  assert.match(denied.error, /unauthor/i);

  pub.close(); sub.ws.close();
});
