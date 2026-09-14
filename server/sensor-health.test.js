import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applySensorHealth } from './sensor-health.js';
import { Store } from './store.js';
import { CHANNELS, validate } from './schema.js';

test('a fault-only frame clears that sensor while retaining other nodes and health', () => {
  const cv = { channels: { vibration_rms: { v: 0.1, node: 'accel' }, temperature: { v: 30, node: 'ir' } }, sensorHealth: { mlx: 'healthy' } };
  applySensorHealth(cv, 'accel', { vibration: 'fault' });
  assert.equal(cv.channels.vibration_rms, undefined);
  assert.equal(cv.channels.temperature.v, 30);
  assert.deepEqual(cv.sensorHealth, { mlx: 'healthy', vibration: 'fault' });
  applySensorHealth(cv, 'other', { mlx: 'fault' });
  assert.equal(cv.channels.temperature.v, 30);
});

test('partial thermal failure invalidates delta and failed register only', () => {
  const cv = { channels: { temperature: { v: 30, node: 'ir' }, ambient: { v: 25, node: 'ir' }, temperature_delta: { v: 5, node: 'derived' } } };
  applySensorHealth(cv, 'ir', { mlx: 'fault' }, { ambient: 26 });
  assert.equal(cv.channels.temperature, undefined);
  assert.equal(cv.channels.temperature_delta, undefined);
  assert.ok(cv.channels.ambient);
});

test('upgrading an existing telemetry database preserves old rows and adds actual acceleration/Hall channels', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pravaah-store-'));
  let store;
  t.after(() => {
    // Windows cannot remove the WAL files while SQLite still holds them open.
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, 'old.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE telemetry (ts INTEGER, conveyor TEXT, node TEXT, seq INTEGER, temperature REAL); INSERT INTO telemetry VALUES(1700000000000, "CV-01", "ir", 1, 30)'.replaceAll('"', "'"));
  db.close();
  store = new Store(path);
  const values = { hall_rpm: 34.5, acceleration_x: -0.1, acceleration_y: 0.2, acceleration_z: 0.95, acceleration_magnitude: 1.02 };
  assert.deepEqual(validate({ ts: 1700000001000, ...values }, CHANNELS).values, values);
  store.telemetry(1700000001000, 'CV-01', 'accel', 2, values);
  const rows = store.db.prepare('SELECT * FROM telemetry ORDER BY ts').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].temperature, 30);
  assert.equal(rows[0].acceleration_x, null);
  assert.equal(rows[1].hall_rpm, 34.5);
  assert.equal(rows[1].acceleration_x, -0.1);
});
