// PRAVAAH dashboard client.
//
// Rendering rule for this whole file: a value is drawn only if the server
// actually received it. Missing -> "NO SIGNAL". Never a zero, never a dash
// that could be mistaken for a reading.

const $ = (id) => document.getElementById(id);

const RISK_WORD = {
  unknown: 'NO DATA',
  healthy: 'HEALTHY',
  observe: 'OBSERVE',
  planned_inspection: 'PLAN INSPECTION',
  urgent_inspection: 'URGENT INSPECTION',
  critical: 'CRITICAL',
};
// Must track the semantic ladder in style.css. Amber is the cap-lamp colour
// and is deliberately absent here — it lights the room, it is not a state.
const RISK_COLOR = {
  unknown: '#4a4640', healthy: '#6f9e46', observe: '#c4a52c',
  planned_inspection: '#d08a22', urgent_inspection: '#d05f26', critical: '#cc3a2e',
};
const LAMP = '#e0a03c';
const GROUP_TITLE = {
  drive: 'Drive', vibration: 'Vibration', thermal: 'Thermal',
  tracking: 'Tracking', acoustic: 'Acoustic', load: 'Load',
};
const DERIVED = new Set(['slip_ratio', 'temperature_delta']);

let snap = null;
let activeConveyor = null;
let openJoint = null;

// ------------------------------------------------------------ formatting

const num = (v, d = 2) =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Number(v).toFixed(d);

function decimals(unit) {
  if (unit === 'rpm') return 0;
  if (unit === 'mm' || unit === '%' || unit === 'K' || unit === '°C') return 1;
  if (unit === 'g') return 3;
  return 2;
}

function ago(ts) {
  if (!Number.isFinite(ts)) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 1) return 'now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  const h = Math.floor(s / 3600);
  if (h < 24) return `${h}h ${Math.floor((s % 3600) / 60)}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const clock = () => {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0')).join(':');
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------- socket

let ws = null;
let wsRetry = 0;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => { wsRetry = 0; setLink(true); };
  ws.onclose = () => {
    setLink(false);
    wsRetry = Math.min(wsRetry + 1, 10);
    setTimeout(connect, 500 * wsRetry);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'snapshot') { snap = msg; render(); }
  };
}

function setLink(up) {
  $('wsDot').className = `dot ${up ? 'on' : 'off'}`;
  $('wsLabel').textContent = up ? 'LINK UP' : 'LINK DOWN';
}

// ---------------------------------------------------------------- render

function currentConveyor() {
  if (!snap?.conveyors?.length) return null;
  return snap.conveyors.find((c) => c.id === activeConveyor) ?? snap.conveyors[0];
}

function render() {
  if (!snap) return;
  const cv = currentConveyor();
  activeConveyor = cv?.id ?? null;

  $('siteLabel').textContent = snap.server.site;
  $('mqttDot').className = `dot ${snap.mqtt.connected ? 'on' : 'off'}`;
  $('mqttLabel').textContent = snap.mqtt.connected
    ? `BROKER :${snap.mqtt.port}` : 'BROKER DOWN';

  renderTabs();
  if (!cv) return;

  renderBanner(cv);
  renderRisk(cv);
  renderSchematic(cv);
  renderComponents(cv);
  renderChannels(cv);
  renderTrendOptions(cv);
  renderJoints(cv);
  renderAlarms(cv);
  renderNodes();
  renderGaps(cv);
  renderIngest(cv);
  if (openJoint) refreshDrawer(cv);
}

function renderTabs() {
  const el = $('conveyorTabs');
  el.innerHTML = snap.conveyors.map((c) =>
    `<button data-id="${esc(c.id)}" aria-current="${c.id === activeConveyor}">${esc(c.id)}</button>`
  ).join('');
  for (const b of el.querySelectorAll('button')) {
    b.onclick = () => { activeConveyor = b.dataset.id; render(); loadTrend(); };
  }
}

function renderBanner(cv) {
  const b = $('banner');
  const noData = cv.lastMessageTs === null;
  const missingGeom = !cv.geometry.configured;
  // The bench harness publishes under `bench-*` node ids. If one is live,
  // say so loudly - nothing on screen is a measurement while it runs.
  const bench = snap.nodes.some((n) => n.state !== 'offline' && /^bench/i.test(n.node));

  if (bench) {
    b.className = 'banner';
    b.dataset.kind = 'alert';
    b.textContent = 'BENCH SOURCE ACTIVE — frames are coming from tools/bench-publisher.js, not from hardware. Nothing on this screen is a measurement.';
  } else if (noData) {
    b.className = 'banner';
    b.dataset.kind = 'wait';
    b.textContent = `WAITING FOR FIRST PACKET — publish to beltguard/${snap.server.site}/${cv.id}/telemetry on mqtt://<this-machine>:${snap.mqtt.port}`;
  } else if (missingGeom) {
    b.className = 'banner';
    b.dataset.kind = 'wait';
    b.textContent = 'BELT GEOMETRY NOT ENTERED — slip ratio and marker-distance rules are disabled until pulleyDiameterMm, gearRatio and beltLengthM are set in server/config.js';
  } else if (cv.risk === 'critical' || cv.risk === 'urgent_inspection') {
    b.className = 'banner';
    b.dataset.kind = 'alert';
    b.textContent = `${RISK_WORD[cv.risk]} — ${cv.alarms[0]?.message ?? ''}`;
  } else {
    b.className = 'banner hidden';
  }
}

function renderRisk(cv) {
  const badge = $('riskBadge');
  badge.dataset.risk = cv.risk;
  $('riskWord').textContent = RISK_WORD[cv.risk] ?? cv.risk.toUpperCase();
  $('riskNote').textContent = cv.riskSource ?? '';
  $('riskSource').textContent = cv.analysis ? `model: ${cv.analysis.model_version ?? 'unnamed'}` : 'rule layer';
  $('opState').textContent = cv.operating_state === 'unknown' ? 'unknown' : cv.operating_state;
  $('lastPacket').textContent = ago(cv.lastMessageTs);
  $('jointCount').textContent = cv.joints.length;
  $('alarmCount').textContent = cv.alarms.length;
}

// --------------------------------------------------------------- schematic
//
// A 3D model of the conveyor, drawn to SVG by scene3d.js. Every part is a hit
// target coloured by what the rules currently measure about it.
//
// The machine drawn here is a mining ROM belt, not a generic box-and-two-
// circles diagram: troughed carrying run on three-roll idler sets, impact
// idlers under the loading chute, a self-aligning set, flat return idlers,
// snub and bend pulleys, a shaft-mounted gearbox on the head shaft, screw
// take-up at the tail, a head scraper and the statutory pull-cord. The point
// is not decoration. Once wear is read per component, an operator has to be
// able to find the part on screen that matches the part in front of them, and
// that only works if the picture is of their machine.
//
// The discipline that matters is UNMONITORED - a component nothing can see is
// drawn as bare dark metal with a dashed outline, never green, because "we
// have no sensor here" and "this part is fine" must never look the same. Most
// of this machine is unmonitored today, and the model says so.

const COMP_COLOR = {
  unmonitored: '#3a3830',
  no_rule: '#7f776a',
  blind: '#6b6459',
  healthy: '#6f9e46',
  observe: '#c4a52c',
  planned_inspection: '#d08a22',
  urgent_inspection: '#d05f26',
  critical: '#cc3a2e',
};
const COMP_WORD = {
  unmonitored: 'UNMONITORED',
  no_rule: 'NO RULE',
  blind: 'SENSOR LOST',
  healthy: 'NOMINAL',
  observe: 'APPROACHING LIMIT',
  planned_inspection: 'PLAN INSPECTION',
  urgent_inspection: 'URGENT',
  critical: 'CRITICAL',
};
const GROUP_LABEL = {
  drive: 'Drive end', pulleys: 'Pulleys and take-up', idlers: 'Idlers',
  belt: 'Belt', structure: 'Structure and safety', joints: 'Joints',
};
const ALERT = new Set(['urgent_inspection', 'critical']);
// States where we cannot vouch for the part: drawn as unlit metal, not colour.
const VAGUE = new Set(['unmonitored', 'no_rule', 'blind']);
// Unlit machine steel. It has to sit ABOVE the panel background once shaded,
// or an unmonitored part reads as a hole in the picture rather than as metal.
const STEEL = '#5b6472';
const DARK_STEEL = '#464d58';
const RUBBER = '#31363e';
const COAL = '#232830';
// Ambient floor per part. High enough that a face turned away from the cap
// lamp is still legible - an operator must be able to see the whole machine -
// but low enough that the machine still has form. The base colours above are
// lifted to compensate, so the darkest face is still clearly metal.
const AMB = 0.40;

