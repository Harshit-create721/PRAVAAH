import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { motionReading, advanceMotion, beltStation, loopLength, motionFaces, materialPosition, miningMaterialFaces, rollerMotionFaces } from '../web/belt-motion.js';

const model = { x0: -215, x1: 215, cy: 0, r: 25, face: 94, taper: 82 };
const stamp = 1780000000000;
const conveyor = (value = 0.4) => ({ geometry: { beltLengthM: 1.2 },
  channels: { belt_speed: { value, ts: stamp, state: 'live' } } });
const read = (cv, extra = {}) => motionReading(cv, { connected: true, now: stamp, ...extra });
const initial = () => ({ phase: 0, rotation: 0, at: null });

test('speed and measured loop length determine travel, independently of frame rate', () => {
  const drive = read(conveyor());
  const results = [20, 30, 60].map(fps => {
    const state = initial();
    for (let frame = 0; frame <= fps; frame++) advanceMotion(state, drive, frame * 1000 / fps, model);
    assert.ok(Math.abs(state.phase - 1 / 3) < 1e-10);
    return state;
  });
  assert.ok(Math.abs(results[0].rotation - results[2].rotation) < 1e-10);
  const state = initial();
  advanceMotion(state, drive, 0, model);
  advanceMotion(state, drive, 250, model);
  const first = state.phase;
  advanceMotion(state, read(conveyor(0.8)), 500, model);
  assert.ok(Math.abs((state.phase - first) - first * 2) < 1e-10);
});

test('zero, lost, invalid, future, unhealthy and unconfigured inputs cannot move the model', () => {
  const cases = [
    [conveyor(0), {}, 'stopped'], [conveyor(), { enabled: false }, 'paused'],
    [conveyor(), { connected: false }, 'unavailable'], [conveyor(), { nodeOnline: false }, 'unavailable'],
    [conveyor(), { now: stamp + 3001 }, 'unavailable'], [conveyor(), { now: stamp - 1001 }, 'unavailable'],
    [conveyor(null), {}, 'unavailable'], [conveyor(NaN), {}, 'unavailable'], [conveyor(-1), {}, 'unavailable'],
    [{ ...conveyor(), sensorHealth: { speed: 'fault' } }, {}, 'unavailable'],
    [{ ...conveyor(), geometry: { beltLengthM: null } }, {}, 'unconfigured'],
    [{ ...conveyor(), channels: { belt_speed: { value: .4, ts: stamp, state: 'offline' } } }, {}, 'unavailable'],
  ];
  for (const [cv, opts, expected] of cases) {
    const reading = read(cv, opts), state = { phase: .4, rotation: 1, at: 0 };
    assert.equal(reading.status, expected);
    advanceMotion(state, reading, 250, model);
    assert.equal(state.phase, .4);
    assert.equal(state.rotation, 1);
  }
});

test('suspension and pause do not cause a catch-up jump; restarting retains belt position', () => {
  const state = { phase: .4, rotation: 1, at: 0 };
  advanceMotion(state, read(conveyor()), 60000, model);
  assert.ok(Math.abs(state.phase - (.4 + .25 / 3)) < 1e-10);
  const phase = state.phase;
  advanceMotion(state, read(conveyor(), { enabled: false }), 60100, model);
  state.at = null;
  advanceMotion(state, read(conveyor()), 120000, model);
  assert.equal(state.phase, phase);
});

test('bands follow a continuous closed path with the return run moving in reverse', () => {
  const run = model.x1 - model.x0, arc = Math.PI * model.r, length = loopLength(model);
  const close = (a, b) => assert.ok(Math.hypot(...a.map((v, i) => v - b[i])) < .003);
  for (const distance of [0, run, run + arc, 2 * run + arc, length]) {
    close(beltStation(distance - .001, model).p, beltStation(distance + .001, model).p);
  }
  assert.ok(beltStation(101, model).p[0] > beltStation(100, model).p[0]);
  assert.ok(beltStation(run + arc + 101, model).p[0] < beltStation(run + arc + 100, model).p[0]);
  close(beltStation(length + 70, model).p, beltStation(70, model).p);
});

