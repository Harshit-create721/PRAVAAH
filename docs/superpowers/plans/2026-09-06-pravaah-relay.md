# PRAVAAH Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put live conveyor state on the public internet at `https://api.sih.shubhang.dev`, fed by an outbound connection from the gateway laptop, so a phone app (Plan 2) can read it from anywhere.

**Architecture:** A small Node WebSocket relay runs in Docker on an existing DigitalOcean droplet behind Caddy. The gateway laptop dials **out** to the relay's `/publish` endpoint and mirrors the snapshots and alarm events it already broadcasts locally; clients connect to `/subscribe`. The relay caches only the latest snapshot in memory and routes commands (`history`, `ack`, `close`) back down to the gateway, correlated by id. Nothing is persisted on the droplet.

**Tech Stack:** Node 22 (ESM), `ws`, `node:test` + `node:assert/strict`, Docker, Caddy.

**Spec:** `docs/superpowers/specs/2026-09-06-pravaah-mobile-app-design.md`

## Global Constraints

- Node `>=22.5` — matches the existing `package.json` `engines` field.
- ESM only (`"type": "module"`). The repo has no CommonJS.
- Tests use `node:test` and `node:assert/strict`, co-located as `*.test.js` beside the source, following `tools/record-session.test.js`.
- The relay's only runtime dependency is `ws`. No framework.
- Relay binds `127.0.0.1:3040` on the droplet. Verified free: 3001, 3002, 3010, 3020, 3030 and 2019 are taken.
- Container memory limit **128 MB**. The droplet has ~284 MB available and five production services on it.
- Caddy config is added as a **new fragment** at `/etc/caddy/sites/sih-api.caddy`. Never edit an existing site file.
- **Always `caddy validate` before `systemctl reload caddy`.** Five production sites share this proxy.
- Droplet: `root@206.189.135.109`, key auth already working.
- `api.sih.shubhang.dev` A record already points at the droplet.
- Reads are unauthenticated by design. Writes are gated by `RELAY_WRITE_TOKEN`; when the variable is unset, writes are permitted.
- The relay must never present stale data as live. When the publisher is gone, `stale: true` and clients are told.

---

## File Structure

**New — relay service (`PRAVAAH/relay/`)**

| File | Responsibility |
|------|----------------|
| `relay/package.json` | Relay deps (`ws`) and `test` script. Separate from the gateway's. |
| `relay/src/state.js` | Latest-snapshot cache, staleness, message envelopes. Pure; clock injected. |
| `relay/src/state.test.js` | Unit tests for the above. |
| `relay/src/hub.js` | Publisher/subscriber registry, fan-out, command correlation. Pure; sockets are duck-typed `{send, close}`. |
| `relay/src/hub.test.js` | Unit tests with fake sockets. No network. |
| `relay/src/server.js` | Wires `hub` to real `ws` + `node:http`. `/health`, `/state`, `/publish`, `/subscribe`. |
| `relay/src/server.test.js` | Integration over a real server on an ephemeral port. |
| `relay/src/index.js` | Entrypoint. Reads env, starts the server. |
| `relay/Dockerfile` | Container image. |
| `relay/.dockerignore` | Keep the image small. |

**New — deployment (`PRAVAAH/deploy/`)**

| File | Responsibility |
|------|----------------|
| `deploy/sih-api.caddy` | Caddy fragment, copied to `/etc/caddy/sites/` on the droplet. |
| `deploy/docker-compose.yml` | Relay service definition with the memory cap. |
| `deploy/deploy-relay.sh` | Build, ship, restart, verify. Idempotent. |

**Modified — gateway**

| File | Change |
|------|--------|
| `server/relay-publisher.js` | **New.** Outbound client: connects to `/publish`, mirrors broadcasts, executes commands. |
| `server/relay-publisher.test.js` | **New.** Tests against a fake relay server. |
| `server/config.js` | Add a `relay` config block. |
| `server/index.js` | Instantiate the publisher; feed it the same messages `broadcast()` sends. |

The split between `state`, `hub` and `server` exists so the two files carrying real logic have no I/O in them and test in milliseconds. `server.js` is thin enough that its integration test is about wiring, not behaviour.

---

## Task 1: Relay state cache

**Files:**
- Create: `relay/package.json`
- Create: `relay/src/state.js`
- Test: `relay/src/state.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `class RelayState`, constructed as `new RelayState({ now, staleAfterMs })` where `now` is a `() => number` clock (injected so staleness is testable without waiting) and `staleAfterMs` defaults to `15000`. Methods: `setSnapshot(obj)`, `publisherConnected()`, `publisherDisconnected()`. Getters: `online: boolean`, `lastSeenTs: number|null`, `stale: boolean`. Message builders: `envelope(): object|null`, `gatewayStateMessage(): object`.

- [ ] **Step 1: Create the relay package manifest**

```json
{
  "name": "pravaah-relay",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.5" },
  "scripts": {
    "start": "node src/index.js",
    "test": "node --test src/*.test.js"
  },
  "dependencies": {
    "ws": "^8.18.0"
  }
}
```

Then run `cd relay && npm install`.

- [ ] **Step 2: Write the failing test**

Create `relay/src/state.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { RelayState } from './state.js';

// A controllable clock. Staleness is a function of time, and a test that
// depends on real elapsed time is a test that is slow and occasionally wrong.
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('envelope is null before any snapshot arrives', () => {
  const state = new RelayState({ now: fakeClock().now });
  assert.equal(state.envelope(), null);
});

test('envelope carries the snapshot, a server timestamp and stale=false', () => {
  const clock = fakeClock();
  const state = new RelayState({ now: clock.now });
  state.publisherConnected();
  state.setSnapshot({ type: 'snapshot', conveyors: [{ id: 'CV-01' }] });

  const env = state.envelope();
  assert.equal(env.type, 'snapshot');
  assert.equal(env.stale, false);
  assert.equal(env.serverTs, clock.now());
  assert.equal(env.conveyors[0].id, 'CV-01');
});

test('state is stale once the publisher disconnects, even with a fresh snapshot', () => {
  const clock = fakeClock();
  const state = new RelayState({ now: clock.now });
  state.publisherConnected();
  state.setSnapshot({ type: 'snapshot' });
  assert.equal(state.envelope().stale, false);

  state.publisherDisconnected();
  assert.equal(state.envelope().stale, true, 'a disconnected gateway must never look live');
});

test('state goes stale when the snapshot ages past the window', () => {
  const clock = fakeClock();
  const state = new RelayState({ now: clock.now, staleAfterMs: 15000 });
  state.publisherConnected();
  state.setSnapshot({ type: 'snapshot' });

  clock.advance(14_999);
  assert.equal(state.envelope().stale, false);
  clock.advance(2);
  assert.equal(state.envelope().stale, true);
});