// Model dimensions, in arbitrary units. +x along the belt, +y up, +z across.
const M = {
  x0: -215, x1: 215,      // tail / head pulley centres
  cy: 0,                  // belt centreline height
  r: 25,                  // pulley radius, and therefore the belt path radius
  width: 80,              // belt width
  hw: 40,                 // half of it, used constantly
  face: 94,               // pulley face width (wider than the belt, as built)
  trough: 0.42,           // wing lift at the belt edge, as a fraction of hw
  flat: 0.34,             // fraction of hw carried flat by the centre roll
  taper: 82,              // distance over which the trough flattens into a pulley
  rail: 56,               // stringer offset either side of the centreline
  railY: -41,             // stringer height
};

/** How troughed the belt is at a given x - see Scene3D.beltPath. */
const troughAt = (x) =>
  Math.max(0, Math.min(1, Math.min(x - M.x0, M.x1 - x) / M.taper));

// Idler stations along the carrying run. The two nearest the loading chute
// are impact sets (rubber-ringed, fatter); one set carries the IR spot and is
// the only one this rig can judge; one is self-aligning.
const SETS = [
  { x: -186, id: 'impact_idlers', r0: 9.5, rubber: true },
  { x: -140, id: 'impact_idlers', r0: 9.5, rubber: true },
  { x: -96, id: 'carry_idlers', r0: 7 },
  { x: -52, id: 'idlers', r0: 7 },
  { x: -8, id: 'training_idler', r0: 7 },
  { x: 36, id: 'carry_idlers', r0: 7 },
  { x: 80, id: 'carry_idlers', r0: 7 },
  { x: 124, id: 'carry_idlers', r0: 7 },
  { x: 168, id: 'carry_idlers', r0: 7 },
];
const IR_X = SETS.find((s) => s.id === 'idlers').x;
const RETURN_X = [-150, -60, 40, 140];
const LEG_X = [-190, -95, 0, 95, 190];
const DRIVE_Z = 92;         // gearbox centre, outboard of the head bearing
const MOTOR_Z = 170;

// Detail levels. A drag redraws ~500 faces; the settled frame draws ~1100.
// Dropping detail mid-gesture keeps the orbit at pointer rate on a plant
// laptop, and the frame an operator actually reads is always the full one.
const LOD = {
  full: { run: 15, wrap: 10, cols: 6, pulley: 18, roll: 9, small: 8, detail: true },
  fast: { run: 8, wrap: 6, cols: 4, pulley: 10, roll: 6, small: 6, detail: false },
};

// A long machine on one screen wants a LONG lens: raising dist and focal
// together keeps the size but flattens the perspective, so the conveyor
// reads as a machine drawing rather than a wide-angle photograph of one.
const cam = { yaw: -0.66, pitch: 0.36, dist: 1420, focal: 1420, cx: 389, cy: 194 };
const HOME = { ...cam };

let compIndex = {};
let lastCv = null;
let focusComp = null;      // part highlighted from the roster panel

const compColor = (state) => COMP_COLOR[state] ?? COMP_COLOR.unmonitored;

/** Colour a part carries in the scene: status colour, or bare steel. */
function partPaint(state, base = STEEL) {
  return VAGUE.has(state)
    ? { color: base, stroke: compColor(state), dash: '4 3' }
    : { color: compColor(state), stroke: null };
}

function renderSchematic(cv) {
  lastCv = cv;
  compIndex = {};
  for (const c of cv.components ?? []) compIndex[c.id] = c;
  requestDraw(false);
}

// One redraw per animation frame at most. Without this, a fast drag queues
// more full scene rebuilds than the browser can retire and the view lags
// behind the pointer.
let rafId = 0;
let pendingFast = false;
function requestDraw(fast) {
  pendingFast = fast;
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    try { drawScene(pendingFast); } catch (err) { fatal('3D scene', err); }
  });
}

