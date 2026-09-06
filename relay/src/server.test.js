import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
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
