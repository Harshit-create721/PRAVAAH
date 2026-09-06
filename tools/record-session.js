#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import mqtt from 'mqtt';
import config from '../server/config.js';
import { Recording } from './lib/recording.js';

const HELP = `Record a labelled conveyor run while the gateway and USB bridge are running.

  npm run record -- --label healthy_empty --state steady --load-kg 0 --hall-target roller

Options:
  --label TEXT          Required operator description; use unlabelled if unknown
  --state TEXT          unknown (default), stopped, starting, steady, stopping
  --load-kg NUMBER      Measured applied load; omitted means unknown
  --speed-setting TEXT  Drive setting as observed, e.g. dial_3 (not measured RPM)
  --hall-target TEXT    unknown (default), roller, motor, belt
  --notes TEXT          Mounting, geometry, inspection evidence, other observations
  --duration SECONDS    Stop this many seconds after the first subscription
  --conveyor ID         Configured conveyor (default: ${config.conveyors[0].id})
  --source TEXT         live (default) or synthetic (accept only bench-* node IDs)
  --output DIRECTORY    Parent folder; default data/recordings or data/synthetic-recordings
  --broker URL          Override broker for an isolated test; default configured MQTT URL
  --help                Show this help

Keep operating conditions constant within each run. Ctrl+C closes and flushes it.
No belt movement, firmware flashing, model training, or dashboard writes are performed.
`;

let values;
try {
  ({ values } = parseArgs({ options: {
    help: { type: 'boolean' },
    ...Object.fromEntries(['label', 'state', 'load-kg', 'speed-setting', 'hall-target',
      'notes', 'duration', 'conveyor', 'source', 'output', 'broker'].map((key) => [key, { type: 'string' }])),
  } }));
  if (values.help) { console.log(HELP); process.exit(0); }
  if (!values.label?.trim()) throw new Error('--label is required (use unlabelled if the condition is unknown)');
  for (const [key, allowed] of Object.entries({
    state: ['unknown', 'stopped', 'starting', 'steady', 'stopping'],
    'hall-target': ['unknown', 'roller', 'motor', 'belt'], source: ['live', 'synthetic'],
  })) {
    if (values[key] !== undefined && !allowed.includes(values[key])) throw new Error(`--${key} must be ${allowed.join(', ')}`);
  }
  for (const key of ['load-kg', 'duration']) {
    if (values[key] !== undefined && (!values[key].trim() || !Number.isFinite(Number(values[key])) || Number(values[key]) < 0)) {
      throw new Error(`--${key} must be a non-negative finite number`);
    }
  }
  if (values.duration !== undefined && (Number(values.duration) <= 0 || Number(values.duration) * 1000 > 2147483647)) {
    throw new Error('--duration must be greater than zero and at most 2147483 seconds');
  }
} catch (error) {
  console.error(`${error.message}\nUse --help for recording options.`);
  process.exit(2);
}

const conveyor = config.conveyors.find((c) => c.id === (values.conveyor ?? config.conveyors[0].id));
if (!conveyor) { console.error('Unknown conveyor; select an ID in server/config.js'); process.exit(2); }
const source = values.source ?? 'live';
const root = resolve(import.meta.dirname, '..');
const recording = new Recording({
  directory: resolve(values.output ?? resolve(root, 'data', source === 'live' ? 'recordings' : 'synthetic-recordings')),
  metadata: {
    site: config.site, conveyor: conveyor.id, source, label: values.label.trim(),
    operating_state: values.state ?? 'unknown',
    load_kg: values['load-kg'] === undefined ? null : Number(values['load-kg']),
    speed_setting: values['speed-setting'] ?? null, hall_target: values['hall-target'] ?? 'unknown',
    notes: values.notes ?? '', asset_config: conveyor,
  },
});
console.log(`Session: ${recording.directory}\nLabel: ${values.label} (${source})\nWaiting for broker subscription...`);
const client = mqtt.connect(values.broker ?? config.mqtt.url, {
  clientId: `record-${recording.id}`, connectTimeout: 10000,
  // Do not send configured credentials to an explicitly overridden broker.
  username: values.broker ? undefined : config.mqtt.username ?? undefined,
  password: values.broker ? undefined : config.mqtt.password ?? undefined,
});
let stopping = false;
let durationTimer;
let subscribedOnce = false;
const connectTimer = setTimeout(() => stop('no broker subscription within 30 seconds', 1), 30000);
const progressTimer = setInterval(() => {
  try {
    recording.flush();
    console.log(`${recording.counts.telemetry} telemetry, ${recording.counts.joint} pulse events, ${recording.counts.excluded} excluded | ${JSON.stringify(recording.signalReport())}`);
  } catch (error) { stop(`recording write failed: ${error.message}`, 1); }
}, 5000);

function stop(reason, code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(connectTimer);
  clearTimeout(durationTimer);
  clearInterval(progressTimer);
  client.end(true);
  try { recording.close(reason); } catch (error) { console.error(error.message); code = 1; }
  console.log(`Stopped: ${reason}\nSaved: ${recording.directory}\n${JSON.stringify(recording.counts)}`);
  if (recording.counts.valid_telemetry === 0) {
    console.error('No valid numeric telemetry was recorded. Check the gateway, USB bridge, and sensor connections.');
    code = 1;
  }
  process.exitCode = code;
}

client.on('connect', () => {
  if (stopping) return;
  const prefix = `beltguard/${config.site}/${conveyor.id}`;
  client.subscribe([`${prefix}/telemetry`, `${prefix}/joint`, `${prefix}/node/+/status`], { qos: 1 }, (error, granted) => {
    if (stopping) return;
    if (error || granted?.some((g) => g.qos === 128)) return stop('broker refused subscription', 1);
    clearTimeout(connectTimer);
    try { recording.event('subscribed'); } catch (error) { return stop(error.message, 1); }
    console.log('Recording subscribed. Match the run label to the current condition; Ctrl+C to finish.');
    if (!subscribedOnce && values.duration) durationTimer = setTimeout(() => stop('duration reached'), Number(values.duration) * 1000);
    subscribedOnce = true;
  });
});
client.on('message', (topic, payload, packet) => {
  if (stopping) return;
  try { recording.accept(topic, payload, packet); } catch (error) { stop(`recording write failed: ${error.message}`, 1); }
});
for (const event of ['offline', 'reconnect', 'close']) client.on(event, () => {
  if (stopping) return;
  try { recording.event(`broker_${event}`); } catch (error) { stop(error.message, 1); }
});
client.on('error', (error) => {
  if (stopping) return;
  console.error(`MQTT: ${error.message}`);
  try { recording.event('broker_error', { message: error.message }); } catch (writeError) { stop(writeError.message, 1); }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(signal));