function drawScene(fast = false) {
  const cv = lastCv;
  if (!cv) return;
  const svg = $('schematic');
  if (!svg) return;
  const q = fast ? LOD.fast : LOD.full;
  const { x0, x1, cy, r, hw, face } = M;
  const st = (id) => compIndex[id]?.state ?? 'unmonitored';
  const faces = [];

  /** Attribute bundle for a hit-testable part. */
  const paint = (id, base = STEEL) => {
    const p = partPaint(st(id), base);
    return { color: p.color, stroke: p.stroke, dash: p.dash, comp: id, ambient: AMB, edge: true };
  };
  /** Bare structure: visible, but not a component anything reports on. */
  const plain = (color = DARK_STEEL, extra = {}) => ({ color, ambient: AMB, edge: true, ...extra });

  // ---- the belt itself, lofted along the closed path.
  //
  // The carrying run is troughed and flattens into each pulley; the return run
  // is flat. Splitting the loft at the return run lets the carcass and the
  // tracking rules own the halves of the belt they can actually speak for.
  const path = Scene3D.beltPath({
    x0, x1, cy, r, runSegs: q.run, wrapSegs: q.wrap, taper: M.taper,
  });
  const secOpts = { width: M.width, troughRise: M.trough, flat: M.flat, cols: q.cols };
  const secs = path.map((s) => Scene3D.beltSection(s, secOpts));
  {
    const pt = partPaint(st('belt_tracking'), RUBBER);
    const pc = partPaint(st('belt_carcass'), RUBBER);
    const n = secs.length;
    for (let i = 0; i < n; i++) {
      const A = secs[i], B = secs[(i + 1) % n];
      const isReturn = path[i].n[1] < -0.5 && path[(i + 1) % n].n[1] < -0.5;
      const id = isReturn ? 'belt_carcass' : 'belt_tracking';
      const p = isReturn ? pc : pt;
      for (let k = 0; k < A.length - 1; k++) {
        faces.push({
          pts: [A[k], A[k + 1], B[k + 1], B[k]],
          color: p.color, comp: id, twoSided: true, ambient: AMB,
          // Only the two edge columns carry the dashed outline. Outlining all
          // 240 quads of an unmonitored belt would be a hatch, not a signal.
          stroke: k === 0 || k === A.length - 2 ? p.stroke : null,
          dash: p.dash,
        });
      }
    }
  }

  // ---- the load. Heaped in the trough, starting under the chute and running
  //      off at the head - a bare belt reads as a machine drawing, loaded it
  //      reads as the plant this actually monitors.
  {
    const LOAD_FROM = x0 + 62, LOAD_TO = x1 - 6;
    const cols = q.cols;
    const heapAt = (x) => {
      const inRun = Math.min((x - LOAD_FROM) / 40, (LOAD_TO - x) / 26, 1);
      if (inRun <= 0) return 0;
      return inRun * 15 * (0.78 + 0.16 * Math.sin(x * 0.071) + 0.1 * Math.sin(x * 0.023));
    };
    const section = (x) => {
      const h = heapAt(x), tr = troughAt(x), pts = [];
      for (let i = 0; i <= cols; i++) {
        const t = -1 + (2 * i) / cols;
        const a = Math.abs(t);
        const rise = a <= M.flat ? 0 : ((a - M.flat) / (1 - M.flat)) * M.trough * hw;
        const heap = Math.max(0, 1 - (a / 0.9) ** 2) * h;
        pts.push([x, cy + r + 1.4 + rise * tr + heap, t * hw * 0.97]);
      }
      return pts;
    };
    const steps = q.detail ? 26 : 12;
    const xs = Array.from({ length: steps + 1 },
      (_, i) => LOAD_FROM + ((LOAD_TO - LOAD_FROM) * i) / steps);
    faces.push(...Scene3D.loft(xs.map(section), { color: COAL, ambient: AMB }));
  }

  // ---- head (drive) pulley, tail pulley, and the shaft through each
  for (const [x, id] of [[x0, 'tail_pulley'], [x1, 'drive_pulley']]) {
    faces.push(...Scene3D.cylinderZ([x, cy, 0], r, face, q.pulley, paint(id)));
    // End discs read as the pulley crown without poking through the belt.
    for (const s of [-1, 1]) {
      faces.push(...Scene3D.cylinderZ([x, cy, s * (face / 2 + 1)], r + 2.5, 2.5, q.pulley,
        plain('#3d434c')));
    }
    faces.push(...Scene3D.cylinderZ([x, cy, 0], 5.5, face + 46, q.small, plain(STEEL)));
  }

  // ---- snub and bend pulleys, tucked under the return run
  faces.push(...Scene3D.cylinderZ([x1 - 62, cy - r - 11, 0], 11, M.width + 6, q.pulley,
    paint('snub_pulley')));
  faces.push(...Scene3D.cylinderZ([x0 + 72, cy - r - 10, 0], 10, M.width + 6, q.pulley,
    paint('bend_pulley')));

  // ---- head shaft bearings: plummer block and pedestal, both sides
  for (const s of [-1, 1]) {
    const z = s * (face / 2 + 16);
    faces.push(...Scene3D.cylinderZ([x1, cy, z], 12, 18, q.small, paint('drive_bearing')));
    faces.push(...Scene3D.box([x1, cy - 17, z], [30, 16, 26], paint('drive_bearing')));
  }

  // ---- screw take-up at the tail. The tail bearings ride on it, so the
  //      housings and the adjusting screws are one component.
  for (const s of [-1, 1]) {
    const z = s * (face / 2 + 16);
    faces.push(...Scene3D.box([x0 + 2, cy, z], [30, 30, 24], paint('takeup')));
    faces.push(...Scene3D.cylinderZ([x0 - 26, cy, z], 3.5, 56, q.small, paint('takeup')));
    faces.push(...Scene3D.box([x0 - 52, cy, z], [10, 14, 14], paint('takeup')));
  }

  // ---- drive train: shaft-mounted gearbox on the head shaft, fluid coupling,
  //      motor, all on a common base frame with a torque arm to it.
  faces.push(...Scene3D.box([x1 - 10, cy - r - 46, DRIVE_Z + 34], [150, 10, 116],
    plain('#40464f')));
  faces.push(...Scene3D.box([x1, cy, DRIVE_Z], [58, 52, 42], paint('gearbox')));
  faces.push(...Scene3D.box([x1 - 30, cy - 24, DRIVE_Z], [8, 46, 14], paint('gearbox')));
  faces.push(...Scene3D.cylinderZ([x1, cy, DRIVE_Z + 34], 16, 26, q.small, paint('gearbox')));
  faces.push(...Scene3D.cylinderZ([x1, cy, MOTOR_Z], 17, 56, q.pulley, paint('drive_motor')));
  faces.push(...Scene3D.box([x1, cy + 20, MOTOR_Z], [24, 12, 28], paint('drive_motor')));
  for (const zz of [MOTOR_Z - 22, MOTOR_Z + 22]) {
    faces.push(...Scene3D.box([x1, cy - 24, zz], [30, 14, 8], plain('#40464f')));
  }

  // ---- troughing idler sets. Three rolls each: one flat centre roll, two
  //      wings lifted to the trough angle, which is why the belt is a V.
  for (const s of SETS) {
    const a = paint(s.id, s.rubber ? RUBBER : STEEL);
    const zc = M.flat * hw;
    const rise = M.trough * hw;
    const yc = cy + r - s.r0 - 1.1;
    faces.push(...Scene3D.cylinderBetween([s.x, yc, -zc], [s.x, yc, zc], s.r0, q.roll, a));
    for (const side of [-1, 1]) {
      faces.push(...Scene3D.cylinderBetween(
        [s.x, yc, side * zc], [s.x, yc + rise, side * hw * 1.05], s.r0, q.roll, a));
    }
    if (q.detail) {
      // The frame the set hangs in, down to the stringer either side.
      for (const side of [-1, 1]) {
        faces.push(...Scene3D.box(
          [s.x, (yc + rise + M.railY) / 2, side * (hw * 1.06 + 4)],
          [5, yc + rise - M.railY, 5], plain('#454c56')));
      }
    }
  }

  // ---- return idlers: single flat rolls under the return run
  for (const x of RETURN_X) {
    faces.push(...Scene3D.cylinderZ([x, cy - r - 7.1, 0], 6, M.width * 0.94, q.roll,
      paint('return_idlers')));
  }

  // ---- stringers, legs, foot plates and cross bracing
  for (const s of [-1, 1]) {
    faces.push(...Scene3D.box([0, M.railY, s * M.rail], [(x1 - x0) + 84, 9, 9],
      plain('#4a515c')));
  }
  for (const x of LEG_X) {
    for (const s of [-1, 1]) {
      faces.push(...Scene3D.box([x, M.railY - 40, s * M.rail], [8, 80, 8], plain('#434955')));
      faces.push(...Scene3D.box([x, M.railY - 81, s * M.rail], [22, 4, 22], plain('#3a4049')));
    }
    faces.push(...Scene3D.box([x, M.railY - 72, 0], [7, 7, M.rail * 2], plain('#434955')));
  }
  if (q.detail) {
    for (let i = 0; i < LEG_X.length - 1; i++) {
      for (const s of [-1, 1]) {
        faces.push(...Scene3D.cylinderBetween(
          [LEG_X[i], M.railY - 78, s * M.rail], [LEG_X[i + 1], M.railY - 4, s * M.rail],
          2.4, 4, plain('#3d434c')));
      }
    }
  }

  // ---- loading chute and skirtboards at the tail
  faces.push(...Scene3D.box([x0 + 52, cy + r + 50, 0], [62, 76, 66], paint('loading_chute')));
  faces.push(...Scene3D.box([x0 + 52, cy + r + 96, 0], [78, 16, 82], plain('#40464f')));
  for (const s of [-1, 1]) {
    faces.push(...Scene3D.box([x0 + 84, cy + r + 15, s * 31], [140, 24, 4],
      paint('loading_chute')));
  }

  // ---- head scraper: blade against the pulley, arm and tensioners
  faces.push(...Scene3D.box([x1 + r + 5, cy - 13, 0], [6, 26, M.width], paint('head_scraper')));
  faces.push(...Scene3D.cylinderZ([x1 + r + 16, cy - 28, 0], 3.5, M.width + 34, q.small,
    paint('head_scraper')));
  for (const s of [-1, 1]) {
    faces.push(...Scene3D.box([x1 + r + 16, cy - 40, s * (M.width / 2 + 18)], [8, 26, 8],
      paint('head_scraper')));
  }

  // ---- pull-cord: the trip line down the walkway side, and two switch boxes
  faces.push(...Scene3D.box([0, cy + r + 24, M.rail + 16], [(x1 - x0) + 40, 2.5, 2.5],
    paint('pull_cord')));
  for (const x of [x0 + 110, x1 - 110]) {
    faces.push(...Scene3D.box([x, cy + r + 16, M.rail + 16], [16, 22, 13], paint('pull_cord')));
  }

  // ---- joints: bands across the carrying run, riding the trough
  const joints = cv.joints ?? [];
  const jointBands = [];
  joints.forEach((j, i) => {
    const span = (x1 - x0) - 150;
    const x = x0 + 90 + (span / Math.max(joints.length, 1)) * (i + 0.5);
    const cid = `joint:${j.id}`;
    const state = compIndex[cid]?.state ?? j.risk ?? 'unknown';
    const col = COMP_COLOR[state] ?? RISK_COLOR[state] ?? RISK_COLOR.unknown;
    const band = (xx) => Scene3D.beltSection(
      { p: [xx, cy + r], n: [0, 1], trough: troughAt(xx) },
      { ...secOpts, cols: 6, lift: 2.6 });
    const A = band(x - 6), B = band(x + 6);
    for (let k = 0; k < A.length - 1; k++) {
      faces.push({
        pts: [A[k], A[k + 1], B[k + 1], B[k]],
        color: col, comp: cid, flat: true, twoSided: true,
        cls: ALERT.has(state) ? 'sch-alert' : null,
      });
    }
    jointBands.push({ id: j.id, cid, x, y: cy + r + 3, state });
  });

  // ---- a part picked out in the roster gets a halo so the eye lands on it
  if (focusComp && PART_ANCHOR[focusComp]) {
    for (const f of faces) if (f.comp === focusComp) f.cls = `${f.cls ? f.cls + ' ' : ''}sch-focus-part`;
  }

  // ---- assemble
  const body = Scene3D.render(faces, cam);
  const labels = buildLabels(cv, jointBands, q);
  svg.innerHTML = body + labels;

  wireHits(svg);
  renderSchematicSummary(cv);
}

