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
