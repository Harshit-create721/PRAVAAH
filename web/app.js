import { SENSOR_COMPONENTS, ROLLER_COMPONENTS, canInspectComponent, inspectionChannels, visionDamageReadings } from './sensor-inspection.js';
import { MINING_MODEL, miningAsset, miningStaticFaces, miningMovingFaces, miningAnchors, toModel } from './mining-model.js';
import {
  attachModelFullscreen, filterComponents, historyCSV, axisRange, formatTime, nodeName,
  humanReason, sustainedML, RULE_TEXT, ruleTitle, ENGINEERING_CHANNELS,
} from './dashboard-ui.js';
import { statusReportHTML } from './readiness.js';
import { motionReading, advanceMotion, motionFaces } from './belt-motion.js';

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
// Must track the semantic ladder in style.css. Teal is reserved for controls
// and chart traces; it does not indicate equipment health.
const RISK_COLOR = {
  unknown: '#97a9b6', healthy: '#6f9e46', observe: '#c4a52c',
  planned_inspection: '#d08a22', urgent_inspection: '#d05f26', critical: '#cc3a2e',
};
const LAMP = '#42d6c4';
const GROUP_TITLE = {
  drive: 'Drive', vibration: 'Vibration', thermal: 'Thermal',
  tracking: 'Tracking', acoustic: 'Acoustic', load: 'Load',
};
const DERIVED = new Set(['slip_ratio', 'temperature_delta']);
// Firmware health keys, as an operator would name the part.
const HEALTH_NAME = { mlx: 'IR thermometer', speed: 'Hall sensor', vibration: 'accelerometer', camera: 'camera' };

let snap = null;
let snapshotReceivedAt = 0;
let activeConveyor = null;
let openJoint = null;
let drawerRequest = 0;

// ------------------------------------------------------------ formatting

const num = (v, d = 2) =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Number(v).toFixed(d);

function decimals(unit) {
  if (unit === 'rpm') return 1;
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

// Every time on screen is plant time (config.timeZone), labelled. Exports stay UTC.
const plantTime = (ts) => formatTime(ts, snap?.server?.timeZone ?? null);
const plantDayTime = (ts) => {
  if (!Number.isFinite(ts)) return 'never';
  let day = '';
  try {
    day = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short',
      ...(snap?.server?.timeZone ? { timeZone: snap.server.timeZone } : {}) }).format(ts);
  } catch { /* unknown zone */ }
  return `${day} ${plantTime(ts)}`.trim();
};
const clock = () => plantTime(Date.now());

// Per-viewer preferences. Storage can be unavailable (private mode); the page
// must work regardless.
const storage = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* not persisted */ } },
};

const parseEvidence = (a) => { try { return a?.evidence ? JSON.parse(a.evidence) : null; } catch { return null; } };

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
    if (msg.type === 'snapshot') { snap = msg; snapshotReceivedAt = Date.now(); render(); }
  };
}

function setLink(up) {
  $('wsDot').className = `dot ${up ? 'on' : 'off'}`;
  $('wsLabel').textContent = up ? 'GATEWAY ONLINE' : 'RECONNECTING';
  if (snap) render();
}

const gatewayLive = () => ws?.readyState === WebSocket.OPEN && Date.now() - snapshotReceivedAt < 10000;

// ---------------------------------------------------------------- render

const ML_STATUS = { NORMAL: 'Within baseline range', WATCH: 'Baseline deviation',
  WARNING: 'High baseline deviation', CRITICAL: 'Very high baseline deviation' };
// Recent scored windows. One window is 2.5 s; the headline only reports a
// status that held for three consecutive windows, so a single spike cannot
// flash CRITICAL next to a HEALTHY rule verdict and vanish again.
const mlWindows = [];
function renderML(cv) {
  const ml = cv.ml;
  const gatewayNow = snap.server.now + Date.now() - snapshotReceivedAt;
  const fresh = ws?.readyState === WebSocket.OPEN && ml?.type === 'condition'
    && ml.data_quality === 'valid' && Number.isFinite(ml.end_ms)
    && gatewayNow - ml.end_ms <= 5000 && gatewayNow >= ml.end_ms - 1000;
  if (fresh && !mlWindows.some((w) => w.end_ms === ml.end_ms)) {
    mlWindows.push(ml);
    if (mlWindows.length > 12) mlWindows.shift();
  }
  const s = fresh ? sustainedML(mlWindows) : null;
  const shown = s?.sustained ?? null;

  if (fresh && !shown) {
    $('mlStatus').textContent = 'Confirming';
    $('mlScore').textContent = '';
    $('mlDetail').textContent = 'A status is reported once it holds for three consecutive 10-second windows (about 7 s).';
  } else if (fresh) {
    $('mlStatus').textContent = ML_STATUS[shown.status] ?? 'Baseline deviation';
    $('mlScore').textContent = Number.isFinite(shown.anomaly_score) ? `${shown.anomaly_score.toFixed(1)} / 100` : '';
    $('mlDetail').textContent = `Held for three consecutive windows. ${shown.explanation ?? ''}`;
  } else {
    $('mlStatus').textContent = ml?.status === 'WARMING_UP' && ws?.readyState === WebSocket.OPEN ? 'Collecting a full window' : 'Data unavailable';
    $('mlScore').textContent = '';
    $('mlDetail').textContent = ws?.readyState !== WebSocket.OPEN ? 'Gateway connection interrupted.'
      : ml?.type === 'condition' ? 'Waiting for fresh readings from all three sensors.'
        : humanReason(ml?.reason ?? 'The ML service is unavailable.');
  }

  const note = $('mlTransient');
  note.hidden = !(fresh && s?.transient);
  if (!note.hidden) {
    note.textContent = `Brief ${s.latest.status.toLowerCase()} window (${s.latest.anomaly_score.toFixed(1)}) at `
      + `${plantTime(s.latest.end_ms)}; not sustained, so not reported as the condition.`;
  }

  // One sentence reconciling the two verdicts, so they never silently disagree.
  const agree = $('mlAgree');
  agree.hidden = !(fresh && shown);
  if (!agree.hidden) {
    const mlNormal = shown.status === 'NORMAL';
    const ruleAlarm = cv.alarms.length > 0;
    agree.textContent = !ruleAlarm && mlNormal ? 'Rules and ML baseline agree: operating normally.'
      : !ruleAlarm ? 'ML sees a sustained deviation that no rule has confirmed. No alarm raised; worth a visual check.'
        : mlNormal ? 'A rule alarm is open while the ML baseline reads normal. Check whether it came from a brief event.'
          : 'Rules and the ML baseline both indicate a problem.';
  }
}

function currentConveyor() {
  if (!snap?.conveyors?.length) return null;
  const cv = snap.conveyors.find((c) => c.id === activeConveyor) ?? snap.conveyors[0];
  if (gatewayLive()) return cv;
  // Preserve historical values but invalidate live claims after a lost feed.
  return { ...cv, risk: 'unknown', riskSource: 'Gateway feed unavailable', operating_state: 'unknown',
    channels: Object.fromEntries(Object.entries(cv.channels).map(([key, c]) => [key,
      { ...c, state: c.state === 'never' ? 'never' : 'offline' }])),
    components: (cv.components ?? []).map(c => c.state === 'unmonitored' ? c
      : { ...c, state: 'blind', causes: [], worstRatio: null, rulesEvaluated: [] }) };

}