/**
 * Format a sensor marker's live readout for the 3D view.
 * Returns null when NOTHING in the list has ever been published, which is what
 * makes the marker read NO SIGNAL rather than invent a placeholder.
 */
function readoutFor(cv, keys) {
  const lines = [];
  for (const key of keys ?? []) {
    const c = cv.channels?.[key];
    if (!c || c.value === null || c.value === undefined) continue;
    const v = num(c.value, decimals(c.unit));
    if (v === null) continue;
    lines.push(`${v}${c.unit ? ' ' + c.unit : ''}`);
  }
  return lines.length ? lines : null;
}

/**
 * Labels and sensor markers are drawn in screen space after the 3D pass, so
 * text always faces the reader however the model is turned.
 */
function buildLabels(cv, jointBands, q) {
  const { x0, x1, cy, r, hw } = M;
  const out = [];

  const anchors = [
    { id: 'tail_pulley', p: [x0 + 2, cy + r + 6, -(M.hw + 46)], text: 'TAIL' },
    { id: 'drive_pulley', p: [x1 + 26, cy - r - 2, -(M.hw + 34)], text: 'HEAD / DRIVE' },
    { id: 'drive_motor', p: [x1, cy - 30, MOTOR_Z + 30], text: 'MOTOR' },
    { id: 'gearbox', p: [x1 - 34, cy - 44, DRIVE_Z], text: 'GEARBOX' },
    { id: 'loading_chute', p: [x0 + 52, cy + r + 62, -(M.hw + 52)], text: 'LOADING POINT' },
    { id: 'takeup', p: [x0 - 58, cy - 54, 0], text: 'TAKE-UP' },
  ];
  for (const a of anchors) {
    const s = compIndex[a.id]?.state ?? 'unmonitored';
    const p = Scene3D.project(a.p, cam);
    out.push(`<text class="sch-label" x="${p[0].toFixed(1)}" y="${(p[1] + 13).toFixed(1)}"
      text-anchor="middle" fill="${VAGUE.has(s) ? '#6b6459' : compColor(s)}" pointer-events="none">${a.text}</text>`);
  }

  // Sensor nodes: a marker in 3D at the place it is mounted, with its label.
  // A marker is green only when its channel is arriving now - this is the row
  // an operator checks first when a part goes grey.
  const sensors = [
    // Current only. motor_rpm now comes from the Hall sensor on the roller, and
    // showing it here too would imply a CT is fitted when none is.
    { p: [x1, cy + 52, MOTOR_Z], label: 'CT', chans: ['motor_current_rms'],
      show: ['motor_current_rms'] },
    { p: [x1, cy + 58, M.face / 2 + 16], label: 'VIB-DRIVE', chans: ['vibration_rms'],
      show: ['vibration_rms', 'vibration_crest'] },
    { p: [40, cy + r + 74, 0], label: 'CAM', chans: ['belt_offset_left', 'belt_offset_right'],
      show: ['belt_offset_left', 'belt_offset_right'] },
    { p: [x0 + 118, cy - r - 40, -(M.rail + 8)], label: 'HALL SPEED', chans: ['motor_rpm', 'belt_speed'],
      show: ['motor_rpm', 'belt_speed'] },
    { p: [IR_X, cy - r - 34, hw + 26], label: 'IR TEMP', chans: ['temperature'],
      show: ['temperature', 'temperature_delta'] },
    {
      p: [x0 + 26, cy + r + 56, -(hw + 14)], label: 'MARKER L/R',
      // No telemetry channel of its own: the marker sensors announce
      // themselves by producing joint passes, so that is what is reported.
      live: (cv.joints ?? []).some((j) => Number.isFinite(j.last_ts)),
      seen: (cv.joints ?? []).length > 0,
      // Laps are the marker's measurement, so that is its readout.
      readout: () => {
        const laps = (cv.joints ?? []).map((j) => j.lap).filter(Number.isFinite);
        return laps.length ? [`LAP ${Math.max(...laps)}`] : null;
      },
    },
  ];
  for (const s of sensors) {
    const states = (s.chans ?? []).map((c) => cv.channels[c]?.state ?? 'never');
    const on = s.live ?? states.some((x) => x === 'live');
    const seen = s.seen ?? states.some((x) => x !== 'never');
    const col = on ? '#6f9e46' : seen ? '#d08a22' : '#3a3830';
    const p = Scene3D.project(s.p, cam);
    // Leader line back to the machine surface it is mounted on.
    const base = Scene3D.project([s.p[0], cy + (s.p[1] > cy ? r : -r), s.p[2]], cam);
    out.push(`<line x1="${p[0].toFixed(1)}" y1="${p[1].toFixed(1)}" x2="${base[0].toFixed(1)}" y2="${base[1].toFixed(1)}"
      stroke="${col}" stroke-width="1" stroke-dasharray="3 3" opacity="0.65" pointer-events="none"/>`);
    out.push(`<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4" fill="${col}" opacity="${on ? 0.95 : 0.5}" pointer-events="none"/>`);
    out.push(`<text class="sch-label" x="${p[0].toFixed(1)}" y="${(p[1] - 9).toFixed(1)}" text-anchor="middle"
      fill="${on ? '#9a9182' : '#5c564d'}" pointer-events="none">${s.label}</text>`);

    // The reading itself, stacked under the marker. Same rule as everywhere
    // else in this dashboard: a channel nobody has published reads NO SIGNAL,
    // never a zero and never a dash that could pass for one.
    const lines = s.readout ? s.readout() : readoutFor(cv, s.show);
    if (lines) {
      lines.forEach((line, i) => {
        out.push(`<text class="sch-readout" x="${p[0].toFixed(1)}" y="${(p[1] + 15 + i * 10).toFixed(1)}"
          text-anchor="middle" fill="${on ? '#cdbf9a' : '#6b6459'}" pointer-events="none">${esc(line)}</text>`);
      });
    }
    // No NO SIGNAL text here on purpose. The marker dot is already grey for a
    // channel that has never published, and the Live Channels panel spells it
    // out; repeating it in the 3D view only lands the words on top of the
    // neighbouring part labels, which costs legibility for no new information.
  }

  for (const b of jointBands) {
    const p = Scene3D.project([b.x, b.y + 30, 0], cam);
    const col = COMP_COLOR[b.state] ?? RISK_COLOR[b.state] ?? RISK_COLOR.unknown;
    out.push(`<text class="sch-label" x="${p[0].toFixed(1)}" y="${p[1].toFixed(1)}" text-anchor="middle"
      fill="${col}" pointer-events="none">${esc(b.id)}</text>`);
  }

  if (!jointBands.length) {
    out.push(`<text class="sch-label" x="436" y="414" text-anchor="middle" fill="#4a4640"
      pointer-events="none">NO JOINT MARKER DETECTED YET</text>`);
  }

  // Keyboard focus proxies: one invisible box per part, so the scene is
  // reachable without a mouse. Skipped mid-gesture - nothing can be focused
  // while the pointer is dragging, and they are the most expensive labels.
  if (q.detail) {
    for (const c of Object.values(compIndex)) {
      const anchor = PART_ANCHOR[c.id];
      if (!anchor) continue;
      const bb = Scene3D.bounds(anchor(), cam);
      out.push(`<rect class="sch-focus" x="${(bb.x - 4).toFixed(1)}" y="${(bb.y - 4).toFixed(1)}"
        width="${(bb.w + 8).toFixed(1)}" height="${(bb.h + 8).toFixed(1)}" fill="none" stroke="none"
        tabindex="0" role="button" data-comp="${esc(c.id)}"
        aria-label="${esc(c.label)}: ${COMP_WORD[c.state] ?? c.state}"/>`);
    }
  }

  return out.join('');
}

/**
 * Model-space extents used to place each part's keyboard focus box, and to
 * aim the camera when a part is picked from the roster. Two opposite corners
 * of the part are enough for both.
 */