test('moving marks render in both model variants and preserve component picking', () => {
  const context = {};
  runInNewContext(readFileSync(new URL('../web/scene3d.js', import.meta.url), 'utf8'), context);
  const scene = context.Scene3D;
  const camera = { yaw: -.66, pitch: .36, dist: 1000, focal: 1420, cx: 436, cy: 210 };
  for (const bench of [true, false]) {
    const opts = { width: 80, troughRise: bench ? 0 : .42, flat: .34, cols: 6 };
    const paint = (comp, color) => ({ comp, color });
    const a = motionFaces(scene, model, opts, initial(), paint, bench);
    const b = motionFaces(scene, model, opts, { phase: .08, rotation: 1 }, paint, bench);
    assert.notDeepEqual(a[0].pts, b[0].pts);
    assert.ok(b.every(f => f.pts.flat().every(Number.isFinite)));
    assert.ok(b.every(f => ['belt_tracking', 'belt_carcass', 'drive_pulley', 'tail_pulley'].includes(f.comp)));
    assert.ok(scene.prepare(b, camera).length > 0);
    assert.match(scene.render(b, camera), /data-comp="belt_tracking"/);
    assert.ok(b.some(f => f.pts.some(p => p[1] < -model.r)));
  }
});

test('the supplied BeltData speed drives approximately one lap per 2.9 seconds', () => {
  const frames = readFileSync(new URL('../BeltData/2026-09-06T17-29-57.647Z-a70e3e55-cleaned-v1/telemetry.frames.jsonl', import.meta.url), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
  const sample = frames.find(frame => Number.isFinite(frame.payload.belt_speed));
  const reading = read(conveyor(sample.payload.belt_speed));
  assert.equal(reading.status, 'moving');
  assert.ok(1 / reading.loopsPerSecond > 2.8 && 1 / reading.loopsPerSecond < 3);
});

test('coal enters from the hopper, moves downstream, and falls beyond the head without lap resets', () => {
  const run = model.x1 - (model.x0 + 52);
  const feed = materialPosition(0, 20, model);
  const carry = materialPosition(0, 80, model);
  const later = materialPosition(0, 90, model);
  const discharge = materialPosition(0, 48 + run + 35, model);
  const fallen = materialPosition(0, 48 + run + 70, model);
  assert.equal(feed.stage, 'feed');
  assert.ok(feed.p[1] > carry.p[1]);
  assert.equal(carry.stage, 'carrying');
  assert.equal(later.p[0] - carry.p[0], 10);
  assert.equal(discharge.stage, 'discharge');
  assert.ok(discharge.p[0] > model.x1 && fallen.p[1] < discharge.p[1]);
  for (const boundary of [48, 48 + run]) {
    const before = materialPosition(0, boundary - .001, model).p;
    const after = materialPosition(0, boundary + .001, model).p;
    assert.ok(Math.hypot(...after.map((v, i) => v - before[i])) < .02);
  }
  const state = { phase: .999, rotation: 1, travel: loopLength(model) * .999, at: 0 };
  const before = state.travel;
  advanceMotion(state, read(conveyor()), 100, model);
  assert.ok(state.phase < .1 && state.travel > before);
});

test('mining material and idler surfaces change with travel and remain fixed while paused', () => {
  const context = {};
  runInNewContext(readFileSync(new URL('../web/scene3d.js', import.meta.url), 'utf8'), context);
  const scene = context.Scene3D, opts = { width: 80, troughRise: .42, flat: .34, cols: 6 };
  const state = { phase: .2, rotation: 1, travel: 220, at: 0 };
  const before = miningMaterialFaces(scene, model, opts, state);
  advanceMotion(state, read(conveyor(), { enabled: false }), 100, model);
  assert.deepEqual(miningMaterialFaces(scene, model, opts, state), before);
  advanceMotion(state, read(conveyor()), 200, model);
  const after = miningMaterialFaces(scene, model, opts, state);
  assert.notDeepEqual(after, before);
  assert.ok(after.every(face => face.pts.flat().every(Number.isFinite)));
  const roller = angle => rollerMotionFaces([0, 0, -15], [0, 10, 35], 7, angle, { color: '#718792', comp: 'idlers' });
  assert.notDeepEqual(roller(0), roller(1));
  assert.ok(roller(1).every(f => f.comp === 'idlers' && f.pts.flat().every(Number.isFinite)));
});
