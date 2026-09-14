// Belt travel is scaled by the measured FULL loop length, not motor RPM.
// Hall speed has no direction/position information: marks illustrate motion,
// and are not tracked splices or a measurement of pulley rotation.
export function motionReading(cv, { connected, now, enabled = true, nodeOnline = true }) {
  const channel = cv?.channels?.belt_speed;
  const length = cv?.geometry?.beltLengthM;
  const age = now - channel?.ts;
  const valid = connected && nodeOnline && channel?.state === 'live'
    && Number.isFinite(channel.ts) && age >= -1000 && age <= 3000
    && Number.isFinite(channel.value) && channel.value >= 0
    && (!cv.sensorHealth?.speed || cv.sensorHealth.speed === 'healthy');
  if (!valid) return { status: 'unavailable', speed: null, loopsPerSecond: 0 };
  const speed = channel.value;
  if (!(Number.isFinite(length) && length > 0)) return { status: 'unconfigured', speed, loopsPerSecond: 0 };
  if (!enabled) return { status: 'paused', speed, loopsPerSecond: 0 };
  return { status: speed === 0 ? 'stopped' : 'moving', speed, loopsPerSecond: speed / length };
}

export const loopLength = ({ x0, x1, r }) => 2 * (x1 - x0) + 2 * Math.PI * r;
const wrap = (value, period) => ((value % period) + period) % period;

/** An exact station on the closed path, including both pulley wraps. */
export function beltStation(distance, model) {
  const { x0, x1, cy, r, taper = 70 } = model;
  const run = x1 - x0;
  let s = wrap(distance, loopLength(model));
  if (s <= run) {
    const x = x0 + s;
    return { p: [x, cy + r], n: [0, 1], trough: Math.max(0, Math.min(1, (x - x0) / taper, (x1 - x) / taper)) };
  }
  s -= run;
  if (s < Math.PI * r) {
    const a = Math.PI / 2 - s / r;
    return { p: [x1 + r * Math.cos(a), cy + r * Math.sin(a)], n: [Math.cos(a), Math.sin(a)], trough: 0 };
  }
  s -= Math.PI * r;
  if (s <= run) return { p: [x1 - s, cy - r], n: [0, -1], trough: 0 };
  const a = -Math.PI / 2 - (s - run) / r;
  return { p: [x0 + r * Math.cos(a), cy + r * Math.sin(a)], n: [Math.cos(a), Math.sin(a)], trough: 0 };
}

/** Integrate elapsed time, never snapshot count; don't catch up after suspension. */
export function advanceMotion(state, reading, at, model) {
  const dt = state.at === null ? 0 : Math.max(0, Math.min(0.25, (at - state.at) / 1000));
  state.at = at;
  if (reading.status !== 'moving') return state;
  const loops = reading.loopsPerSecond * dt;
  state.travel = (state.travel ?? 0) + loops * loopLength(model);
  state.phase = wrap(state.phase + loops, 1);
  state.rotation = wrap(state.rotation - loops * loopLength(model) / model.r, Math.PI * 2);
  return state;
}

/** Moving surface bands and pulley index marks share the scene's depth/picking. */
export function motionFaces(scene, model, sectionOptions, state, paint, bench) {
  const faces = [], length = loopLength(model);
  const marking = (id, base) => {
    const attrs = paint(id, base);
    // Retain the part's status hue, but keep marks visible on a coloured part.
    if (attrs.color !== base) attrs.color = '#' + attrs.color.slice(1).match(/../g)
      .map(hex => Math.round(parseInt(hex, 16) * .72).toString(16).padStart(2, '0')).join('');
    return attrs;
  };
  // Fine transverse tread marks. They follow the complete loop, including return.
  for (let i = 0; i < 14; i++) {
    const distance = (i / 14 + state.phase) * length;
    const station = beltStation(distance, model);
    const id = station.n[1] < -0.5 ? 'belt_carcass' : 'belt_tracking';
    const sections = [-1.6, 0, 1.6].map(offset => scene.beltSection(beltStation(distance + offset, model),
      { ...sectionOptions, lift: 0.65, scale: 0.94 }));
    faces.push(...scene.loft(sections, { ...marking(id, '#72888d'), material: null, twoSided: true, edge: false }));
  }
  // A contrasting radial mark on each end face makes the otherwise round,
  // featureless pulley visibly rotate. Bearings and motor housings stay fixed.
  for (const [x, id] of [[model.x0, 'tail_pulley'], [model.x1, 'drive_pulley']]) {
    for (const side of [-1, 1]) {
      const z = side * (model.face / 2 + (bench ? 0.2 : 2.5));
      const point = (radius, angle) => [x + radius * Math.cos(angle), model.cy + radius * Math.sin(angle), z];
      for (let spoke = 0; spoke < 3; spoke++) {
        const a = state.rotation + spoke * Math.PI * 2 / 3;
        faces.push({ pts: [point(12, a - 0.09), point(model.r - 3, a - 0.09),
          point(model.r - 3, a + 0.09), point(12, a + 0.09)],
          ...marking(id, '#647880'), material: null, edge: false, twoSided: true });
      }
    }
  }
  return faces;
}