const PART_ANCHOR = {
  tail_pulley: () => [[M.x0 - M.r, M.cy - M.r, -M.face / 2], [M.x0 + M.r, M.cy + M.r, M.face / 2]],
  drive_pulley: () => [[M.x1 - M.r, M.cy - M.r, -M.face / 2], [M.x1 + M.r, M.cy + M.r, M.face / 2]],
  snub_pulley: () => [[M.x1 - 73, M.cy - M.r - 22, -M.hw], [M.x1 - 51, M.cy - M.r, M.hw]],
  bend_pulley: () => [[M.x0 + 62, M.cy - M.r - 20, -M.hw], [M.x0 + 82, M.cy - M.r, M.hw]],
  takeup: () => [[M.x0 - 57, M.cy - 15, -(M.face / 2 + 28)], [M.x0 + 17, M.cy + 15, M.face / 2 + 28]],
  drive_motor: () => [[M.x1 - 17, M.cy - 17, MOTOR_Z - 28], [M.x1 + 17, M.cy + 26, MOTOR_Z + 28]],
  gearbox: () => [[M.x1 - 29, M.cy - 26, DRIVE_Z - 21], [M.x1 + 29, M.cy + 26, DRIVE_Z + 47]],
  drive_bearing: () => [[M.x1 - 15, M.cy - 25, -(M.face / 2 + 29)], [M.x1 + 15, M.cy + 12, M.face / 2 + 29]],
  idlers: () => [[IR_X - 8, M.cy + M.r - 16, -M.hw], [IR_X + 8, M.cy + M.r + M.trough * M.hw, M.hw]],
  carry_idlers: () => [[36 - 8, M.cy + M.r - 16, -M.hw], [168 + 8, M.cy + M.r + M.trough * M.hw, M.hw]],
  impact_idlers: () => [[-195, M.cy + M.r - 18, -M.hw], [-131, M.cy + M.r + M.trough * M.hw, M.hw]],
  training_idler: () => [[-16, M.cy + M.r - 16, -M.hw], [0, M.cy + M.r + M.trough * M.hw, M.hw]],
  return_idlers: () => [[RETURN_X[0] - 6, M.cy - M.r - 12, -M.hw], [RETURN_X.at(-1) + 6, M.cy - M.r, M.hw]],
  belt_tracking: () => [[M.x0, M.cy + M.r, -M.hw], [M.x1, M.cy + M.r + M.trough * M.hw, M.hw]],
  belt_carcass: () => [[M.x0 + 8, M.cy - M.r - 2, -M.hw], [M.x1 - 8, M.cy - M.r, M.hw]],
  loading_chute: () => [[M.x0 + 21, M.cy + M.r + 12, -M.hw], [M.x0 + 154, M.cy + M.r + 88, M.hw]],
  head_scraper: () => [[M.x1 + M.r, M.cy - 42, -(M.hw + 22)], [M.x1 + M.r + 22, M.cy, M.hw + 22]],
  pull_cord: () => [[M.x0, M.cy + M.r + 5, M.rail + 10], [M.x1, M.cy + M.r + 28, M.rail + 22]],
};

/** Hover, focus and click, by delegation - faces are individual polygons. */
function wireHits(svg) {
  svg.onpointermove = (e) => {
    const id = e.target?.dataset?.comp;
    if (id && compIndex[id]) showCompTip(id, e);
    else if (!svg.classList.contains('dragging')) hideCompTip();
    if (tipVisible()) moveCompTip(e);
  };
  svg.onpointerleave = hideCompTip;
  svg.onclick = (e) => {
    if (svg.dataset.dragged) { svg.dataset.dragged = ''; return; }
    const id = e.target?.dataset?.comp;
    if (id?.startsWith('joint:')) openDrawer(id.slice(6));
  };
  for (const f of svg.querySelectorAll('.sch-focus')) {
    f.onfocus = (e) => {
      const bb = e.target.getBoundingClientRect();
      showCompTip(e.target.dataset.comp, { clientX: bb.left + bb.width / 2, clientY: bb.top + bb.height / 2 });
    };
    f.onblur = hideCompTip;
    f.onkeydown = (e) => {
      const id = e.target.dataset.comp;
      if ((e.key === 'Enter' || e.key === ' ') && id?.startsWith('joint:')) {
        e.preventDefault();
        openDrawer(id.slice(6));
      }
    };
  }
}

/** The line above the scene: what it is currently able to see. */
function renderSchematicSummary(cv) {
  const all = cv.components ?? [];
  const fixed = all.filter((c) => !c.joint);
  const flagged = all.filter((c) =>
    ['observe', 'planned_inspection', 'urgent_inspection', 'critical'].includes(c.state)).length;
  // "Evaluated" and "sensed" are different claims and the header keeps them
  // apart. So is "drawn": most of this machine is drawn and unwatched, and the
  // ratio saying so is the honest headline, not a number to hide.
  const evaluated = fixed.filter((c) => c.rulesEvaluated.length > 0).length;
  const sensed = fixed.filter((c) => c.everSeen.length > 0).length;

  const bits = [];
  if (flagged) bits.push(`${flagged} flagged`);
  bits.push(`${evaluated}/${fixed.length} parts evaluated`);
  if (sensed > evaluated) bits.push(`${sensed} sensed`);
  if (cv.joints.length) bits.push(`${cv.joints.length} joint${cv.joints.length === 1 ? '' : 's'}`);
  $('schematicSrc').textContent = bits.join(' \u00b7 ');
}

// ------------------------------------------------------------ part roster
//
// The list beside the model. It exists because a 3D picture answers "where"
// well and "how many" badly: an operator planning a shutdown needs to read
// every part and its headroom in one column, without orbiting to find the
// ones that are hiding behind the belt.

/** Fraction-of-limit bar. This is the wear readout: how much of the allowed
 *  deviation this part has already used, straight from the rule that judged
 *  it. Nothing is extrapolated - a part with no rule gets no bar. */
function wearBar(ratio) {
  if (!Number.isFinite(ratio)) return '<div class="pc-bar empty"></div>';
  const pct = Math.min(ratio, 1.4) / 1.4 * 100;
  const col = ratio >= 1 ? COMP_COLOR.urgent_inspection
    : ratio >= 0.75 ? COMP_COLOR.observe : COMP_COLOR.healthy;
  return `<div class="pc-bar"><i style="width:${pct.toFixed(1)}%;background:${col}"></i></div>`;
}

function renderComponents(cv) {
  const el = $('componentList');
  if (!el) return;
  const fixed = (cv.components ?? []).filter((c) => !c.joint);

  const groups = new Map();
  for (const c of fixed) {
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group).push(c);
  }

  el.innerHTML = [...groups].map(([g, rows]) => `
    <div class="pc-group">
      <div class="pc-group-title">${esc(GROUP_LABEL[g] ?? g)}</div>
      ${rows.map((c) => {
        const col = COMP_COLOR[c.state] ?? COMP_COLOR.unmonitored;
        const note = c.state === 'unmonitored'
          ? (c.sensorHint ? `no sensor \u2014 ${c.sensorHint}` : 'no sensor on this part')
          : Number.isFinite(c.worstRatio)
            ? `${(c.worstRatio * 100).toFixed(0)}% of limit \u00b7 ${c.causes[0]?.rule ?? c.rulesEvaluated[0] ?? ''}`
            : c.state === 'no_rule' ? 'signal arriving, no rule evaluates it'
              : c.state === 'blind' ? 'its sensor stopped reporting' : '';
        return `<button class="pc-row${focusComp === c.id ? ' on' : ''}" data-comp="${esc(c.id)}"
                        aria-pressed="${focusComp === c.id}">
          <span class="pc-dot" style="background:${col}"></span>
          <span class="pc-name">${esc(c.label)}</span>
          ${wearBar(c.worstRatio)}
          <span class="pc-state" style="color:${col}">${COMP_WORD[c.state] ?? c.state}</span>
          <span class="pc-note">${esc(note)}</span>
        </button>`;
      }).join('')}
    </div>`).join('');

  for (const b of el.querySelectorAll('.pc-row')) {
    b.onclick = () => {
      // Second click clears it, so the highlight is never sticky.
      focusComp = focusComp === b.dataset.comp ? null : b.dataset.comp;
      renderComponents(cv);
      requestDraw(false);
    };
  }

  const un = fixed.filter((c) => c.state === 'unmonitored').length;
  $('componentSrc').textContent = `${fixed.length - un}/${fixed.length} instrumented`;
}