test('gatewayStateMessage reports liveness and last-seen', () => {
  const clock = fakeClock();
  const state = new RelayState({ now: clock.now });
  assert.deepEqual(state.gatewayStateMessage(), {
    type: 'gatewayState', online: false, lastSeenTs: null, serverTs: clock.now(),
  });

  state.publisherConnected();
  state.setSnapshot({ type: 'snapshot' });
  const seenAt = clock.now();
  clock.advance(500);

  assert.deepEqual(state.gatewayStateMessage(), {
    type: 'gatewayState', online: true, lastSeenTs: seenAt, serverTs: clock.now(),
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `cd relay && npm test`
Expected: FAIL — `Cannot find module './state.js'`.

- [ ] **Step 4: Implement `state.js`**

Create `relay/src/state.js`:

```js
// The relay's entire memory: the most recent snapshot, and whether the gateway
// that produced it is still connected.
//
// Nothing here is persisted. If the relay restarts, the gateway reconnects and
// republishes a full snapshot, so durability would buy nothing.

const DEFAULT_STALE_AFTER_MS = 15_000;

export class RelayState {
  #snapshot = null;
  #receivedTs = null;
  #online = false;
  #now;
  #staleAfterMs;

  // `now` is injected so staleness can be tested without elapsed real time.
  constructor({ now = () => Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
    this.#now = now;
    this.#staleAfterMs = staleAfterMs;
  }

  setSnapshot(snapshot) {
    this.#snapshot = snapshot;
    this.#receivedTs = this.#now();
  }

  publisherConnected() { this.#online = true; }
  publisherDisconnected() { this.#online = false; }

  get online() { return this.#online; }
  get lastSeenTs() { return this.#receivedTs; }

  // Two independent ways to be stale: the gateway is gone, or it is nominally
  // connected but has not produced a snapshot recently (a half-open socket).
  get stale() {
    if (!this.#online || this.#receivedTs === null) return true;
    return this.#now() - this.#receivedTs > this.#staleAfterMs;
  }

  // `serverTs` on every outbound message is what lets a client correct for
  // clock skew: it has no other way to know what "now" means to us.
  envelope() {
    if (this.#snapshot === null) return null;
    return {
      ...this.#snapshot,
      type: 'snapshot',
      serverTs: this.#now(),
      stale: this.stale,
      lastSeenTs: this.#receivedTs,
    };
  }

  gatewayStateMessage() {
    return {
      type: 'gatewayState',
      online: this.#online,
      lastSeenTs: this.#receivedTs,
      serverTs: this.#now(),
    };
  }
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `cd relay && npm test`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add relay/package.json relay/package-lock.json relay/src/state.js relay/src/state.test.js
git commit -m "feat(relay): snapshot cache with injected clock and staleness"
```

---
## Task 2: Relay hub — fan-out and command routing

**Files:**
- Create: `relay/src/hub.js`
- Test: `relay/src/hub.test.js`

**Interfaces:**
- Consumes: `RelayState` from Task 1.
- Produces: `class Hub`, constructed as `new Hub({ state })`. Sockets are duck-typed as `{ send(text: string), close?(code, reason), bufferedAmount?: number }` — deliberately not `ws` instances, so this file needs no network to test. Methods: `attachPublisher(socket)`, `detachPublisher(socket): boolean`, `addSubscriber(socket)`, `removeSubscriber(socket)`, `handlePublisherMessage(raw: string)`, `handleSubscriberMessage(socket, raw: string, { canWrite: boolean })`. Getter: `subscriberCount: number`.

- [ ] **Step 1: Write the failing test**

Create `relay/src/hub.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { RelayState } from './state.js';
import { Hub } from './hub.js';

// A socket that records what was sent, so assertions read as "what did this
// client actually receive". No network involved.
function fakeSocket() {
  const sent = [];
  return {
    sent,
    bufferedAmount: 0,
    closed: null,
    send(text) { sent.push(JSON.parse(text)); },
    close(code, reason) { this.closed = { code, reason }; },
    messagesOfType(type) { return sent.filter((m) => m.type === type); },
    last() { return sent.at(-1); },
  };
}

function setup() {
  const state = new RelayState({ now: () => 1_000_000 });
  return { state, hub: new Hub({ state }) };
}

test('a new subscriber receives the cached snapshot immediately', () => {
  const { hub } = setup();
  const pub = fakeSocket();
  hub.attachPublisher(pub);
  hub.handlePublisherMessage(JSON.stringify({ type: 'snapshot', conveyors: [{ id: 'CV-01' }] }));

  const sub = fakeSocket();
  hub.addSubscriber(sub);

  const snap = sub.messagesOfType('snapshot');
  assert.equal(snap.length, 1, 'must not wait for the next broadcast');
  assert.equal(snap[0].conveyors[0].id, 'CV-01');
});

test('a subscriber joining before any snapshot gets gateway state but no snapshot', () => {
  const { hub } = setup();
  const sub = fakeSocket();
  hub.addSubscriber(sub);

  assert.equal(sub.messagesOfType('snapshot').length, 0);
  assert.equal(sub.messagesOfType('gatewayState').length, 1);
});

test('snapshots and alarms fan out to every subscriber', () => {
  const { hub } = setup();
  const pub = fakeSocket();
  hub.attachPublisher(pub);

  const a = fakeSocket(), b = fakeSocket();
  hub.addSubscriber(a);
  hub.addSubscriber(b);

  hub.handlePublisherMessage(JSON.stringify({ type: 'snapshot', conveyors: [] }));
  hub.handlePublisherMessage(JSON.stringify({ type: 'alarm', alarm: { id: 7, message: 'hot' } }));

  for (const sub of [a, b]) {
    assert.equal(sub.messagesOfType('snapshot').length, 1);
    assert.equal(sub.messagesOfType('alarm').length, 1);
    assert.equal(sub.messagesOfType('alarm')[0].alarm.id, 7);
  }
});

test('a second publisher displaces the first', () => {
  const { hub, state } = setup();
  const first = fakeSocket(), second = fakeSocket();
  hub.attachPublisher(first);
  hub.attachPublisher(second);

  assert.ok(first.closed, 'the stale publisher must be closed, not left half-open');
  assert.equal(state.online, true);
});

test('a displaced publisher closing does not mark the live one offline', () => {
  const { hub, state } = setup();
  const first = fakeSocket(), second = fakeSocket();
  hub.attachPublisher(first);
  hub.attachPublisher(second);

  // The old socket's close event arrives late. It must be ignored.
  const changed = hub.detachPublisher(first);
  assert.equal(changed, false);
  assert.equal(state.online, true, 'a dead socket must not take the live gateway down with it');
});

test('command routes to the publisher and the result returns only to its sender', () => {
  const { hub } = setup();
  const pub = fakeSocket();
  hub.attachPublisher(pub);

  const asker = fakeSocket(), bystander = fakeSocket();
  hub.addSubscriber(asker);
  hub.addSubscriber(bystander);

  hub.handleSubscriberMessage(asker, JSON.stringify({
    type: 'command', id: 'c1', action: 'ack', payload: { alarmId: 3 },
  }), { canWrite: true });

  const forwarded = pub.messagesOfType('command');
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].action, 'ack');

  hub.handlePublisherMessage(JSON.stringify({
    type: 'commandResult', id: 'c1', ok: true, result: { acked: true },
  }));

  assert.equal(asker.messagesOfType('commandResult').length, 1);
  assert.equal(bystander.messagesOfType('commandResult').length, 0,
    'a command result is private to the client that asked');
});

test('a command with no publisher attached fails explicitly', () => {
  const { hub } = setup();
  const sub = fakeSocket();
  hub.addSubscriber(sub);

  hub.handleSubscriberMessage(sub, JSON.stringify({
    type: 'command', id: 'c9', action: 'close', payload: {},
  }), { canWrite: true });

  const res = sub.messagesOfType('commandResult');
  assert.equal(res.length, 1);
  assert.equal(res[0].ok, false);
  assert.match(res[0].error, /gateway/i);
});

test('in-flight commands fail when the publisher disconnects', () => {
  const { hub } = setup();
  const pub = fakeSocket();
  hub.attachPublisher(pub);
  const sub = fakeSocket();
  hub.addSubscriber(sub);

  hub.handleSubscriberMessage(sub, JSON.stringify({
    type: 'command', id: 'c2', action: 'history', payload: { channel: 'temperature' },
  }), { canWrite: true });

  hub.detachPublisher(pub);

  const res = sub.messagesOfType('commandResult');
  assert.equal(res.length, 1);
  assert.equal(res[0].ok, false, 'a command must never hang forever waiting on a gone gateway');
});

test('writes are refused when the caller lacks the write token', () => {
  const { hub } = setup();
  const pub = fakeSocket();
  hub.attachPublisher(pub);
  const sub = fakeSocket();
  hub.addSubscriber(sub);

  hub.handleSubscriberMessage(sub, JSON.stringify({
    type: 'command', id: 'c3', action: 'close', payload: {},
  }), { canWrite: false });

  assert.equal(pub.messagesOfType('command').length, 0, 'must not reach the gateway');
  assert.equal(sub.last().ok, false);
  assert.match(sub.last().error, /unauthor/i);
});

test('history is readable without a write token', () => {
  const { hub } = setup();
  const pub = fakeSocket();
  hub.attachPublisher(pub);
  const sub = fakeSocket();
  hub.addSubscriber(sub);

  hub.handleSubscriberMessage(sub, JSON.stringify({
    type: 'command', id: 'c4', action: 'history', payload: { channel: 'temperature' },
  }), { canWrite: false });

  assert.equal(pub.messagesOfType('command').length, 1, 'reads stay open by design');
});

test('a slow subscriber loses superseded snapshots but never an alarm', () => {
  const { hub } = setup();
  const pub = fakeSocket();
  hub.attachPublisher(pub);

  const slow = fakeSocket();
  slow.bufferedAmount = 5_000_000; // far beyond the drop threshold
  hub.addSubscriber(slow);
  const before = slow.sent.length;

  hub.handlePublisherMessage(JSON.stringify({ type: 'snapshot', conveyors: [] }));
  assert.equal(slow.messagesOfType('snapshot').length, 0, 'stale snapshot should be dropped');

  hub.handlePublisherMessage(JSON.stringify({ type: 'alarm', alarm: { id: 1 } }));
  assert.equal(slow.messagesOfType('alarm').length, 1, 'alarms are never dropped');
  assert.ok(slow.sent.length > before);
});

test('malformed publisher input is ignored rather than thrown', () => {
  const { hub } = setup();
  const pub = fakeSocket();
  hub.attachPublisher(pub);
  const sub = fakeSocket();
  hub.addSubscriber(sub);
  const before = sub.sent.length;

  assert.doesNotThrow(() => hub.handlePublisherMessage('{not json'));
  assert.doesNotThrow(() => hub.handlePublisherMessage(JSON.stringify({ type: 'nonsense' })));
  assert.equal(sub.sent.length, before, 'garbage must not reach subscribers');
});

test('removing a subscriber drops its pending commands', () => {
  const { hub } = setup();
  const pub = fakeSocket();
  hub.attachPublisher(pub);
  const sub = fakeSocket();
  hub.addSubscriber(sub);

  hub.handleSubscriberMessage(sub, JSON.stringify({
    type: 'command', id: 'c5', action: 'ack', payload: {},
  }), { canWrite: true });
  hub.removeSubscriber(sub);

  assert.doesNotThrow(() => hub.handlePublisherMessage(JSON.stringify({
    type: 'commandResult', id: 'c5', ok: true,
  })), 'a result for a departed client must not crash the relay');
  assert.equal(hub.subscriberCount, 0);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd relay && npm test`
Expected: FAIL — `Cannot find module './hub.js'`.

- [ ] **Step 3: Implement `hub.js`**

Create `relay/src/hub.js`:

```js
// Publisher/subscriber registry, fan-out, and command correlation.
//
// Sockets here are duck-typed as { send(text), close?(code, reason),
// bufferedAmount? }. That is deliberate: none of the logic in this file needs
// a real network, so all of it tests in milliseconds without one.

// A subscriber this far behind is not going to catch up on a snapshot that is
// about to be superseded anyway. Alarms ignore this - they are rare, discrete,
// and losing one is the failure the whole system exists to prevent.
const SLOW_CLIENT_BYTES = 1_000_000;

export class Hub {
  #state;
  #publisher = null;
  #subscribers = new Set();
  #pending = new Map();   // command id -> subscriber socket

  constructor({ state }) {
    this.#state = state;
  }

  get subscriberCount() { return this.#subscribers.size; }

  // Newest publisher wins. A half-open socket left behind by a dropped mobile
  // connection must never lock the real gateway out.
  attachPublisher(socket) {
    const previous = this.#publisher;
    this.#publisher = socket;
    this.#state.publisherConnected();
    if (previous && previous !== socket) {
      try { previous.close?.(4000, 'replaced by newer publisher'); } catch { /* already gone */ }
    }
    this.#broadcast(this.#state.gatewayStateMessage());
    return previous;
  }

  // Returns true only if this socket was the live publisher. A late close event
  // from a displaced socket must not mark the current gateway offline.
  detachPublisher(socket) {
    if (this.#publisher !== socket) return false;
    this.#publisher = null;
    this.#state.publisherDisconnected();

    for (const [id, sub] of this.#pending) {
      this.#sendTo(sub, { type: 'commandResult', id, ok: false, error: 'gateway disconnected' });
    }
    this.#pending.clear();

    this.#broadcast(this.#state.gatewayStateMessage());
    return true;
  }

  addSubscriber(socket) {
    this.#subscribers.add(socket);
    const envelope = this.#state.envelope();
    if (envelope) this.#sendTo(socket, envelope);
    this.#sendTo(socket, this.#state.gatewayStateMessage());
  }

  removeSubscriber(socket) {
    this.#subscribers.delete(socket);
    for (const [id, sub] of this.#pending) {
      if (sub === socket) this.#pending.delete(id);
    }
  }

  handlePublisherMessage(raw) {
    const msg = parse(raw);
    if (!msg) return;

    if (msg.type === 'snapshot') {
      this.#state.setSnapshot(msg);
      const envelope = this.#state.envelope();
      if (envelope) this.#broadcast(envelope, { droppable: true });
      return;
    }

    if (msg.type === 'alarm') {
      this.#broadcast({ type: 'alarm', alarm: msg.alarm, serverTs: this.#state.gatewayStateMessage().serverTs });
      return;
    }

    if (msg.type === 'commandResult' && typeof msg.id === 'string') {
      const waiting = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (waiting) this.#sendTo(waiting, msg);
    }
  }

  handleSubscriberMessage(socket, raw, { canWrite }) {
    const msg = parse(raw);
    if (!msg || msg.type !== 'command' || typeof msg.id !== 'string') return;

    const isWrite = msg.action === 'ack' || msg.action === 'close';
    if (isWrite && !canWrite) {
      this.#sendTo(socket, { type: 'commandResult', id: msg.id, ok: false, error: 'unauthorized: write token required' });
      return;
    }

    if (!this.#publisher) {
      this.#sendTo(socket, { type: 'commandResult', id: msg.id, ok: false, error: 'gateway not connected' });
      return;
    }

    this.#pending.set(msg.id, socket);
    this.#sendTo(this.#publisher, { type: 'command', id: msg.id, action: msg.action, payload: msg.payload ?? {} });
  }

  #broadcast(message, { droppable = false } = {}) {
    for (const socket of this.#subscribers) {
      if (droppable && (socket.bufferedAmount ?? 0) > SLOW_CLIENT_BYTES) continue;
      this.#sendTo(socket, message);
    }
  }

  // A send that throws (socket closed between iteration and write) must not
  // abort the fan-out to everyone else.
  #sendTo(socket, message) {
    try { socket.send(JSON.stringify(message)); } catch { /* client is gone */ }
  }
}

function parse(raw) {
  try {
    const msg = JSON.parse(raw);
    return msg && typeof msg === 'object' ? msg : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd relay && npm test`
Expected: PASS — 18 tests total (5 from Task 1, 13 here).

- [ ] **Step 5: Commit**

```bash
git add relay/src/hub.js relay/src/hub.test.js
git commit -m "feat(relay): fan-out hub with command correlation and backpressure"
```

---
## Task 3: HTTP + WebSocket server

**Files:**
- Create: `relay/src/server.js`
- Create: `relay/src/index.js`
- Test: `relay/src/server.test.js`

**Interfaces:**
- Consumes: `RelayState` (Task 1), `Hub` (Task 2).
- Produces: `createRelayServer({ publishSecret, writeToken, staleAfterMs })` returning `{ server, hub, state, listen(port): Promise<number>, close(): Promise<void> }`. `listen(0)` resolves with the actual bound port, which is what lets tests run in parallel without fighting over a fixed one.

- [ ] **Step 1: Write the failing test**

Create `relay/src/server.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createRelayServer } from './server.js';

// Wait for the next parsed message of a given type, with a timeout so a hang
// fails loudly instead of stalling the whole suite.
function nextMessage(ws, type, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${type}"`)), timeoutMs);
    const onMessage = (data) => {
      const msg = JSON.parse(data.toString());
      if (type && msg.type !== type) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(msg);
    };
    ws.on('message', onMessage);
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
  const sub = new WebSocket(`${url}/subscribe`);
  await once(sub, 'open');

  pub.send(JSON.stringify({ type: 'snapshot', conveyors: [{ id: 'CV-01', risk: 'healthy' }] }));

  const snap = await nextMessage(sub, 'snapshot');
  assert.equal(snap.conveyors[0].id, 'CV-01');
  assert.equal(snap.stale, false);
  assert.equal(typeof snap.serverTs, 'number');
  assert.ok(port > 0);

  pub.close(); sub.close();
});

