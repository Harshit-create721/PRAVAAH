import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { motionReading, advanceMotion, motionFaces, miningMaterialFaces, rollerMotionFaces } from '../web/belt-motion.js';

// Exercise the real app scene/controller against a small DOM adapter. No fake
// readings reach the running gateway or database.
export function sceneFixture() {
  const elements = new Map(), pending = new Map(), listeners = {}, uploads = [];
  let nextFrame = 0, now = 1780000000000, labelBuilds = 0;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { dataset: {}, innerHTML: '', childNodes: [],
      attrs: { 'aria-pressed': 'true' }, contains: () => false, querySelectorAll: () => [],
      getAttribute(name) { return this.attrs[name]; }, setAttribute(name, value) { this.attrs[name] = value; },
      replaceChildren() { this.innerHTML = ''; this.childNodes = []; } });
    return elements.get(id);
  };
  const context = createContext({ motionReading, advanceMotion, motionFaces, miningMaterialFaces, rollerMotionFaces, $: element,
    storage: { get: () => null, set() {} }, matchMedia: () => ({ matches: false, addEventListener() {} }),
    IntersectionObserver: class { constructor(callback) { listeners.intersection = callback; } observe() {} },
    document: { hidden: false, activeElement: null, addEventListener: (name, fn) => { listeners[name] = fn; } },
    requestAnimationFrame: fn => { const id = ++nextFrame; pending.set(id, fn); return id; },
    cancelAnimationFrame: id => pending.delete(id), gatewayLive: () => true,
    snap: { server: { now }, nodes: [] }, snapshotReceivedAt: now,
    Date: class extends Date { static now() { return now; } },
    VIEWS: {}, RISK_COLOR: {}, plantTime: () => '12:00:00 IST',
    buildLabels: () => { labelBuilds++; return '<text>Stable labels</text>'; }, wireHits() {},
    renderSchematicSummary() {}, fatal: (where, error) => { throw new Error(`${where}: ${error.stack}`); },
    uploads,
  });
  runInContext(readFileSync(new URL('../web/scene3d.js', import.meta.url), 'utf8'), context);
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const block = app.slice(app.indexOf('const COMP_COLOR ='), app.indexOf('/**\n * Format a sensor marker'));
  runInContext(block + `
    viewport = { draw(faces) { uploads.push(faces); return true; } };
    globalThis.controller = { renderSchematic, drawScene, paintScene,
      motion: () => ({ ...motion }), cache: () => sceneCache,
      svgFallback: () => { viewport = null; paintScene(); } };
  `, context);
  return { context, element, listeners, uploads,
    labels: () => labelBuilds,
    step(at) { now = 1780000000000 + at; const batch = [...pending.values()]; pending.clear(); batch.forEach(fn => fn(at)); },
    pending: () => pending.size,
  };
}

const cv = () => ({ id: 'CV-01', geometry: { model: 'bench', beltLengthM: 1.2 }, components: [], joints: [],
  channels: { belt_speed: { value: .4, ts: 1780000000000, state: 'live' } } });

test('animation reuses static geometry/labels, changes surfaces and retains the SVG fallback', () => {
  const f = sceneFixture();
  f.context.controller.renderSchematic(cv());
  f.step(0);
  const cache = f.context.controller.cache();
  const first = f.uploads.at(-1);
  for (let time = 40; time <= 400; time += 40) f.step(time);
  assert.equal(f.context.controller.cache(), cache);
  assert.equal(f.labels(), 1);
  assert.ok(f.context.controller.motion().phase > .1);
  assert.notDeepEqual(f.uploads.at(-1).at(-1).modelPoints, first.at(-1).modelPoints);
  f.context.controller.svgFallback();
  assert.equal(f.element('schematic').dataset.renderer, 'svg');
  assert.match(f.element('sceneSurfaces').innerHTML, /data-comp="belt_tracking"/);
  assert.equal(f.labels(), 1);
});

test('pause, visibility loss, zero speed and a replay gap stop the actual animation scheduler', () => {
  const f = sceneFixture();
  f.context.controller.renderSchematic(cv()); f.step(0); f.step(100);
  const phase = f.context.controller.motion().phase;
  f.element('modelMotion').onclick();
  f.step(300);
  assert.equal(f.context.controller.motion().phase, phase);
  assert.equal(f.pending(), 0);
  f.element('modelMotion').onclick(); f.step(400); f.step(500);
  assert.ok(f.context.controller.motion().phase > phase);
  f.listeners.intersection([{ isIntersecting: false }]);
  assert.equal(f.pending(), 0);
  const hiddenPhase = f.context.controller.motion().phase;
  f.listeners.intersection([{ isIntersecting: true }]); f.step(900);
  assert.equal(f.context.controller.motion().phase, hiddenPhase);
  const stopped = cv(); stopped.channels.belt_speed.value = 0;
  f.context.controller.renderSchematic(stopped); f.step(1000);
  assert.equal(f.pending(), 0);
  assert.match(f.element('motionStatus').textContent, /Belt stopped/);
  const replay = cv(); replay.channels.belt_speed.node = 'esp32-marker-01';
  replay.playback = { rate: 1, recorded_at_ms: 1788715800166 };
  f.context.snap.nodes = [{ node: 'esp32-marker-01', state: 'offline' }];
  f.context.controller.renderSchematic(replay); f.step(1100);
  assert.equal(f.pending(), 0);
  assert.match(f.element('motionStatus').textContent, /speed unavailable/);
  assert.match(f.element('motionSource').textContent, /Recorded playback/);
});
