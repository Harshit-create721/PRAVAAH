import asset from './assets/mining-conveyor.js';
import { SENSOR_COMPONENTS } from './sensor-inspection.js';

// Imported MC-120 meshes; no generated replacement geometry or remote runtime.
// Motion uses the model's real metre dimensions: one measured metre of belt
// travel advances the illustrated belt by one metre, independently of rig size.
export const MODEL_SCALE = 43;
export const MINING_MODEL = {
  x0: -215, x1: 215, cy: 0, r: .55 * MODEL_SCALE,
  width: 1.65 * MODEL_SCALE, hw: .825 * MODEL_SCALE,
  face: 1.76 * MODEL_SCALE, trough: 0, flat: 1, taper: 82,
  rail: 1.01 * MODEL_SCALE, railY: -.03 * MODEL_SCALE,
};
export const miningParts = asset.parts.filter(p => p.component !== 'material_flow' && p.motion?.kind !== 'ore');
export const miningAsset = { name: asset.name, source: asset.source, sha256: asset.sha256,
  parts: miningParts.length, loopLength: asset.belt.loopLength };
// Reflect the cross-belt coordinate to put the drive on the default camera side.
// Face winding is reversed below to preserve outward normals after reflection.
export const toModel = ([x, y, z]) => [x * MODEL_SCALE, (z - 2.2) * MODEL_SCALE, y * MODEL_SCALE];
const wrap = (n, size) => ((n % size) + size) % size;

export function miningPartVertices(part, distance = 0) {
  const m = part.motion;
  if (!m) return part.vertices.map(toModel);
  if (m.kind === 'belt') {
    const s = wrap(m.offset + distance, asset.belt.loopLength), r = .55;
    let x, z, a;
    if (s < 10) { x = -5 + s; z = 2.75; a = 0; }
    else if (s < 10 + Math.PI * r) {
      a = (s - 10) / r; x = 5 + r * Math.sin(a); z = 2.2 + r * Math.cos(a);
    } else if (s < 20 + Math.PI * r) { x = 5 - (s - 10 - Math.PI * r); z = 1.65; a = Math.PI; }
    else { const t = (s - 20 - Math.PI * r) / r; x = -5 - r * Math.sin(t); z = 2.2 - r * Math.cos(t); a = Math.PI + t; }
    const c = Math.cos(a), sn = Math.sin(a);
    return part.vertices.map(([vx, vy, vz]) => toModel([x + vx * c + vz * sn, vy, z - vx * sn + vz * c]));
  }
  const a = wrap(distance * m.rate, Math.PI * 2), c = Math.cos(a), sn = Math.sin(a);
  return part.vertices.map(v => {
    const [x, y, z] = v.map((n, i) => n - m.pivot[i]);
    const p = m.axis === 0 ? [x, y * c - z * sn, y * sn + z * c] : [x * c + z * sn, y, -x * sn + z * c];
    return toModel(p.map((n, i) => n + m.pivot[i]));
  });
}

const staticParts = miningParts.filter(p => !p.motion).map(p => ({ ...p, points: miningPartVertices(p) }));
const movingParts = miningParts.filter(p => p.motion);
function facesFor(parts, paint, distance) {
  const faces = [];
  for (const part of parts) {
    const points = part.points ?? miningPartVertices(part, distance);
    if (!points.length) continue;
    const attrs = { ...paint(part.component, part.color),
      comp: SENSOR_COMPONENTS.has(part.component) ? part.component : null,
      material: part.material, edge: false, twoSided: false, ambient: .70, textureStrength: .28 };
    for (const polygon of part.faces) faces.push({ ...attrs, pts: polygon.map(i => points[i]).reverse() });
  }
  return faces;
}
export const miningStaticFaces = paint => facesFor(staticParts, paint, 0);
export const miningMovingFaces = (paint, state) => facesFor(movingParts, paint, (state.travel ?? 0) / MODEL_SCALE);

// Fine parts inherit the monitoring scope of their assembly, not a new sensor.
// They do not enter the health roster or inflate alarm/rule/instrumentation counts.
export function indexMiningParts(index) {
  for (const p of miningParts) {
    const parent = index[p.component] ?? { state: 'unmonitored', watch: [], watching: [],
      everSeen: [], causes: [], rulesEvaluated: [], alarmCount: 0, worstRatio: null, group: 'structure' };
    index[p.id] = { ...parent, id: p.id, label: p.name, modelPart: true,
      assembly: p.assembly, parentId: p.component, moving: !!p.motion,
      coverage: `Part of ${parent.label ?? p.assembly}. ${parent.coverage ?? 'No sensor monitors this part.'} Assembly readings do not diagnose this individual piece.` };
  }
}

export const miningAnchors = [
  { id: 'tail_pulley', p: toModel([-5, 1.32, 2.4]), text: 'TAIL' },
  { id: 'drive_pulley', p: toModel([5.1, .7, 2.7]), text: 'HEAD / DRIVE' },
  { id: 'drive_motor', p: toModel([4.0, -2.55, 2.4]), text: 'MOTOR' },
  { id: 'loading_chute', p: toModel([-4, 0, 4.8]), text: 'LOADING HOPPER' },
  { id: 'receiving_bin', p: toModel([7.1, 0, -.15]), text: 'DISCHARGE' },
];