// ------------------------------------------------------------ component tip

const tipVisible = () => $('compTip')?.classList.contains('on');

/** Headroom bar: fill is the measured fraction of the limit, tick marks it. */
function bar(ratio) {
  if (!Number.isFinite(ratio)) return '';
  const width = (Math.min(ratio, 2) / 2) * 100;
  const col = ratio >= 2 ? COMP_COLOR.urgent_inspection
    : ratio >= 1 ? COMP_COLOR.planned_inspection
      : ratio >= 0.75 ? COMP_COLOR.observe : COMP_COLOR.healthy;
  return `<div class="tip-bar"><i style="width:${width.toFixed(1)}%;background:${col}"></i></div>`;
}

let tipFor = null;

function showCompTip(id, ev) {
  const c = compIndex[id];
  const el = $('compTip');
  if (!c || !el) return;

  if (tipFor !== id) {
    tipFor = id;
    const col = COMP_COLOR[c.state] ?? RISK_COLOR[c.state] ?? COMP_COLOR.unmonitored;
    const rows = [`<div class="tip-head">
        <span class="tip-name">${esc(c.label)}</span>
        <span class="tip-state" style="color:${col};border-color:${col}">${COMP_WORD[c.state] ?? c.state.toUpperCase()}</span>
      </div>`];

    if (c.state === 'unmonitored') {
      rows.push(`<div class="tip-none">Nothing on this rig reports on it, so no condition can be claimed.</div>`);
    } else if (c.state === 'no_rule') {
      rows.push(`<div class="tip-none">Signal is arriving but no rule evaluates it yet, so no condition can be claimed.</div>`);
    } else if (c.state === 'blind') {
      rows.push(`<div class="tip-none">Its sensor stopped reporting. The last known state cannot be trusted.</div>`);
    } else if (!c.causes.length) {
      rows.push(`<div class="tip-none">${Number.isFinite(c.worstRatio)
        ? `Closest rule sits at ${(c.worstRatio * 100).toFixed(0)}% of its limit.`
        : 'No rule for this component could be evaluated yet.'}</div>`);
      if (Number.isFinite(c.worstRatio)) rows.push(bar(c.worstRatio));
    } else {
      for (const cause of c.causes.slice(0, 3)) {
        rows.push(`<div class="tip-cause">
          <div class="tip-rule">${esc(cause.rule)}<span>${Number.isFinite(cause.ratio) ? `${(cause.ratio * 100).toFixed(0)}% of limit` : ''}</span></div>
          <div class="tip-msg">${esc(cause.message)}</div>
          ${bar(cause.ratio)}
        </div>`);
      }
    }

    if (c.watching?.length) rows.push(`<div class="tip-src">measured from ${c.watching.map(esc).join(', ')}</div>`);
    if (c.coverage) rows.push(`<div class="tip-cov">${esc(c.coverage)}</div>`);
    // What it would take to see this part. An unmonitored component is not a
    // dead end, it is a line item - and this is the one an E&M department can
    // put a price against.
    if (c.sensorHint) rows.push(`<div class="tip-hint">To monitor it: ${esc(c.sensorHint)}</div>`);
    if (c.joint) rows.push(`<div class="tip-cov">Click to open this joint's record.</div>`);
    el.innerHTML = rows.join('');
  }

  el.classList.add('on');
  moveCompTip(ev);
}

function moveCompTip(ev) {
  const el = $('compTip');
  if (!el || !el.classList.contains('on')) return;
  const wrap = el.parentElement.getBoundingClientRect();
  const x = Number.isFinite(ev?.clientX) ? ev.clientX - wrap.left : wrap.width / 2;
  const y = Number.isFinite(ev?.clientY) ? ev.clientY - wrap.top : wrap.height / 2;
  el.style.left = `${Math.max(6, Math.min(x + 16, wrap.width - el.offsetWidth - 6))}px`;
  el.style.top = `${Math.max(6, Math.min(y + 16, wrap.height - el.offsetHeight - 6))}px`;
}

function hideCompTip() {
  $('compTip')?.classList.remove('on');
  tipFor = null;
}

/**
 * Named camera positions. A wall display gets orbited by whoever walked past
 * last, and an operator who wants "the drive end, from the walkway" should not
 * have to find it by dragging.
 */
// Each preset carries its own projection centre as well as its angle. A long
// machine framed for a three-quarter view runs straight off the edge when you
// swing round to look down the belt from the head, because what was 40 m of
// length becomes 40 m of depth. These numbers were measured from the rendered
// bounding box at each angle, not guessed.
const VIEWS = {
  iso: { yaw: -0.66, pitch: 0.36, dist: 1420, cx: 389, cy: 194 },
  side: { yaw: 0, pitch: 0.08, dist: 1020, cx: 446, cy: 207 },
  top: { yaw: -0.04, pitch: 1.06, dist: 1100, cx: 448, cy: 238 },
  head: { yaw: -1.26, pitch: 0.30, dist: 1367, cx: 356, cy: 190 },
  tail: { yaw: 1.26, pitch: 0.30, dist: 1161, cx: 475, cy: 146 },
};

/** Orbit control, wired once the DOM exists. */
function initSchematic() {
  const svg = $('schematic');
  if (!svg) return;
  // `fast` is true while a gesture is in flight; the settled frame is full
  // quality. See LOD above.
  Scene3D.orbit(svg, cam, (fast) => requestDraw(fast));

  $('viewReset').onclick = () => { Object.assign(cam, HOME); requestDraw(false); };
  for (const b of document.querySelectorAll('[data-view]')) {
    b.onclick = () => {
      Object.assign(cam, VIEWS[b.dataset.view] ?? HOME);
      for (const o of document.querySelectorAll('[data-view]')) o.setAttribute('aria-pressed', o === b);
      requestDraw(false);
    };
  }
}

// ---------------------------------------------------------------- channels

function renderChannels(cv) {
  const groups = {};
  for (const [key, c] of Object.entries(cv.channels)) {
    (groups[c.group] ??= []).push([key, c]);
  }
  const html = Object.entries(groups).map(([g, rows]) => `
    <div class="chan-group">
      <div class="chan-group-title">${GROUP_TITLE[g] ?? g}</div>
      ${rows.map(([key, c]) => {
        const has = c.value !== null && c.value !== undefined;
        const v = has
          ? `<span class="chan-value">${num(c.value, decimals(c.unit))}<span class="unit">${esc(c.unit)}</span></span>`
          : `<span class="chan-value nosignal">NO SIGNAL</span>`;
        return `<div class="chan-row${DERIVED.has(key) ? ' derived' : ''}">
          <div class="chan-name">${esc(c.label)}<span class="badge" data-state="${c.state}">${c.state.toUpperCase()}</span></div>
          ${v}
        </div>`;
      }).join('')}
    </div>`).join('');
  $('channelGroups').innerHTML = html;

  const liveCount = Object.values(cv.channels).filter((c) => c.state === 'live').length;
  const total = Object.keys(cv.channels).length;
  $('channelSrc').textContent = `${liveCount}/${total} live`;
}

// ------------------------------------------------------------------ trend

let trendInited = false;
function renderTrendOptions(cv) {
  if (trendInited) return;
  const sel = $('trendChannel');
  sel.innerHTML = Object.entries(cv.channels)
    .map(([k, c]) => `<option value="${esc(k)}">${esc(c.label)}</option>`).join('');
  sel.value = 'motor_current_rms';
  sel.onchange = loadTrend;
  $('trendWindow').onchange = loadTrend;
  trendInited = true;
  loadTrend();
}

async function loadTrend() {
  const cv = currentConveyor();
  if (!cv) return;
  const channel = $('trendChannel').value;
  const minutes = $('trendWindow').value;
  try {
    const res = await fetch(`/api/history?conveyor=${encodeURIComponent(cv.id)}&channel=${channel}&minutes=${minutes}`);
    const data = await res.json();
    drawSeries($('trendChart'), data.points ?? [], data.unit ?? '');
    $('trendEmpty').classList.toggle('hidden', (data.points ?? []).length > 0);
  } catch {
    $('trendEmpty').classList.remove('hidden');
  }
}
setInterval(loadTrend, 5000);

