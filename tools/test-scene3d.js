// Tests for the 3D pipeline in web/scene3d.js.
//
//   node tools/test-scene3d.js
//
// Pure geometry - no sensor data, real or otherwise, is involved. The renderer
// is the one part of the dashboard that can be wrong in a way you cannot see
// by looking at it, so it gets checked against arithmetic instead.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(import.meta.dirname, '..', 'web', 'scene3d.js'), 'utf8');
// eslint-disable-next-line no-eval
(0, eval)(src);
const S = globalThis.Scene3D;

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
};
const faces = (html) => (html.match(/<polygon/g) ?? []).length;
const CAM = { yaw: 0, pitch: 0, dist: 500, focal: 760, cx: 400, cy: 200 };

console.log('\nprojection');
{
  const o = S.project([0, 0, 0], CAM);
  ok('origin lands on the camera centre', Math.abs(o[0] - 400) < 1e-9 && Math.abs(o[1] - 200) < 1e-9);
  ok('+y is up, so screen y decreases', S.project([0, 50, 0], CAM)[1] < o[1]);
  ok('depth grows away from the camera', S.project([0, 0, 200], CAM)[2] > S.project([0, 0, -200], CAM)[2]);

  const near = Math.abs(S.project([50, 0, -200], CAM)[0] - 400);
  const far = Math.abs(S.project([50, 0, 200], CAM)[0] - 400);
  ok('perspective makes nearer things bigger', near > far);

  const p = S.project([100, 0, 0], { ...CAM, yaw: Math.PI / 2 });
  ok('yaw of 90 deg swings +x into depth', Math.abs(p[0] - 400) < 1e-6 && p[2] > CAM.dist);
}

console.log('\ngeometry');
{
  const b = S.box([0, 0, 0], [10, 10, 10], { color: '#ffffff' });
  ok('a box is 6 quads', b.length === 6 && b.every((f) => f.pts.length === 4));
  ok('every box normal points outward', b.every((f) => {
    const n = S.faceNormal(f.pts);
    const c = f.pts.reduce((a, q) => [a[0] + q[0] / 4, a[1] + q[1] / 4, a[2] + q[2] / 4], [0, 0, 0]);
    return S.dot(n, S.norm(c)) > 0.9;
  }));

  ok('a cylinder is segs sides plus 2 caps', S.cylinderZ([0, 0, 0], 10, 20, 12, {}).length === 14);

  const prof = S.beltProfile(-100, 100, 0, 20, 8);
  const ys = prof.map((q) => q[1]);
  ok('the belt profile reaches both runs', Math.max(...ys) > 19.9 && Math.min(...ys) < -19.9);
  ok('a closed ribbon has one quad per profile edge', S.ribbon(prof, 50, {}).length === prof.length);
  ok('an open ribbon has one fewer', S.ribbon(prof, 50, {}, false).length === prof.length - 1);
}

console.log('\nback-face culling');
{
  // The camera sits at the origin looking along +z, so a face you can see has
  // a normal pointing back toward -z.
  const toward = { pts: [[-10, 10, -50], [10, 10, -50], [10, -10, -50], [-10, -10, -50]], color: '#fff' };
  const away = { pts: [...toward.pts].reverse(), color: '#fff' };
  ok('a visible face normal points at the camera', S.faceNormal(toward.pts)[2] === -1);
  ok('a face turned toward the camera renders', faces(S.render([toward], CAM)) === 1);
  ok('a face turned away is dropped', faces(S.render([away], CAM)) === 0);
  ok('twoSided opts out of culling', faces(S.render([{ ...away, twoSided: true }], CAM)) === 1);

  // How many faces of a cube you can see is fixed by which axes are oblique:
  // straight on you see 1, turned you see 2, turned and tilted you see 3.
  const box = () => S.box([0, 0, 0], [20, 20, 20], { color: '#888' });
  ok('square on, a cube shows 1 face', faces(S.render(box(), CAM)) === 1);
  ok('yawed, a cube shows 2', faces(S.render(box(), { ...CAM, yaw: 0.4 })) === 2);
  ok('pitched, a cube shows 2', faces(S.render(box(), { ...CAM, pitch: 0.4 })) === 2);
  for (const yaw of [0.4, 1.1, 2.3, -0.7]) {
    ok(`yawed ${yaw} and pitched, a cube shows 3`, faces(S.render(box(), { ...CAM, yaw, pitch: 0.42 })) === 3);
  }

  // Culling against the camera-to-face vector rather than the view axis is
  // what keeps this correct for geometry far off the centre of frame.
  const off = S.box([260, 40, 0], [20, 20, 20], { color: '#888' });
  ok('an off-centre cube still shows 3', faces(S.render(off, { ...CAM, yaw: 0.5, pitch: 0.42 })) === 3);

  const n = faces(S.render(S.cylinderZ([0, 0, 0], 10, 20, 12, {}), { ...CAM, yaw: 0.5, pitch: 0.42 }));
  ok(`a closed cylinder culls to about half (${n})`, n >= 6 && n <= 9);
}