test('a late subscriber is replayed the cached snapshot', async (t) => {
  const { relay, url } = await startRelay();
  t.after(() => relay.close());

  const pub = new WebSocket(`${url}/publish`);
  await once(pub, 'open');
  pub.send(JSON.stringify({ type: 'snapshot', conveyors: [{ id: 'CV-01' }] }));
  await new Promise((r) => setTimeout(r, 50));

  const sub = new WebSocket(`${url}/subscribe`);
  await once(sub, 'open');
  const snap = await nextMessage(sub, 'snapshot');
  assert.equal(snap.conveyors[0].id, 'CV-01');

  pub.close(); sub.close();
});

test('subscribers are told when the gateway disconnects', async (t) => {
  const { relay, url } = await startRelay();
  t.after(() => relay.close());

  const pub = new WebSocket(`${url}/publish`);
  await once(pub, 'open');
  const sub = new WebSocket(`${url}/subscribe`);
  await once(sub, 'open');
  await nextMessage(sub, 'gatewayState');

  pub.close();
  const state = await nextMessage(sub, 'gatewayState');
  assert.equal(state.online, false);

  sub.close();
});

test('publish requires the secret when one is configured', async (t) => {
  const { relay, url } = await startRelay({ publishSecret: 's3cret' });
  t.after(() => relay.close());

  const bad = new WebSocket(`${url}/publish`);
  const [code] = await once(bad, 'close');
  assert.equal(code >= 4000 || code === 1006, true, 'unauthenticated publisher must be rejected');

  const good = new WebSocket(`${url}/publish?token=s3cret`);
  await once(good, 'open');
  good.close();
});

