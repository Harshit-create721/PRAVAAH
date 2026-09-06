// PRAVAAH gateway.
//
//   sensor nodes --MQTT--> [embedded broker] --> validate --> store --> WebSocket --> dashboard
//
// One process. Start it with `npm start` and point the ESP32 at this machine.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { WebSocketServer } from 'ws';
import mqtt from 'mqtt';
import Aedes from 'aedes';

import config from './config.js';
import { Store } from './store.js';
import { CHANNELS, JOINT_CHANNELS, validate, normaliseHealth, TOPICS } from './schema.js';
import { evaluateJointPass, evaluateTelemetry, inferOperatingState, worse } from './rules.js';
import { componentStatus } from './components.js';
import { createRelayPublisher } from './relay-publisher.js';

const ROOT = resolve(import.meta.dirname, '..');
const WEB = join(ROOT, 'web');
const EVIDENCE = join(ROOT, 'data', 'evidence');
const DOCS = join(ROOT, 'docs');
const store = new Store(join(ROOT, config.storage.file));
const started = Date.now();

// ---------------------------------------------------------------- live state

/** Per-conveyor in-memory view. Nothing here is seeded with a value. */
const live = new Map();
for (const c of config.conveyors) {
  live.set(c.id, {
    id: c.id,
    label: c.label,
    config: c,
    // channel -> { v, ts, node }. Absent key === never received.
    channels: {},
    derived: {},
    operating_state: 'unknown',
    prevSpeed: null,
    joints: {},           // joint_id -> { last pass, deviations, risk }
    analysis: null,       // last message on the analysis topic, if any
    risk: 'unknown',      // 'unknown' until at least one rule has been evaluated
    riskSource: 'no packet received yet',
    telemetryMetrics: [],
    lastMessageTs: null,
    counters: { telemetry: 0, joints: 0, vision: 0, rejects: 0 },
  });
  for (const j of c.joints ?? []) {
    live.get(c.id).joints[j.id] = { id: j.id, label: j.label ?? j.id, type: j.type ?? null, passes: 0 };
  }
  // Re-hydrate joints that have history from previous runs.
  for (const j of store.knownJoints(c.id)) {
    live.get(c.id).joints[j.joint_id] ??= { id: j.joint_id, label: j.joint_id, type: null };
    Object.assign(live.get(c.id).joints[j.joint_id], {
      passes: j.passes, last_ts: j.last_ts, first_ts: j.first_ts,
    });
  }
}

// Mirror what the local dashboard already receives up to the public relay, and
// execute commands the relay routes back down. Reads and writes both arrive
// here; there is no second code path for remote clients.
const relayPublisher = config.relay?.enabled
  ? createRelayPublisher({
      url: config.relay.url,
      secret: config.relay.publishSecret,
      log: (line) => console.log(line),
      onCommand: async ({ action, payload }) => {
        if (action === 'history') {
          const cid = payload.conveyor ?? config.conveyors[0].id;
          const channel = payload.channel;
          if (!channel || !CHANNELS[channel]) throw new Error(`unknown channel: ${channel}`);
          const minutes = Number(payload.minutes ?? 15);
          return {
            channel,
            unit: CHANNELS[channel].unit,
            points: store.history(cid, channel, Date.now() - minutes * 60000),
          };
        }

        if (action === 'ack') {
          const id = Number(payload.alarmId);
          if (!Number.isFinite(id)) throw new Error('alarmId required');
          store.ackAlarm(id, payload.by ?? 'mobile');
          pushSnapshot();
          return { acked: id };
        }

        if (action === 'close') {
          const id = Number(payload.alarmId);
          if (!Number.isFinite(id)) throw new Error('alarmId required');
          store.closeAlarm(id, payload.outcome, payload.technician, payload.notes);
          for (const [key, value] of openKeys) if (value === id) openKeys.delete(key);
          for (const cv of live.values()) recomputeRisk(cv);
          pushSnapshot();
          return { closed: id };
        }

        throw new Error(`unknown action: ${action}`);
      },
    })
  : null;

relayPublisher?.start();

const nodeSeen = new Map(); // nodeId -> { ts, conveyor, meta }

