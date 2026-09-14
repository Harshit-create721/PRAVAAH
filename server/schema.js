// The wire contract between the sensor nodes and the dashboard.
// Field names follow Appendix C of the SIH26008 blueprint.
//
// Anything a node does not measure must be OMITTED from the payload.
// Never send 0, -1 or null as a stand-in: the dashboard renders a missing
// field as "no signal" and an out-of-range field as a fault, and it cannot
// tell those apart from a placeholder value.

/** Numeric channel definitions: unit, plausible physical range, label. */
export const CHANNELS = {
  motor_current_rms:  { unit: 'A',    min: 0,    max: 200,  label: 'Motor current (RMS)',  group: 'drive' },
  motor_power:        { unit: 'W',    min: 0,    max: 2e5,  label: 'Motor power',          group: 'drive' },
  motor_rpm:          { unit: 'rpm',  min: 0,    max: 6000, label: 'Motor speed',          group: 'drive' },
  hall_rpm:           { unit: 'rpm',  min: 0,    max: 6000, label: 'Belt RPM (Hall)',      group: 'drive' },
  belt_speed:         { unit: 'm/s',  min: 0,    max: 12,   label: 'Belt speed',           group: 'drive' },
  slip_ratio:         { unit: '%',    min: -50,  max: 50,   label: 'Slip ratio',           group: 'drive' },
  vibration_rms:      { unit: 'g',    min: 0,    max: 16,   label: 'Vibration RMS',        group: 'vibration' },
  vibration_kurtosis: { unit: '',     min: 0,    max: 100,  label: 'Kurtosis',             group: 'vibration' },
  vibration_crest:    { unit: '',     min: 0,    max: 100,  label: 'Crest factor',         group: 'vibration' },
  acceleration_x:    { unit: 'g',    min: -8,   max: 8,    label: 'X acceleration (mean, incl. gravity)', group: 'vibration' },
  acceleration_y:    { unit: 'g',    min: -8,   max: 8,    label: 'Y acceleration (mean, incl. gravity)', group: 'vibration' },
  acceleration_z:    { unit: 'g',    min: -8,   max: 8,    label: 'Z acceleration (mean, incl. gravity)', group: 'vibration' },
  acceleration_magnitude: { unit: 'g', min: 0, max: 14, label: 'Total acceleration (incl. gravity)', group: 'vibration' },
  temperature:        { unit: '\u00b0C', min: -40, max: 380, label: 'Surface temperature', group: 'thermal' },
  ambient:            { unit: '\u00b0C', min: -40, max: 125, label: 'IR sensor body temperature', group: 'thermal' },
  temperature_delta:  { unit: 'K',    min: -50,  max: 300,  label: 'Surface above sensor body', group: 'thermal' },
  belt_offset_left:   { unit: 'mm',   min: -500, max: 500,  label: 'Belt offset (left)',   group: 'tracking' },
  belt_offset_right:  { unit: 'mm',   min: -500, max: 500,  label: 'Belt offset (right)',  group: 'tracking' },
  acoustic_rms:       { unit: 'dBFS', min: -120, max: 0,    label: 'Acoustic RMS',         group: 'acoustic' },
  load_cell_kg:       { unit: 'kg',   min: -10,  max: 500,  label: 'Load',                 group: 'load' },
};