/** Continuous illustrative material journey: hopper -> carrying run -> discharge. */
export function materialPosition(index, travel, model, count = 72) {
  const from = model.x0 + 52, run = model.x1 - from, feed = 48, discharge = 110;
  const cycle = feed + run + discharge;
  const s = wrap(travel + index * cycle / count, cycle);
  const lane = index % 3 - 1;
  const z = lane * 16 + Math.sin(index * 7.13) * 4;
  const height = model.cy + model.r + 10 + (lane === 0 ? 7 : 1);
  if (s < feed) {
    const t = s / feed;
    return { p: [from - 8 + 8 * t, height + 76 * (1 - t * t), z], stage: 'feed', tumble: t * 3 };
  }
  if (s < feed + run) return { p: [from + s - feed, height, z], stage: 'carrying', tumble: 3 };
  const t = (s - feed - run) / discharge;
  return { p: [model.x1 + 90 * t, height - 150 * t * t, z * (1 + .3 * t)], stage: 'discharge', tumble: 3 + t * 8 };
}

function coalRock(center, size, angle, seed) {
  // Eight faceted triangles, with stable per-rock shape/colour (no frame noise).
  const points = [[-1, 0, 0], [0, 0, -.8], [1.1, 0, 0], [0, 0, .9], [.1, .95, .05], [-.15, -.65, 0]];
  const ca = Math.cos(angle), sa = Math.sin(angle), tilt = seed * .7;
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  const vertices = points.map(([x, y, z]) => {
    const xx = x * ca - y * sa, yy = x * sa + y * ca;
    return [center[0] + xx * size, center[1] + (yy * ct - z * st) * size,
      center[2] + (yy * st + z * ct) * size];
  });
  const palette = ['#424e56', '#526069', '#35424a', '#667078', '#3e4951'];
  const faces = [];
  for (let side = 0; side < 4; side++) {
    const next = (side + 1) % 4;
    for (const top of [4, 5]) faces.push({ pts: [vertices[side], vertices[next], vertices[top]],
      color: palette[seed % palette.length], material: 'coal', ambient: .72, twoSided: true });
  }
  return faces;
}

export function miningMaterialFaces(scene, model, options, state) {
  const faces = [], travel = state.travel ?? state.phase * loopLength(model);
  // A continuous bed under the larger fragments. Its ridges advect downstream.
  const from = model.x0 + 52, to = model.x1;
  const sections = Array.from({ length: 29 }, (_, i) => {
    const x = from + (to - from) * i / 28;
    const station = beltStation(x - model.x0, model);
    const base = scene.beltSection(station, { ...options, scale: .78, lift: 1 });
    const envelope = Math.min(1, (x - from) / 22, (to - x) / 15);
    const ridge = 10 + 2 * Math.sin((x - travel) * .13) + 1.5 * Math.sin((x - travel) * .31);
    return base.map(([px, py, pz], j) => [px, py + Math.max(0, envelope) * ridge *
      (1 - Math.abs(j / (base.length - 1) * 2 - 1) ** 1.5), pz]);
  });
  faces.push(...scene.loft(sections, { color: '#303c44', material: 'coal', ambient: .68, twoSided: true }));
  for (let index = 0; index < 72; index++) {
    const particle = materialPosition(index, travel, model);
    const size = 4.8 + ((index * 17) % 11) * .35;
    faces.push(...coalRock(particle.p, size, particle.tumble + index * 1.7, index));
  }
  return faces;
}

/** A raised stripe around an idler surface; its housing and supports stay fixed. */
export function rollerMotionFaces(p0, p1, radius, angle, attrs) {
  const length = Math.hypot(...p1.map((v, i) => v - p0[i]));
  const dy = (p1[1] - p0[1]) / length, dz = (p1[2] - p0[2]) / length;
  const r = radius + .2;
  const at = (p, a) => [p[0] + Math.cos(a) * r, p[1] + Math.sin(a) * dz * r, p[2] - Math.sin(a) * dy * r];
  // One asymmetric stripe avoids the wagon-wheel reversal of repeated stripes
  // at the lower SVG frame rate.
  return [0].map(offset => {
    const a = angle + offset;
    return { pts: [at(p0, a - .12), at(p1, a - .12), at(p1, a + .12), at(p0, a + .12)],
      ...attrs, material: null, twoSided: true, edge: false };
  });
}