test('health endpoint reports liveness and subscriber count', async (t) => {
  const { relay, url, http } = await startRelay();
  t.after(() => relay.close());

  const sub = new WebSocket(`${url}/subscribe`);
  await once(sub, 'open');
  await new Promise((r) => setTimeout(r, 30));

  const body = await (await fetch(`${http}/health`)).json();
  assert.equal(body.ok, true);
  assert.equal(body.gatewayOnline, false);
  assert.equal(body.subscribers, 1);

  sub.close();
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
  const [code] = await once(ws, 'close');
  assert.ok(code, 'unknown upgrade paths must not become subscribers');
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd relay && npm test`
Expected: FAIL — `Cannot find module './server.js'`.

- [ ] **Step 3: Implement `server.js`**

Create `relay/src/server.js`:

```js
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { RelayState } from './state.js';
import { Hub } from './hub.js';

const json = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};

export function createRelayServer({ publishSecret = null, writeToken = null, staleAfterMs } = {}) {
  const state = new RelayState({ staleAfterMs });
  const hub = new Hub({ state });

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://relay.local');

    if (url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        gatewayOnline: state.online,
        stale: state.stale,
        lastSeenTs: state.lastSeenTs,
        subscribers: hub.subscriberCount,
      });
    }

    if (url.pathname === '/state') {
      const envelope = state.envelope();
      // 503 rather than an empty 200: "no gateway has ever published" is not a
      // successful read of an empty machine.
      if (!envelope) return json(res, 503, { error: 'no snapshot yet' });
      return json(res, 200, envelope);
    }

    return json(res, 404, { error: 'not found' });
  });

  // noServer + manual upgrade so the path decides the role, and anything
  // unrecognised is destroyed rather than silently becoming a subscriber.
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://relay.local');
    const token = url.searchParams.get('token');

    if (url.pathname === '/publish') {
      if (publishSecret && token !== publishSecret) {
        socket.destroy();
        return;
      }
      return wss.handleUpgrade(req, socket, head, (ws) => attachPublisher(ws));
    }

    if (url.pathname === '/subscribe') {
      // Reads are open by design. A write token is only consulted for
      // ack/close; when none is configured, writes are open too.
      const canWrite = !writeToken || token === writeToken;
      return wss.handleUpgrade(req, socket, head, (ws) => attachSubscriber(ws, canWrite));
    }

    socket.destroy();
  });

  function attachPublisher(ws) {
    hub.attachPublisher(ws);
    ws.on('message', (data) => hub.handlePublisherMessage(data.toString()));
    ws.on('close', () => hub.detachPublisher(ws));
    ws.on('error', () => hub.detachPublisher(ws));
  }

  function attachSubscriber(ws, canWrite) {
    hub.addSubscriber(ws);
    ws.on('message', (data) => hub.handleSubscriberMessage(ws, data.toString(), { canWrite }));
    ws.on('close', () => hub.removeSubscriber(ws));
    ws.on('error', () => hub.removeSubscriber(ws));
  }

  return {
    server,
    hub,
    state,
    listen(port) {
      return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => server.close(() => resolve()));
      });
    },
  };
}
```

- [ ] **Step 4: Implement `index.js`**

Create `relay/src/index.js`:

```js
import { createRelayServer } from './server.js';

