import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPONENTS, alarmBelongsTo, componentStatus } from './components.js';

const part = (id) => COMPONENTS.find((c) => c.id === id);
const alarm = (evidence, extra = {}) => ({
  id: 1, level: 'planned_inspection', family: 'idler_anomaly', joint_id: null,
  evidence: evidence === undefined ? null : JSON.stringify(evidence), ...extra,
});

test('a vibration alarm belongs to the head shaft bearings, not the IR idler spot', () => {
  const a = alarm({ rule: 'vibration_impulsive', component: 'drive_bearing' });
  assert.equal(alarmBelongsTo(a, part('drive_bearing')), true);
  assert.equal(alarmBelongsTo(a, part('idlers')), false);
});

test('legacy alarms without a recorded component fall back to the fault family', () => {
  assert.equal(alarmBelongsTo(alarm({ rule: 'thermal_delta' }), part('idlers')), true);
  assert.equal(alarmBelongsTo(alarm(undefined), part('idlers')), true);
  assert.equal(alarmBelongsTo({ ...alarm(undefined), evidence: '{broken' }, part('idlers')), true);
});

test('component status colours the measured part and leaves the idler spot at its own reading', () => {
  const channels = {};
  const comps = componentStatus({
    channels, joints: [], metrics: [],
    alarms: [alarm({ rule: 'vibration_impulsive', component: 'drive_bearing' })],
  });
  const byId = Object.fromEntries(comps.map((c) => [c.id, c]));
  assert.equal(byId.drive_bearing.state, 'planned_inspection');
  assert.equal(byId.drive_bearing.alarmCount, 1);
  assert.notEqual(byId.idlers.state, 'planned_inspection');
  assert.equal(byId.idlers.alarmCount, 0);
});

test('the bench model lists only the parts the bench rig has', () => {
  const comps = componentStatus({ channels: {}, joints: [], metrics: [], alarms: [], model: 'bench' });
  const ids = comps.map((c) => c.id).sort();
  assert.deepEqual(ids, ['belt_carcass', 'belt_tracking', 'drive_bearing', 'drive_motor', 'drive_pulley', 'gearbox', 'idlers', 'tail_pulley']);
  const ir = comps.find((c) => c.id === 'idlers');
  assert.equal(ir.label, 'IR temperature spot');
  assert.equal(ir.group, 'belt');
  // The mining model is unchanged.
  assert.equal(componentStatus({ channels: {}, joints: [], metrics: [], alarms: [] }).length, COMPONENTS.length);
});
