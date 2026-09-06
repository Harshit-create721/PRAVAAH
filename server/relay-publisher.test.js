import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { createRelayPublisher } from './relay-publisher.js';

// A stand-in relay: accepts one publisher and records what it receives.
async function fakeRelay() {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/publish' });
  const received = [];
  let current = null;
  let closeCount = 0;
  wss.on('connection', (ws) => {
    current = ws;
    ws.on('message', (d) => received.push(JSON.parse(d.toString())));
    ws.on('close', () => { closeCount++; });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `ws://127.0.0.1:${server.address().port}/publish`,
    received,
    send: (msg) => current?.send(JSON.stringify(msg)),
    dropConnection: () => current?.close(),
    get closeCount() { return closeCount; },
    waitFor: async (predicate, timeoutMs = 2000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = received.find(predicate);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('timed out waiting for message');
    },
    // Mirrors waitFor's polling style, for the one test that verifies stop()
    // actually closes the underlying socket rather than just flipping a flag.
    waitForClose: async (timeoutMs = 2000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (closeCount > 0) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('timed out waiting for socket close');
    },
    close: () => new Promise((r) => { wss.close(() => server.close(r)); }),
  };
}

const silent = () => {};

test('publishes snapshots once connected', async (t) => {
  const relay = await fakeRelay();

  const pub = createRelayPublisher({ url: relay.url, onCommand: async () => ({}), log: silent });
  pub.start();
  // Registered before relay.close(): the publisher must stop (and close its
  // socket) before the relay tries to close, or relay.close() would deadlock
  // waiting for a client that never disconnects (t.after hooks run
  // sequentially in registration order - see the fix report for the
  // full trace of the deadlock this ordering avoids).
  t.after(() => pub.stop());
  t.after(() => relay.close());

  // Poll the connection flag rather than waiting on a message the publisher
  // never sends on connect - that would burn the full waitFor timeout.
  for (let i = 0; i < 100 && !pub.connected; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(pub.connected, true);

  pub.send({ type: 'snapshot', conveyors: [{ id: 'CV-01' }] });

  const msg = await relay.waitFor((m) => m.type === 'snapshot');
  assert.equal(msg.conveyors[0].id, 'CV-01');
});

test('send before connection is a no-op, not a crash', () => {
  const pub = createRelayPublisher({ url: 'ws://127.0.0.1:1/publish', onCommand: async () => ({}), log: silent });
  assert.doesNotThrow(() => pub.send({ type: 'snapshot' }));
  assert.equal(pub.connected, false);
});

test('executes a command and returns its result', async (t) => {
  const relay = await fakeRelay();

  const seen = [];
  const pub = createRelayPublisher({
    url: relay.url, log: silent,
    onCommand: async ({ action, payload }) => { seen.push({ action, payload }); return { acked: true }; },
  });
  pub.start();
  t.after(() => pub.stop());
  t.after(() => relay.close());

  await new Promise((r) => setTimeout(r, 100));
  relay.send({ type: 'command', id: 'x1', action: 'ack', payload: { alarmId: 5 } });

  const result = await relay.waitFor((m) => m.type === 'commandResult');
  assert.equal(result.id, 'x1');
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, { acked: true });
  assert.deepEqual(seen[0], { action: 'ack', payload: { alarmId: 5 } });
});

test('a throwing command handler produces ok:false, not a crash', async (t) => {
  const relay = await fakeRelay();

  const pub = createRelayPublisher({
    url: relay.url, log: silent,
    onCommand: async () => { throw new Error('no such alarm'); },
  });
  pub.start();
  t.after(() => pub.stop());
  t.after(() => relay.close());

  await new Promise((r) => setTimeout(r, 100));
  relay.send({ type: 'command', id: 'x2', action: 'close', payload: {} });

  const result = await relay.waitFor((m) => m.type === 'commandResult');
  assert.equal(result.ok, false);
  assert.match(result.error, /no such alarm/);
});

test('reconnects after the relay drops the connection', async (t) => {
  const relay = await fakeRelay();

  const pub = createRelayPublisher({
    url: relay.url, onCommand: async () => ({}), log: silent,
    // Collapse backoff so the test does not sit through real delays.
    scheduleFn: (fn) => setTimeout(fn, 10),
  });
  pub.start();
  t.after(() => pub.stop());
  t.after(() => relay.close());

  await new Promise((r) => setTimeout(r, 100));
  assert.equal(pub.connected, true);

  relay.dropConnection();
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(pub.connected, true, 'must dial back out on its own');
  pub.send({ type: 'snapshot', conveyors: [] });
  await relay.waitFor((m) => m.type === 'snapshot');
});

test('stop() prevents further reconnection', async (t) => {
  const relay = await fakeRelay();
  t.after(() => relay.close());

  const pub = createRelayPublisher({
    url: relay.url, onCommand: async () => ({}), log: silent,
    scheduleFn: (fn) => setTimeout(fn, 10),
  });
  pub.start();
  await new Promise((r) => setTimeout(r, 100));

  pub.stop();
  // Verify stop() actually closes the underlying socket, not just that it
  // flips the `connected` flag - a stop() that merely nulled out its local
  // reference (leaving the real socket open) would previously go
  // undetected here and could deadlock relay.close() in the tests above.
  await relay.waitForClose();
  assert.ok(relay.closeCount >= 1, 'stop() must close the underlying socket');

  relay.dropConnection();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(pub.connected, false, 'a stopped publisher must stay stopped');
});
