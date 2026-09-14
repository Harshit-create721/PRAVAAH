import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const context = {};
runInNewContext(readFileSync(new URL('../web/scene3d.js', import.meta.url), 'utf8'), context);
const S = context.Scene3D;
const camera = { yaw: 0, pitch: 0, dist: 500, focal: 760, cx: 436, cy: 210 };
const face = { pts: [[-20, 20, 0], [20, 20, 0], [20, -20, 0], [-20, -20, 0]],
  color: '#9badbd', comp: 'motor', material: 'steel', textureStrength: 0.35 };

test('textures retain model coordinates through orbit without changing picking or health colours', () => {
  for (const yaw of [0, -0.66, 0.9]) {
    const cam = { ...camera, yaw, pitch: 0.3 };
    const [plain] = S.prepare([{ ...face, material: null }], cam);
    const [textured] = S.prepare([face], cam);
    assert.deepEqual(textured.modelPoints, S.prepare([face], camera)[0].modelPoints);
    assert.deepEqual(textured.points, plain.points);
    assert.deepEqual(textured.color, plain.color);
    assert.equal(textured.material, 1);
    assert.equal(textured.textureStrength, 0.35);
    assert.equal(S.pick([textured], cam.cx, cam.cy), 'motor');
  }
});

test('near-plane clipping interpolates model coordinates with the projected surface', () => {
  const cam = { ...camera, dist: 0 };
  const crossing = { ...face, twoSided: true, material: 'rubber',
    pts: [[-3, -3, -2], [3, -3, 3], [3, 3, 3], [-3, 3, -2]] };
  const [prepared] = S.prepare([crossing], cam);
  assert.equal(prepared.material, 2);
  assert.equal(prepared.modelPoints.length, prepared.points.length);
  prepared.modelPoints.forEach((point, index) => {
    assert.ok(point.every(Number.isFinite));
    assert.ok(S.project(point, cam).every((value, axis) => Math.abs(value - prepared.projected[index][axis]) < 1e-8));
  });
});

test('status bands stay exact and the SVG texture overlay cannot intercept component clicks', () => {
  const status = { ...face, flat: true, color: '#cc3a2e' };
  assert.equal(S.prepare([status], camera)[0].material, 0);
  const flat = S.render([status], camera);
  assert.ok(flat.includes('fill="#cc3a2e"'));
  assert.ok(!flat.includes('url(#surface-'));
  const textured = S.render([face], camera);
  assert.match(textured, /fill="url\(#surface-steel\)"[^>]+pointer-events="none"/);
  assert.equal((textured.match(/data-comp="motor"/g) ?? []).length, 1);
  assert.ok(!S.render([face], camera, false).includes('url(#surface-'));
  assert.ok(!S.render([{ ...face, material: 'unknown' }], camera).includes('<pattern'));
});

function rendererFixture() {
  const uploads = [], draws = [], shaders = [], attributes = [];
  const methods = {
    getShaderPrecisionFormat: () => ({ precision: 23 }),
    createShader: type => ({ type }),
    shaderSource: (shader, source) => { shaders.push({ type: shader.type, source }); },
    getShaderParameter: () => true, getProgramParameter: () => true,
    createProgram: () => ({}), createBuffer: () => ({}),
    getAttribLocation: (_, name) => name, getUniformLocation: (_, name) => name,
    isContextLost: () => false,
    bufferData: (_, data) => uploads.push(Array.from(data)),
    drawArrays: (_, start, count) => draws.push({ start, count }),
    vertexAttribPointer: (...args) => attributes.push(args),
  };
  const gl = new Proxy(methods, { get: (target, key) => target[key] ?? (/^[A-Z_]+$/.test(key) ? key : () => {}) });
  const events = {};
  const canvas = { clientWidth: 872, clientHeight: 420, getContext: () => gl,
    addEventListener: (name, callback) => { events[name] = callback; } };
  const runtime = { devicePixelRatio: 1 };
  runInNewContext(readFileSync(new URL('../web/webgl3d.js', import.meta.url), 'utf8'), runtime);
  const viewport = new runtime.ConveyorViewport(canvas, () => {});
  return { viewport, uploads, draws, shaders, attributes, events };
}

test('WebGL uploads aligned material coordinates and texture toggles leave geometry unchanged', () => {
  const f = rendererFixture();
  const faces = S.prepare([face], camera);
  assert.equal(f.viewport.draw(faces, camera), true);
  assert.equal(f.draws[0].count, 6);
  assert.equal(f.uploads[0].length, 6 * 11);
  assert.ok(f.uploads[0].every(Number.isFinite));
  assert.ok(f.attributes.every(a => a[4] === 44));
  for (let i = 0; i < f.uploads[0].length; i += 11) {
    assert.equal(f.uploads[0][i + 9], 1);
    assert.ok(Math.abs(f.uploads[0][i + 10] - 0.35) < 1e-6);
  }
  f.viewport.draw(faces, camera, null, false);
  for (let i = 0; i < f.uploads[1].length; i += 11) {
    assert.equal(f.uploads[1][i + 9], 0);
    assert.deepEqual(f.uploads[1].slice(i, i + 9), f.uploads[0].slice(i, i + 9));
  }
});

test('textured inspection retains the selected depth layer and recovers after WebGL context loss', () => {
  const f = rendererFixture();
  const faces = S.prepare([face, { ...face, comp: 'belt', material: 'rubber' }], camera);
  f.viewport.draw(faces, camera, 'motor');
  assert.equal(f.uploads.length, 2);
  assert.equal(f.uploads[0][9], 2);
  assert.equal(f.uploads[1][9], 1);
  f.events.webglcontextlost({ preventDefault() {} });
  assert.equal(f.viewport.draw(faces, camera), false);
  f.events.webglcontextrestored();
  assert.equal(f.viewport.draw(faces, camera), true);
});

test('motion frames retain stationary GPU buffers and invalidate them for selection/textures', () => {
  const f = rendererFixture();
  const fixed = S.prepare([face], camera);
  const moving = S.prepare([{ ...face, comp: 'belt', material: 'rubber' }], camera);
  const all = [...fixed, ...moving];
  f.viewport.draw(all, camera, null, true, fixed);
  assert.equal(f.uploads.length, 2);
  f.viewport.draw(all, camera, null, true, fixed);
  assert.equal(f.uploads.length, 3, 'only moving geometry is uploaded again');
  f.viewport.draw(all, camera, null, false, fixed);
  assert.equal(f.uploads.length, 5, 'texture change rebuilds stationary material attributes');
  f.viewport.draw(all, camera, 'motor', true, fixed);
  assert.equal(f.uploads.length, 9, 'selection prepares dimmed context and selected part buffers');
  f.viewport.draw(all, camera, 'motor', true, fixed);
  assert.equal(f.uploads.length, 11, 'both stationary selection buffers are reused');
});
