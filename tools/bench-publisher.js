#!/usr/bin/env node
/* ============================================================================
   WIRE-PROTOCOL TEST HARNESS - NOT A DATA SOURCE
   ----------------------------------------------------------------------------
   This exists to answer one question before the hardware exists:
   "if a node publishes the contract, does the topic route, does the payload
   validate, does it store, does it reach the browser, does a rule fire?"

   It is NOT a demo mode and its numbers mean nothing about any belt. It
   publishes under node ids beginning with `bench-`, which makes the dashboard
   raise a BENCH SOURCE banner for as long as it runs. Kill it before any
   real capture, and delete data/beltguard.db so bench rows never mix with
   measurements from the rig.

     node tools/bench-publisher.js                # nominal frames
     node tools/bench-publisher.js --fault splice # drift a joint until a rule fires
     node tools/bench-publisher.js --reject       # malformed payloads, to see them rejected

   ==========================================================================*/

import mqtt from 'mqtt';
import config from '../server/config.js';

const args = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : (args[i + 1]?.startsWith('--') ? true : args[i + 1] ?? true);
};

const FAULT = flag('fault', null);      // null | 'splice' | 'tracking' | 'slip' | 'thermal'
const REJECT = args.includes('--reject');
const CONVEYOR = flag('conveyor', config.conveyors[0].id);
const SITE = config.site;
const NODE = 'bench-harness-01';

console.log('\n  ############################################################');
console.log('  #  BENCH HARNESS - synthetic frames, NOT sensor readings   #');
console.log('  #  Kill this before capturing anything from the real rig.  #');
console.log('  ############################################################\n');
console.log(`  broker    ${config.mqtt.url}`);
console.log(`  conveyor  ${CONVEYOR}`);
console.log(`  fault     ${FAULT ?? 'none (nominal)'}\n`);

const client = mqtt.connect(config.mqtt.url, {
  clientId: `${NODE}-${process.pid}`,
  username: config.mqtt.username ?? undefined,
  password: config.mqtt.password ?? undefined,
  will: {
    topic: `beltguard/${SITE}/${CONVEYOR}/node/${NODE}/status`,
    payload: JSON.stringify({ online: false }), qos: 1, retain: true,
  },
});

const T = {
  telemetry: `beltguard/${SITE}/${CONVEYOR}/telemetry`,
  joint:     `beltguard/${SITE}/${CONVEYOR}/joint`,
  vision:    `beltguard/${SITE}/${CONVEYOR}/vision`,
  status:    `beltguard/${SITE}/${CONVEYOR}/node/${NODE}/status`,
};

// A plain deterministic wobble - no attempt to look like a real belt.
const noise = (amp) => (Math.random() - 0.5) * 2 * amp;
let seq = 0, lap = 0, t0 = Date.now();
const elapsedMin = () => (Date.now() - t0) / 60000;

client.on('connect', () => {
  console.log('  connected. Ctrl-C to stop.\n');
  client.publish(T.status, JSON.stringify({
    online: true, node: NODE, firmware: 'bench-harness (synthetic)', rssi: -50, uptime_s: 0,
  }), { retain: true, qos: 1 });

  setInterval(publishTelemetry, 500);
  setInterval(publishJoint, 4000);
  if (REJECT) setInterval(publishGarbage, 7000);
  setInterval(() => client.publish(T.status, JSON.stringify({
    online: true, node: NODE, firmware: 'bench-harness (synthetic)',
    rssi: -50, uptime_s: Math.round((Date.now() - t0) / 1000),
  }), { retain: true, qos: 1 }), 10000);
});

client.on('error', (e) => { console.error(`  mqtt: ${e.message}`); process.exit(1); });