function freshness(ts) {
  if (!Number.isFinite(ts)) return 'never';
  const age = Date.now() - ts;
  if (age <= config.freshness.liveMs) return 'live';
  if (age <= config.freshness.staleMs) return 'stale';
  if (age <= config.freshness.offlineMs) return 'late';
  return 'offline';
}

// ------------------------------------------------------------------- ingest

function topicParts(topic) {
  const p = topic.split('/');
  if (p[0] !== 'beltguard') return null;
  return { site: p[1], conveyor: p[2], kind: p[3], rest: p.slice(4) };
}

/**
 * The current value of every channel that is still fresh, merged across nodes.
 *
 * With one ESP32 carrying every sensor, a telemetry frame WAS the machine
 * state and rules could be evaluated straight off it. With one node per sensor
 * each frame is a fragment: the thermal node's packet has no vibration in it.
 * Evaluating per-frame would leave every cross-sensor rule permanently listed
 * as "not connected", and would make the skipped list flap depending on which
 * node published last.
 *
 * Stale channels are excluded rather than carried forward - a rule that fires
 * on a reading from a node that went silent minutes ago is worse than a rule
 * that admits it cannot see.
 */
function liveValues(cv) {
  const now = Date.now();
  const out = {};
  for (const [k, c] of Object.entries(cv.channels)) {
    if (!c || !Number.isFinite(c.v) || !Number.isFinite(c.ts)) continue;
    if (now - c.ts > config.freshness.staleMs) continue;
    out[k] = c.v;
  }
  return out;
}

function onTelemetry(cv, payload, raw) {
  const r = validate(payload, CHANNELS);
  for (const rej of r.rejected) {
    store.reject('telemetry', `${rej.key}=${rej.val}: ${rej.why}`, raw);
    cv.counters.rejects++;
  }
  if (!r.ok) return;

  const node = typeof payload.node === 'string' ? payload.node : null;
  store.telemetry(r.ts, cv.id, node, payload.seq, r.values);
  cv.counters.telemetry++;
  cv.lastMessageTs = Date.now();

  for (const [k, v] of Object.entries(r.values)) {
    cv.channels[k] = { v, ts: r.ts, node };
  }
  if (payload.sensor_health) cv.sensorHealth = normaliseHealth(payload.sensor_health);

  // Everything below reasons about the machine, so it reads the merged state
  // rather than this one packet.
  const merged = liveValues(cv);

  const state = inferOperatingState(merged, { state: cv.operating_state, speed: cv.prevSpeed });
  cv.operating_state = state;
  cv.prevSpeed = merged.belt_speed ?? cv.prevSpeed;

  const ev = evaluateTelemetry(cv.config, merged);
  cv.derived = ev.derived;
  cv.telemetrySkipped = ev.skipped;
  // Kept so the schematic can show headroom, not just breaches.
  cv.telemetryMetrics = ev.metrics;
  if (Number.isFinite(ev.derived.expected_belt_speed) && Number.isFinite(merged.belt_speed)
      && ev.derived.expected_belt_speed > 0.05) {
    const slip = ((ev.derived.expected_belt_speed - merged.belt_speed) / ev.derived.expected_belt_speed) * 100;
    cv.channels.slip_ratio = { v: slip, ts: r.ts, node: 'derived' };
  }
  if (Number.isFinite(merged.temperature) && Number.isFinite(merged.ambient)) {
    cv.channels.temperature_delta = { v: merged.temperature - merged.ambient, ts: r.ts, node: 'derived' };
  }

  applyFindings(cv, null, ev.findings, 'telemetry');
  if (node) touchNode(node, cv.id, payload);
}

