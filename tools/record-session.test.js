import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import Aedes from 'aedes';
import mqtt from 'mqtt';
import { Recording } from './lib/recording.js';

const prefix = 'beltguard/factory/CV-01';
const metadata = { site: 'factory', conveyor: 'CV-01', source: 'live', label: 'unlabelled', hall_target: 'roller' };
const temporaryDirectory = () => mkdtempSync(join(tmpdir(), 'pravaah-record-test-'));
const readJSON = (folder, name) => JSON.parse(readFileSync(join(folder, name), 'utf8'));
const readLines = (folder, name) => readFileSync(join(folder, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const frame = (payload) => Buffer.from(JSON.stringify(payload));

// Parse the exported file as an external CSV consumer, including quoted fields.
function csvRows(file) {
  const rows = [], row = [];
  let value = '', quoted = false;
  for (let i = 0; i < file.length; i++) {
    const char = file[i];
    if (char === '"') {
      if (quoted && file[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (char === ',' || char === '\n')) {
      row.push(value); value = '';
      if (char === '\n') { rows.push([...row]); row.length = 0; }
    } else value += char;
  }
  const headers = rows.shift();
  return rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]])));
}

test('capture preserves separate sensor rows, exact payloads, health and CSV labels', () => {
  const recording = new Recording({ directory: temporaryDirectory(), metadata: { ...metadata, label: 'observed, "warm"\nrun' } });
  const original = { node: 'esp32-thermal-01', ts: 1770000000000, seq: 1,
    temperature: 30.5, ambient: 24.1, sensor_health: { mlx: 'fault' }, future_field: [1, 2] };
  recording.accept(`${prefix}/telemetry`, frame(original));
  recording.accept(`${prefix}/telemetry`, frame({ node: 'esp32-vibration-01', seq: 1, vibration_rms: 0, temperature: 900 }));
  recording.accept(`${prefix}/joint`, frame({ node: 'esp32-marker-01', lap: 2, joint_id: 'J01', joint_marker_dt_left: 812 }));
  recording.close();
  recording.close();
  assert.deepEqual(readLines(recording.directory, 'frames.jsonl')[0].payload, original);
  const rows = csvRows(readFileSync(join(recording.directory, 'telemetry.csv'), 'utf8'));
  assert.equal(rows[0].label, 'observed, "warm"\nrun');
  assert.equal(rows[0].vibration_rms, '');
  assert.equal(rows[1].vibration_rms, '0');
  assert.equal(rows[1].temperature, '');
  assert.equal(rows[1].ambient, '');
  assert.equal(JSON.parse(rows[0].sensor_health).mlx, 'fault');
  assert.match(rows[1].quality_issues, /outside plausible range/);
  assert.match(rows[1].quality_issues, /stamped on arrival/);
  assert.match(readFileSync(join(recording.directory, 'joint.csv'), 'utf8'), /not verified belt-joint passages/);
  assert.equal(readJSON(recording.directory, 'summary.json').counts.telemetry, 2);
  assert.throws(() => recording.event('after-close'), /closed/);
});

test('live captures exclude known synthetic, stale retained, malformed and unidentifiable input', () => {
  const recording = new Recording({ directory: temporaryDirectory(), metadata });
  for (const [topic, body, packet] of [
    [`${prefix}/telemetry`, frame({ node: 'bench-harness-01', temperature: 30 })],
    [`${prefix}/node/bench-harness-01/status`, frame({ node: 'esp32-thermal-01', online: true })],
    [`${prefix}/telemetry`, frame({ node: 'esp32-thermal-01', temperature: 30 }), { retain: true }],
    [`${prefix}/telemetry`, Buffer.from('{bad')],
    [`${prefix}/telemetry`, Buffer.from('[]')],
    [`${prefix}/telemetry`, frame({ temperature: 30 })],
    ['beltguard/factory/CV-02/telemetry', frame({ node: 'esp32-thermal-01', temperature: 30 })],
  ]) assert.equal(recording.accept(topic, body, packet), false);
  recording.close();
  assert.equal(readLines(recording.directory, 'frames.jsonl').length, 0);
  assert.equal(readLines(recording.directory, 'excluded.jsonl').length, 7);
});

test('gaps and possible resets are per node; joint events remain separate after a restart', () => {
  const recording = new Recording({ directory: temporaryDirectory(), metadata });
  for (const [node, seq] of [['a', 10], ['b', 2], ['a', 13], ['a', 1], ['a', 1]]) {
    recording.accept(`${prefix}/telemetry`, frame({ node, seq, temperature: 25 }));
  }
  for (let i = 0; i < 2; i++) recording.accept(`${prefix}/joint`, frame({ node: 'a', lap: 1, joint_id: 'J01' }));
  recording.close();
  const summary = readJSON(recording.directory, 'summary.json');
  assert.equal(summary.counts.sequence_gaps, 2);
  assert.equal(summary.counts.sequence_resets, 1);
  assert.equal(summary.counts.joint, 2);
  const rows = csvRows(readFileSync(join(recording.directory, 'telemetry.csv'), 'utf8'));
  assert.equal(rows[1].seq_gap, '');
  assert.equal(rows[2].seq_gap, '2');
  assert.equal(rows[3].seq_reset, '1');
  assert.match(rows[4].quality_issues, /repeated sequence/);
});