const PORT = Number(process.env.PORT ?? 3040);
const relay = createRelayServer({
  publishSecret: process.env.RELAY_PUBLISH_SECRET || null,
  writeToken: process.env.RELAY_WRITE_TOKEN || null,
});

const port = await relay.listen(PORT);
console.log(`[relay] listening on 127.0.0.1:${port}`);
console.log(`[relay] publish secret ${process.env.RELAY_PUBLISH_SECRET ? 'set' : 'NOT set'}`);
console.log(`[relay] write token ${process.env.RELAY_WRITE_TOKEN ? 'set (writes gated)' : 'NOT set (writes open)'}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log('[relay] shutting down');
    await relay.close();
    process.exit(0);
  });
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `cd relay && npm test`
Expected: PASS — 25 tests total.

- [ ] **Step 6: Smoke-test it by hand**

```bash
cd relay && node src/index.js &
curl -s http://127.0.0.1:3040/health
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3040/state   # expect 503
kill %1
```

- [ ] **Step 7: Commit**

```bash
git add relay/src/server.js relay/src/server.test.js relay/src/index.js
git commit -m "feat(relay): http and websocket server with path-based roles"
```

---

## Task 4: Container image

**Files:**
- Create: `relay/Dockerfile`
- Create: `relay/.dockerignore`
- Create: `deploy/docker-compose.yml`

**Interfaces:**
- Consumes: the `relay/` package from Tasks 1-3.
- Produces: an image tagged `sih-relay:latest` and a compose service named `sih-relay` publishing `127.0.0.1:3040`.

- [ ] **Step 1: Write the Dockerfile**

Create `relay/Dockerfile`:

```dockerfile
# Alpine keeps this near 60 MB. The droplet runs five other services in under
# 1 GB total, so image and resident size both matter here.
FROM node:22-alpine

WORKDIR /app

# Copy manifests first so a source-only change reuses the dependency layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=3040
EXPOSE 3040

# Run unprivileged. The node image ships a `node` user for exactly this.
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3040/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
```

- [ ] **Step 2: Write `.dockerignore`**

Create `relay/.dockerignore`:

```
node_modules
npm-debug.log
src/*.test.js
Dockerfile
.dockerignore
```

- [ ] **Step 3: Write the compose file**

Create `deploy/docker-compose.yml`:

```yaml
# Deployed to /opt/sih-relay/docker-compose.yml on the droplet.
services:
  sih-relay:
    image: sih-relay:latest
    container_name: sih-relay
    restart: unless-stopped
    # Bound to loopback only. Caddy is the sole path in from the internet.
    ports:
      - "127.0.0.1:3040:3040"
    environment:
      PORT: "3040"
      RELAY_PUBLISH_SECRET: "${RELAY_PUBLISH_SECRET:-}"
      RELAY_WRITE_TOKEN: "${RELAY_WRITE_TOKEN:-}"
    # Hard cap. Five production services share this box; the relay must never
    # be the reason one of them gets OOM-killed.
    mem_limit: 128m
    memswap_limit: 128m
    logging:
      driver: json-file
      options: { max-size: "5m", max-file: "3" }
```

- [ ] **Step 4: Build and run locally to verify**

```bash
cd relay && docker build -t sih-relay:latest .
docker run --rm -d --name sih-relay-test -p 127.0.0.1:3041:3040 sih-relay:latest
sleep 2
curl -s http://127.0.0.1:3041/health   # expect {"ok":true,...}
docker stop sih-relay-test
```

Expected: `{"ok":true,"gatewayOnline":false,...}`. Confirm the image is under
120 MB with `docker images sih-relay:latest`.

- [ ] **Step 5: Commit**

```bash
git add relay/Dockerfile relay/.dockerignore deploy/docker-compose.yml
git commit -m "build(relay): alpine container image and compose service"
```

---
## Task 5: Gateway relay-publisher client

**Files:**
- Create: `server/relay-publisher.js`
- Test: `server/relay-publisher.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (it talks to the relay over the wire).
- Produces: `createRelayPublisher({ url, secret, onCommand, log, scheduleFn })` returning `{ start(), stop(), send(message), get connected }`. `onCommand` is `async ({ action, payload }) => result` and may throw; a throw becomes `{ ok: false, error }`. `scheduleFn` defaults to `setTimeout` and is injected so backoff is testable without waiting.

- [ ] **Step 1: Write the failing test**

Create `server/relay-publisher.test.js`:

```js
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
  wss.on('connection', (ws) => {
    current = ws;
    ws.on('message', (d) => received.push(JSON.parse(d.toString())));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `ws://127.0.0.1:${server.address().port}/publish`,
    received,
    send: (msg) => current?.send(JSON.stringify(msg)),
    dropConnection: () => current?.close(),
    waitFor: async (predicate, timeoutMs = 2000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = received.find(predicate);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('timed out waiting for message');
    },
    close: () => new Promise((r) => { wss.close(() => server.close(r)); }),
  };
}

const silent = () => {};

test('publishes snapshots once connected', async (t) => {
  const relay = await fakeRelay();
  t.after(() => relay.close());

  const pub = createRelayPublisher({ url: relay.url, onCommand: async () => ({}), log: silent });
  pub.start();
  t.after(() => pub.stop());

  await relay.waitFor(() => true).catch(() => {});
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
  t.after(() => relay.close());

  const seen = [];
  const pub = createRelayPublisher({
    url: relay.url, log: silent,
    onCommand: async ({ action, payload }) => { seen.push({ action, payload }); return { acked: true }; },
  });
  pub.start();
  t.after(() => pub.stop());

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
  t.after(() => relay.close());

  const pub = createRelayPublisher({
    url: relay.url, log: silent,
    onCommand: async () => { throw new Error('no such alarm'); },
  });
  pub.start();
  t.after(() => pub.stop());

  await new Promise((r) => setTimeout(r, 100));
  relay.send({ type: 'command', id: 'x2', action: 'close', payload: {} });

  const result = await relay.waitFor((m) => m.type === 'commandResult');
  assert.equal(result.ok, false);
  assert.match(result.error, /no such alarm/);
});

test('reconnects after the relay drops the connection', async (t) => {
  const relay = await fakeRelay();
  t.after(() => relay.close());

  const pub = createRelayPublisher({
    url: relay.url, onCommand: async () => ({}), log: silent,
    // Collapse backoff so the test does not sit through real delays.
    scheduleFn: (fn) => setTimeout(fn, 10),
  });
  pub.start();
  t.after(() => pub.stop());

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
  relay.dropConnection();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(pub.connected, false, 'a stopped publisher must stay stopped');
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd .. && node --test server/relay-publisher.test.js` (from the repo root:
`node --test server/relay-publisher.test.js`)
Expected: FAIL — `Cannot find module './relay-publisher.js'`.

- [ ] **Step 3: Implement `relay-publisher.js`**

Create `server/relay-publisher.js`:

```js
import WebSocket from 'ws';

// Outbound client from the gateway to the public relay.
//
// The gateway dials OUT. That is the whole point: no port forwarding, no
// inbound firewall rule, no router access, and it works from behind any NAT or
// captive portal that permits outbound HTTPS.

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

export function createRelayPublisher({
  url,
  secret = null,
  onCommand,
  log = console.log,
  scheduleFn = setTimeout,
}) {
  let socket = null;
  let stopped = false;
  let attempt = 0;
  let timer = null;

  const target = secret ? `${url}?token=${encodeURIComponent(secret)}` : url;

  function connect() {
    if (stopped) return;
    socket = new WebSocket(target);

    socket.on('open', () => {
      attempt = 0;
      log(`[relay] connected to ${url}`);
    });

    socket.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg?.type !== 'command' || typeof msg.id !== 'string') return;

      // A failing command must come back as a result, never as an unhandled
      // rejection that takes the gateway down.
      try {
        const result = await onCommand({ action: msg.action, payload: msg.payload ?? {} });
        send({ type: 'commandResult', id: msg.id, ok: true, result });
      } catch (err) {
        send({ type: 'commandResult', id: msg.id, ok: false, error: String(err?.message ?? err) });
      }
    });

    socket.on('close', () => {
      socket = null;
      scheduleReconnect();
    });

    // 'error' is always followed by 'close', so reconnection is handled there.
    socket.on('error', (err) => log(`[relay] ${err.message}`));
  }

  function scheduleReconnect() {
    if (stopped) return;
    const delay = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
    attempt++;
    timer = scheduleFn(connect, delay);
  }

  function send(message) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    try { socket.send(JSON.stringify(message)); return true; } catch { return false; }
  }

  return {
    start() { stopped = false; connect(); },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      try { socket?.close(); } catch { /* already closing */ }
      socket = null;
    },
    send,
    get connected() { return socket?.readyState === WebSocket.OPEN; },
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test server/relay-publisher.test.js`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add server/relay-publisher.js server/relay-publisher.test.js
git commit -m "feat(gateway): outbound relay publisher with backoff reconnect"
```