function onJointPass(cv, payload, raw, source) {
  const jointId = typeof payload.joint_id === 'string' ? payload.joint_id.trim() : '';
  if (!jointId) {
    store.reject('joint', 'missing joint_id', raw);
    cv.counters.rejects++;
    return;
  }
  const r = validate(payload, JOINT_CHANNELS);
  for (const rej of r.rejected) {
    store.reject('joint', `${rej.key}=${rej.val}: ${rej.why}`, raw);
    cv.counters.rejects++;
  }

  const rec = {
    ts: r.ts, conveyor: cv.id, joint_id: jointId,
    lap: Number.isFinite(payload.lap) ? payload.lap : null,
    belt_speed: Number.isFinite(payload.belt_speed) ? payload.belt_speed : null,
    image_quality: Number.isFinite(payload.image_quality) ? payload.image_quality : null,
    cv_confidence: Number.isFinite(payload.cv_confidence) ? payload.cv_confidence : null,
    evidence_frame: typeof payload.evidence_frame === 'string' ? payload.evidence_frame : null,
    source, values: r.values,
  };
  // Merged with the other source's report of the same lap, if there was one.
  const merged = store.jointPass(rec);
  cv.counters[source === 'vision' ? 'vision' : 'joints']++;
  cv.lastMessageTs = Date.now();

  // Everything downstream evaluates the MERGED passage, so a rule that needs
  // a timing channel and a vision channel together can actually fire.
  const mergedValues = {};
  for (const k of Object.keys(JOINT_CHANNELS)) {
    if (merged[k] !== null && merged[k] !== undefined) mergedValues[k] = merged[k];
  }

  const j = (cv.joints[jointId] ??= { id: jointId, label: jointId, type: null, passes: 0 });
  j.passes = store.countPasses(cv.id, jointId);
  j.last_ts = r.ts;
  j.first_ts ??= r.ts;
  j.lap = merged.lap;
  j.last = mergedValues;
  if (merged.evidence_frame) j.evidence_frame = merged.evidence_frame;
  if (merged.image_quality !== null) j.image_quality = merged.image_quality;

  // Evaluate BEFORE folding this pass into the baseline, so a bad pass is
  // judged against clean history rather than partly against itself.
  const ev = evaluateJointPass(store, cv.config, { ...rec, values: mergedValues });
  j.risk = ev.risk;
  j.findings = ev.findings;
  j.metrics = ev.metrics;
  j.skipped = ev.skipped;

  for (const [ch, val] of Object.entries(r.values)) {
    store.updateBaseline(cv.id, jointId, ch, val, r.ts, cv.config.baselineLaps);
  }
  j.baseline = store.allBaselines(cv.id, jointId);
  j.baselineReady = Object.values(j.baseline).some((b) => b.n >= cv.config.baselineLaps);

  applyFindings(cv, jointId, ev.findings, source);
  if (typeof payload.node === 'string') touchNode(payload.node, cv.id, payload);
}

function onAnalysis(cv, payload) {
  // Output of YOUR model, if you run one. Stored and displayed verbatim.
  const ts = Number.isFinite(payload.ts) ? payload.ts : Date.now();
  cv.analysis = { ...payload, ts, received: Date.now() };
  store.analysis(ts, cv.id, payload);
  cv.lastMessageTs = Date.now();
  if (typeof payload.risk === 'string') {
    cv.risk = payload.risk;
    cv.riskSource = `model ${payload.model_version ?? ''}`.trim();
  }
}

function touchNode(node, conveyorId, payload) {
  const meta = {
    firmware: payload.fw ?? payload.firmware ?? null,
    rssi: Number.isFinite(payload.rssi) ? payload.rssi : null,
    uptime_s: Number.isFinite(payload.uptime_s) ? payload.uptime_s : null,
    health: payload.sensor_health ? normaliseHealth(payload.sensor_health) : null,
    ip: typeof payload.ip === 'string' ? payload.ip : null,
  };
  nodeSeen.set(node, { ts: Date.now(), conveyor: conveyorId, meta });
  store.nodeStatus(node, conveyorId, true, meta);
}

/** Raise alarms for new findings, de-duplicated per (joint, rule). */
const openKeys = new Map(); // `${cv}|${joint}|${rule}` -> alarmId
function applyFindings(cv, jointId, findings, source) {
  for (const f of findings) {
    const key = `${cv.id}|${jointId ?? '-'}|${f.rule}`;
    if (openKeys.has(key)) continue;
    const id = store.alarm(Date.now(), cv.id, jointId, f.level, f.family, f.message,
      { rule: f.rule, source, measured: f.measured });
    openKeys.set(key, id);
    broadcast({ type: 'alarm', alarm: { id, ts: Date.now(), conveyor: cv.id, joint_id: jointId, level: f.level, family: f.family, message: f.message, evidence: JSON.stringify({ rule: f.rule, source, measured: f.measured }) } });
  }
  recomputeRisk(cv);
}

