import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
// The gateway's actual JavaScript modules are exercised without changing its running instance.
import { createRelayServer } from '../../relay/src/server.js';
import { createRelayPublisher } from '../../server/relay-publisher.js';
import { Store } from '../../server/store.js';
import { createConnection } from '../src/gateway/connection';
import { createCommands } from '../src/gateway/commands';
import { endpoint } from '../src/gateway/discovery';
import { snapshot } from './fixtures';
import { parseEvidence } from '../src/domain/alarms';
import { decodeMessage } from '../src/gateway/types';

async function until(predicate, timeout = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for condition.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
test('mobile -> real relay -> real publisher -> SQLite: history, auth, ack, close, reconnect and alarm evidence', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pravaah-mobile-test-'));
  const store = new Store(join(dir, 'test.db'));
  const relay = createRelayServer({ publishSecret: 'fixture-publish', writeToken: 'fixture-write' });
  await relay.listen(0, '127.0.0.1');
  const port = relay.server.address().port;
  const url = `ws://127.0.0.1:${port}`;
  const fixtureLines = (await readFile(new URL('../../relay/src/fixtures/thermal-alarm.jsonl', import.meta.url), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const alarmFrame = fixtureLines.find(frame => frame.type === 'alarm');
  assert.ok(alarmFrame);
  const recorded = alarmFrame.alarm;
  const alarmId = store.alarm(Date.now(), 'CV-01', null, recorded.level, recorded.family, recorded.message, JSON.parse(recorded.evidence));
  store.telemetry(Date.now() - 1000, 'CV-01', 'esp32-thermal-01', 1, { temperature: 41.65 });
  let publisher;
  function publishSnapshot() {
    const frame = snapshot(Date.now()); frame.conveyors[0].alarms = store.openAlarms('CV-01');
    publisher.send(frame);
  }
  publisher = createRelayPublisher({ url: `${url}/publish`, secret: 'fixture-publish', log: () => {},
    onCommand: ({ action, payload }) => {
      if (action === 'history') return { channel: payload.channel, unit: '°C', points: store.history(payload.conveyor, payload.channel, Date.now() - Number(payload.minutes) * 60000) };
      if (action === 'ack') { store.ackAlarm(payload.alarmId, payload.by); publishSnapshot(); return { acked: payload.alarmId }; }
      if (action === 'close') { store.closeAlarm(payload.alarmId, payload.outcome, payload.technician, payload.notes); publishSnapshot(); return { closed: payload.alarmId }; }
      throw new Error('Unknown command');
    },
  });
  const make = (writeToken = '') => createConnection({ endpoints: [endpoint(url, 'relay')], writeToken,
    socketFactory: (target, headers) => new WebSocket(target, { headers }), random: () => 0.5 });
  const conn = make('fixture-write'); const reader = make();
  const commands = createCommands({ connection: conn }); const readCommands = createCommands({ connection: reader });
  try {
    publisher.start(); await until(() => publisher.connected); publishSnapshot();
    const events = []; conn.onMessage(message => { if (message.type === 'alarm') events.push(message); });
    conn.start(); reader.start(); await until(() => conn.available && reader.available);
    const history = await commands.history({ conveyor: 'CV-01', channel: 'temperature', minutes: 15 });
    assert.equal(history.points[0].v, 41.65);
    await assert.rejects(readCommands.ack(alarmId, 'Anonymous'), /unauthorized/i);
    await commands.ack(alarmId, 'Mobile test'); assert.equal(store.openAlarms('CV-01')[0].ack_by, 'Mobile test');
    publisher.send({ ...alarmFrame, alarm: { ...recorded, id: alarmId } });
    await until(() => events.length === 1);
    assert.deepEqual(parseEvidence(events[0].alarm)?.measured, JSON.parse(recorded.evidence).measured);
    await commands.close(alarmId, { outcome: 'inspected', technician: 'Mobile test', notes: 'Integration fixture only' });
    assert.equal(store.openAlarms('CV-01').length, 0);
    const maintenance = store.db.prepare('SELECT technician, notes FROM maintenance WHERE alarm_id=?').get(alarmId);
    assert.equal(maintenance.technician, 'Mobile test'); assert.equal(maintenance.notes, 'Integration fixture only');
    publisher.stop(); await until(() => !conn.available);
    await assert.rejects(commands.ack(alarmId, 'Test'), /offline/);
    publisher.start(); await until(() => publisher.connected); publishSnapshot(); await until(() => conn.available);
  } finally {
    commands.dispose(); readCommands.dispose(); conn.stop(); reader.stop(); publisher.stop();
    await relay.close(); store.db.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('live deployed relay and local gateway contracts decode without writes', { skip: process.env.PRAVAAH_LIVE_TEST !== '1', timeout: 15000 }, async () => {
  const response = await fetch('https://api.sih.shubhang.dev/state'); assert.equal(response.status, 200);
  const message = decodeMessage(await response.text()); assert.equal(message?.type, 'snapshot');
  const ws = new WebSocket('wss://api.sih.shubhang.dev/subscribe');
  const firstMessage = once(ws, 'message');
  try {
    const [raw] = await firstMessage;
    const first = decodeMessage(raw.toString()); assert.ok(first);
  } finally { ws.close(); }
});