---

## Task 6: Wire the publisher into the gateway

**Files:**
- Modify: `server/config.js` (add a `relay` block)
- Modify: `server/index.js` (construct the publisher; mirror broadcasts; handle commands)

**Interfaces:**
- Consumes: `createRelayPublisher` (Task 5); `store.ackAlarm`, `store.closeAlarm`, `store.history` (existing).
- Produces: no new exports. `broadcast()` gains a second sink.

- [ ] **Step 1: Add the relay config block**

In `server/config.js`, add a top-level `relay` key beside `mqtt` and `storage`:

```js
  // Outbound link to the public relay. The gateway dials out, so nothing here
  // requires inbound network access. Set `enabled: false` to run purely local.
  relay: {
    enabled: true,
    url: 'wss://api.sih.shubhang.dev/publish',
    // Must match RELAY_PUBLISH_SECRET on the relay. null = relay accepts anyone.
    publishSecret: process.env.RELAY_PUBLISH_SECRET || null,
  },
```

- [ ] **Step 2: Import and construct the publisher in `server/index.js`**

Add near the other imports:

```js
import { createRelayPublisher } from './relay-publisher.js';
```

Then, after `store` and `live` are initialised but before `broadcast` is first
called, add:

```js
// Mirror what the local dashboard already receives up to the public relay, and
// execute commands the relay routes back down. Reads and writes both arrive
// here; there is no second code path for remote clients.
const relayPublisher = config.relay?.enabled
  ? createRelayPublisher({
      url: config.relay.url,
      secret: config.relay.publishSecret,
      log: (line) => console.log(line),
      onCommand: async ({ action, payload }) => {
        if (action === 'history') {
          const cid = payload.conveyor ?? config.conveyors[0].id;
          const channel = payload.channel;
          if (!channel || !CHANNELS[channel]) throw new Error(`unknown channel: ${channel}`);
          const minutes = Number(payload.minutes ?? 15);
          return {
            channel,
            unit: CHANNELS[channel].unit,
            points: store.history(cid, channel, Date.now() - minutes * 60000),
          };
        }

        if (action === 'ack') {
          const id = Number(payload.alarmId);
          if (!Number.isFinite(id)) throw new Error('alarmId required');
          store.ackAlarm(id, payload.by ?? 'mobile');
          pushSnapshot();
          return { acked: id };
        }

        if (action === 'close') {
          const id = Number(payload.alarmId);
          if (!Number.isFinite(id)) throw new Error('alarmId required');
          store.closeAlarm(id, payload.outcome, payload.technician, payload.notes);
          for (const [key, value] of openKeys) if (value === id) openKeys.delete(key);
          for (const cv of live.values()) recomputeRisk(cv);
          pushSnapshot();
          return { closed: id };
        }

        throw new Error(`unknown action: ${action}`);
      },
    })
  : null;

relayPublisher?.start();
```