function recomputeRisk(cv) {
  if (cv.analysis?.risk) return; // a real model outranks the rule layer
  let r = null;
  for (const a of store.openAlarms(cv.id)) r = r === null ? a.level : worse(r, a.level);
  if (r === null) {
    // No alarms. Only claim "healthy" once we have actually measured something.
    const any = Object.keys(cv.channels).length > 0 || Object.keys(cv.joints).length > 0;
    cv.risk = any ? 'healthy' : 'unknown';
    cv.riskSource = any ? 'rules: no rule triggered' : 'no data received yet';
  } else {
    cv.risk = r;
    cv.riskSource = 'rules';
  }
}

function handleMessage(topic, buf) {
  const parts = topicParts(topic);
  if (!parts || parts.site !== config.site) return;
  const cv = live.get(parts.conveyor);
  const raw = buf.toString('utf8');

  if (!cv) { store.reject(topic, `unknown conveyor "${parts.conveyor}"`, raw); return; }

  let payload;
  try { payload = JSON.parse(raw); }
  catch { store.reject(topic, 'payload is not valid JSON', raw); cv.counters.rejects++; return; }

  switch (parts.kind) {
    case 'telemetry': onTelemetry(cv, payload, raw); break;
    case 'joint':     onJointPass(cv, payload, raw, 'esp32'); break;
    case 'vision':    onJointPass(cv, payload, raw, 'vision'); break;
    case 'analysis':  onAnalysis(cv, payload); break;
    case 'node': {
      const nodeId = parts.rest[0];
      if (parts.rest[1] === 'status' && nodeId) {
        const online = payload.online !== false && payload.status !== 'offline';
        if (online) touchNode(nodeId, cv.id, payload);
        else { nodeSeen.delete(nodeId); store.nodeStatus(nodeId, cv.id, false, {}); }
      }
      break;
    }
    default: store.reject(topic, `unknown topic kind "${parts.kind}"`, raw);
  }
  pushSnapshot();
}

// ------------------------------------------------------------------- broker

let broker = null;
if (config.mqtt.embedded) {
  const aedes = new Aedes();
  if (config.mqtt.username) {
    aedes.authenticate = (client, u, p, done) => {
      const ok = u === config.mqtt.username && p?.toString() === config.mqtt.password;
      done(ok ? null : Object.assign(new Error('bad credentials'), { returnCode: 4 }), ok);
    };
  }
  aedes.on('client', (c) => console.log(`[broker] connect   ${c.id}`));
  aedes.on('clientDisconnect', (c) => console.log(`[broker] disconnect ${c.id}`));
  aedes.on('clientError', (c, e) => console.log(`[broker] error ${c?.id}: ${e.message}`));
  broker = createNetServer(aedes.handle);
  broker.listen(config.mqtt.port, config.mqtt.host, () => {
    console.log(`[broker] mqtt://${config.mqtt.host}:${config.mqtt.port}`);
  });
  broker.on('error', (e) => {
    console.error(`[broker] cannot listen on ${config.mqtt.port}: ${e.message}`);
    console.error('         Another broker already running? Set mqtt.embedded=false in server/config.js.');
  });
}

const client = mqtt.connect(config.mqtt.url, {
  clientId: `beltguard-gateway-${process.pid}`,
  username: config.mqtt.username ?? undefined,
  password: config.mqtt.password ?? undefined,
  reconnectPeriod: 2000,
});
client.on('connect', () => {
  const t = TOPICS.subscribeAll(config.site);
  client.subscribe(t, { qos: 1 }, (e) => {
    console.log(e ? `[mqtt] subscribe failed: ${e.message}` : `[mqtt] subscribed ${t}`);
  });
});
client.on('error', (e) => console.error(`[mqtt] ${e.message}`));
client.on('message', (topic, buf) => {
  try { handleMessage(topic, buf); }
  catch (e) { console.error(`[ingest] ${topic}: ${e.message}`); store.reject(topic, e.message, buf.toString('utf8')); }
});

