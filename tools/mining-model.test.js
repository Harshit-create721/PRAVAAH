import { canInspectComponent, inspectionChannels, visionDamageReadings } from '../web/sensor-inspection.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { miningParts, miningAsset, miningPartVertices, miningStaticFaces, miningMovingFaces,
  indexMiningParts, MODEL_SCALE } from '../web/mining-model.js';
import { COMPONENTS, componentStatus } from '../server/components.js';

const context = {};
runInNewContext(readFileSync(new URL('../web/scene3d.js', import.meta.url), 'utf8'), context);
const S = context.Scene3D;
const paint = (comp, color) => ({ comp, color });

test('browser geometry comes from the delivered Blender file and every part maps to a real monitoring assembly', () => {
  const hash = createHash('sha256').update(readFileSync(new URL('../assets/MiningConveyor.blend', import.meta.url))).digest('hex');
  assert.equal(miningAsset.sha256, hash);
  assert.equal(miningParts.length, 504);
  assert.equal(new Set(miningParts.map(p => p.id)).size, 504);
  for (const p of miningParts) {
    assert.ok(COMPONENTS.some(c => c.id === p.component), `${p.name}: ${p.component}`);
    assert.ok(p.vertices.every(v => v.length === 3 && v.every(Number.isFinite)));
    assert.ok(p.faces.every(f => f.length >= 3 && f.every(i => i >= 0 && i < p.vertices.length)));
  }
  for (const c of COMPONENTS) assert.ok(miningParts.some(p => p.component === c.id), `visible assembly ${c.id}`);
  for (const absent of ['snub_pulley', 'bend_pulley', 'impact_idlers', 'pull_cord']) assert.ok(!COMPONENTS.some(c => c.id === absent));
});

test('native belt loop and parented ribs reproduce Blender travel and close continuously', () => {
  const section = miningParts.find(p => p.name === 'BELT | Moving rubber section 001');
  const initial = miningPartVertices(section, 0), next = miningPartVertices(section, 1.2);
  initial.forEach((v, i) => {
    assert.ok(Math.abs(next[i][0] - v[0] - 1.2 * MODEL_SCALE) < 1e-6);
    assert.ok(Math.abs(next[i][1] - v[1]) < 1e-6);
  });
  const loop = miningPartVertices(section, miningAsset.loopLength);
  initial.forEach((v, i) => v.forEach((n, j) => assert.ok(Math.abs(n - loop[i][j]) < 1e-6)));
  for (const transition of [10, 10 + Math.PI * .55, 20 + Math.PI * .55, miningAsset.loopLength]) {
    const a = miningPartVertices(section, transition - 1e-7), b = miningPartVertices(section, transition + 1e-7);
    assert.ok(Math.hypot(...a[0].map((n, i) => n - b[0][i])) < .001);
  }
  const rib = miningParts.find(p => p.name === 'BELT | Grip rib 01');
  assert.equal(rib.motion.kind, 'belt');
  assert.equal(rib.motion.offset, section.motion.offset);
  assert.ok(!miningParts.some(p => p.component === 'material_flow' || p.motion?.kind === 'ore'));
});

test('drum and return rotation remain synchronized and stationary meshes are invariant', () => {
  const drum = miningParts.find(p => p.name === 'DRUM | HEAD DRIVE lagged barrel');
  const ret = miningParts.find(p => p.name === 'IDLER | Return roller 01');
  assert.ok(drum.motion.rate > 0 && ret.motion.rate < 0);
  assert.notDeepEqual(miningPartVertices(drum, 0), miningPartVertices(drum, .2));
  const frame = miningParts.find(p => p.name === 'FRAME | L upper channel');
  assert.deepEqual(miningPartVertices(frame, 0), miningPartVertices(frame, 30));
  assert.notDeepEqual(miningMovingFaces(paint, { travel: 0 }), miningMovingFaces(paint, { travel: 43 }));
});

test('fault attribution reaches only the measured assembly; individual parts do not inflate monitoring counts', () => {
  const components = componentStatus({ channels: {}, metrics: [], joints: [], alarms: [{ id: 1,
    level: 'critical', family: 'idler_anomaly', evidence: JSON.stringify({ component: 'drive_bearing' }) }] });
  const index = Object.fromEntries(components.map(c => [c.id, c]));
  const count = components.length;
  indexMiningParts(index);
  assert.equal(components.length, count);
  for (const part of miningParts) assert.equal(index[part.id].state === 'critical', part.component === 'drive_bearing');
  assert.match(index[miningParts.find(p => p.component === 'drive_bearing').id].coverage, /do not diagnose this individual piece/);
});

test('WebGL and SVG select sensor assemblies while structure remains unselectable', () => {
  const faces = miningStaticFaces(paint);
  for (const component of ['drive_motor', 'belt_carcass']) {
    const selected = faces.filter(f => f.comp === component);
    assert.ok(selected.length > 0);
    const points = selected.flatMap(f => f.pts);
    const mid = [0, 1, 2].map(i => (Math.min(...points.map(p => p[i])) + Math.max(...points.map(p => p[i]))) / 2);
    const cam = { yaw: 0, pitch: .3, dist: 500, focal: 760, cx: 436, cy: 210, tx: mid[0], ty: mid[1], tz: mid[2] };
    const prepared = S.prepare(selected, cam);
    const triangle = prepared[0].projected.slice(0, 3);
    const hit = [0, 1].map(i => triangle.reduce((sum, p) => sum + p[i], 0) / 3);
    assert.equal(S.pick(prepared, ...hit), component);
    assert.match(S.render(selected, cam), new RegExp(`data-comp="${component}"`));
  }
  const frame = miningStaticFaces((comp, color) => ({ comp, color, source: comp })).filter(f => f.source === 'structural_frame');
  assert.ok(frame.length > 0 && frame.every(f => f.comp === null && !f.part));
  assert.ok(faces.every(f => !f.part));
});

test('wear inspection requires positive vision measurements and clears when damage is absent', () => {
  const joint = { id: 'J1', last: {} };
  const conveyor = { joints: [joint] };
  assert.equal(canInspectComponent('joint:J1', conveyor), false);
  joint.last = { crack_length: 0, opening: null, edge_separation: NaN };
  assert.deepEqual(visionDamageReadings(joint), []);
  assert.equal(canInspectComponent('joint:J1', conveyor), false);
  joint.last.crack_length = 12.4;
  assert.equal(canInspectComponent('joint:J1', conveyor), true);
  assert.deepEqual(visionDamageReadings(joint), [{ key: 'crack_length', label: 'Crack length', value: 12.4 }]);
  joint.last.crack_length = 0;
  assert.equal(canInspectComponent('joint:J1', conveyor), false);
  assert.equal(canInspectComponent('structural_frame', conveyor), false);
  assert.equal(canInspectComponent('drive_motor', conveyor), true);
});

test('roller and belt details expose existing Hall RPM without duplicating watched channels', () => {
  assert.deepEqual(inspectionChannels({ id: 'drive_pulley', watch: ['belt_speed', 'hall_rpm'] }), ['belt_speed', 'hall_rpm']);
  assert.deepEqual(inspectionChannels({ id: 'return_idlers', watch: [] }), ['hall_rpm']);
  assert.deepEqual(inspectionChannels({ id: 'belt_carcass', watch: [] }), ['belt_speed', 'hall_rpm']);
  assert.deepEqual(inspectionChannels({ id: 'drive_motor', watch: ['motor_rpm'] }), ['motor_rpm']);
});
