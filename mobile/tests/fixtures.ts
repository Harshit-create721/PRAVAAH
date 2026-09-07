import type { Alarm, ChannelValue, Snapshot } from '../src/gateway/types';
export const thermalAlarm: Alarm = { id: 41, ts: 995000, conveyor: 'CV-01', level: 'planned_inspection', family: 'idler_anomaly',
  message: 'Surface 15.4 K above ambient (limit 15 K)', evidence: '{"rule":"thermal_delta","source":"telemetry","measured":{"temperature":41.65,"ambient":26.27,"delta_k":15.38}}', ack_ts: null, closed_ts: null };
export const channel: ChannelValue = { value: 0, ts: 1000000, node: 'esp32-marker-01', state: 'live', unit: 'rpm', label: 'Motor speed', group: 'drive' };
export function snapshot(now = 1000000): Snapshot {
  return { type: 'snapshot', serverTs: now, lastSeenTs: now, stale: false, server: { now, site: 'test', uptime_s: 10 },
    conveyors: [{ id: 'CV-01', label: 'Test conveyor', risk: 'planned_inspection', riskSource: 'rules', operating_state: 'unknown',
      channels: { motor_rpm: { ...channel, ts: now } }, alarms: [thermalAlarm], joints: [], thresholds: {}, lastMessageTs: now }], nodes: [] };
}