console.log('\ndepth sort and output');
{
  const far = { pts: [[-5, 5, -100], [5, 5, -100], [5, -5, -100], [-5, -5, -100]], color: '#111111' };
  const near = { pts: [[-5, 5, -300], [5, 5, -300], [5, -5, -300], [-5, -5, -300]], color: '#eeeeee' };
  const order = [...S.render([far, near], CAM).matchAll(/fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
  ok('both faces survive', order.length === 2);
  // Painter's algorithm: whatever is nearer must be written last so it wins.
  const lum = (h) => parseInt(h.slice(1, 3), 16) + parseInt(h.slice(3, 5), 16) + parseInt(h.slice(5, 7), 16);
  ok('the nearer face is painted last', lum(order[1]) > lum(order[0]));

  ok('a component id reaches the polygon',
    S.render([{ ...near, comp: 'drive_pulley' }], CAM).includes('data-comp="drive_pulley"'));
  ok('faces with no component are click-through',
    S.render([near], CAM).includes('pointer-events="none"'));
  // The camera sits `dist` in front of the origin, so anything at model
  // z <= -dist has passed behind it and must not be drawn.
  const behind = -CAM.dist - 100;
  ok('a face behind the camera is skipped',
    faces(S.render([{ pts: [[-5, 5, behind], [5, 5, behind], [5, -5, behind], [-5, -5, behind]], color: '#fff', twoSided: true }], CAM)) === 0);
  ok('the same face in front is drawn',
    faces(S.render([{ pts: [[-5, 5, -100], [5, 5, -100], [5, -5, -100], [-5, -5, -100]], color: '#fff', twoSided: true }], CAM)) === 1);
  ok('a face with no colour renders instead of throwing',
    faces(S.render([{ pts: [[-5, 5, -100], [5, 5, -100], [5, -5, -100], [-5, -5, -100]] }], CAM)) === 1);
}

console.log('\nshading');
{
  const lit = S.shade('#6f9e46', [0, 1, 0]);
  const dark = S.shade('#6f9e46', [0, -1, 0]);
  const lum = (h) => parseInt(h.slice(1, 3), 16) + parseInt(h.slice(3, 5), 16) + parseInt(h.slice(5, 7), 16);
  ok('a face toward the light is brighter', lum(lit) > lum(dark));
  ok('shaded output is always valid hex', /^#[0-9a-f]{6}$/.test(lit) && /^#[0-9a-f]{6}$/.test(dark));
  ok('an unlit face stays visible, not black', lum(dark) > 40);
  ok('white cannot overflow its channels', /^#[0-9a-f]{6}$/.test(S.shade('#ffffff', [0, 1, 0])));
  // `flat` faces keep their exact status colour - a risk colour must not be
  // dimmed by which way the belt happens to be facing.
  ok('flat faces keep their exact colour',
    S.render([{ pts: [[-5, 5, -100], [5, 5, -100], [5, -5, -100], [-5, -5, -100]], color: '#cc3a2e', flat: true }], CAM)
      .includes('fill="#cc3a2e"'));
}

console.log('\nlofted geometry');
{
  // cylinderBetween has to agree with cylinderZ when the axis IS +z, or the
  // troughing wing rolls will be lit differently from the centre roll they
  // butt against and the idler set will look broken.
  const a = S.cylinderZ([0, 0, 0], 10, 20, 12, {});
  const b = S.cylinderBetween([0, 0, -10], [0, 0, 10], 10, 12, {});
  ok('cylinderBetween has the same face count as cylinderZ', a.length === b.length);
  const outward = (f) => {
    const n = S.faceNormal(f.pts);
    const c = f.pts.reduce((q, r) => [q[0] + r[0] / 4, q[1] + r[1] / 4, q[2] + r[2] / 4], [0, 0, 0]);
    // Sides only: a cap's centroid is on the axis, so this test says nothing
    // about it. Sides are what make the shading of a tilted roll right.
    return Math.hypot(c[0], c[1]) < 1e-9 || S.dot(n, S.norm([c[0], c[1], 0])) > 0.9;
  };
  ok('every side normal of an axis-aligned cylinder points outward', b.every(outward));

  const tilted = S.cylinderBetween([0, 0, 0], [0, 30, 40], 6, 10, {});
  ok('a tilted cylinder is segs sides plus 2 caps', tilted.length === 12);
  ok('a tilted cylinder has no NaN vertices',
    tilted.every((f) => f.pts.every((q) => q.every(Number.isFinite))));
  const ends = tilted.flatMap((f) => f.pts);
  ok('a tilted cylinder spans its two endpoints',
    Math.min(...ends.map((q) => q[1])) < 6.1 && Math.max(...ends.map((q) => q[1])) > 23.9);

  // A cylinder straight up the y axis is the case the naive basis breaks on.
  const vertical = S.cylinderBetween([0, -20, 0], [0, 20, 0], 5, 8, {});
  ok('a vertical cylinder has no NaN vertices',
    vertical.every((f) => f.pts.every((q) => q.every(Number.isFinite))));

  const secs = [
    [[0, 0, -10], [0, 0, 0], [0, 0, 10]],
    [[10, 0, -10], [10, 0, 0], [10, 0, 10]],
    [[20, 0, -10], [20, 0, 0], [20, 0, 10]],
  ];
  ok('an open loft is (sections-1) x (cols-1) quads', S.loft(secs, {}).length === 4);
  ok('a closed loft wraps back to the first section', S.loft(secs, {}, true).length === 6);
  ok('a loft of ragged sections does not overrun',
    S.loft([[[0, 0, 0], [0, 0, 5]], [[1, 0, 0], [1, 0, 5], [1, 0, 9]]], {}).length === 1);
}

console.log('\nbelt path and trough');
{
  const path = S.beltPath({ x0: -100, x1: 100, cy: 0, r: 20, runSegs: 10, wrapSegs: 6, taper: 40 });
  ok('the path closes into a loop', path.length === 11 + 5 + 11 + 5);
  ok('every station carries a normal and a trough',
    path.every((st) => st.n.length === 2 && Number.isFinite(st.trough)));
  ok('trough is only ever 0..1', path.every((st) => st.trough >= 0 && st.trough <= 1));

  const carry = path.filter((st) => st.n[1] > 0.99);
  const ret = path.filter((st) => st.n[1] < -0.99);
  ok('the carrying run is troughed somewhere', carry.some((st) => st.trough > 0.9));
  // This is the physical claim the picture is making: the belt flattens as it
  // runs into a pulley, and it is dead flat all the way round the return.
  ok('the belt flattens into both pulleys',
    carry[0].trough === 0 && carry.at(-1).trough === 0);
  ok('the return run is never troughed', ret.every((st) => st.trough === 0));

  const opts = { width: 80, troughRise: 0.42, flat: 0.34, cols: 6 };
  const mid = S.beltSection(carry.find((st) => st.trough > 0.9), opts);
  ok('a section spans the belt width', Math.abs(mid[0][2] + 40) < 1e-9 && Math.abs(mid.at(-1)[2] - 40) < 1e-9);
  ok('the wings sit above the centre of the trough',
    mid[0][1] > mid[3][1] + 10 && mid.at(-1)[1] > mid[3][1] + 10);
  ok('the trough is symmetric', Math.abs(mid[0][1] - mid.at(-1)[1]) < 1e-9);

  const flatSec = S.beltSection(ret[2], opts);
  ok('a return section is flat across the width',
    flatSec.every((q) => Math.abs(q[1] - flatSec[0][1]) < 1e-9));

  // `lift` is how the splice bands and the load ride ON the belt rather than
  // z-fighting it, so it has to displace along the surface normal.
  const lifted = S.beltSection(ret[2], { ...opts, lift: 5 });
  ok('lift displaces along the surface normal', lifted[0][1] < flatSec[0][1] - 4.9);
}

console.log('\npitch puts the camera above the machine');
{
  const UP = { ...CAM, pitch: 0.5 };
  // The regression this guards: with the pitch sign flipped, the machine is
  // rendered from underneath. Faces still shade plausibly, so it looks almost
  // right - but every stringer and leg counts as nearer than the belt and
  // paints straight over it, and the load disappears under its own frame.
  ok('looking down, the top of the model is nearer',
    S.project([0, 100, 0], UP)[2] < S.project([0, -100, 0], UP)[2]);
  ok('looking down, the far end of the model is higher on screen',
    S.project([0, 0, 200], UP)[1] < S.project([0, 0, -200], UP)[1]);
  ok('a taller point still draws higher on screen',
    S.project([0, 100, 0], UP)[1] < S.project([0, 0, 0], UP)[1]);

  // An upward-facing deck is visible from above and hidden from below.
  const deck = (y, color) => ({
    pts: [[-30, y, -30], [-30, y, 30], [30, y, 30], [30, y, -30]], color,
  });
  ok('an up-facing deck is drawn when the camera is above it',
    faces(S.render([deck(0, '#cccccc')], UP)) === 1);
  ok('the same deck is culled when the camera is below it',
    faces(S.render([deck(0, '#cccccc')], { ...CAM, pitch: -0.5 })) === 0);

  // Painter's order: the higher deck must be written last, so it wins.
  const order = [...S.render([deck(0, '#111111'), deck(60, '#eeeeee')], UP)
    .matchAll(/fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
  const lum = (h) => parseInt(h.slice(1, 3), 16) + parseInt(h.slice(3, 5), 16) + parseInt(h.slice(5, 7), 16);
  ok('two stacked decks both draw', order.length === 2);
  ok('the upper deck paints over the lower one', lum(order[1]) > lum(order[0]));

  // The same claim in the terms of the machine: a belt above its stringer.
  const belt = { pts: [[-200, 25, -40], [-200, 25, 40], [200, 25, 40], [200, 25, -40]], color: '#eeeeee', twoSided: true };
  const stringer = { pts: [[-200, -41, -56], [-200, -41, 56], [200, -41, 56], [200, -41, -56]], color: '#111111', twoSided: true };
  const belted = [...S.render([stringer, belt], { ...CAM, yaw: -0.66, pitch: 0.4, dist: 1150, focal: 1360 })
    .matchAll(/fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
  ok('the belt paints over the stringer that carries it', lum(belted[1]) > lum(belted[0]));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