/** Per-joint measurements, produced once per marker passage. */
export const JOINT_CHANNELS = {
  joint_marker_dt_left:  { unit: 'ms', min: 0,   max: 6e4, label: 'Marker interval (left)' },
  joint_marker_dt_right: { unit: 'ms', min: 0,   max: 6e4, label: 'Marker interval (right)' },
  marker_distance_left:  { unit: 'mm', min: 0,   max: 5e4, label: 'Marker distance (left)' },
  marker_distance_right: { unit: 'mm', min: 0,   max: 5e4, label: 'Marker distance (right)' },
  event_vibration_rms:   { unit: 'g',  min: 0,   max: 16,  label: 'Passage impact RMS' },
  event_vibration_peak:  { unit: 'g',  min: 0,   max: 16,  label: 'Passage impact peak' },
  event_kurtosis:        { unit: '',   min: 0,   max: 100, label: 'Passage kurtosis' },
  crack_length:          { unit: 'mm', min: 0,   max: 3e3, label: 'Crack length' },
  opening:               { unit: 'mm', min: 0,   max: 200, label: 'Splice opening' },
  edge_separation:       { unit: 'mm', min: 0,   max: 200, label: 'Edge separation' },
  belt_offset:           { unit: 'mm', min: -500, max: 500, label: 'Lateral offset' },
};

export const OPERATING_STATES = ['unknown', 'stopped', 'starting', 'steady', 'stopping'];
export const LOAD_BANDS = ['unknown', 'no_load', 'light', 'normal', 'heavy', 'overload'];
export const RISK_LEVELS = ['healthy', 'observe', 'planned_inspection', 'urgent_inspection', 'critical'];
export const TRENDS = ['unknown', 'stable', 'slow_deterioration', 'rapid_deterioration', 'improving'];
export const FAULT_FAMILIES = ['joint_degradation', 'mistracking', 'slip_tension', 'idler_anomaly'];
export const SENSOR_STATES = ['healthy', 'missing', 'stale', 'clipped', 'blurred', 'uncalibrated', 'fault'];

/** MQTT topics. `<site>` and `<conveyor>` come from config. */
export const TOPICS = {
  telemetry:   (s, c) => `beltguard/${s}/${c}/telemetry`,
  jointEvent:  (s, c) => `beltguard/${s}/${c}/joint`,
  vision:      (s, c) => `beltguard/${s}/${c}/vision`,
  analysis:    (s, c) => `beltguard/${s}/${c}/analysis`,
  nodeStatus:  (s, c) => `beltguard/${s}/${c}/node/+/status`,
  subscribeAll: (s) => `beltguard/${s}/#`,
};

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Validate an inbound payload against the channel table.
 * Returns { ok, ts, values, rejected, warnings }.
 * Out-of-range numbers are REJECTED, not clamped - a clamped value is a
 * fabricated value, and this dashboard does not fabricate values.
 */
export function validate(payload, table) {
  const warnings = [];
  const rejected = [];
  const values = {};

  if (!payload || typeof payload !== 'object') {
    return { ok: false, warnings: ['payload is not a JSON object'], values, rejected };
  }

  let ts = payload.ts ?? payload.timestamp_utc;
  if (typeof ts === 'string') ts = Date.parse(ts);
  if (!isFiniteNum(ts)) {
    warnings.push('missing or unparseable `ts`; stamped on arrival at the gateway');
    ts = Date.now();
  } else if (ts < 1e12) {
    ts = ts * 1000; // seconds -> ms
    warnings.push('`ts` looked like seconds; converted to ms');
  }

  for (const [key, val] of Object.entries(payload)) {
    const spec = table[key];
    if (!spec) continue;
    if (val === null || val === undefined) continue;
    if (!isFiniteNum(val)) {
      rejected.push({ key, val, why: 'not a finite number' });
      continue;
    }
    if (val < spec.min || val > spec.max) {
      rejected.push({ key, val, why: `outside plausible range ${spec.min}..${spec.max} ${spec.unit}` });
      continue;
    }
    values[key] = val;
  }

  return { ok: Object.keys(values).length > 0, ts, values, rejected, warnings };
}

/** Normalise a sensor_health map into { name: state } using known states. */
export function normaliseHealth(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [name, state] of Object.entries(raw)) {
    const s = String(state).toLowerCase();
    out[name] = SENSOR_STATES.includes(s) ? s : (s === 'ok' ? 'healthy' : 'fault');
  }
  return out;
}
