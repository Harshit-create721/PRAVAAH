#!/usr/bin/env node
/* ============================================================================
   USB SERIAL -> MQTT BRIDGE
   ----------------------------------------------------------------------------
   Carries real sensor frames from ESP32 nodes over USB instead of WiFi, for
   demonstrating where the venue's network is unknown or locked down.

   This is NOT the bench harness. It invents nothing: every field it publishes
   was measured on a node and arrived over the wire. Its only additions are
   `ts` (the ESP32 has no RTC, so frames are stamped with the laptop clock on
   arrival) and the MQTT topic. A node that says nothing publishes nothing.

     node tools/serial-bridge.js                    # auto-detect USB ports
     node tools/serial-bridge.js --port /dev/cu.usbserial-5
     node tools/serial-bridge.js --conveyor CV-01 --baud 115200

   Each line a node prints that parses as JSON and carries a `kind` of
   "telemetry" or "joint" is republished to the matching topic. Everything
   else (boot banners, role detection) is echoed to the console as node log
   output, so the same cable serves as both transport and debug view.
   ==========================================================================*/

import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import mqtt from 'mqtt';
import config from '../server/config.js';
import { TOPICS } from '../server/schema.js';

const args = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : (args[i + 1]?.startsWith('--') ? true : args[i + 1] ?? true);
};

const CONVEYOR = flag('conveyor', config.conveyors[0].id);
// The gateway only refreshes a node's liveness from a numeric telemetry frame
// or a status message. The marker node publishes neither between passages, so
// without this it would show OFFLINE while working perfectly. Republishing
// status states only what the bridge can see: frames are still arriving.
const HEARTBEAT_MS = 2000;
const NODE_STALE_MS = 5000;
// If a port stops delivering bytes we force it closed and let the normal retry
// path reopen it. A USB-serial adapter that drops off the bus leaves a zombie
// device node behind on macOS: the fd stays readable-but-silent, no 'close' or
// 'error' ever fires, and without this the node is gone until someone notices.
// Every node here publishes at 2 Hz, so ten seconds of silence is a fault.
const PORT_SILENCE_MS = 10000;
const BAUD = Number(flag('baud', 115200));
const ONLY_PORT = flag('port', null);
const SITE = config.site;

// Matches the CP2102/CH340 bridges on ESP32 devkits. Deliberately narrow:
// /dev/cu.Bluetooth-Incoming-Port and friends must never be opened.
const PORT_RE = /usbserial|usbmodem|SLAB_USBtoUART|wchusb/i;

const topicTelemetry = TOPICS.telemetry(SITE, CONVEYOR);
const topicJoint = TOPICS.jointEvent(SITE, CONVEYOR);
const topicStatus = (node) => `beltguard/${SITE}/${CONVEYOR}/node/${node}/status`;

const stats = { frames: 0, joints: 0, unparsed: 0, byNode: new Map() };
// node -> { path, lastSeen, health, online }. Drives the status heartbeat.
const nodes = new Map();

const client = mqtt.connect(config.mqtt.url, { clientId: `serial-bridge-${process.pid}` });

client.on('error', (e) => console.error('  mqtt error:', e.message));

client.on('connect', async () => {
  console.log(`\n  PRAVAAH serial bridge`);
  console.log(`  broker    ${config.mqtt.url}`);
  console.log(`  conveyor  ${CONVEYOR}`);
  console.log(`  topics    ${topicTelemetry}`);
  console.log(`            ${topicJoint}\n`);

  const ports = ONLY_PORT ? [{ path: ONLY_PORT }] : (await SerialPort.list()).filter((p) => PORT_RE.test(p.path));

  if (!ports.length) {
    console.error('  no USB serial ports found. Is anything plugged in?');
    process.exit(1);
  }

  console.log(`  found ${ports.length} port(s):`);
  for (const p of ports) console.log(`    ${p.path}`);
  console.log('');

  for (const p of ports) openPort(p.path);
  setInterval(report, 5000);
  setInterval(heartbeat, HEARTBEAT_MS);
});

