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

// A controllable clock, shared by the state and the hub, so the command rate
// limiter can be driven without real elapsed time.
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function setup(clock = fakeClock()) {
  const state = new RelayState({ now: clock.now });
  return { state, clock, hub: new Hub({ state, now: clock.now }) };
}

// The relay mints its own command id and translates it back on the way out, so
// a test that wants to answer a command has to read the id off the wire.
function forwardedId(pub, index = 0) {
  return pub.messagesOfType('command')[index].id;
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
    type: 'commandResult', id: forwardedId(pub), ok: true, result: { acked: true },
  }));

  assert.equal(asker.messagesOfType('commandResult').length, 1);
  assert.equal(asker.messagesOfType('commandResult')[0].id, 'c1',
    'the client must get back the id IT chose, not the relay\'s internal one');
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
  const relayId = forwardedId(pub);
  hub.removeSubscriber(sub);

  assert.doesNotThrow(() => hub.handlePublisherMessage(JSON.stringify({
    type: 'commandResult', id: relayId, ok: true,
  })), 'a result for a departed client must not crash the relay');
  assert.equal(hub.subscriberCount, 0);
  assert.equal(sub.messagesOfType('commandResult').length, 0,
    'a departed subscriber must not receive a stale result');
});

test('one subscriber\'s send throwing does not abort fan-out to others', () => {
  const { hub } = setup();
  const pub = fakeSocket();
  hub.attachPublisher(pub);

  // Create a socket that throws on send
  const throwing = fakeSocket();
  const originalSend = throwing.send;
  throwing.send = () => { throw new Error('socket closed'); };

  // Create a normal socket
  const normal = fakeSocket();

  hub.addSubscriber(throwing);
  hub.addSubscriber(normal);

  // Send a snapshot - the throwing socket should not crash the hub
  // and the normal socket should still receive it
  hub.handlePublisherMessage(JSON.stringify({ type: 'snapshot', conveyors: [] }));

  assert.equal(normal.messagesOfType('snapshot').length, 1,
    'a healthy subscriber must receive the broadcast even if another throws');
});


// --------------------------------------------------------------- rate limits
//
// Every subscriber command costs the GATEWAY work, and `history` is a
// SYNCHRONOUS SQLite query on the gateway's event loop. Unthrottled, an
// anonymous client on a public endpoint could starve MQTT ingest, the local
// dashboard socket and the 2 s snapshot heartbeat - the exact property the
// design says must never be possible.

test('a subscriber flooding commands is throttled to a burst then a rate', () => {
  const clock = fakeClock();
  const { hub } = setup(clock);
  const sub = fakeSocket();
  hub.addSubscriber(sub);

  // No publisher attached, so every accepted command answers "gateway not
  // connected" without occupying an in-flight slot. That isolates the token
  // bucket from the concurrency cap.
  for (let i = 0; i < 10; i++) {
    hub.handleSubscriberMessage(sub, JSON.stringify({
      type: 'command', id: `burst-${i}`, action: 'history', payload: {},
    }), { canWrite: false });
  }
  const accepted = sub.messagesOfType('commandResult');
  assert.equal(accepted.length, 10);
  assert.equal(accepted.every((m) => /gateway not connected/.test(m.error)), true,
    'the burst allowance must be spendable in one go');

  hub.handleSubscriberMessage(sub, JSON.stringify({
    type: 'command', id: 'over', action: 'history', payload: {},
  }), { canWrite: false });
  const rejected = sub.last();
  assert.equal(rejected.id, 'over');
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /rate limit/i);

  // The bucket refills, so a legitimate client is throttled rather than banned.
  clock.advance(1000);
  hub.handleSubscriberMessage(sub, JSON.stringify({
    type: 'command', id: 'later', action: 'history', payload: {},
  }), { canWrite: false });
  assert.match(sub.last().error, /gateway not connected/,
    'a refilled bucket must let an ordinary client through again');
});

test('the rate limiter is per socket, so one flooder cannot mute another client', () => {
  const clock = fakeClock();
  const { hub } = setup(clock);
  const flooder = fakeSocket(), quiet = fakeSocket();
  hub.addSubscriber(flooder);
  hub.addSubscriber(quiet);

  for (let i = 0; i < 30; i++) {
    hub.handleSubscriberMessage(flooder, JSON.stringify({
      type: 'command', id: `f${i}`, action: 'history', payload: {},
    }), { canWrite: false });
  }
  assert.match(flooder.last().error, /rate limit/i);

  hub.handleSubscriberMessage(quiet, JSON.stringify({
    type: 'command', id: 'q1', action: 'history', payload: {},
  }), { canWrite: false });
  assert.match(quiet.last().error, /gateway not connected/,
    "a throttled neighbour must not consume this client's allowance");
});