// --------------------------------------------------------------- snapshot

function snapshot() {
  return {
    type: 'snapshot',
    server: { now: Date.now(), uptime_s: Math.round((Date.now() - started) / 1000), site: config.site },
    mqtt: { connected: client.connected, broker: config.mqtt.embedded ? 'embedded' : config.mqtt.url, port: config.mqtt.port },
    conveyors: config.conveyors.map((c) => {
      const cv = live.get(c.id);
      const channels = {};
      for (const [k, spec] of Object.entries(CHANNELS)) {
        const s = cv.channels[k];
        channels[k] = s
          ? { value: s.v, ts: s.ts, node: s.node, state: freshness(s.ts), unit: spec.unit, label: spec.label, group: spec.group }
          : { value: null, ts: null, node: null, state: 'never', unit: spec.unit, label: spec.label, group: spec.group };
      }
      const alarms = store.openAlarms(c.id);
      const joints = Object.values(cv.joints).sort((a, b) => a.id.localeCompare(b.id));
      return {
        id: c.id, label: c.label,
        components: componentStatus({
          channels, alarms, joints,
          // Joint rules also speak about shared parts (marker asymmetry and
          // lateral offset are evidence about belt tracking), so their metrics
          // have to reach the component fold too - not just the drive rules.
          metrics: [
            ...(cv.telemetryMetrics ?? []),
            ...joints.flatMap((j) => j.metrics ?? []),
          ],
        }),
        geometry: {
          beltLengthM: c.beltLengthM, beltWidthMm: c.beltWidthMm,
          driveRatedCurrentA: c.driveRatedCurrentA, pulleyDiameterMm: c.pulleyDiameterMm,
          gearRatio: c.gearRatio,
          configured: [c.beltLengthM, c.pulleyDiameterMm, c.gearRatio].every((x) => x !== null),
        },
        thresholds: c.thresholds,
        baselineLaps: c.baselineLaps,
        channels,
        operating_state: cv.operating_state,
        risk: cv.risk, riskSource: cv.riskSource,
        analysis: cv.analysis,
        sensorHealth: cv.sensorHealth ?? null,
        telemetrySkipped: cv.telemetrySkipped ?? [],
        joints,
        alarms,
        counters: cv.counters,
        stored: store.counts(c.id),
        lastMessageTs: cv.lastMessageTs,
      };
    }),
    nodes: store.nodes().map((n) => ({
      ...n,
      health: n.health ? JSON.parse(n.health) : null,
      state: nodeSeen.has(n.node) ? freshness(nodeSeen.get(n.node).ts) : 'offline',
    })),
    rejects: store.recentRejects(20),
  };
}

// -------------------------------------------------------------- http + ws

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