test('new runs never overwrite an earlier session and synthetic captures are explicit', () => {
  const directory = temporaryDirectory();
  const first = new Recording({ directory, metadata });
  first.close();
  const second = new Recording({ directory, metadata: { ...metadata, source: 'synthetic' } });
  assert.notEqual(first.directory, second.directory);
  assert.equal(second.accept(`${prefix}/telemetry`, frame({ node: 'esp32-thermal-01', temperature: 30 })), false);
  assert.equal(second.accept(`${prefix}/telemetry`, frame({ node: 'bench-harness-01', temperature: 30 })), true);
  second.close();
  assert.equal(readJSON(first.directory, 'summary.json').counts.telemetry, 0);
});

test('health-only messages and rejected numbers do not count as useful telemetry', () => {
  const recording = new Recording({ directory: temporaryDirectory(), metadata });
  recording.accept(`${prefix}/telemetry`, frame({ node: 'esp32-thermal-01', sensor_health: { mlx: 'fault' } }));
  recording.accept(`${prefix}/telemetry`, frame({ node: 'esp32-vibration-01', vibration_rms: -4 }));
  recording.close();
  const summary = readJSON(recording.directory, 'summary.json');
  assert.equal(summary.counts.telemetry, 2);
  assert.equal(summary.counts.valid_telemetry, 0);
  assert.deepEqual(summary.final_signals, {
    temperature: 'not seen', vibration_rms: 'not seen', hall_rpm: 'not seen', motor_rpm: 'not seen', belt_speed: 'not seen',
  });
});

test('CLI records all three sensor streams through an isolated MQTT broker and flushes on stop', { timeout: 12000 }, async (t) => {
  const directory = temporaryDirectory();
  const broker = new Aedes();
  const server = createServer(broker.handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `mqtt://127.0.0.1:${server.address().port}`;
  const publisher = await mqtt.connectAsync(url);
  let child;
  t.after(async () => {
    if (child?.exitCode === null) child.kill('SIGTERM');
    await publisher.endAsync(true);
    await new Promise((done) => broker.close(done));
    await new Promise((done) => server.close(done));
  });
  child = spawn(process.execPath, [resolve(import.meta.dirname, 'record-session.js'), '--label', 'protocol-test',
    '--source', 'synthetic', '--broker', url, '--output', directory, '--duration', '1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  const exited = once(child, 'exit');
  child.stderr.on('data', (data) => { errors += data; });
  await new Promise((done, reject) => {
    child.on('error', reject);
    child.on('exit', () => reject(new Error(`CLI exited before subscribing: ${output} ${errors}`)));
    child.stdout.on('data', (data) => {
      output += data;
      if (output.includes('Recording subscribed.')) done();
    });
  });
  for (const payload of [
    { node: 'bench-thermal', seq: 1, temperature: 31, ambient: 26 },
    { node: 'bench-vibration', seq: 1, vibration_rms: 0.08 },
    { node: 'bench-marker', seq: 1, hall_rpm: 34.5 },
  ]) await publisher.publishAsync(`${prefix}/telemetry`, JSON.stringify(payload), { qos: 1 });
  const [code] = await exited;
  assert.equal(code, 0, errors + output);
  const session = join(directory, readdirSync(directory)[0]);
  assert.equal(readJSON(session, 'summary.json').counts.telemetry, 3);
  assert.deepEqual(readJSON(session, 'summary.json').final_signals, {
    temperature: 'receiving', vibration_rms: 'receiving', hall_rpm: 'receiving', motor_rpm: 'not seen', belt_speed: 'not seen',
  });
  assert.equal(readJSON(session, 'session.json').source, 'synthetic');
  assert.equal(readLines(session, 'frames.jsonl').length, 3);
});

test('CLI rejects invalid run metadata before creating output', () => {
  const directory = temporaryDirectory();
  const script = resolve(import.meta.dirname, 'record-session.js');
  for (const args of [[], ['--label', 'x', '--load-kg', '-1'], ['--label', 'x', '--duration', '0'], ['--label', 'x', '--conveyor', 'missing']]) {
    const result = spawnSync(process.execPath, [script, '--output', directory, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr);
  }
  assert.deepEqual(readdirSync(directory), []);
});