function render() {
  if (!snap) return;
  const cv = currentConveyor();
  activeConveyor = cv?.id ?? null;

  $('siteLabel').textContent = snap.server.siteLabel ?? snap.server.site;
  $('mqttDot').className = `dot ${gatewayLive() && snap.mqtt.connected ? 'on' : 'off'}`;
  $('mqttLabel').textContent = !gatewayLive() ? 'BROKER UNKNOWN'
    : snap.mqtt.connected ? 'SENSOR BROKER ONLINE' : 'BROKER DOWN';

  renderTabs();
  if (!cv) return;

  renderOverview(cv);
  renderBanner(cv);
  renderRisk(cv);
  renderML(cv);
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

function renderOverview(cv) {
  const connected = gatewayLive();
  const channels = Object.values(cv.channels);
  const live = channels.filter(c => c.state === 'live').length;
  const fixed = (cv.components ?? []).filter(c => !c.joint);
  const evaluated = fixed.filter(c => c.rulesEvaluated?.length).length;
  $('assetName').textContent = `${cv.id} / ${cv.label ?? 'Conveyor'}`;
  $('assetMeta').textContent = `${snap.server.siteLabel ?? snap.server.site} · ${connected ? 'Gateway connected' : 'Connection interrupted'}`;
  $('summaryCondition').textContent = connected ? (RISK_WORD[cv.risk] ?? 'NO DATA') : 'OFFLINE';
  $('summaryCondition').style.color = RISK_COLOR[cv.risk] ?? RISK_COLOR.unknown;
  $('summaryConditionNote').textContent = cv.lastMessageTs === null ? 'Waiting for the first sensor packet' : `Last sensor packet ${ago(cv.lastMessageTs)}`;
  $('summaryChannels').textContent = `${live} / ${channels.length}`;
  $('summaryChannelsNote').textContent = live ? 'Channels currently reporting' : 'No live sensor channels';
  $('summaryAlarms').textContent = cv.alarms.length;
  $('navAlarmCount').textContent = cv.alarms.length;
  $('summaryAlarmsNote').textContent = !connected ? 'Last received alarm records' : cv.alarms.length ? 'Review findings and plan maintenance' : cv.lastMessageTs === null ? 'No data evaluated yet' : 'No open alarm records';
  $('summaryCoverage').textContent = `${evaluated} / ${fixed.length}`;
}

function renderTabs() {
  const el = $('conveyorTabs');
  el.innerHTML = snap.conveyors.map((c) =>
    `<button data-id="${esc(c.id)}" aria-current="${c.id === activeConveyor}">${esc(c.id)}</button>`
  ).join('');
  for (const b of el.querySelectorAll('button')) {
    b.onclick = () => { if (openJoint) closeDrawer(); activeConveyor = b.dataset.id; resetComponent(); render(); loadTrend(); };
  }
}

function renderBanner(cv) {
  const b = $('banner');
  const noData = cv.lastMessageTs === null;
  const missingGeom = !cv.geometry.configured;
  // The bench harness publishes under `bench-*` node ids. If one is live,
  // say so loudly - nothing on screen is a measurement while it runs.
  const bench = snap.nodes.some((n) => n.state !== 'offline' && /^bench/i.test(n.node));

  if (!gatewayLive()) {
    b.className = 'banner'; b.dataset.kind = 'alert';
    b.textContent = 'Gateway connection interrupted. Readings are historical; live condition is unavailable. Reconnecting automatically.';
  } else if (bench) {
    b.className = 'banner';
    b.dataset.kind = 'alert';
    b.textContent = 'BENCH SOURCE ACTIVE — frames are coming from tools/bench-publisher.js, not from hardware. Nothing on this screen is a measurement.';
  } else if (noData) {
    b.className = 'banner';
    b.dataset.kind = 'wait';
    b.textContent = 'Ready to monitor. Connect a sensor node to start receiving measurements and evaluating conveyor condition.';
  } else if (cv.risk === 'critical' || cv.risk === 'urgent_inspection') {
    b.className = 'banner'; b.dataset.kind = 'alert';
    b.textContent = `${RISK_WORD[cv.risk]} — ${cv.alarms[0]?.message ?? 'Review active findings.'}`;
  } else if (missingGeom) {
    b.className = 'banner';
    b.dataset.kind = 'wait';
    const missing = [
      ['beltLengthM', 'full belt loop length'],
      ['pulleyDiameterMm', 'drive pulley diameter'],
      ['gearRatio', 'gear ratio'],
    ].filter(([key]) => !(cv.geometry[key] > 0)).map(([, label]) => label);
    const loop = cv.geometry.beltLengthM > 0
      ? `BELT LOOP ${cv.geometry.beltLengthM.toFixed(2)} m — ` : '';
    b.textContent = `${loop}Asset settings incomplete: ${missing.join(', ')}. Belt-slip checks stay off until these are measured on the machine.`;
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
// The default mining view imports the actual Blender MC-120 meshes through
// mining-model.js. Scene3D and ConveyorViewport retain projection, picking,
// status coloring and the offline SVG fallback. The bench rig stays procedural.
// Individual pieces belong to monitoring assemblies; a selected bolt does not
// acquire its own sensor or alter the gateway's alarm/coverage counts.

const COMP_COLOR = {
  unmonitored: '#687988',
  no_rule: '#8a9ca8',
  blind: '#8a9ca8',
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
// Neutral machine steel. It has to sit ABOVE the panel background once shaded,
// or an unmonitored part reads as a hole in the picture rather than as metal.
const STEEL = '#9badbd';
const DARK_STEEL = '#627381';
const RUBBER = '#303a43';
const COAL = '#263039';
// Ambient floor per part. High enough that a face turned away from the cap
// lamp is still legible - an operator must be able to see the whole machine -
// but low enough that the machine still has form. The base colours above are
// lifted to compensate, so the darkest face is still clearly metal.
const AMB = 0.64;

// Model dimensions, in arbitrary units. +x along the belt, +y up, +z across.
const BENCH_MODEL = {
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

const M = { ...MINING_MODEL };

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
// Bench rig (conveyor `model: 'bench'`), drawn in the same model frame.
const BENCH = { sideZ: M.face / 2 + 7, gz: M.face / 2 + 37, irX: -30, floorY: M.cy - 70 };

// Keep identical geometry through zoom, orbit and telemetry updates.
const DETAIL = { run: 24, wrap: 18, cols: 6, pulley: 36, roll: 16, small: 12, detail: true };

// A long machine on one screen wants a LONG lens: raising dist and focal
// together keeps the size but flattens the perspective, so the conveyor
// reads as a machine drawing rather than a wide-angle photograph of one.
const cam = { yaw: -0.45, pitch: 0.42, dist: 1250, focal: 1420, cx: 436, cy: 210, tx: 48, ty: 0, tz: 0 };
const HOME = { ...cam };

let compIndex = {};
let lastCv = null;
let partPoints = {};
let viewport = null;
let preparedFaces = [];
let cameraAnimation = 0;
let focusComp = null;      // component currently being inspected
const motion = { phase: 0, rotation: 0, travel: 0, at: null };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let motionEnabled = storage.get('pravaah.motion') !== 'off' && !reducedMotion.matches;
let motionVisible = true;
let motionRaf = 0;
let motionFrameAt = 0;
let sceneCache = null;

function beltDrive() {
  const channel = lastCv?.channels?.belt_speed;
  const node = snap?.nodes?.find(n => n.node === channel?.node);
  return motionReading(lastCv, {
    connected: gatewayLive(), enabled: motionEnabled,
    now: snap ? snap.server.now + Date.now() - snapshotReceivedAt : Date.now(),
    nodeOnline: !node || node.state === 'live',
    visualLoopLengthM: lastCv?.geometry?.model === 'bench' ? null : miningAsset.loopLength,
  });
}

function renderMotionStatus(reading = beltDrive()) {
  const speed = reading.speed === null ? '' : ` · ${reading.speed.toFixed(3)} m/s`;
  const words = { moving: 'Belt moving', stopped: 'Belt stopped', paused: 'Animation paused',
    unavailable: 'Motion held · speed unavailable', unconfigured: 'Set belt loop length to animate' };
  $('motionReadout').dataset.state = reading.status;
  $('motionStatus').textContent = words[reading.status] + speed;
  $('motionSource').textContent = lastCv?.playback
    ? `Recorded playback${lastCv.playback.loop ? ` · looping (${lastCv.playback.cycle ?? 1})` : ''} · ${lastCv.playback.rate}× · ${plantTime(lastCv.playback.recorded_at_ms)}`
    : 'Live sensor feed · motion follows measured belt speed';
  $('modelMotion').setAttribute('aria-pressed', String(motionEnabled));
  $('modelMotion').textContent = motionEnabled ? 'Pause motion' : 'Resume motion';
}

function scheduleMotion() {
  if (motionRaf || !motionVisible || document.hidden || beltDrive().status !== 'moving') return;
  motionRaf = requestAnimationFrame(frame => {
    motionRaf = 0;
    if (!motionVisible || document.hidden) { motion.at = null; return; }
    // Reuse static geometry and labels; update only moving part transforms.
    if (frame - motionFrameAt >= 1000 / (viewport?.ready === false || !viewport ? 24 : 60) - .5) {
      motionFrameAt = frame;
      const reading = beltDrive();
      advanceMotion(motion, reading, frame, M);
      try { paintScene(); } catch (err) { fatal('belt animation', err); return; }
      if (reading.status !== 'moving') { motion.at = null; renderMotionStatus(reading); }
    }
    scheduleMotion();
  });
}

function resetMotionClock() {
  if (motionRaf) cancelAnimationFrame(motionRaf);
  motionRaf = 0;
  motion.at = null;
  motionFrameAt = 0;
}

$('modelMotion').onclick = () => {
  motionEnabled = !motionEnabled;
  storage.set('pravaah.motion', motionEnabled ? 'on' : 'off');
  resetMotionClock(); renderMotionStatus(); scheduleMotion();
};
reducedMotion.addEventListener('change', event => {
  if (event.matches) { motionEnabled = false; resetMotionClock(); renderMotionStatus(); }
});
document.addEventListener('visibilitychange', () => { resetMotionClock(); scheduleMotion(); });
new IntersectionObserver(entries => {
  motionVisible = entries[0].isIntersecting;
  resetMotionClock(); scheduleMotion();
}).observe($('schematic'));

const compColor = (state) => COMP_COLOR[state] ?? COMP_COLOR.unmonitored;

/** Colour a part carries in the scene: status colour, or bare steel. */
function partPaint(state, base = STEEL) {
  return VAGUE.has(state)
    ? { color: base, stroke: null }
    : { color: compColor(state), stroke: null };
}

let benchFramed = false;
function renderSchematic(cv) {
  $('modelEmpty').hidden = true;
  if (lastCv?.id !== cv.id) { resetMotionClock(); motion.phase = 0; motion.rotation = 0; motion.travel = 0; }
  Object.assign(M, cv.geometry?.model === 'bench' ? BENCH_MODEL : MINING_MODEL);
  lastCv = cv;
  if (beltDrive().status !== 'moving') resetMotionClock();
  renderMotionStatus();
  // The bench rig has no hopper, drive train or legs sticking out, so at the
  // mining camera distance it fills a third of the view. Pull every preset in
  // once, so it fills the viewport the way the mining model does.
  if (cv.geometry?.model === 'bench' && !benchFramed) {
    benchFramed = true;
    for (const v of [cam, HOME, ...Object.values(VIEWS)]) v.dist = Math.round(v.dist * 0.7);
  }
  compIndex = {};
  for (const c of cv.components ?? []) compIndex[c.id] = c;
  if (focusComp && !canInspectComponent(focusComp, cv)) focusComp = null;
  populateSensorComponents();
  requestDraw(false);
  scheduleMotion();
}

// One redraw per animation frame at most. Without this, a fast drag queues
// more full scene rebuilds than the browser can retire and the view lags
// behind the pointer.
let rafId = 0;
function requestDraw() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    try { drawScene(); } catch (err) { fatal('3D scene', err); }
  });
}

/**
 * The team's bench rig as photographed (ConveryBelt/): a short flat belt on an
 * aluminium profile frame, two plain end pulleys, painted end brackets standing
 * on the floor, and a right-angle gear motor on the head shaft. No idlers,
 * hopper, take-up, scraper or pull-cord: drawing those would claim equipment
 * the demo machine does not have. The belt itself is lofted by drawScene.
 */
function drawBenchRig(faces, q, paint, plain) {
  const { x0, x1, cy, r, face } = M;
  const { sideZ, gz, irX, floorY } = BENCH;
  const ALU = '#b3bec7', PLATE = '#c3cad1';

  // End pulleys and their shafts.
  for (const [x, id] of [[x0, 'tail_pulley'], [x1, 'drive_pulley']]) {
    faces.push(...Scene3D.cylinderZ([x, cy, 0], r - 1.5, face, q.pulley, paint(id, '#d5dade')));
    faces.push(...Scene3D.cylinderZ([x, cy, 0], 4.5, face + 30, q.small, paint(id)));
  }

  // Aluminium profile frame between the pulleys, with a T-slot line on each face.
  for (const s of [-1, 1]) {
    faces.push(...Scene3D.box([0, cy, s * sideZ], [x1 - x0 - 10, 2 * r - 12, 8], plain(ALU)));
    faces.push(...Scene3D.box([0, cy, s * (sideZ + 4.5)], [x1 - x0 - 10, 2.5, 1.5], plain('#7f8b95')));
  }

  // Painted end brackets: wide along the frame, narrowing to a foot on the floor.
  for (const [x, dir] of [[x0, -1], [x1, 1]]) {
    for (const s of [-1, 1]) {
      const z = s * (sideZ + 6);
      const top = cy + 10, inner = x - dir * 70, outer = x + dir * 14;
      faces.push({
        pts: [[inner, top, z], [outer, top, z], [x + dir * 4, floorY, z], [x - dir * 34, floorY, z]],
        color: PLATE, ambient: AMB, edge: true, material: 'paint', twoSided: true,
      });
      faces.push(...Scene3D.box([x - dir * 15, floorY - 1.5, z], [44, 3, 14], plain('#8f9aa3')));
      // Shaft bearings bolted to the bracket. Only the head side is a rule-bearing part.
      faces.push(...Scene3D.box([x, cy, s * (sideZ + 10)], [16, 16, 8],
        x === x1 ? paint('drive_bearing') : plain('#9aa5ae')));
    }
  }

  // Right-angle gear motor on the head shaft, outboard of the near bracket:
  // gearbox on the shaft, motor body running out past the head and down.
  faces.push(...Scene3D.box([x1 + 4, cy - 4, gz], [40, 42, 34], paint('gearbox', '#9aa6b0')));
  faces.push(...Scene3D.cylinderZ([x1 + 4, cy - 4, gz + 19], 12, 6, q.small, paint('gearbox', '#7c8791')));
  const m0 = [x1 + 24, cy - 12, gz], m1 = [x1 + 92, cy - 48, gz];
  faces.push(...Scene3D.cylinderBetween(m0, m1, 16, q.pulley, paint('drive_motor', '#8d98a2')));
  faces.push(...Scene3D.cylinderBetween(m1, [m1[0] + 6, m1[1] - 3.2, gz], 13, q.small, paint('drive_motor', '#3b5f8a')));

  // The single spot the IR thermometer reads, as a patch on the carrying run.
  faces.push(...Scene3D.box([irX, cy + r + 1.8, 0], [34, 1.2, M.width * 0.5], paint('idlers', '#5b6b76')));
}

function drawScene() {
  const cv = lastCv;
  if (!cv) return;
  const svg = $('schematic');
  if (!svg) return;
  const q = DETAIL;
  const { x0, x1, cy, r, hw, face } = M;
  const st = (id) => compIndex[id]?.state ?? 'unmonitored';
  const faces = [];

  /** Attribute bundle for a hit-testable part. */
  const paint = (id, base = STEEL) => {
    const p = partPaint(st(id), base);
    const material = base === RUBBER ? 'rubber'
      : ['drive_motor', 'gearbox', 'loading_chute', 'pull_cord'].includes(id) ? 'paint' : 'steel';
    return { color: p.color, stroke: p.stroke, dash: p.dash, comp: SENSOR_COMPONENTS.has(id) ? id : null, ambient: AMB, edge: true,
      material, textureStrength: VAGUE.has(st(id)) ? 1 : 0.35 };
  };
  /** Bare structure: visible, but not a component anything reports on. */
  const plain = (color = DARK_STEEL, extra = {}) => ({ color, ambient: AMB, edge: true, material: 'paint', ...extra });

  const bench = cv.geometry?.model === 'bench';
  const secOpts = { width: M.width, troughRise: 0, flat: 1, cols: q.cols };
  if (bench) {
  const path = Scene3D.beltPath({
    x0, x1, cy, r, runSegs: q.run, wrapSegs: q.wrap, taper: M.taper,
  });
  // Both the bench rig and the imported MC-120 use a flat carrying belt.
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
          material: 'rubber', textureStrength: VAGUE.has(st(id)) ? 1 : 0.35,
          // Keep the interior of the belt free of a distracting wire grid.
          stroke: k === 0 || k === A.length - 2 ? p.stroke : null,
          dash: p.dash,
        });
      }
    }
  }

    drawBenchRig(faces, q, paint, plain);
  } else {
    faces.push(...miningStaticFaces(paint));
  }

  // ---- joints: bands across the carrying run, riding the trough
  const joints = cv.joints ?? [];
  const jointBands = [];
  joints.forEach((j, i) => {
    const span = (x1 - x0) - 150;
    const x = x0 + 90 + (span / Math.max(joints.length, 1)) * (i + 0.5);
    const cid = `joint:${j.id}`;
    const damage = visionDamageReadings(j);
    const inspectId = damage.length ? cid : null;
    const state = compIndex[cid]?.state ?? j.risk ?? 'unknown';
    const col = COMP_COLOR[state] ?? RISK_COLOR[state] ?? RISK_COLOR.unknown;
    const band = (xx) => Scene3D.beltSection(
      { p: [xx, cy + r], n: [0, 1], trough: troughAt(xx) },
      { ...secOpts, cols: 6, lift: 2.6 });
    const A = band(x - 6), B = band(x + 6);
    for (let k = 0; k < A.length - 1; k++) {
      faces.push({
        pts: [A[k], A[k + 1], B[k + 1], B[k]],
        color: col, comp: inspectId, flat: true, twoSided: true,
        cls: ALERT.has(state) ? 'sch-alert' : null,
      });
    }
    // A schematic scar marks reported damage; it is not a camera-localized shape.
    if (damage.length) {
      const offsets = [-.65, -.35, -.05, .25, .6];
      for (let k = 0; k < offsets.length - 1; k++) {
        const a = [x + (k % 2 ? 3 : -3), cy + r + 3.2, hw * offsets[k]];
        const b = [x + (k % 2 ? -3 : 3), cy + r + 3.2, hw * offsets[k + 1]];
        faces.push({ pts: [a, b, [b[0] + 2, b[1], b[2]], [a[0] + 2, a[1], a[2]]],
          color: '#efaa55', comp: cid, flat: true, twoSided: true });
      }
    }
    jointBands.push({ id: damage.length ? `${j.id} / WEAR & TEAR` : j.id, cid, x, y: cy + r + 3, state });
  });

  // ---- a part picked out in the roster gets a halo so the eye lands on it
  if (focusComp) {
    for (const f of faces) if (f.comp === focusComp || f.part === focusComp) f.cls = `${f.cls ? f.cls + ' ' : ''}sch-focus-part`;
  }

  partPoints = {};
  const boundsFaces = bench ? faces : [...faces, ...miningMovingFaces(paint, motion)];
  for (const f of boundsFaces) {
    if (f.comp) (partPoints[f.comp] ??= []).push(...f.pts);
    if (f.part) (partPoints[f.part] ??= []).push(...f.pts);
  }
  sceneCache = { faces, prepared: Scene3D.prepare(faces, cam), secOpts, paint, bench };
  const focusedId = svg.contains(document.activeElement) ? document.activeElement.dataset.comp : null;
  // Keep labels and keyboard targets stable during motion frames.
  svg.innerHTML = `<g id="sceneSurfaces"></g><g id="sceneLabels">${buildLabels(cv, jointBands, q)}</g>`;
  paintScene();
  wireHits(svg);
  if (focusedId) [...svg.querySelectorAll('.sch-focus')].find(el => el.dataset.comp === focusedId)?.focus({ preventScroll: true });
  renderSchematicSummary(cv);
}

