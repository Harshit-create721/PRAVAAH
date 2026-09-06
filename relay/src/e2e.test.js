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