- [ ] **Step 3: Mirror broadcasts to the relay**

Find `function broadcast(msg)` (around line 530) and add the relay sink so
local and remote clients receive identical messages from one place:

```js
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(s);
  // Same payload, second sink. Anything the dashboard sees, the phone sees.
  relayPublisher?.send(msg);
}
```

- [ ] **Step 4: Confirm no republish logic is needed after a relay restart**

The spec requires that a relay restart recovers automatically. It already does,
and adding code for it would be redundant: `server/index.js` ends with

```js
setInterval(() => broadcast(snapshot()), 2000);
```

so within two seconds of the publisher reconnecting, a full snapshot is sent
through the same `broadcast()` sink. Read that line and confirm it is present
before concluding this task; do **not** add a separate on-reconnect publish.

- [ ] **Step 5: Verify the existing suite still passes**

Run: `npm run test:record`
Expected: PASS — 7 tests, unchanged. This task must not alter recording behaviour.

- [ ] **Step 6: Verify the gateway still starts and connects**

```bash
npm start
```

Expected: the usual startup lines plus `[relay] connected to wss://api.sih.shubhang.dev/publish`
once Task 7 has deployed the relay. Before that it will log connection errors
and retry, which is correct behaviour and not a failure of this task.

- [ ] **Step 7: Commit**

```bash
git add server/config.js server/index.js
git commit -m "feat(gateway): mirror broadcasts to the relay and serve its commands"
```

---
## Task 7: Deploy to the droplet

**Files:**
- Create: `deploy/sih-api.caddy`
- Create: `deploy/deploy-relay.sh`

**Interfaces:**
- Consumes: the `sih-relay:latest` image (Task 4).
- Produces: a live `https://api.sih.shubhang.dev`.

- [ ] **Step 1: Write the Caddy fragment**

Create `deploy/sih-api.caddy`, matching the style of the existing site files:

```
api.sih.shubhang.dev {
	encode zstd gzip

	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
		-Server
	}

	# Caddy forwards Upgrade/Connection headers unchanged, so WebSocket
	# proxying needs no special directive.
	reverse_proxy 127.0.0.1:3040

	log {
		output stdout
		format json
	}
}
```

- [ ] **Step 2: Write the deploy script**

Create `deploy/deploy-relay.sh`:

```bash
#!/usr/bin/env bash
# Build the relay locally, ship it to the droplet, and bring it up behind Caddy.
# Idempotent: safe to re-run for every deployment.
set -euo pipefail

HOST="${RELAY_HOST:-root@206.189.135.109}"
REMOTE_DIR=/opt/sih-relay
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "==> building image for linux/amd64"
# The droplet is amd64 and a developer Mac is arm64. Without --platform the
# image builds for the wrong architecture and fails at runtime with a confusing
# 'exec format error'.
docker build --platform linux/amd64 -t sih-relay:latest "$HERE/../relay"

echo "==> shipping image"
docker save sih-relay:latest | gzip | ssh "$HOST" 'gunzip | docker load'

echo "==> shipping compose and caddy config"
ssh "$HOST" "mkdir -p $REMOTE_DIR"
scp "$HERE/docker-compose.yml" "$HOST:$REMOTE_DIR/docker-compose.yml"
scp "$HERE/sih-api.caddy" "$HOST:/etc/caddy/sites/sih-api.caddy"

echo "==> starting container"
ssh "$HOST" "cd $REMOTE_DIR && docker compose up -d --force-recreate"

echo "==> validating caddy BEFORE reload"
# Five production sites share this proxy. A bad fragment must be caught here,
# not by discovering the whole box stopped serving.
ssh "$HOST" 'caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1' \
  || { echo "caddy config INVALID - not reloading"; exit 1; }
ssh "$HOST" 'systemctl reload caddy'

echo "==> verifying"
sleep 3
ssh "$HOST" 'curl -sf http://127.0.0.1:3040/health' && echo
curl -sf https://api.sih.shubhang.dev/health && echo
echo "==> deployed"
```

Then `chmod +x deploy/deploy-relay.sh`.

- [ ] **Step 3: Deploy**

Run: `./deploy/deploy-relay.sh`
Expected: ends with `{"ok":true,"gatewayOnline":false,...}` from the public URL,
then `==> deployed`.

- [ ] **Step 4: Verify TLS and the WebSocket upgrade through Cloudflare**

```bash
curl -s https://api.sih.shubhang.dev/health
curl -s -o /dev/null -w "%{http_code}\n" https://api.sih.shubhang.dev/state   # expect 503
# WebSocket upgrade should return 101
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://api.sih.shubhang.dev/subscribe
```

Expected: `{"ok":true,...}`, then `503`, then `101`.

- [ ] **Step 5: Confirm the other five sites are unharmed**

```bash
for d in git.shubhang.dev staging.prepshelf.in t-scanner.shubhang.dev \
         uni-market.shubhang.dev www.prepshelf.in; do
  printf "%s -> " "$d"; curl -s -o /dev/null -w "%{http_code}\n" --max-time 8 "https://$d"
done
ssh root@206.189.135.109 'free -m | head -2; docker stats --no-stream --format "{{.Name}} {{.MemUsage}}" sih-relay'
```

Expected: `200`, `200`, `303`, `301`, `301` as before, and the relay well under
its 128 MB cap.

- [ ] **Step 6: Commit**

```bash
git add deploy/sih-api.caddy deploy/deploy-relay.sh
git commit -m "deploy(relay): caddy vhost and deployment script"
```

---

## Task 8: End-to-end path test

**Files:**
- Create: `relay/src/e2e.test.js`
- Create: `relay/src/fixtures/thermal-alarm.jsonl`

**Interfaces:**
- Consumes: `createRelayServer` (Task 3), `createRelayPublisher` (Task 5).
- Produces: no exports. This is the test that proves the pieces work together.

- [ ] **Step 1: Create the fixture**

Create `relay/src/fixtures/thermal-alarm.jsonl`. These are the exact message
shapes the gateway broadcasts — a snapshot, then a `thermal_delta` breach with
the measured values that produced it.

