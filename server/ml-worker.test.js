import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createMLWorker } from './ml-worker.js';

const root = resolve(import.meta.dirname, '..');
function harness() {
  let at = 20000;
  const proc = new EventEmitter();
  proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
  proc.kill = () => {};
  const worker = createMLWorker({ root, conveyor: 'CV-01', python: 'test-python',
    spawnProcess: () => proc, now: () => at, log: () => {} });
  worker.start();
  const send = value => proc.stdout.write(JSON.stringify(value) + '\n');
  return { worker, proc, send, time: value => { at = value; } };
}
const condition = { type: 'condition', data_quality: 'valid', status: 'NORMAL',
  anomaly_score: 0, health_score: 100, start_ms: 10000, end_ms: 20000,
  window_seconds: 10, driver_sensor: 'vibration', explanation: 'Recorded-baseline comparison.' };

test('the gateway accepts a zero score and expires it even if the worker hangs', () => {
  const h = harness(); h.send(condition);
  assert.equal(h.worker.snapshot().anomaly_score, 0);
  h.time(25001);
  assert.equal(h.worker.snapshot().status, 'DATA_UNAVAILABLE');
  assert.equal(h.worker.snapshot().anomaly_score, null);
  h.worker.stop();
});

test('disconnects clear the worker and ignore already queued older verdicts', () => {
  const h = harness(); h.send(condition);
  h.worker.invalidate('sensor disconnected');
  assert.match(h.proc.stdin.read().toString(), /invalidate/);
  h.send(condition);
  assert.equal(h.worker.snapshot().status, 'DATA_UNAVAILABLE');
  h.worker.stop();
});

test('bad output or worker failure cannot retain a condition score', () => {
  const h = harness(); h.send(condition);
  h.proc.stdout.write('not JSON\n');
  assert.equal(h.worker.snapshot().anomaly_score, null);
  const g = harness(); g.send(condition); g.proc.emit('error', new Error('test crash'));
  assert.equal(g.worker.snapshot().status, 'DATA_UNAVAILABLE');
  h.worker.stop(); g.worker.stop();
});

const python = join(root, 'ML/SIH-2026/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
test('real recorded gateway payloads reach Python; a null reading invalidates and silence stays unavailable',
  { skip: !existsSync(python), timeout: 90000 }, async () => {
    // An isolated, paced replay, never published to MQTT, history or training data.
    const source = join(root, 'ML/SIH-2026/data/2026-09-06T17-29-57.647Z-a70e3e55-cleaned-v1/telemetry.frames.jsonl');
    const frames = readFileSync(source, 'utf8').trim().split('\n').map(JSON.parse).map(r => r.payload);
    const t0 = frames[0].ts;
    const slice = frames.filter(f => f.ts - t0 <= 12500);
    const changes = [];
    const worker = createMLWorker({ root, conveyor: 'CV-01', python,
      onChange: () => changes.push(worker.snapshot()), log: () => {} });
    try {
      worker.start();
      const readyDeadline = Date.now() + 60000;
      while (!worker.snapshot().reason?.startsWith('Waiting for ten seconds') && Date.now() < readyDeadline) await delay(50);
      assert.match(worker.snapshot().reason, /^Waiting for ten seconds/);
      const start = Date.now();
      for (const frame of slice) {
        const ts = start + frame.ts - t0;
        await delay(Math.max(0, ts - Date.now()));
        worker.push({ ...frame, ts });
      }
      const deadline = Date.now() + 3000;
      while (!changes.some(v => v.type === 'condition') && Date.now() < deadline) await delay(50);
      assert.ok(changes.some(v => v.type === 'condition'), JSON.stringify(changes));
      worker.push({ ...slice.find(f => f.temperature !== undefined), ts: Date.now(), temperature: null });
      await delay(500);
      assert.equal(worker.snapshot().status, 'DATA_UNAVAILABLE');
      assert.equal(worker.snapshot().anomaly_score, null);
    } finally { worker.stop(); }
  });