function paintScene() {
  if (!sceneCache) return;
  const svg = $('schematic');
  const { faces, prepared, secOpts, paint, bench } = sceneCache;
  const marks = bench ? motionFaces(Scene3D, M, secOpts, motion, paint, true)
    : miningMovingFaces(paint, motion);
  preparedFaces = [...prepared, ...Scene3D.prepare(marks, cam)];
  const textures = true;
  const drawn = viewport?.draw(preparedFaces, cam, focusComp, textures, prepared) ?? false;
  $('schematicCanvas').hidden = !drawn;
  svg.dataset.renderer = drawn ? 'webgl' : 'svg';
  svg.dataset.faceCount = faces.length + marks.length;
  svg.dataset.components = Object.keys(partPoints).length;
  svg.dataset.motionPhase = motion.phase.toFixed(6);
  // Labels and accessible part targets remain SVG; solid surfaces stay on GPU.
  const surface = $('sceneSurfaces');
  if (drawn) { if (surface.childNodes.length) surface.replaceChildren(); }
  else surface.innerHTML = Scene3D.render([...faces, ...marks], cam, textures, focusComp);
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
  const occupied = [];
  const place = (point, width, height) => {
    for (const [dx, dy] of [[0, 0], [80, 0], [-80, 0], [0, -65], [0, 65], [120, -65], [-120, -65], [160, 65], [-160, 65]]) {
      const x = Math.max(width / 2 + 8, Math.min(864 - width / 2, point[0] + dx));
      const y = Math.max(24, Math.min(395 - height, point[1] + dy));
      const box = { x: x - width / 2, y: y - 16, w: width, h: height };
      if (!occupied.some(b => box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y)) {
        occupied.push(box); return [x, y];
      }
    }
    return point;
  };

  const bench = cv.geometry?.model === 'bench';
  const anchors = bench ? [
    { id: 'tail_pulley', p: [x0 - 6, cy + r + 10, -(BENCH.sideZ + 26)], text: 'TAIL' },
    { id: 'drive_pulley', p: [x1 - 6, cy + r + 34, -(BENCH.sideZ + 44)], text: 'HEAD / DRIVE' },
    { id: 'drive_motor', p: [x1 + 100, cy - 62, BENCH.gz], text: 'GEAR MOTOR' },
  ] : miningAnchors;
  for (const a of anchors) {
    if (focusComp && a.id !== focusComp && a.id !== compIndex[focusComp]?.parentId) continue;
    const s = compIndex[a.id]?.state ?? 'unmonitored';
    const p = place(Scene3D.project(a.p, cam), a.text.length * 5 + 10, 26);
    out.push(`<text class="sch-label" x="${p[0].toFixed(1)}" y="${(p[1] + 13).toFixed(1)}"
      text-anchor="middle" fill="${VAGUE.has(s) ? '#8a9ca8' : compColor(s)}" pointer-events="none">${a.text}</text>`);
  }

  // Sensor nodes: a marker in 3D at the place it is mounted, with its label.
  // A marker is green only when its channel is arriving now - this is the row
  // an operator checks first when a part goes grey.
  const sensors = [
    // Current only. Hall cycle speed has its own callout; showing it here
    // would imply a CT is fitted when none is.
    { p: bench ? [x1, cy + 52, MOTOR_Z] : toModel([4.25, -2.04, 3.3]), label: 'CT', chans: ['motor_current_rms'],
      show: ['motor_current_rms'] },
    { p: bench ? [x1 - 14, cy + 52, BENCH.sideZ + 10] : toModel([5, -1.09, 3.6]), label: 'VIB-DRIVE', chans: ['vibration_rms'],
      show: ['vibration_rms', 'vibration_crest'] },
    { p: [40, cy + r + 74, 0], label: 'CAM', chans: ['belt_offset_left', 'belt_offset_right'],
      show: ['belt_offset_left', 'belt_offset_right'] },
    { p: bench ? [x0 + 96, cy + r + 44, -(BENCH.sideZ + 8)] : toModel([-3.0, 1.05, .9]), label: 'HALL SPEED', chans: ['hall_rpm', 'motor_rpm', 'belt_speed'],
      show: ['hall_rpm', 'belt_speed'] },
    { p: bench ? [BENCH.irX, cy + r + 52, hw + 12] : toModel([-.4, -1.3, 3.45]), label: 'IR TEMP', chans: ['temperature'],
      show: ['temperature', 'temperature_delta'] },
    {
      p: [x0 + 26, cy + r + 56, -(hw + 14)], label: 'MARKER L/R',
      // No telemetry channel of its own: the marker sensors announce
      // themselves by producing joint passes, so that is what is reported.
      live: gatewayLive() && (cv.joints ?? []).some((j) => Number.isFinite(j.last_ts)
        && snap.server.now + Date.now() - snapshotReceivedAt - j.last_ts < 3000),
      seen: (cv.joints ?? []).length > 0,
      // Laps are the marker's measurement, so that is its readout.
      readout: () => {
        const laps = (cv.joints ?? []).map((j) => j.lap).filter(Number.isFinite);
        return laps.length ? [`LAP ${Math.max(...laps)}`] : null;
      },
    },
  ];
  for (const s of sensors) {
    if (focusComp && !(s.chans ?? []).some(key => compIndex[focusComp]?.watch?.includes(key))) continue;
    const states = (s.chans ?? []).map((c) => cv.channels[c]?.state ?? 'never');
    const on = s.live ?? states.some((x) => x === 'live');
    const seen = s.seen ?? states.some((x) => x !== 'never');
    // A marker for a sensor that has never reported (CT, camera, joint marker
    // on this rig) reads as a claim that it is fitted. Show it only while that
    // part is being inspected, where it doubles as "what to install".
    if (!seen && !focusComp) continue;
    const col = on ? '#6f9e46' : seen ? '#d08a22' : '#3a3830';
    const lines = s.readout ? s.readout() : readoutFor(cv, s.show);
    const p = place(Scene3D.project(s.p, cam), 84, 38 + (lines?.length ?? 0) * 10);
    // Leader line back to the machine surface it is mounted on.
    const base = Scene3D.project([s.p[0], cy + (s.p[1] > cy ? r : -r), s.p[2]], cam);
    out.push(`<line x1="${p[0].toFixed(1)}" y1="${p[1].toFixed(1)}" x2="${base[0].toFixed(1)}" y2="${base[1].toFixed(1)}"
      stroke="${col}" stroke-width="1" stroke-dasharray="3 3" opacity="0.65" pointer-events="none"/>`);
    out.push(`<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4" fill="${col}" opacity="${on ? 0.95 : 0.5}" pointer-events="none"/>`);
    out.push(`<text class="sch-label" x="${p[0].toFixed(1)}" y="${(p[1] - 9).toFixed(1)}" text-anchor="middle"
      fill="${on ? '#a2b2bd' : '#8a9ca8'}" pointer-events="none">${s.label}</text>`);

    // The reading itself, stacked under the marker. Same rule as everywhere
    // else in this dashboard: a channel nobody has published reads NO SIGNAL,
    // never a zero and never a dash that could pass for one.
    if (lines) {
      lines.forEach((line, i) => {
        out.push(`<text class="sch-readout" x="${p[0].toFixed(1)}" y="${(p[1] + 15 + i * 10).toFixed(1)}"
          text-anchor="middle" fill="${on ? '#c6e1df' : '#8a9ca8'}" pointer-events="none">${esc(line)}</text>`);
      });
    }
    // No NO SIGNAL text here on purpose. The marker dot is already grey for a
    // channel that has never published, and the Live Channels panel spells it
    // out; repeating it in the 3D view only lands the words on top of the
    // neighbouring part labels, which costs legibility for no new information.
  }

  for (const b of jointBands) {
    if (focusComp && b.cid !== focusComp) continue;
    const p = Scene3D.project([b.x, b.y + 30, 0], cam);
    const col = COMP_COLOR[b.state] ?? RISK_COLOR[b.state] ?? RISK_COLOR.unknown;
    out.push(`<text class="sch-label" x="${p[0].toFixed(1)}" y="${p[1].toFixed(1)}" text-anchor="middle"
      fill="${col}" pointer-events="none">${esc(b.id)}</text>`);
  }

  if (!jointBands.length && !focusComp) {
    out.push(`<text class="sch-label" x="436" y="414" text-anchor="middle" fill="#97a9b6"
      pointer-events="none">NO JOINT MARKER DETECTED YET</text>`);
  }

  // Keyboard focus proxies: one invisible box per part, so the scene is
  // reachable without a mouse. Skipped mid-gesture - nothing can be focused
  // while the pointer is dragging, and they are the most expensive labels.
  const annotations = $('modelLabels').getAttribute('aria-pressed') === 'true' ? out.join('') : '';
  out.length = 0;
  if (q.detail) {
    for (const c of Object.values(compIndex).filter(c => canInspectComponent(c.id, cv))) {
      const points = partPoints[c.id] ?? PART_ANCHOR[c.id]?.();
      if (!points) continue;
      const bb = Scene3D.bounds(points, cam);
      out.push(`<rect class="sch-focus" x="${(bb.x - 4).toFixed(1)}" y="${(bb.y - 4).toFixed(1)}"
        width="${(bb.w + 8).toFixed(1)}" height="${(bb.h + 8).toFixed(1)}" fill="none" stroke="none"
        pointer-events="none" tabindex="0" role="button" data-comp="${esc(c.id)}"
        aria-label="${esc(c.label)}: ${COMP_WORD[c.state] ?? c.state}"/>`);
    }
  }

  return annotations + out.join('');
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

function componentAt(event) {
  if (event.target?.dataset?.comp) return canInspectComponent(event.target.dataset.comp, lastCv) ? event.target.dataset.comp : null;
  const svg = $('schematic');
  const matrix = svg.getScreenCTM();
  if (!matrix) return null;
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  const id = Scene3D.pick(preparedFaces, point.x, point.y, focusComp);
  return canInspectComponent(id, lastCv) ? id : null;
}

/** Pointer picking and accessible keyboard component selection. */
function wireHits(svg) {
  svg.onpointermove = (e) => {
    if (svg.classList.contains('dragging')) return;
    const id = componentAt(e);
    svg.classList.toggle('over-component', !!id);
    if (id && compIndex[id] && !focusComp && !svg.classList.contains('dragging')) showCompTip(id, e);
    else if (!svg.classList.contains('dragging')) hideCompTip();
    if (tipVisible()) moveCompTip(e);
  };
  svg.onpointerleave = hideCompTip;
  svg.onclick = (e) => {
    if (svg.dataset.dragged) { svg.dataset.dragged = ''; return; }
    const id = componentAt(e);
    if (id && compIndex[id]) selectComponent(id);
  };
  for (const f of svg.querySelectorAll('.sch-focus')) {
    f.onfocus = (e) => {
      if (focusComp) return;
      const bb = e.target.getBoundingClientRect();
      showCompTip(e.target.dataset.comp, { clientX: bb.left + bb.width / 2, clientY: bb.top + bb.height / 2 });
    };
    f.onblur = hideCompTip;
    f.onkeydown = (e) => {
      const id = e.target.dataset.comp;
      if ((e.key === 'Enter' || e.key === ' ') && id && compIndex[id]) {
        e.preventDefault();
        selectComponent(id);
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
// The roster below the model. It exists because a 3D picture answers "where"
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
  const filtered = filterComponents(fixed, $('componentSearch').value, $('componentFilter').value);
  $('componentResults').textContent = `${filtered.length} of ${fixed.length} components`;
  for (const c of filtered) {
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group).push(c);
  }

  const focusedId = el.contains(document.activeElement) ? document.activeElement.dataset.comp : null;
  el.innerHTML = [...groups].map(([g, rows]) => `
    <div class="pc-group">
      <div class="pc-group-title">${esc(GROUP_LABEL[g] ?? g)}</div>
      ${rows.map((c) => {
        const col = COMP_COLOR[c.state] ?? COMP_COLOR.unmonitored;
        const note = c.state === 'unmonitored'
          ? (c.sensorHint ? `no sensor \u2014 ${c.sensorHint}` : 'no sensor on this part')
          : Number.isFinite(c.worstRatio)
            ? `${(c.worstRatio * 100).toFixed(0)}% of limit \u00b7 ${ruleTitle(c.causes[0]?.rule ?? c.rulesEvaluated[0])}`
            : c.state === 'no_rule' ? 'signal arriving, no rule evaluates it'
              : c.state === 'blind' ? 'its sensor stopped reporting' : '';
        const tag = canInspectComponent(c.id, cv) ? 'button' : 'div';
        return `<${tag} class="pc-row${focusComp === c.id ? ' on' : ''}" data-comp="${esc(c.id)}"
                        ${tag === 'button' ? `aria-pressed="${focusComp === c.id}"` : ''}>
          <span class="pc-dot" style="background:${col}"></span>
          <span class="pc-name">${esc(c.label)}</span>
          ${wearBar(c.worstRatio)}
          <span class="pc-state" style="color:${VAGUE.has(c.state) ? RISK_COLOR.unknown : col}">${COMP_WORD[c.state] ?? c.state}</span>
          <span class="pc-note">${esc(note)}</span>
        </${tag}>`;
      }).join('')}
    </div>`).join('') || '<div class="empty-note">No components match. Try another name or filter.</div>';

  for (const b of el.querySelectorAll('button.pc-row')) {
    b.onclick = () => {
      selectComponent(b.dataset.comp);
      $('machine').scrollIntoView({ block: 'start' });
    };
  }

  if (focusedId) [...el.querySelectorAll('button.pc-row')].find(b => b.dataset.comp === focusedId)?.focus({ preventScroll: true });
  renderComponentDetail(cv);
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

function componentHealthHTML(c, full = false) {
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
      for (const cause of c.causes.slice(0, full ? undefined : 3)) {
        rows.push(`<div class="tip-cause">
          <div class="tip-rule">${esc(ruleTitle(cause.rule))}<span>${Number.isFinite(cause.ratio) ? `${(cause.ratio * 100).toFixed(0)}% of limit` : ''}</span></div>
          <div class="tip-msg">${esc(cause.message)}</div>
          ${bar(cause.ratio)}
        </div>`);
      }
    }

    if (c.watching?.length) {
      const labels = c.watching.map((k) => esc(lastCv?.channels?.[k]?.label ?? k));
      rows.push(`<div class="tip-src">measured from ${labels.join(', ')}</div>`);
    }
    if (c.coverage) rows.push(`<div class="tip-cov">${esc(c.coverage)}</div>`);
    // What it would take to see this part. An unmonitored component is not a
    // dead end, it is a line item - and this is the one an E&M department can
    // put a price against.
    if (c.sensorHint) rows.push(`<div class="tip-hint">To monitor it: ${esc(c.sensorHint)}</div>`);

  return rows.join('');
}

function showCompTip(id, ev) {
  const c = compIndex[id];
  const el = $('compTip');
  if (!c || !el) return;
  el.innerHTML = componentHealthHTML(c);
  el.classList.add('on');
  moveCompTip(ev);
}

function renderComponentDetail(cv) {
  const component = compIndex[focusComp];
  const c = component && !gatewayLive() && component.everSeen?.length
    ? { ...component, state: 'blind', causes: [], worstRatio: null } : component;
  const panel = $('componentDetail');
  panel.hidden = !c;
  $('machine').classList.toggle('inspecting', !!c);
  $('modelMode').textContent = c ? 'COMPONENT INSPECTION / surrounding structure dimmed' : 'INTERACTIVE ASSET VIEW';
  if (!c) return;
  $('componentTitle').textContent = c.label;
  const partContext = ROLLER_COMPONENTS.has(c.id) ? '<p class="component-message">RPM uses the existing Hall sensor reading (Belt RPM). It is not a separate measurement of each roller.</p>' : '';
  const damage = c.joint ? visionDamageReadings(cv.joints.find(j => `joint:${j.id}` === c.id)) : [];
  const color = VAGUE.has(c.state) ? RISK_COLOR.unknown : compColor(c.state);
  const linked = inspectionChannels(c).map(key => [key, cv.channels[key]]);
  const readings = linked.map(([key, channel]) => {
    const live = channel?.state === 'live' && gatewayLive();
    const value = live ? num(channel.value, decimals(channel.unit)) : null;
    return `<div><dt>${esc(channel?.label ?? key)}</dt><dd>${value === null ? 'NO SIGNAL' : `${value} ${esc(channel.unit)}`}<small>${live ? 'LIVE' : 'UNAVAILABLE'} &middot; ${ago(channel?.ts)}</small></dd></div>`;
  }).join('');
  $('componentDetailBody').innerHTML = `${partContext}${damage.length ? `<figure class="vision-damage"><svg viewBox="0 0 240 72" width="240" height="72" role="img" aria-label="Schematic wear and tear indicator"><rect x="2" y="4" width="236" height="64" rx="8" fill="#303940"/><path d="M20 40 L57 27 L94 43 L131 25 L167 41 L219 30" fill="none" stroke="#efaa55" stroke-width="3"/></svg><figcaption><strong>Vision-reported wear &amp; tear</strong><p>${damage.map(d => `${esc(d.label)}: ${d.value.toFixed(1)} mm`).join(' &middot; ')}</p><small>Schematic indicator; shape and location are not measured. Last joint update: ${ago(cv.joints.find(j => `joint:${j.id}` === c.id)?.last_ts)}</small></figcaption></figure>` : ''}<div class="component-health"><strong class="component-status" style="color:${color}">${esc(COMP_WORD[c.state] ?? c.state)}</strong>${componentHealthHTML(c, true)}<div class="tip-cov">${c.rulesEvaluated.length} rules evaluated &middot; ${c.alarmCount ?? 0} open alarms</div></div>
    <div>${c.joint ? `<p class="component-message">${c.passes ?? 0} recorded passes &middot; Last seen ${ago(cv.joints.find(j => `joint:${j.id}` === c.id)?.last_ts)}</p>` : ''}${readings ? `<dl class="component-readings">${readings}</dl>` : '<p class="component-message">No live sensor channels are assigned to this component.</p>'}
    ${c.joint ? '<button class="ghost-btn" id="componentJointRecord">Open joint history</button>' : ''}</div>`;
  if (c.joint) $('componentJointRecord').onclick = () => openDrawer(c.id.slice(6));
}

function moveCamera(target) {
  cancelAnimationFrame(cameraAnimation);
  const start = { ...cam };
  const started = performance.now();
  const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 360;
  const frame = now => {
    const t = duration ? Math.min(1, (now - started) / duration) : 1;
    const eased = 1 - (1 - t) ** 3;
    for (const key of Object.keys(target)) cam[key] = start[key] + (target[key] - start[key]) * eased;
    requestDraw(false);
    cameraAnimation = t < 1 ? requestAnimationFrame(frame) : 0;
  };
  cameraAnimation = requestAnimationFrame(frame);
}

function selectComponent(id) {
  if (!compIndex[id] || !canInspectComponent(id, lastCv)) return;
  // Re-selecting the inspected part toggles back to the full conveyor,
  // using the same camera and control reset as the Reset button.
  if (focusComp === id) {
    $('viewReset').click();
    return;
  }
  focusComp = id;
  if ($('modelPartSelect')) $('modelPartSelect').value = id;
  hideCompTip();
  const points = partPoints[id] ?? PART_ANCHOR[id]?.();
  if (points?.length) {
    const min = [0, 1, 2].map(i => Math.min(...points.map(p => p[i])));
    const max = [0, 1, 2].map(i => Math.max(...points.map(p => p[i])));
    const target = { ...HOME, cx: 436, cy: 210,
      tx: (min[0] + max[0]) / 2, ty: (min[1] + max[1]) / 2, tz: (min[2] + max[2]) / 2 };
    const bounds = Scene3D.bounds(points, target);
    target.focal *= Math.min(4.5, 570 / Math.max(bounds.w, 1), 255 / Math.max(bounds.h, 1));
    moveCamera(target);
  }
  for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', 'false');
  renderComponents(lastCv);
  requestDraw(false);
}

function resetComponent(view = HOME) {
  focusComp = null;
  if ($('modelPartSelect')) $('modelPartSelect').value = '';
  hideCompTip();
  moveCamera({ ...HOME, ...view });
  if (lastCv) renderComponents(lastCv);
  requestDraw(false);
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
  iso: { yaw: -0.45, pitch: 0.42, dist: 1250, cx: 436, cy: 210 },
  side: { yaw: 0, pitch: 0.08, dist: 1020, cx: 446, cy: 207 },
  top: { yaw: -0.04, pitch: 1.06, dist: 1100, cx: 448, cy: 238 },
  head: { yaw: -1.26, pitch: 0.30, dist: 1490, cx: 386, cy: 174 },
  tail: { yaw: 1.26, pitch: 0.30, dist: 1161, cx: 475, cy: 146 },
};

function populateSensorComponents() {
  const select = $('modelPartSelect');
  if (!select) return;
  const query = ($('modelPartSearch').value ?? '').trim().toLowerCase();
  const available = Object.values(compIndex).filter(c => canInspectComponent(c.id, lastCv));
  const matching = available.filter(c => c.label.toLowerCase().includes(query));
  select.innerHTML = '<option value="">Select a sensor-linked component...</option>' + matching.map(c =>
    `<option value="${esc(c.id)}">${esc(c.label)}${c.joint ? ' / Wear &amp; tear' : ''}</option>`).join('');
  select.value = focusComp ?? '';
  $('modelPartCount').textContent = `${matching.length} of ${available.length} components`;
}

/** Orbit control, wired once the DOM exists. */
function initSchematic() {
  const svg = $('schematic');
  if (!svg) return;
  $('modelPartSearch').addEventListener('input', populateSensorComponents);
  $('modelPartSelect').addEventListener('change', e => { if (e.target.value) selectComponent(e.target.value); });
  attachModelFullscreen($('machine'), $('modelFullscreen'), requestDraw);
  // Keep joint records accessible in the browser's fullscreen top layer.
  $('machine').append($('scrim'), $('drawer'));
  $('modelLabels').onclick = () => {
    const b = $('modelLabels');
    b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
    requestDraw();
  };
  for (const [id, factor] of [['modelZoomIn', 1.18], ['modelZoomOut', 1 / 1.18]]) {
    $(id).onclick = () => {
      cancelAnimationFrame(cameraAnimation);
      cam.focal = Math.max(650, Math.min(9000, cam.focal * factor));
      for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', 'false');
      requestDraw();
    };
  }
  for (const id of ['componentSearch', 'componentFilter']) {
    $(id).addEventListener(id === 'componentSearch' ? 'input' : 'change', () => {
      if (lastCv) renderComponents(lastCv);
    });
  }
  try { viewport = new ConveyorViewport($('schematicCanvas'), () => requestDraw()); }
  catch (error) { console.warn('Using SVG model fallback:', error); }
  new ResizeObserver(() => requestDraw()).observe(svg);
  svg.addEventListener('pointerdown', () => cancelAnimationFrame(cameraAnimation));
  Scene3D.orbit(svg, cam, (fast) => {
    cancelAnimationFrame(cameraAnimation);
    hideCompTip();
    for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', 'false');
    requestDraw(fast);
  });

  $('viewReset').onclick = () => {
    resetComponent();
    for (const button of document.querySelectorAll('[data-view]')) {
      button.setAttribute('aria-pressed', button.dataset.view === 'iso');
    }
    requestDraw(false);
  };
  $('componentClose').onclick = () => { $('viewReset').click(); $('schematic').focus({ preventScroll: true }); };
  svg.addEventListener('keydown', e => {
    if (e.key === 'Escape') { $('viewReset').click(); svg.focus({ preventScroll: true }); }
  });
  for (const b of document.querySelectorAll('[data-view]')) {
    b.onclick = () => {
      resetComponent(VIEWS[b.dataset.view] ?? HOME);
      for (const o of document.querySelectorAll('[data-view]')) o.setAttribute('aria-pressed', o === b);
      requestDraw(false);
    };
  }
}

// ---------------------------------------------------------------- channels

// Channels no node has ever published are folded into one line: eight
// "NO SIGNAL" rows read as a broken system, when they are sensors this
// conveyor simply does not have. They stay listed, never hidden outright.
let uninstalledOpen = false;
$('channelGroups').addEventListener('toggle', (e) => {
  if (e.target.classList?.contains('chan-uninstalled')) uninstalledOpen = e.target.open;
}, true);

function renderChannels(cv) {
  const showEngineering = $('engToggle').getAttribute('aria-pressed') === 'true';
  const hallWaiting = gatewayLive() && cv.hallDiagnostics && Date.now() - cv.hallDiagnostics.ts < 5000;
  const groups = {};
  const uninstalled = [];
  for (const [key, c] of Object.entries(cv.channels)) {
    if (c.state === 'never' && !(key === 'hall_rpm' && hallWaiting)) { uninstalled.push(c.label); continue; }
    if (!showEngineering && ENGINEERING_CHANNELS.has(key)) continue;
    (groups[c.group] ??= []).push([key, c]);
  }
  const html = Object.entries(groups).map(([g, rows]) => `
    <div class="chan-group">
      <div class="chan-group-title">${GROUP_TITLE[g] ?? g}</div>
      ${rows.map(([key, c]) => {
        const has = c.value !== null && c.value !== undefined;
        const hall = key === 'hall_rpm' ? cv.hallDiagnostics : null;
        const hallFresh = gatewayLive() && hall && Date.now() - hall.ts < 5000;
        const waiting = hallFresh && !has;
        const hallNote = hallFresh
          ? `${hall.pulses ?? 0} magnet passes${hall.period_ms > 0 ? ` · loop ${(hall.period_ms / 1000).toFixed(2)} s` : ' · waiting for two passes to measure RPM'}`
          : '';
        const v = has
          ? `<span class="chan-value">${num(c.value, decimals(c.unit))}<span class="unit">${esc(c.unit)}</span></span>`
          : `<span class="chan-value nosignal">NO SIGNAL</span>`;
        return `<div class="chan-row${DERIVED.has(key) ? ' derived' : ''}">
          <div class="chan-name">${esc(c.label)}<span class="badge" data-state="${waiting ? 'stale' : c.state}">${waiting ? 'WAITING' : c.state.toUpperCase()}</span>${hallNote ? `<small class="chan-note">${esc(hallNote)}</small>` : ''}</div>
          ${v}
        </div>`;
      }).join('')}
    </div>`).join('');
  $('channelGroups').innerHTML = html + (uninstalled.length
    ? `<details class="chan-uninstalled"${uninstalledOpen ? ' open' : ''}><summary>Not installed on this conveyor (${uninstalled.length})</summary>
        <ul>${uninstalled.map((label) => `<li>${esc(label)}</li>`).join('')}</ul></details>`
    : '');

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
  sel.value = ['hall_rpm', 'vibration_rms', 'temperature'].find((key) => cv.channels[key]?.state === 'live')
    ?? (cv.channels.hall_rpm ? 'hall_rpm' : Object.keys(cv.channels)[0]);
  sel.onchange = loadTrend;
  $('trendWindow').onchange = loadTrend;
  trendInited = true;
  loadTrend();
}

let trendRequest = 0;
let trendData = null;
let trendAbort = null;
async function loadTrend() {
  const cv = currentConveyor();
  if (!cv) return;
  const channel = $('trendChannel').value;
  const minutes = $('trendWindow').value;
  const request = ++trendRequest;
  trendAbort?.abort();
  trendAbort = new AbortController();
  const key = `${cv.id}/${channel}/${minutes}`;
  if (trendData?.key !== key) {
    trendData = null;
    drawSeries($('trendChart'), [], '');
    $('exportTrend').disabled = true;
    $('trendEmpty').textContent = 'Loading signal history...';
    $('trendEmpty').classList.remove('hidden');
  }
  try {
    const res = await fetch(`/api/history?conveyor=${encodeURIComponent(cv.id)}&channel=${encodeURIComponent(channel)}&minutes=${encodeURIComponent(minutes)}`, { signal: trendAbort.signal });
    if (!res.ok) throw new Error(`History unavailable (${res.status})`);
    const data = await res.json();
    if (request !== trendRequest) return;
    const points = (data.points ?? []).filter(p => Number.isFinite(p.ts) && Number.isFinite(p.v));
    trendData = { key, conveyor: cv.id, channel, unit: data.unit ?? '', points };
    drawSeries($('trendChart'), points, trendData.unit);
    $('trendEmpty').textContent = 'No stored samples in this window';
    $('trendEmpty').classList.toggle('hidden', points.length > 0);
    $('exportTrend').disabled = !points.length;
    const values = points.map(p => p.v);
    const range = values.length ? values.reduce((r, v) => [Math.min(r[0], v), Math.max(r[1], v)], [Infinity, -Infinity]) : null;
    $('trendSummary').textContent = range
      ? `${points.length.toLocaleString()} samples / Min ${num(range[0])} / Max ${num(range[1])} / Latest ${num(points.at(-1).v)} ${trendData.unit}`
      : 'No measurements recorded for this signal and time window.';
  } catch (error) {
    if (request !== trendRequest || error.name === 'AbortError') return;
    trendData = null;
    drawSeries($('trendChart'), [], '');
    $('exportTrend').disabled = true;
    $('trendEmpty').textContent = 'History unavailable. Retrying automatically...';
    $('trendEmpty').classList.remove('hidden');
    $('trendSummary').textContent = 'Could not retrieve measurements from the gateway.';
  }
}
$('exportTrend').onclick = () => {
  if (!trendData?.points.length) return;
  const url = URL.createObjectURL(new Blob(['\ufeff', historyCSV(trendData)], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `pravaah-${trendData.conveyor}-${trendData.channel}-${new Date().toISOString().slice(0, 10)}.csv`.replace(/[^a-zA-Z0-9._-]/g, '_');
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
new ResizeObserver(() => {
  if (trendData) drawSeries($('trendChart'), trendData.points, trendData.unit);
}).observe($('trendChart'));
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
  // Minimum span relative to the signal, so a steady belt reads as steady.
  const [lo, hi] = axisRange(ys);
  const t0 = xs.reduce((a, b) => Math.min(a, b), Infinity), t1 = xs.reduce((a, b) => Math.max(a, b), -Infinity);
  const X = (t) => padL + ((t - t0) / Math.max(t1 - t0, 1)) * (w - padL - padR);
  const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);

  g.font = '10px "IBM Plex Mono", Consolas, monospace';
  g.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) / 4) * i;
    const y = Y(v);
    g.strokeStyle = '#263740'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(padL, y + 0.5); g.lineTo(w - padR, y + 0.5); g.stroke();
    g.fillStyle = '#94aab9'; g.textAlign = 'right';
    g.fillText(v.toFixed(Math.abs(hi - lo) < 0.5 ? 3 : Math.abs(hi - lo) < 5 ? 2 : 1), padL - 7, y);
  }
  g.fillStyle = '#94aab9'; g.textAlign = 'left';
  g.fillText(plantTime(t0), padL, h - 9);
  g.textAlign = 'right';
  g.fillText(plantTime(t1), w - padR, h - 9);
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
      <td><button class="joint-link" aria-label="Inspect joint ${esc(j.label ?? j.id)}">${esc(j.label ?? j.id)}</button></td>
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

const OUTCOME = {
  inspected_no_fault: 'inspected, no fault found', adjusted: 'adjusted', repaired: 'repaired',
  replaced: 'part replaced', false_alarm: 'false alarm (sensor or setting issue)',
  inspected: 'inspected', no_action: 'no action',
};

function renderAlarms(cv) {
  alertOnChange(cv.alarms);
  const el = $('alarmList');
  if (!cv.alarms.length) {
    el.innerHTML = `<div class="empty-note">NO OPEN ALARMS</div>`;
    return;
  }
  const parts = Object.fromEntries((cv.components ?? []).map((c) => [c.id, c.label]));
  el.innerHTML = cv.alarms.map((a) => {
    const ev = parseEvidence(a);
    const part = parts[ev?.component] ?? (a.joint_id ? `joint ${a.joint_id}` : 'the conveyor');
    const action = RULE_TEXT[ev?.rule]?.action;
    const readings = ev?.measured
      ? Object.entries(ev.measured).filter(([, v]) => typeof v === 'number')
        .map(([k, v]) => `${cv.channels[k]?.label ?? k.replace(/_/g, ' ')} ${num(v, 3)}`).join(' · ')
      : '';
    return `<div class="alarm">
      <div class="alarm-bar" style="background:${RISK_COLOR[a.level] ?? RISK_COLOR.unknown}"></div>
      <div class="alarm-main">
        <div class="alarm-msg">${esc(RISK_WORD[a.level] ?? a.level)}: ${esc(ruleTitle(ev?.rule))} at ${esc(part)}</div>
        <div class="alarm-meta">${esc(a.message)}</div>
        ${action ? `<div class="alarm-action"><b>Suggested check:</b> ${esc(action)}</div>` : ''}
        <div class="alarm-meta">Opened ${esc(plantDayTime(a.ts))} (${ago(a.ts)})${a.ack_ts ? ` · acknowledged by ${esc(a.ack_by ?? 'unknown')}` : ''}</div>
        ${readings ? `<div class="alarm-meta alarm-peak">Worst reading: ${esc(readings)}</div>` : ''}
      </div>
      <div class="alarm-actions">
        <button class="ghost-btn" data-ack="${a.id}"${a.ack_ts ? ' disabled' : ''}>${a.ack_ts ? 'Acknowledged' : 'Acknowledge'}</button>
        <button class="ghost-btn" data-close="${a.id}">Close</button>
      </div>
    </div>`;
  }).join('');

  const find = (id) => cv.alarms.find((x) => String(x.id) === id);
  for (const b of el.querySelectorAll('[data-ack]')) b.onclick = () => openAlarmDialog('ack', find(b.dataset.ack));
  for (const b of el.querySelectorAll('[data-close]')) b.onclick = () => openAlarmDialog('close', find(b.dataset.close));
}

// ---- acknowledge / close: always a named person, never a browser prompt()

let dialogTarget = null;
function openAlarmDialog(mode, alarm) {
  if (!alarm) return;
  dialogTarget = { mode, id: alarm.id };
  const ev = parseEvidence(alarm);
  $('alarmDialogTitle').textContent = mode === 'ack' ? 'Acknowledge alarm' : 'Close alarm';
  $('alarmDialogSub').textContent = `${ruleTitle(ev?.rule)}: ${alarm.message}`;
  $('alarmOutcomeWrap').hidden = mode === 'ack';
  $('alarmNotesWrap').hidden = mode === 'ack';
  $('alarmSubmit').textContent = mode === 'ack' ? 'Acknowledge' : 'Close alarm';
  $('alarmWho').value = storage.get('pravaah.operator') ?? '';
  $('alarmNotes').value = '';
  $('alarmDialog').showModal();
  ($('alarmWho').value ? $('alarmSubmit') : $('alarmWho')).focus();
}
$('alarmCancel').onclick = () => $('alarmDialog').close();
$('alarmForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const who = $('alarmWho').value.trim();
  if (!who || !dialogTarget) return;
  storage.set('pravaah.operator', who);
  const { mode, id } = dialogTarget;
  const body = mode === 'ack' ? { by: who }
    : { outcome: $('alarmOutcome').value, technician: who, notes: $('alarmNotes').value.trim() || null };
  $('alarmSubmit').disabled = true;
  try {
    const res = await fetch(`/api/alarms/${id}/${mode}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`gateway answered ${res.status}`);
    $('alarmDialog').close();
    if (alarmView === 'history') loadAlarmHistory();
  } catch (err) {
    $('alarmDialogSub').textContent = `Could not save (${err.message}). Try again.`;
  } finally {
    $('alarmSubmit').disabled = false;
  }
});

// ---- open / history

let alarmView = 'open';
function setAlarmView(view) {
  alarmView = view;
  $('alarmTabOpen').setAttribute('aria-pressed', String(view === 'open'));
  $('alarmTabHistory').setAttribute('aria-pressed', String(view === 'history'));
  $('alarmList').hidden = view !== 'open';
  $('alarmHistory').hidden = view !== 'history';
  if (view === 'history') loadAlarmHistory();
}
$('alarmTabOpen').onclick = () => setAlarmView('open');
$('alarmTabHistory').onclick = () => setAlarmView('history');

async function loadAlarmHistory() {
  const cv = currentConveyor();
  if (!cv) return;
  const el = $('alarmHistory');
  try {
    const res = await fetch(`/api/alarms?conveyor=${encodeURIComponent(cv.id)}`);
    if (!res.ok) throw new Error(String(res.status));
    const { alarms } = await res.json();
    el.innerHTML = alarms.length ? alarms.map((a) => {
      const ev = parseEvidence(a);
      const closed = a.closed_ts
        ? `Closed ${esc(plantDayTime(a.closed_ts))} by ${esc(a.closed_by ?? 'unknown')}: ${esc(OUTCOME[a.outcome] ?? a.outcome ?? 'no finding recorded')}${a.close_notes ? ` · "${esc(a.close_notes)}"` : ''}`
        : 'Still open';
      return `<div class="alarm">
        <div class="alarm-bar" style="background:${RISK_COLOR[a.level] ?? RISK_COLOR.unknown}"></div>
        <div class="alarm-main">
          <div class="alarm-msg">${esc(ruleTitle(ev?.rule))} · ${esc(RISK_WORD[a.level] ?? a.level)}</div>
          <div class="alarm-meta">${esc(a.message)}</div>
          <div class="alarm-meta">Opened ${esc(plantDayTime(a.ts))}${a.ack_ts ? ` · acknowledged ${esc(plantDayTime(a.ack_ts))} by ${esc(a.ack_by ?? 'unknown')}` : ''}</div>
          <div class="alarm-meta${a.closed_ts ? ' hist-outcome' : ''}">${closed}</div>
        </div>
      </div>`;
    }).join('') : '<div class="empty-note">NO ALARMS RECORDED YET</div>';
  } catch {
    el.innerHTML = '<div class="empty-note">Alarm history unavailable. Try again shortly.</div>';
  }
}

// ---- audible and visual alert when an alarm opens or escalates

let audio = null;
let soundOn = storage.get('pravaah.sound') !== 'off';
let knownAlarms = null; // id -> "level|message"
function syncSoundButton() {
  $('soundToggle').setAttribute('aria-pressed', String(soundOn));
  $('soundToggle').textContent = soundOn ? 'Sound on' : 'Sound off';
}
syncSoundButton();
$('soundToggle').onclick = () => {
  soundOn = !soundOn;
  storage.set('pravaah.sound', soundOn ? 'on' : 'off');
  syncSoundButton();
  if (soundOn) chime(1);
};
// Browsers only allow audio after a user gesture, so unlock on the first one.
addEventListener('pointerdown', () => {
  try { audio ??= new AudioContext(); audio.resume(); } catch { /* no audio */ }
}, { once: true });

function chime(times = 3) {
  if (!soundOn) return;
  try {
    audio ??= new AudioContext();
    const t0 = audio.currentTime;
    for (let i = 0; i < times; i++) {
      const at = t0 + i * 0.35;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'square';
      osc.frequency.value = i % 2 ? 660 : 880;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.28);
      osc.connect(gain).connect(audio.destination);
      osc.start(at);
      osc.stop(at + 0.3);
    }
  } catch { /* audio unavailable */ }
}

function alertOnChange(alarms) {
  const current = new Map(alarms.map((a) => [a.id, `${a.level}|${a.message}`]));
  if (knownAlarms && alarms.some((a) => !a.ack_ts && knownAlarms.get(a.id) !== current.get(a.id))) {
    chime(3);
    document.body.classList.remove('alarm-flash');
    void document.body.offsetWidth; // restart the animation
    document.body.classList.add('alarm-flash');
    setTimeout(() => document.body.classList.remove('alarm-flash'), 6500);
  }
  knownAlarms = current;
  document.title = alarms.length ? `(${alarms.length}) ALARM · PRAVAAH` : 'PRAVAAH | Conveyor intelligence';
}

// ------------------------------------------------------------------ nodes

function renderNodes() {
  const el = $('nodeList');
  if (!snap.nodes.length) {
    el.innerHTML = `<div class="empty-note">NO NODE HAS ANNOUNCED ITSELF</div>`;
    $('nodeSrc').textContent = '0 nodes';
    return;
  }
  const nodes = snap.nodes.map(n => gatewayLive() ? n : { ...n, state: 'offline', health: null });
  el.innerHTML = nodes.map((n) => {
    const cls = n.state === 'live' ? 'on' : n.state === 'offline' ? 'off' : '';
    const health = n.health
      ? `<div class="node-health">${Object.entries(n.health)
          .map(([k, s]) => `<span class="hchip" data-s="${esc(s)}" title="${esc(k)}: ${esc(s)}">${esc(HEALTH_NAME[k] ?? k)}</span>`).join('')}</div>`
      : '';
    return `<div class="node" title="${esc(n.firmware ? `Firmware ${n.firmware}` : '')}">
      <span class="dot ${cls}"></span>
      <div>
        <div class="node-id">${esc(nodeName(n.node))}<small class="node-sub">${esc(n.node)}</small></div>
        ${health}
      </div>
      <div class="node-meta">
        ${n.state.toUpperCase()} · ${ago(n.ts)}${n.rssi !== null && n.rssi !== undefined ? `<br>${n.rssi} dBm` : ''}
      </div>
    </div>`;
  }).join('');
  const up = nodes.filter((n) => n.state === 'live').length;
  $('nodeSrc').textContent = `${up}/${snap.nodes.length} live`;
}

// ------------------------------------------------------------------- gaps

function renderGaps(cv) {
  const gaps = new Map();
  for (const s of cv.telemetrySkipped ?? []) gaps.set(s.rule, s.why);
  for (const j of cv.joints) for (const s of j.skipped ?? []) gaps.set(`${j.id}:${s.rule}`, s.why);

  const el = $('gapList');
  if (!gatewayLive()) {
    el.innerHTML = '<div class="empty-note">Gateway unavailable. Waiting for a fresh coverage evaluation.</div>';
    return;
  }
  if (!gaps.size) {
    el.innerHTML = `<div class="empty-note">${cv.lastMessageTs === null ? 'NOTHING EVALUATED YET' : 'ALL RULES EVALUATING'}</div>`;
    return;
  }
  el.innerHTML = [...gaps].map(([key, why]) => {
    const [joint, rule] = key.includes(':') ? key.split(':') : [null, key];
    return `<div class="gap"><div class="gap-rule">${esc(ruleTitle(rule))}${joint ? ` · joint ${esc(joint)}` : ''}</div>
      <div class="gap-why">${esc(RULE_TEXT[rule]?.needs ?? why)}</div></div>`;
  }).join('');
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
        `<div class="reject"><span>${plantTime(r.ts)} ${esc(r.topic)}</span> ${esc(r.reason)}</div>`
      ).join('')
    : `<div class="reject" style="color:var(--dimmer)">none</div>`;
  $('ingestSrc').textContent = snap.mqtt.broker;
}

// ----------------------------------------------------------------- drawer

async function openDrawer(jointId) {
  openJoint = jointId;
  $('drawer').inert = false;
  $('drawer').setAttribute('aria-hidden', 'false');
  $('drawerClose').focus();
  $('scrim').classList.add('on');
  await refreshDrawer(currentConveyor());
}

function closeDrawer() {
  drawerRequest++;
  const wasOpen = !!openJoint;
  openJoint = null;
  $('drawer').inert = true;
  if (wasOpen) $('schematic').focus({ preventScroll: true });
  $('drawer').setAttribute('aria-hidden', 'true');
  $('scrim').classList.remove('on');
}
$('drawerClose').onclick = closeDrawer;
$('scrim').onclick = closeDrawer;
document.addEventListener('keydown', (e) => {
  if (!openJoint) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDrawer(); }
  if (e.key === 'Tab') {
    const targets = [...$('drawer').querySelectorAll('button, a[href], input, select, [tabindex="0"]')];
    const first = targets[0], last = targets.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }
});

async function refreshDrawer(cv) {
  if (!openJoint || !cv) return;
  const request = ++drawerRequest;
  const jointId = openJoint;
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
  if (request !== drawerRequest || openJoint !== jointId || currentConveyor()?.id !== cv.id) return;

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

$('statusReport').onclick = () => {
  const cv = currentConveyor();
  if (!cv) return;
  const html = statusReportHTML(cv, {
    site: snap.server.siteLabel ?? snap.server.site, connected: gatewayLive(),
    now: snap.server.now + Date.now() - snapshotReceivedAt,
    source: cv.playback ? `Recorded playback (${cv.playback.rate}×); original recording ${new Date(cv.playback.recorded_at_ms).toISOString()}` : 'Live gateway snapshot',
  });
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  if (!window.open(url, '_blank')) {
    // Pop-up blocked: download it instead.
    const a = document.createElement('a');
    a.href = url;
    a.download = `pravaah-status-${cv.id}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.html`;
    document.body.append(a); a.click(); a.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
};

$('engToggle').setAttribute('aria-pressed', String(storage.get('pravaah.engineering') === 'on'));
$('engToggle').onclick = () => {
  const on = $('engToggle').getAttribute('aria-pressed') !== 'true';
  $('engToggle').setAttribute('aria-pressed', String(on));
  storage.set('pravaah.engineering', on ? 'on' : 'off');
  if (snap) render();
};

setInterval(() => { $('clock').textContent = clock(); }, 1000);
$('clock').textContent = clock();
setInterval(() => { if (snap) render(); }, 1000); // keeps "ago" fields moving
// The socket is opened even if the scene fails to wire up, so a broken
// renderer never takes the numbers down with it.
try { initSchematic(); } catch (err) { fatal('schematic setup', err); }
connect();