test('a subscriber cannot hold more than the in-flight cap open at once', () => {
  const { hub } = setup();
  const pub = fakeSocket();
  hub.attachPublisher(pub);
  const sub = fakeSocket();
  hub.addSubscriber(sub);

  for (let i = 0; i < 8; i++) {
    hub.handleSubscriberMessage(sub, JSON.stringify({
      type: 'command', id: `i${i}`, action: 'history', payload: {},
    }), { canWrite: false });
  }
  assert.equal(pub.messagesOfType('command').length, 8);

  hub.handleSubscriberMessage(sub, JSON.stringify({
    type: 'command', id: 'i8', action: 'history', payload: {},
  }), { canWrite: false });

  assert.equal(pub.messagesOfType('command').length, 8, 'the 9th must not reach the gateway');
  assert.equal(sub.last().id, 'i8');
  assert.equal(sub.last().ok, false);
  assert.match(sub.last().error, /in flight/i);

  // Answering one frees exactly one slot.
  hub.handlePublisherMessage(JSON.stringify({
    type: 'commandResult', id: forwardedId(pub, 0), ok: true, result: {},
  }));
  hub.handleSubscriberMessage(sub, JSON.stringify({
    type: 'command', id: 'i9', action: 'history', payload: {},
  }), { canWrite: false });
  assert.equal(pub.messagesOfType('command').length, 9, 'a completed command must free its slot');
});

test('an over-long command id is refused instead of being stored', () => {
  const { hub } = setup();
  const pub = fakeSocket();
  hub.attachPublisher(pub);
  const sub = fakeSocket();
  hub.addSubscriber(sub);

  const huge = 'x'.repeat(5000);
  hub.handleSubscriberMessage(sub, JSON.stringify({
    type: 'command', id: huge, action: 'history', payload: {},
  }), { canWrite: false });

  assert.equal(pub.messagesOfType('command').length, 0, 'must not reach the gateway');
  const reply = sub.last();
  assert.equal(reply.ok, false);
  assert.match(reply.error, /too long/i);
  assert.ok(reply.id.length <= 64, "must not echo the attacker's whole string back");
});

// ------------------------------------------------------- command id ownership

test('two subscribers using the same command id do not steal each other results', () => {
  const { hub } = setup();
  const pub = fakeSocket();
  hub.attachPublisher(pub);
  const a = fakeSocket(), b = fakeSocket();
  hub.addSubscriber(a);
  hub.addSubscriber(b);

  // Both clients pick "1". Nothing stops them: the id is theirs to choose.
  hub.handleSubscriberMessage(a, JSON.stringify({
    type: 'command', id: '1', action: 'history', payload: { channel: 'temperature' },
  }), { canWrite: false });
  hub.handleSubscriberMessage(b, JSON.stringify({
    type: 'command', id: '1', action: 'history', payload: { channel: 'vibration' },
  }), { canWrite: false });

  const forwarded = pub.messagesOfType('command');
  assert.equal(forwarded.length, 2, 'the second must not overwrite the first');
  assert.notEqual(forwarded[0].id, forwarded[1].id, 'the relay must qualify client ids');

  hub.handlePublisherMessage(JSON.stringify({
    type: 'commandResult', id: forwarded[0].id, ok: true, result: { for: 'a' },
  }));
  assert.equal(a.messagesOfType('commandResult').length, 1);
  assert.equal(b.messagesOfType('commandResult').length, 0, "B must not receive A's result");
  assert.deepEqual(a.last().result, { for: 'a' });
  assert.equal(a.last().id, '1');

  hub.handlePublisherMessage(JSON.stringify({
    type: 'commandResult', id: forwarded[1].id, ok: true, result: { for: 'b' },
  }));
  assert.equal(b.messagesOfType('commandResult').length, 1, 'B must not be stranded forever');
  assert.deepEqual(b.last().result, { for: 'b' });
  assert.equal(b.last().id, '1');
});

// -------------------------------------------------------------------- alarms

test('an alarm with no body is dropped rather than fanned out', () => {
  const { hub } = setup();
  const pub = fakeSocket();
  hub.attachPublisher(pub);
  const sub = fakeSocket();
  hub.addSubscriber(sub);

  // `{type:'alarm'}` used to broadcast as `{type:'alarm', serverTs}`, and every
  // client that reads `alarm.alarm.level` throws on it. Alarms are the one
  // message class this system must never mishandle.
  hub.handlePublisherMessage(JSON.stringify({ type: 'alarm' }));
  hub.handlePublisherMessage(JSON.stringify({ type: 'alarm', alarm: null }));
  hub.handlePublisherMessage(JSON.stringify({ type: 'alarm', alarm: 'hot' }));

  assert.equal(sub.messagesOfType('alarm').length, 0);

  hub.handlePublisherMessage(JSON.stringify({ type: 'alarm', alarm: { id: 9, level: 'critical' } }));
  assert.equal(sub.messagesOfType('alarm').length, 1, 'a real alarm still goes through');
  assert.equal(sub.last().alarm.level, 'critical');
});

test('broadcastCurrentState re-states stale data to already-connected clients', () => {
  const clock = fakeClock();
  const { hub, state } = setup(clock);
  const pub = fakeSocket();
  hub.attachPublisher(pub);
  const sub = fakeSocket();
  hub.addSubscriber(sub);

  hub.handlePublisherMessage(JSON.stringify({ type: 'snapshot', conveyors: [{ id: 'CV-01' }] }));
  assert.equal(sub.messagesOfType('snapshot').at(-1).stale, false);

  // The gateway's socket is still nominally open, but nothing has arrived.
  clock.advance(60_000);
  assert.equal(state.stale, true);

  hub.broadcastCurrentState();
  assert.equal(sub.messagesOfType('snapshot').at(-1).stale, true,
    'a client that connected while things were healthy must be told they no longer are');
});