```
{"type":"snapshot","conveyors":[{"id":"CV-01","risk":"healthy","channels":{"temperature":{"value":26.2,"unit":"°C","state":"live"},"ambient":{"value":26.6,"unit":"°C","state":"live"}}}],"nodes":[{"node":"esp32-thermal-01","state":"live"}]}
{"type":"snapshot","conveyors":[{"id":"CV-01","risk":"healthy","channels":{"temperature":{"value":38.4,"unit":"°C","state":"live"},"ambient":{"value":26.3,"unit":"°C","state":"live"}}}],"nodes":[{"node":"esp32-thermal-01","state":"live"}]}
{"type":"alarm","alarm":{"id":41,"ts":1788372737736,"conveyor":"CV-01","level":"planned_inspection","family":"idler_anomaly","message":"Surface 15.4 K above ambient (limit 15 K)","evidence":"{\"rule\":\"thermal_delta\",\"source\":\"telemetry\",\"measured\":{\"temperature\":41.65,\"ambient\":26.27,\"delta_k\":15.38}}"}}
{"type":"snapshot","conveyors":[{"id":"CV-01","risk":"planned_inspection","channels":{"temperature":{"value":41.65,"unit":"°C","state":"live"},"ambient":{"value":26.27,"unit":"°C","state":"live"}}}],"nodes":[{"node":"esp32-thermal-01","state":"live"}]}
```

- [ ] **Step 2: Write the failing test**

Create `relay/src/e2e.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createRelayServer } from './server.js';
import { createRelayPublisher } from '../../server/relay-publisher.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, 'fixtures', 'thermal-alarm.jsonl'), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line));

function collect(ws) {
  const messages = [];
  ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
  return {
    messages,
    waitFor: async (predicate, timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = messages.find(predicate);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('timed out');
    },
  };
}

test('a recorded run reaches a subscriber with its alarm evidence intact', async (t) => {
  const relay = createRelayServer();
  const port = await relay.listen(0);
  t.after(() => relay.close());

  const publisher = createRelayPublisher({
    url: `ws://127.0.0.1:${port}/publish`,
    onCommand: async () => ({}),
    log: () => {},
  });
  publisher.start();
  t.after(() => publisher.stop());
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(publisher.connected, true);

  const sub = new WebSocket(`ws://127.0.0.1:${port}/subscribe`);
  await once(sub, 'open');
  const inbox = collect(sub);

  for (const frame of fixture) {
    publisher.send(frame);
    await new Promise((r) => setTimeout(r, 20));
  }

  const alarm = await inbox.waitFor((m) => m.type === 'alarm');
  assert.equal(alarm.alarm.id, 41);
  assert.match(alarm.alarm.message, /15\.4 K above ambient/);

  // The evidence is what makes an alarm defensible. Losing it in transit would
  // leave the app showing a claim with no numbers behind it.
  const evidence = JSON.parse(alarm.alarm.evidence);
  assert.equal(evidence.rule, 'thermal_delta');
  assert.equal(evidence.measured.delta_k, 15.38);

  const last = inbox.messages.filter((m) => m.type === 'snapshot').at(-1);
  assert.equal(last.conveyors[0].risk, 'planned_inspection');
  assert.equal(last.conveyors[0].channels.temperature.value, 41.65);
  assert.equal(last.stale, false);

  sub.close();
});

test('a command round-trips from subscriber to gateway and back', async (t) => {
  const relay = createRelayServer();
  const port = await relay.listen(0);
  t.after(() => relay.close());

  const handled = [];
  const publisher = createRelayPublisher({
    url: `ws://127.0.0.1:${port}/publish`,
    log: () => {},
    onCommand: async ({ action, payload }) => {
      handled.push({ action, payload });
      return { closed: payload.alarmId };
    },
  });
  publisher.start();
  t.after(() => publisher.stop());
  await new Promise((r) => setTimeout(r, 150));

  const sub = new WebSocket(`ws://127.0.0.1:${port}/subscribe`);
  await once(sub, 'open');
  const inbox = collect(sub);

  sub.send(JSON.stringify({
    type: 'command', id: 'e2e-1', action: 'close',
    payload: { alarmId: 41, outcome: 'false_positive', technician: 'demo' },
  }));

  const result = await inbox.waitFor((m) => m.type === 'commandResult');
  assert.equal(result.id, 'e2e-1');
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, { closed: 41 });
  assert.equal(handled[0].action, 'close');
  assert.equal(handled[0].payload.outcome, 'false_positive');

  sub.close();
});

test('subscribers see the gateway go offline when the publisher stops', async (t) => {
  const relay = createRelayServer();
  const port = await relay.listen(0);
  t.after(() => relay.close());

  const publisher = createRelayPublisher({
    url: `ws://127.0.0.1:${port}/publish`, onCommand: async () => ({}), log: () => {},
  });
  publisher.start();
  await new Promise((r) => setTimeout(r, 150));

  const sub = new WebSocket(`ws://127.0.0.1:${port}/subscribe`);
  await once(sub, 'open');
  const inbox = collect(sub);

  publisher.send({ type: 'snapshot', conveyors: [{ id: 'CV-01' }] });
  await inbox.waitFor((m) => m.type === 'snapshot');

  publisher.stop();

  const offline = await inbox.waitFor((m) => m.type === 'gatewayState' && m.online === false);
  assert.equal(offline.online, false, 'a phone must be told the gateway is gone, not left on stale numbers');

  sub.close();
});
```

- [ ] **Step 3: Run and confirm it fails**

Run: `cd relay && npm test`
Expected: FAIL — the fixture path or the cross-package import resolves wrongly
until Step 4 confirms both.

- [ ] **Step 4: Confirm `ws` resolves for the cross-package import**

`relay/src/e2e.test.js` imports `../../server/relay-publisher.js`, which imports
`ws` from the repo-root `node_modules`. Node resolves upward from the importing
file, so this works without extra configuration. Verify:

```bash
cd relay && node -e "import('../server/relay-publisher.js').then(()=>console.log('resolves'))"
```

Expected: `resolves`.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `cd relay && npm test`
Expected: PASS — 28 tests total.

- [ ] **Step 6: Add a repo-root test script**

In the root `package.json`, extend the scripts so one command runs everything:

```json
"test": "node --test server/*.test.js tools/*.test.js && cd relay && npm test",
```

Run: `npm test` from the repo root.
Expected: PASS — all suites.

- [ ] **Step 7: Commit**

```bash
git add relay/src/e2e.test.js relay/src/fixtures/thermal-alarm.jsonl package.json
git commit -m "test(relay): end-to-end path with recorded thermal alarm fixture"
```

---

## Follow-ups (not in this plan)

- **Gateway-in-the-loop E2E.** Driving Aedes + the real gateway + the relay in
  one test would also exercise rule evaluation, but `server/config.js` is a
  static module with no environment overrides for the broker URL or HTTP port,
  so a test cannot point it at ephemeral ports. Adding those overrides is a
  prerequisite and is a change to existing code that this plan does not need.
- **Plan 2: the Android app**, which consumes the relay this plan deploys.