/** Line chart on a canvas. No library, no smoothing, no interpolation of gaps. */
function drawSeries(canvas, points, unit, color = LAMP) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (!points.length) return;

  const padL = 52, padR = 10, padT = 10, padB = 22;
  const xs = points.map((p) => p.ts), ys = points.map((p) => p.v);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (hi - lo < 1e-9) { hi = lo + 1; lo -= 1; }
  const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
  const t0 = Math.min(...xs), t1 = Math.max(...xs);
  const X = (t) => padL + ((t - t0) / Math.max(t1 - t0, 1)) * (w - padL - padR);
  const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);

  g.font = '10px "IBM Plex Mono", Consolas, monospace';
  g.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) / 4) * i;
    const y = Y(v);
    g.strokeStyle = '#191c21'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(padL, y + 0.5); g.lineTo(w - padR, y + 0.5); g.stroke();
    g.fillStyle = '#5c564d'; g.textAlign = 'right';
    g.fillText(v.toFixed(Math.abs(hi - lo) < 5 ? 2 : 1), padL - 7, y);
  }
  g.fillStyle = '#5c564d'; g.textAlign = 'left';
  g.fillText(new Date(t0).toLocaleTimeString(), padL, h - 9);
  g.textAlign = 'right';
  g.fillText(new Date(t1).toLocaleTimeString(), w - padR, h - 9);
  if (unit) { g.textAlign = 'left'; g.fillText(unit, 6, padT + 4); }

  const grad = g.createLinearGradient(0, padT, 0, h - padB);
  grad.addColorStop(0, color + '33'); grad.addColorStop(1, color + '00');
  g.beginPath(); g.moveTo(X(points[0].ts), h - padB);
  for (const p of points) g.lineTo(X(p.ts), Y(p.v));
  g.lineTo(X(points.at(-1).ts), h - padB); g.closePath();
  g.fillStyle = grad; g.fill();

  g.beginPath();
  points.forEach((p, i) => (i ? g.lineTo(X(p.ts), Y(p.v)) : g.moveTo(X(p.ts), Y(p.v))));
  g.strokeStyle = color; g.lineWidth = 1.6; g.lineJoin = 'round'; g.stroke();

  const last = points.at(-1);
  g.beginPath(); g.arc(X(last.ts), Y(last.v), 3, 0, Math.PI * 2);
  g.fillStyle = color; g.fill();
}

// ----------------------------------------------------------------- joints

function renderJoints(cv) {
  const tb = $('jointTable').querySelector('tbody');
  if (!cv.joints.length) {
    tb.innerHTML = `<tr class="empty-row"><td colspan="8">NO JOINT PASSES RECORDED — the joint table fills as the marker sensor reports each splice</td></tr>`;
    $('jointSrc').textContent = 'awaiting marker detections';
    return;
  }
  tb.innerHTML = cv.joints.map((j) => {
    const l = j.last ?? {};
    const asym = Number.isFinite(l.joint_marker_dt_left) && Number.isFinite(l.joint_marker_dt_right)
      && (l.joint_marker_dt_left + l.joint_marker_dt_right) > 0
      ? (Math.abs(l.joint_marker_dt_left - l.joint_marker_dt_right) /
         ((l.joint_marker_dt_left + l.joint_marker_dt_right) / 2)) * 100
      : null;
    const blN = j.baseline?.event_vibration_rms?.n ?? 0;
    const cell = (v, d, suffix = '') =>
      v === null ? '<span class="muted">&mdash;</span>' : `${num(v, d)}${suffix}`;
    return `<tr data-joint="${esc(j.id)}">
      <td>${esc(j.label ?? j.id)}</td>
      <td><span class="pill" data-risk="${j.risk ?? 'unknown'}">${(j.risk ?? 'unknown').replace(/_/g, ' ')}</span></td>
      <td class="num">${j.passes ?? 0}</td>
      <td class="num">${j.baselineReady ? `${blN} laps` : `<span class="muted">${blN}/${cv.baselineLaps}</span>`}</td>
      <td class="num">${cell(asym, 2, '%')}</td>
      <td class="num">${cell(l.event_vibration_rms ?? null, 3, ' g')}</td>
      <td class="num">${cell(l.crack_length ?? null, 1, ' mm')}</td>
      <td class="num muted">${ago(j.last_ts)}</td>
    </tr>`;
  }).join('');
  for (const tr of tb.querySelectorAll('tr[data-joint]')) {
    tr.onclick = () => openDrawer(tr.dataset.joint);
  }
  const ready = cv.joints.filter((j) => j.baselineReady).length;
  $('jointSrc').textContent = `${ready}/${cv.joints.length} baselined (${cv.baselineLaps} laps)`;
}

// ----------------------------------------------------------------- alarms

function renderAlarms(cv) {
  const el = $('alarmList');
  if (!cv.alarms.length) {
    el.innerHTML = `<div class="empty-note">NO OPEN ALARMS</div>`;
    return;
  }
  el.innerHTML = cv.alarms.map((a) => {
    let ev = null;
    try { ev = a.evidence ? JSON.parse(a.evidence) : null; } catch { /* keep null */ }
    const measured = ev?.measured
      ? Object.entries(ev.measured).map(([k, v]) =>
          `${k}=${typeof v === 'number' ? v.toFixed(3) : v}`).join('  ')
      : '';
    return `<div class="alarm">
      <div class="alarm-bar" style="background:${RISK_COLOR[a.level] ?? RISK_COLOR.unknown}"></div>
      <div class="alarm-main">
        <div class="alarm-msg">${esc(a.message)}</div>
        <div class="alarm-meta">${esc(a.joint_id ?? 'conveyor')} · ${esc(a.family ?? '')} · ${esc(ev?.rule ?? '')} · ${ago(a.ts)}${a.ack_ts ? ` · ack ${esc(a.ack_by ?? '')}` : ''}</div>
        ${measured ? `<div class="alarm-meta">${esc(measured)}</div>` : ''}
      </div>
      <div class="alarm-actions">
        <button class="ghost-btn" data-ack="${a.id}"${a.ack_ts ? ' disabled' : ''}>${a.ack_ts ? 'ACKED' : 'ACK'}</button>
        <button class="ghost-btn" data-close="${a.id}">CLOSE</button>
      </div>
    </div>`;
  }).join('');

  for (const b of el.querySelectorAll('[data-ack]')) {
    b.onclick = () => fetch(`/api/alarms/${b.dataset.ack}/ack`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ by: 'operator' }),
    });
  }
  for (const b of el.querySelectorAll('[data-close]')) {
    b.onclick = () => {
      const outcome = prompt('Close alarm. What did the inspection find?\n(adjusted / inspected / repaired / replaced / no_action)');
      if (outcome === null) return;
      fetch(`/api/alarms/${b.dataset.close}/close`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outcome: outcome || 'no_action', technician: 'operator' }),
      });
    };
  }
}

// ------------------------------------------------------------------ nodes

function renderNodes() {
  const el = $('nodeList');
  if (!snap.nodes.length) {
    el.innerHTML = `<div class="empty-note">NO NODE HAS ANNOUNCED ITSELF</div>`;
    $('nodeSrc').textContent = '0 nodes';
    return;
  }
  el.innerHTML = snap.nodes.map((n) => {
    const cls = n.state === 'live' ? 'on' : n.state === 'offline' ? 'off' : '';
    const health = n.health
      ? `<div class="node-health">${Object.entries(n.health)
          .map(([k, s]) => `<span class="hchip" data-s="${esc(s)}">${esc(k)}</span>`).join('')}</div>`
      : '';
    return `<div class="node">
      <span class="dot ${cls}"></span>
      <div>
        <div class="node-id">${esc(n.node)}</div>
        ${health}
      </div>
      <div class="node-meta">
        ${n.state.toUpperCase()} · ${ago(n.ts)}<br>
        ${n.rssi !== null && n.rssi !== undefined ? `${n.rssi} dBm · ` : ''}${esc(n.firmware ?? '')}
      </div>
    </div>`;
  }).join('');
  const up = snap.nodes.filter((n) => n.state === 'live').length;
  $('nodeSrc').textContent = `${up}/${snap.nodes.length} live`;
}

// ------------------------------------------------------------------- gaps

