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