async function serveStatic(res, base, relPath, fallback) {
  const clean = normalize(relPath).replace(/^([.][.][/\\])+/, '');
  const file = join(base, clean);
  if (!resolve(file).startsWith(resolve(base) + sep) && resolve(file) !== resolve(base)) {
    return json(res, 403, { error: 'forbidden' });
  }
  try {
    const st = await stat(file);
    if (st.isDirectory()) throw new Error('dir');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    if (fallback) return serveStatic(res, base, fallback, null);
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const p = url.pathname;

  if (p === '/api/state') return json(res, 200, snapshot());

  if (p === '/api/history') {
    const cid = url.searchParams.get('conveyor') ?? config.conveyors[0].id;
    const channel = url.searchParams.get('channel');
    const minutes = Number(url.searchParams.get('minutes') ?? 15);
    if (!channel || !CHANNELS[channel]) return json(res, 400, { error: 'unknown channel' });
    return json(res, 200, {
      channel, unit: CHANNELS[channel].unit,
      points: store.history(cid, channel, Date.now() - minutes * 60000),
    });
  }

  if (p.startsWith('/api/joint/')) {
    const jointId = decodeURIComponent(p.slice('/api/joint/'.length));
    const cid = url.searchParams.get('conveyor') ?? config.conveyors[0].id;
    return json(res, 200, {
      joint_id: jointId,
      passes: store.jointHistory(cid, jointId, Number(url.searchParams.get('limit') ?? 300)),
      baseline: store.allBaselines(cid, jointId),
    });
  }

  if (p === '/api/alarms') {
    const cid = url.searchParams.get('conveyor') ?? config.conveyors[0].id;
    return json(res, 200, { alarms: store.recentAlarms(cid, 200) });
  }

  const ack = p.match(/^\/api\/alarms\/(\d+)\/ack$/);
  if (ack && req.method === 'POST') {
    const b = await readBody(req);
    store.ackAlarm(Number(ack[1]), b.by);
    pushSnapshot();
    return json(res, 200, { ok: true });
  }

  const close = p.match(/^\/api\/alarms\/(\d+)\/close$/);
  if (close && req.method === 'POST') {
    const b = await readBody(req);
    const id = Number(close[1]);
    store.closeAlarm(id, b.outcome, b.technician, b.notes);
    for (const [k, v] of openKeys) if (v === id) openKeys.delete(k);
    for (const cv of live.values()) recomputeRisk(cv);
    pushSnapshot();
    return json(res, 200, { ok: true });
  }

  if (p === '/api/contract') {
    return json(res, 200, {
      site: config.site,
      topics: {
        telemetry: TOPICS.telemetry(config.site, '<conveyor_id>'),
        joint: TOPICS.jointEvent(config.site, '<conveyor_id>'),
        vision: TOPICS.vision(config.site, '<conveyor_id>'),
        analysis: TOPICS.analysis(config.site, '<conveyor_id>'),
        nodeStatus: TOPICS.nodeStatus(config.site, '<conveyor_id>'),
      },
      channels: CHANNELS, jointChannels: JOINT_CHANNELS,
      conveyors: config.conveyors.map((c) => c.id),
    });
  }

  if (p.startsWith('/evidence/')) return serveStatic(res, EVIDENCE, p.slice('/evidence/'.length), null);
  // The bring-up guide, so anyone on the plant WiFi can read it at the belt.
  if (p.startsWith('/docs/')) return serveStatic(res, DOCS, p.slice('/docs/'.length), null);
  return serveStatic(res, WEB, p === '/' ? 'index.html' : p, 'index.html');
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify(snapshot()));
  ws.on('error', () => {});
});
// ws re-emits the HTTP server's listen errors on itself; without this handler
// an occupied port surfaces as a raw stack trace instead of the message below.
wss.on('error', () => {});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n[http]   Port ${config.http.port} is already in use.`);
    console.error('         A BeltGuard gateway is most likely already running.');
    console.error(`         Open http://localhost:${config.http.port} before starting a second one,`);
    console.error('         or change http.port in server/config.js.\n');
  } else if (e.code === 'EACCES') {
    console.error(`\n[http]   Not permitted to listen on port ${config.http.port}.\n`);
  } else {
    console.error(`\n[http]   ${e.message}\n`);
  }
  process.exit(1);
});

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(s);
  // Same payload, second sink. Anything the dashboard sees, the phone sees.
  relayPublisher?.send(msg);
}

// Coalesce pushes: telemetry can arrive faster than a browser needs redrawing.
let pushPending = false;
function pushSnapshot() {
  if (pushPending) return;
  pushPending = true;
  setTimeout(() => { pushPending = false; broadcast(snapshot()); }, 250);
}
// Heartbeat so freshness badges decay to OFFLINE even when nothing arrives.
setInterval(() => broadcast(snapshot()), 2000);
setInterval(() => store.prune(config.storage.rawDays), 3600_000);

server.listen(config.http.port, config.http.host, () => {
  console.log(`[http]   dashboard on http://localhost:${config.http.port}`);
  console.log(`[state]  waiting for the first packet - nothing is displayed until a node publishes`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nshutting down');
    try { client.end(true); } catch {}
    try { broker?.close(); } catch {}
    try { store.close(); } catch {}
    process.exit(0);
  });
}