function renderGaps(cv) {
  const gaps = new Map();
  for (const s of cv.telemetrySkipped ?? []) gaps.set(s.rule, s.why);
  for (const j of cv.joints) for (const s of j.skipped ?? []) gaps.set(`${j.id}:${s.rule}`, s.why);

  const el = $('gapList');
  if (!gaps.size) {
    el.innerHTML = `<div class="empty-note">${cv.lastMessageTs === null ? 'NOTHING EVALUATED YET' : 'ALL RULES EVALUATING'}</div>`;
    return;
  }
  el.innerHTML = [...gaps].map(([rule, why]) =>
    `<div class="gap"><div class="gap-rule">${esc(rule)}</div><div class="gap-why">${esc(why)}</div></div>`
  ).join('');
}

// ----------------------------------------------------------------- ingest

function renderIngest(cv) {
  $('ingestStats').innerHTML = `
    <div><dt>Telemetry frames</dt><dd>${cv.counters.telemetry}</dd></div>
    <div><dt>Joint passes</dt><dd>${cv.counters.joints}</dd></div>
    <div><dt>Vision reports</dt><dd>${cv.counters.vision}</dd></div>
    <div><dt>Rejected</dt><dd>${cv.counters.rejects}</dd></div>
    <div><dt>Rows stored</dt><dd>${cv.stored.telemetry}</dd></div>
    <div><dt>Passes stored</dt><dd>${cv.stored.jointPasses}</dd></div>
    <div><dt>Uptime</dt><dd>${Math.floor(snap.server.uptime_s / 60)}m</dd></div>`;

  const el = $('rejectList');
  el.innerHTML = snap.rejects.length
    ? snap.rejects.map((r) =>
        `<div class="reject"><span>${new Date(r.ts).toLocaleTimeString()} ${esc(r.topic)}</span> ${esc(r.reason)}</div>`
      ).join('')
    : `<div class="reject" style="color:var(--dimmer)">none</div>`;
  $('ingestSrc').textContent = snap.mqtt.broker;
}

// ----------------------------------------------------------------- drawer

async function openDrawer(jointId) {
  openJoint = jointId;
  $('drawer').setAttribute('aria-hidden', 'false');
  $('scrim').classList.add('on');
  await refreshDrawer(currentConveyor());
}

function closeDrawer() {
  openJoint = null;
  $('drawer').setAttribute('aria-hidden', 'true');
  $('scrim').classList.remove('on');
}
$('drawerClose').onclick = closeDrawer;
$('scrim').onclick = closeDrawer;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

async function refreshDrawer(cv) {
  if (!openJoint || !cv) return;
  const j = cv.joints.find((x) => x.id === openJoint);
  $('drawerTitle').textContent = j?.label ?? openJoint;
  $('drawerSub').textContent = j
    ? `${j.passes ?? 0} passes · last ${ago(j.last_ts)} · ${(j.risk ?? 'unknown').replace(/_/g, ' ')}`
    : 'no passes recorded';

  let detail = { passes: [], baseline: {} };
  try {
    const res = await fetch(`/api/joint/${encodeURIComponent(openJoint)}?conveyor=${encodeURIComponent(cv.id)}`);
    detail = await res.json();
  } catch { /* leave empty */ }

  const last = j?.last ?? {};
  const bl = detail.baseline ?? {};
  const CELLS = [
    ['joint_marker_dt_left', 'Marker dt L', 'ms', 1],
    ['joint_marker_dt_right', 'Marker dt R', 'ms', 1],
    ['marker_distance_left', 'Distance L', 'mm', 1],
    ['marker_distance_right', 'Distance R', 'mm', 1],
    ['event_vibration_rms', 'Impact RMS', 'g', 3],
    ['event_vibration_peak', 'Impact peak', 'g', 3],
    ['crack_length', 'Crack', 'mm', 1],
    ['opening', 'Opening', 'mm', 2],
    ['edge_separation', 'Edge sep.', 'mm', 2],
    ['belt_offset', 'Offset', 'mm', 1],
  ];

  const cells = CELLS.map(([key, label, unit, d]) => {
    const v = last[key];
    const b = bl[key];
    if (v === undefined || v === null) {
      return `<div class="dcell"><div class="k">${label}</div><div class="v none">NO SIGNAL</div></div>`;
    }
    let delta = '';
    let cls = '';
    if (b && b.n > 1 && b.mean !== 0) {
      const pc = ((v - b.mean) / Math.abs(b.mean)) * 100;
      delta = `base ${b.mean.toFixed(d)} · ${pc >= 0 ? '+' : ''}${pc.toFixed(1)}%`;
      if (Math.abs(pc) > 25) cls = ' up';
    } else {
      delta = `baseline ${b?.n ?? 0}/${cv.baselineLaps}`;
    }
    return `<div class="dcell">
      <div class="k">${label}</div>
      <div class="v${cls}">${Number(v).toFixed(d)} <span style="font-size:10px;color:var(--dim)">${unit}</span></div>
      <div class="b">${delta}</div>
    </div>`;
  }).join('');

  const findings = (j?.findings ?? []).map((f) => `
    <div class="finding" data-level="${esc(f.level)}">
      <div class="fmsg">${esc(f.message)}</div>
      <div class="fmeta">${esc(f.rule)} · ${esc(Object.entries(f.measured ?? {})
        .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(3) : v}`).join('  '))}</div>
    </div>`).join('') || `<div class="empty-note" style="padding:14px 0">NO RULE TRIGGERED ON THE LAST PASS</div>`;

  const skipped = (j?.skipped ?? []).map((s) =>
    `<div class="gap"><div class="gap-rule">${esc(s.rule)}</div><div class="gap-why">${esc(s.why)}</div></div>`
  ).join('') || `<div class="empty-note" style="padding:14px 0">ALL RULES EVALUATING</div>`;

  const evidenceImg = j?.evidence_frame
    ? `<div class="dsection"><h3>Evidence frame${j.image_quality != null ? ` · quality ${j.image_quality.toFixed(2)}` : ''}</h3>
       <img class="evidence-img" src="${esc(j.evidence_frame)}" alt="Last captured frame of ${esc(openJoint)}"></div>`
    : '';

  $('drawerBody').innerHTML = `
    <div class="dsection"><h3>Last pass vs own baseline</h3><div class="dgrid">${cells}</div></div>
    <div class="dsection"><h3>Findings</h3>${findings}</div>
    <div class="dsection"><h3>Impact RMS over the last ${detail.passes.length} passes</h3>
      <div class="dchart-wrap"><canvas id="jointChart"></canvas></div></div>
    ${evidenceImg}
    <div class="dsection"><h3>Rules not evaluated</h3>${skipped}</div>`;

  const pts = (detail.passes ?? [])
    .filter((p) => Number.isFinite(p.event_vibration_rms))
    .map((p) => ({ ts: p.ts, v: p.event_vibration_rms }));
  const cnv = $('jointChart');
  if (cnv) {
    if (pts.length) drawSeries(cnv, pts, 'g', '#d05f26');
    else {
      const g = cnv.getContext('2d');
      g.clearRect(0, 0, cnv.width, cnv.height);
      cnv.parentElement.insertAdjacentHTML('beforeend',
        '<div class="chart-empty">NO IMPACT SAMPLES STORED</div>');
    }
  }
}

// ------------------------------------------------------------------- boot

// If this client throws, the screen must SAY so. A monitoring dashboard that
// silently stops updating is worse than one that is obviously broken: the
// panels keep showing the last good frame and an operator reads stale numbers
// as current ones.
function fatal(what, err) {
  const b = $('banner');
  if (!b) return;
  b.className = 'banner';
  b.dataset.kind = 'alert';
  b.textContent = `DASHBOARD FAULT in ${what} - ${err?.message ?? err}. `
    + 'Readings on screen may be stale. Reload; if it persists, the console has the stack.';
  console.error(`[pravaah] ${what}`, err);
}
addEventListener('error', (e) => fatal('page script', e.error ?? e.message));
addEventListener('unhandledrejection', (e) => fatal('async task', e.reason));

setInterval(() => { $('clock').textContent = clock(); }, 1000);
$('clock').textContent = clock();
setInterval(() => { if (snap) render(); }, 1000); // keeps "ago" fields moving
// The socket is opened even if the scene fails to wire up, so a broken
// renderer never takes the numbers down with it.
try { initSchematic(); } catch (err) { fatal('schematic setup', err); }
connect();
