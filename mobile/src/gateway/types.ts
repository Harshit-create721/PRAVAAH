export type Freshness = 'live' | 'stale' | 'late' | 'offline' | 'never';
export type MLCondition = {
  type: 'condition'; data_quality: 'valid'; status: 'NORMAL' | 'WATCH' | 'WARNING' | 'CRITICAL';
  anomaly_score: number; start_ms: number; end_ms: number; window_seconds: number;
  driver_sensor: string; explanation: string;
} | {
  type: 'data_quality'; status: 'WARMING_UP' | 'DATA_UNAVAILABLE'; reason: string;
  anomaly_score: null; health_score: null;
};
export interface ChannelValue {
  value: number | null;
  ts: number | null;
  node: string | null;
  state: Freshness;
  unit: string;
  label: string;
  group: string;
}
export interface Alarm {
  id: number;
  ts: number;
  conveyor: string;
  joint_id?: string | null;
  level: string;
  family: string | null;
  message: string | null;
  evidence: string | null;
  ack_ts?: number | null;
  ack_by?: string | null;
  closed_ts?: number | null;
  outcome?: string | null;
}
export interface NodeStatus {
  node: string;
  conveyor: string;
  ts: number | null;
  online: number;
  state: Freshness;
  health: Record<string, string> | null;
  firmware: string | null;
  rssi: number | null;
  uptime_s: number | null;
  ip: string | null;
}
export interface Conveyor {
  ml?: MLCondition | null;
  id: string;
  label: string;
  risk: string;
  riskSource: string;
  operating_state: string;
  channels: Record<string, ChannelValue>;
  alarms: Alarm[];
  joints: { id: string; label: string; passes: number; last_ts?: number }[];
  telemetrySkipped?: { rule: string; why: string }[];
  thresholds: Record<string, number | null>;
  lastMessageTs: number | null;
}
export interface Snapshot {
  type: 'snapshot';
  server: { now: number; site: string; uptime_s: number };
  serverTs: number;
  stale: boolean;
  lastSeenTs: number | null;
  conveyors: Conveyor[];
  nodes: NodeStatus[];
}
export interface AlarmEvent { type: 'alarm'; serverTs: number; alarm: Alarm }
export interface GatewayState { type: 'gatewayState'; serverTs: number; online: boolean; lastSeenTs: number | null }
export interface CommandResult { type: 'commandResult'; serverTs?: number; id: string; ok: boolean; result?: unknown; error?: string }
export type RelayMessage = Snapshot | AlarmEvent | GatewayState | CommandResult;
export type Action = 'history' | 'ack' | 'close';
export interface History { channel: string; unit: string; points: { ts: number; v: number }[] }
export interface Endpoint { mode: 'relay' | 'lan'; url: string; baseUrl: string }
export interface Settings { relayUrl: string; lanUrl: string; writeToken: string; operator: string; configured: boolean }

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nullableNumber = (v: unknown) => v === null || finite(v);
const freshness = new Set(['live', 'stale', 'late', 'offline', 'never']);
export function isMLCondition(v: unknown): v is MLCondition {
  if (!isRecord(v)) return false;
  if (v.type === 'data_quality') return (v.status === 'WARMING_UP' || v.status === 'DATA_UNAVAILABLE')
    && typeof v.reason === 'string' && v.anomaly_score === null && v.health_score === null;
  return v.type === 'condition' && v.data_quality === 'valid'
    && ['NORMAL', 'WATCH', 'WARNING', 'CRITICAL'].includes(String(v.status))
    && finite(v.anomaly_score) && v.anomaly_score >= 0 && v.anomaly_score <= 100
    && finite(v.start_ms) && finite(v.end_ms) && v.end_ms - v.start_ms === 10000
    && v.window_seconds === 10 && typeof v.driver_sensor === 'string' && typeof v.explanation === 'string';
}
export function isAlarm(v: unknown): v is Alarm {
  return isRecord(v) && finite(v.id) && finite(v.ts) && typeof v.conveyor === 'string'
    && typeof v.level === 'string' && (v.message == null || typeof v.message === 'string')
    && (v.evidence == null || typeof v.evidence === 'string') && (v.family == null || typeof v.family === 'string')
    && (v.joint_id == null || typeof v.joint_id === 'string') && (v.ack_by == null || typeof v.ack_by === 'string')
    && (v.ack_ts == null || finite(v.ack_ts)) && (v.closed_ts == null || finite(v.closed_ts));
}
function isChannel(v: unknown): v is ChannelValue {
  return isRecord(v) && nullableNumber(v.value) && nullableNumber(v.ts)
    && typeof v.state === 'string' && freshness.has(v.state)
    && typeof v.label === 'string' && typeof v.group === 'string' && typeof v.unit === 'string';
}
/** Decode both the gateway's LAN snapshot and the relay envelope. Fail closed on malformed data. */
export function decodeMessage(raw: string): RelayMessage | null {
  if (raw.length > 4 * 1024 * 1024) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!isRecord(v)) return null;
  if (v.type === 'snapshot') {
    if (!isRecord(v.server) || !finite(v.server.now) || typeof v.server.site !== 'string'
      || !Array.isArray(v.conveyors) || !Array.isArray(v.nodes)) return null;
    for (const c of v.conveyors) {
      if (!isRecord(c) || typeof c.id !== 'string' || typeof c.label !== 'string' || typeof c.risk !== 'string'
        || typeof c.riskSource !== 'string' || typeof c.operating_state !== 'string'
        || !isRecord(c.channels) || !Object.values(c.channels).every(isChannel)
        || !Array.isArray(c.alarms) || !c.alarms.every(isAlarm) || !Array.isArray(c.joints)) return null;
      // A malformed optional model result must not hide valid sensor telemetry.
      if (c.ml != null && !isMLCondition(c.ml)) c.ml = null;
    }
    for (const n of v.nodes) {
      if (!isRecord(n) || typeof n.node !== 'string' || typeof n.conveyor !== 'string'
        || (n.online !== 0 && n.online !== 1)
        || !nullableNumber(n.ts) || typeof n.state !== 'string' || !freshness.has(n.state)
        || (n.health != null && (!isRecord(n.health) || !Object.values(n.health).every(x => typeof x === 'string')))) return null;
    }
    return { ...v, serverTs: finite(v.serverTs) ? v.serverTs : v.server.now,
      stale: v.stale === true, lastSeenTs: nullableNumber(v.lastSeenTs) ? v.lastSeenTs : v.server.now } as unknown as Snapshot;
  }
  if (v.type === 'alarm' && isAlarm(v.alarm)) {
    return { type: 'alarm', alarm: v.alarm, serverTs: finite(v.serverTs) ? v.serverTs : v.alarm.ts };
  }
  if (v.type === 'gatewayState' && finite(v.serverTs) && typeof v.online === 'boolean' && nullableNumber(v.lastSeenTs)) {
    return v as unknown as GatewayState;
  }
  if (v.type === 'commandResult' && typeof v.id === 'string' && typeof v.ok === 'boolean') {
    return v as unknown as CommandResult;
  }
  return null;
}
export function decodeHistory(v: unknown): History {
  if (!isRecord(v) || typeof v.channel !== 'string' || typeof v.unit !== 'string' || !Array.isArray(v.points)
    || !v.points.every(p => isRecord(p) && finite(p.ts) && finite(p.v))) throw new Error('The gateway returned invalid history.');
  return v as unknown as History;
}
