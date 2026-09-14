#!/usr/bin/env node
/* ============================================================================
   RECORDED-RUN REPLAY -> MQTT
   ----------------------------------------------------------------------------
   Plays a cleaned conveyor recording (the output of clean-recording.py) back
   into a running gateway, so the dashboard reacts to a real run exactly as it
   did when the belt was moving.

     node tools/replay-recording.js --dir BeltData/<session>-cleaned-v1
     node tools/replay-recording.js --dir ... --gap 3 --from S010 --limit 5

   What is and is not changed:
   - Sensor values are published unchanged from telemetry.frames.jsonl, to its
     original topic, with the original inter-frame spacing inside a segment.
   - `ts` is re-stamped with the laptop clock at publish time. That is what
     serial-bridge.js does live, and the gateway judges freshness against now;
     original timestamps would make every channel read OFFLINE.
   - `playback` records the original arrival time and replay rate, so the UI
     labels recorded data and live recording sessions do not ingest it again.
   - `--mqtt URL` selects a separate playback broker. `npm run demo:recording`
     starts an isolated local gateway and runs this tool against it at 1x.
   - `--loop` repeats the recording until stopped, retaining every segment gap.
   - Segments are never joined. Between segments every node is announced
     offline (which also flushes the ML window), the replay pauses `--gap`
     seconds, then the next segment starts. Excluded intervals are not
     replayed, interpolated or filled.
   - `--speed` other than 1 compresses real time. Rule values are unaffected,
     but ML windows then hold more frames than the model was trained on, so
     its score is not meaningful. Use 1 when the ML panel matters.
   ==========================================================================*/

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import mqtt from 'mqtt';
import config from '../server/config.js';

const args = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : (args[i + 1]?.startsWith('--') ? true : args[i + 1] ?? true);
};

const DIR = flag('dir');
if (!DIR || DIR === true) {
  console.error('usage: node tools/replay-recording.js --dir <cleaned recording dir> [--speed 1] [--gap 3] [--from S001] [--limit N]');
  process.exit(2);
}
const SPEED = Number(flag('speed', 1));
const GAP_MS = Number(flag('gap', 3)) * 1000;
const FROM = flag('from', null);
const LIMIT = Number(flag('limit', Infinity));
const LOOP = args.includes('--loop');
if (!(SPEED > 0) || !(GAP_MS >= 0)) { console.error('--speed must be > 0 and --gap >= 0'); process.exit(2); }

// frames.jsonl and telemetry.csv are row-aligned; the CSV carries segment_id.
const dir = resolve(DIR);
const frames = readFileSync(join(dir, 'telemetry.frames.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const csv = readFileSync(join(dir, 'telemetry.csv'), 'utf8').trim().split('\n');
const header = csv[0].split(',');
const segCol = header.indexOf('segment_id');
const recvCol = header.indexOf('received_at_ms');
if (segCol < 0 || csv.length - 1 !== frames.length) {
  console.error('telemetry.csv and telemetry.frames.jsonl do not line up; refusing to guess segment boundaries');
  process.exit(1);
}

const segments = [];
for (let i = 0; i < frames.length; i++) {
  // segment_id and received_at_ms come after the quoted JSON columns, so read from the right.
  const cells = csv[i + 1].split(',');
  const seg = cells[cells.length - (header.length - segCol)];
  if (Number(cells[recvCol]) !== frames[i].received_at_ms) {
    console.error(`row ${i + 1}: CSV and frame arrival times differ; refusing to replay`);
    process.exit(1);
  }
  if (segments.at(-1)?.id !== seg) segments.push({ id: seg, frames: [] });
  segments.at(-1).frames.push(frames[i]);
}

let chosen = segments;
if (FROM) chosen = chosen.slice(Math.max(0, chosen.findIndex((s) => s.id === FROM)));
chosen = chosen.slice(0, LIMIT);
if (!chosen.length) { console.error('No recording segments selected'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const statusTopic = (topic, node) => topic.replace(/\/telemetry$/, `/node/${node}/status`);
const brokerURL = flag('mqtt', config.mqtt.url);
const client = mqtt.connect(brokerURL, { clientId: `recording-replay-${process.pid}` });
client.on('error', (e) => console.error('  mqtt error:', e.message));

let stopping = false;
let cycle = 0;
const seen = new Map(); // node -> { topic, firmware, health }

function status(node, online) {
  const n = seen.get(node);
  const body = online
    ? { online: true, node, firmware: n.firmware, transport: 'replay', sensor_health: n.health }
    : { online: false, node };
  client.publish(statusTopic(n.topic, node), JSON.stringify(body), { retain: true });
}

async function playSegment(seg) {
  const t0 = seg.frames[0].received_at_ms;
  const wall0 = Date.now();
  let lastBeat = 0;
  for (const f of seg.frames) {
    if (stopping) return;
    const due = wall0 + (f.received_at_ms - t0) / SPEED;
    const wait = due - Date.now();
    if (wait > 0) await sleep(wait);
    const payload = { ...f.payload, ts: Date.now(),
      playback: { recorded_at_ms: f.received_at_ms, rate: SPEED, loop: LOOP, cycle } };
    client.publish(f.topic, JSON.stringify(payload));
    const first = !seen.has(payload.node);
    seen.set(payload.node, { topic: f.topic, firmware: payload.firmware, health: payload.sensor_health });
    if (first) status(payload.node, true);
    if (Date.now() - lastBeat > 2000) {
      for (const node of seen.keys()) status(node, true);
      lastBeat = Date.now();
    }
  }
}

client.on('connect', async () => {
  if (client.replayStarted) return;
  client.replayStarted = true;
  const secs = chosen.reduce((a, s) => a + (s.frames.at(-1).received_at_ms - s.frames[0].received_at_ms), 0) / 1000;
  console.log(`\n  PRAVAAH recording replay`);
  console.log(`  source    ${dir}`);
  console.log(`  broker    ${brokerURL}`);
  console.log(`  segments  ${chosen.length} (${chosen[0]?.id} .. ${chosen.at(-1)?.id}), ${secs.toFixed(0)} s of data at ${SPEED}x, ${GAP_MS / 1000} s pause between\n`);
  const started = Date.now();
  do {
    cycle++;
    if (LOOP) console.log(`  Playback cycle ${cycle} (continuous; Ctrl+C to stop)`);
    for (const [i, seg] of chosen.entries()) {
      if (stopping) break;
      console.log(`  [${new Date().toISOString()}] ${seg.id}  ${seg.frames.length} frames  (${i + 1}/${chosen.length})`);
      await playSegment(seg);
      // Every segment/cycle boundary invalidates old readings and the ML window.
      for (const node of seen.keys()) status(node, false);
      if ((i < chosen.length - 1 || LOOP) && GAP_MS && !stopping) await sleep(GAP_MS);
    }
  } while (LOOP && !stopping);
  console.log(`\n  replay ${stopping ? 'stopped' : 'finished'} after ${((Date.now() - started) / 1000).toFixed(0)} s`);
  client.end(false, {}, () => process.exit(0));
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    for (const node of seen.keys()) status(node, false);
    setTimeout(() => process.exit(0), 200);
  });
}