function publishTelemetry() {
  const rpm = 1450 + noise(6);
  // Nominal belt speed for the config geometry, or a fixed bench value.
  const c = config.conveyors.find((x) => x.id === CONVEYOR);
  let speed = (c?.pulleyDiameterMm && c?.gearRatio)
    ? (Math.PI * (c.pulleyDiameterMm / 1000) * (rpm / c.gearRatio)) / 60
    : 1.80;
  if (FAULT === 'slip') speed *= 1 - Math.min(0.18, elapsedMin() * 0.04);
  speed += noise(0.008);

  const ambient = 29.5 + noise(0.3);
  let surface = ambient + 4.5 + noise(0.4);
  if (FAULT === 'thermal') surface = ambient + 4.5 + elapsedMin() * 6;

  client.publish(T.telemetry, JSON.stringify({
    ts: Date.now(), node: NODE, seq: ++seq,
    motor_current_rms: +(6.30 + noise(0.09)).toFixed(3),
    motor_rpm: Math.round(rpm),
    belt_speed: +speed.toFixed(3),
    vibration_rms: +(0.062 + noise(0.005)).toFixed(4),
    vibration_kurtosis: +(3.05 + noise(0.2)).toFixed(3),
    vibration_crest: +(3.9 + noise(0.3)).toFixed(3),
    temperature: +surface.toFixed(2),
    ambient: +ambient.toFixed(2),
    sensor_health: { speed: 'healthy', vibration: 'healthy', ct: 'healthy', mlx: 'healthy' },
  }));
}

function publishJoint() {
  lap++;
  const JID = 'J01';
  const baseDt = 820;
  let dtL = baseDt + noise(2.0);
  let dtR = baseDt + noise(2.0);
  let impact = 0.150 + noise(0.010);
  let offset = 1.5 + noise(1.0);
  let crack = 4.0 + noise(0.2);

  // A fault only starts after the baseline window has filled, otherwise the
  // drift would be learned as normal - which is the point of the lock.
  const c = config.conveyors.find((x) => x.id === CONVEYOR);
  const past = lap - (c?.baselineLaps ?? 20);
  if (past > 0) {
    if (FAULT === 'splice')   { dtL += past * 2.4; impact += past * 0.011; crack += past * 0.14; }
    if (FAULT === 'tracking') { dtR += past * 3.0; offset += past * 1.6; }
  }

  const speed = 1.80;
  client.publish(T.joint, JSON.stringify({
    ts: Date.now(), node: NODE, joint_id: JID, lap,
    belt_speed: speed,
    joint_marker_dt_left: +dtL.toFixed(2),
    joint_marker_dt_right: +dtR.toFixed(2),
    marker_distance_left: +(speed * (dtL / 1000) * 1000).toFixed(1),
    marker_distance_right: +(speed * (dtR / 1000) * 1000).toFixed(1),
    event_vibration_rms: +impact.toFixed(4),
    event_vibration_peak: +(impact * 4.2).toFixed(4),
    event_kurtosis: +(4.1 + noise(0.4)).toFixed(3),
  }));

  client.publish(T.vision, JSON.stringify({
    ts: Date.now(), node: `${NODE}-cam`, joint_id: JID, lap,
    belt_offset: +offset.toFixed(2),
    crack_length: +crack.toFixed(2),
    opening: +(0.6 + noise(0.05)).toFixed(3),
    image_quality: 0.9, cv_confidence: 0.85,
  }));

  process.stdout.write(`  lap ${String(lap).padStart(3)}  dtL ${dtL.toFixed(1)}  dtR ${dtR.toFixed(1)}  impact ${impact.toFixed(4)}  crack ${crack.toFixed(2)}\n`);
}

/** Deliberately bad payloads - the dashboard must REJECT, not display, these. */
let garbageN = 0;
function publishGarbage() {
  const cases = [
    'not json at all',
    JSON.stringify({ ts: Date.now(), motor_current_rms: 'six point three' }),
    JSON.stringify({ ts: Date.now(), belt_speed: 9999 }),
    JSON.stringify({ ts: Date.now(), node: NODE }),               // no channels
    JSON.stringify({ ts: Date.now(), lap: 1 }),                   // joint with no joint_id
  ];
  const topic = garbageN % 5 === 4 ? T.joint : T.telemetry;
  client.publish(topic, cases[garbageN % cases.length]);
  garbageN++;
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    client.publish(T.status, JSON.stringify({ online: false }), { retain: true, qos: 1 }, () => {
      console.log('\n  bench harness stopped.');
      client.end(true, () => process.exit(0));
    });
  });
}