function openPort(path) {
  // Guard against double-scheduling: a failed open can raise both the callback
  // error and 'close', and two timers would then open the port twice.
  let scheduled = false;
  const retry = (why) => {
    if (scheduled) return;
    scheduled = true;
    console.log(`  ${short(path)}: ${why}, retrying in 2s`);
    setTimeout(() => openPort(path), 2000);
  };

  const port = new SerialPort({ path, baudRate: BAUD }, (err) => {
    // An open that fails never emits 'close', so without this a port that was
    // briefly locked (a previous bridge still exiting) would stay dead for the
    // whole run.
    if (err) retry(err.message);
  });

  // Reopening is what makes a mid-demo unplug survivable: the node reboots,
  // the port reappears, and frames resume without restarting the bridge.
  port.on('close', () => retry('closed'));
  port.on('error', (e) => retry(e.message));

  let lastData = Date.now();
  port.on('data', () => { lastData = Date.now(); });

  const watchdog = setInterval(() => {
    if (Date.now() - lastData < PORT_SILENCE_MS) return;
    clearInterval(watchdog);
    console.log(`  ${short(path)}: silent for ${PORT_SILENCE_MS / 1000}s, forcing reopen`);
    // close() emits 'close', which routes into the same retry as an unplug.
    try { port.close(() => {}); } catch { retry('silent'); }
  }, 2000);
  port.on('close', () => clearInterval(watchdog));

  const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
  parser.on('data', (line) => handleLine(path, line.trim()));
}

function handleLine(path, line) {
  if (!line) return;

  // Node log output, not data. Echo it: the same cable is the debug view.
  if (!line.startsWith('{')) {
    console.log(`  [${short(path)}] ${line}`);
    return;
  }

  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    stats.unparsed++;
    return;
  }

  const kind = msg.kind;
  delete msg.kind;

  // The node has no clock. Stamp on arrival rather than let the gateway warn
  // about a missing `ts` on every single frame.
  msg.ts = Date.now();

  if (kind === 'telemetry') {
    client.publish(topicTelemetry, JSON.stringify(msg));
    stats.frames++;
    bump(msg.node);
    announce(msg.node, path, msg.sensor_health);
  } else if (kind === 'joint') {
    client.publish(topicJoint, JSON.stringify(msg));
    stats.joints++;
    console.log(`  [${short(path)}] joint pass  lap=${msg.lap}  dt=${msg.joint_marker_dt_left}ms`);
    bump(msg.node);
    announce(msg.node, path);
  }
}

// Track a node as seen, and announce it the first time.
function announce(node, path, health) {
  if (!node) return;
  const known = nodes.get(node);
  nodes.set(node, { path, lastSeen: Date.now(), health: health ?? known?.health ?? null, online: true });
  if (!known) {
    publishStatus(node, true);
    console.log(`  node online: ${node}  (${short(path)})`);
  }
}

function publishStatus(node, online) {
  const n = nodes.get(node);
  const body = online
    ? { online: true, node, firmware: 'pravaah-serial-node 0.1.0',
        transport: `usb:${short(n?.path ?? '')}`, sensor_health: n?.health ?? undefined }
    : { online: false, node };
  client.publish(topicStatus(node), JSON.stringify(body), { retain: true });
}

// Re-assert liveness for nodes still sending, and mark silent ones offline.
function heartbeat() {
  const now = Date.now();
  for (const [node, n] of nodes) {
    const fresh = now - n.lastSeen < NODE_STALE_MS;
    if (fresh) {
      publishStatus(node, true);
    } else if (n.online) {
      n.online = false;
      publishStatus(node, false);
      console.log(`  node silent: ${node}`);
    }
  }
}

function bump(node) {
  if (!node) return;
  stats.byNode.set(node, (stats.byNode.get(node) ?? 0) + 1);
}

const short = (p) => p.replace('/dev/cu.', '').replace('/dev/tty.', '');

function report() {
  const per = [...stats.byNode.entries()].map(([n, c]) => `${n}=${c}`).join('  ') || 'none yet';
  console.log(`  -- frames ${stats.frames}  joints ${stats.joints}  unparsed ${stats.unparsed}  |  ${per}`);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const node of nodes.keys()) publishStatus(node, false);
    console.log('\n  bridge stopped');
    setTimeout(() => process.exit(0), 150);
  });
}
