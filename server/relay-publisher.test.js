import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { createRelayPublisher, droppableUnderBackpressure, SLOW_SOCKET_BYTES } from './relay-publisher.js';

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


// ------------------------------------------------------- structural isolation
//
// The local dashboard working with no internet at all is the property the whole
// product rests on. Nothing in the relay client may ever be able to stop the
// gateway from booting.

test('a malformed relay URL schedules a retry instead of throwing', () => {
  const scheduled = [];
  const logged = [];
  const pub = createRelayPublisher({
    url: 'not a url at all',
    onCommand: async () => ({}),
    log: (line) => logged.push(line),
    // Record the retry rather than arming it: a real timer here would spin
    // forever against a URL that can never parse.
    scheduleFn: (fn, delay) => { scheduled.push({ fn, delay }); return null; },
  });

  // `new WebSocket(url)` throws SYNCHRONOUSLY on this. Unguarded it runs at
  // gateway boot, so one bad config value would mean the plant never gets its
  // display.
  assert.doesNotThrow(() => pub.start());
  assert.equal(pub.connected, false);
  assert.equal(scheduled.length, 1, 'a failed dial must schedule a retry, not give up or crash');
  assert.ok(scheduled[0].delay > 0);
  assert.equal(logged.some((l) => /cannot connect/.test(l)), true, 'the operator must be told why');
});

test('a malformed URL retried from the timer also stays contained', () => {
  const scheduled = [];
  const pub = createRelayPublisher({
    url: 'ws://[',
    onCommand: async () => ({}),
    log: () => {},
    scheduleFn: (fn, delay) => { scheduled.push({ fn, delay }); return null; },
  });
  pub.start();
  assert.equal(scheduled.length, 1);

  // Driving the retry by hand is the second entry point into connect().
  assert.doesNotThrow(() => scheduled[0].fn());
  assert.equal(scheduled.length, 2, 'the retry must keep retrying, with backoff');
  assert.ok(scheduled[1].delay > scheduled[0].delay);
});

// ------------------------------------------------------------- backpressure
//
// The relay already refuses to buffer snapshots for a slow subscriber. The
// gateway had no equivalent guard, so a stalled-but-open relay socket
// accumulated one snapshot every 2 s in the laptop's heap, without bound.

test('snapshots are dropped under backpressure but alarms and results are not', () => {
  const stalled = SLOW_SOCKET_BYTES + 1;

  assert.equal(droppableUnderBackpressure({ type: 'snapshot' }, stalled), true,
    'a superseded snapshot costs nothing to drop');
  assert.equal(droppableUnderBackpressure({ type: 'snapshot' }, 0), false,
    'a healthy socket must still get its snapshots');

  assert.equal(droppableUnderBackpressure({ type: 'alarm', alarm: { id: 1 } }, stalled), false,
    'an alarm is discrete: losing one is the failure this system exists to prevent');
  assert.equal(droppableUnderBackpressure({ type: 'commandResult', id: 'x' }, stalled), false,
    'dropping a result strands the caller waiting on it');
});

test('a healthy socket still publishes with the guard in place', async (t) => {
  const relay = await fakeRelay();

  const pub = createRelayPublisher({ url: relay.url, onCommand: async () => ({}), log: silent });
  pub.start();
  t.after(() => pub.stop());
  t.after(() => relay.close());

  for (let i = 0; i < 100 && !pub.connected; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(pub.send({ type: 'snapshot', conveyors: [{ id: 'CV-01' }] }), true);
  await relay.waitFor((m) => m.type === 'snapshot');
});
