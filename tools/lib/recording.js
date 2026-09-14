// An append-only capture, separate from the dashboard's rolling history.
// CSV rows are individual messages: missing sensors are never forward-filled.
import { openSync, writeSync, closeSync, fsyncSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CHANNELS, JOINT_CHANNELS, validate } from '../../server/schema.js';

const BASE_COLUMNS = ['session_id', 'label', 'source', 'conveyor', 'received_at_ms',
  'ts_ms', 'node', 'seq', 'seq_gap', 'seq_reset', 'sensor_health', 'quality_issues'];
const TELEMETRY_COLUMNS = [...BASE_COLUMNS, ...Object.keys(CHANNELS)];
const JOINT_COLUMNS = [...BASE_COLUMNS, 'joint_id', 'lap', 'belt_speed', ...Object.keys(JOINT_CHANNELS)];

function csvCell(value) {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export class Recording {
  constructor({ directory, metadata }) {
    this.startedAt = Date.now();
    this.id = `${new Date(this.startedAt).toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
    this.directory = join(directory, this.id);
    this.metadata = metadata;
    this.files = new Map();
    this.closed = false;
    this.previousSeq = new Map();
    this.counts = { telemetry: 0, valid_telemetry: 0, joint: 0, status: 0, excluded: 0, sequence_gaps: 0, sequence_resets: 0 };
    this.byNode = Object.create(null);
    this.lastChannelAt = new Map();
    mkdirSync(directory, { recursive: true });
    mkdirSync(this.directory); // A session can never overwrite another run.
    try {
      for (const name of ['session.json', 'frames.jsonl', 'excluded.jsonl', 'events.jsonl', 'telemetry.csv', 'joint.csv']) {
        this.files.set(name, openSync(join(this.directory, name), 'wx'));
      }
      this.write('session.json', JSON.stringify({
        format_version: 1, session_id: this.id, started_at_ms: this.startedAt,
        ...metadata,
        time_basis: 'ts is publisher time; USB bridge uses laptop arrival time. received_at_ms is recorder arrival time. Nodes are not hardware-synchronised.',
        label_basis: 'Operator-supplied run description; not a diagnosis or an automatically verified ground truth.',
        provenance: 'Source selection filters the known bench-* harness convention; it does not authenticate hardware.',
        telemetry_channels: CHANNELS, joint_channels: JOINT_CHANNELS,
      }, null, 2) + '\n');
      this.write('telemetry.csv', TELEMETRY_COLUMNS.join(',') + '\n');
      this.write('joint.csv', JOINT_COLUMNS.join(',') + '\n');
      this.event('created');
      this.flush();
    } catch (error) {
      for (const fd of this.files.values()) closeSync(fd);
      throw error;
    }
  }

  write(name, text) {
    if (this.closed) throw new Error('Recording is closed');
    const bytes = Buffer.from(text);
    let offset = 0;
    while (offset < bytes.length) {
      const n = writeSync(this.files.get(name), bytes, offset, bytes.length - offset);
      if (!n) throw new Error(`Could not write ${name}`);
      offset += n;
    }
  }

  event(type, details = {}) {
    this.write('events.jsonl', JSON.stringify({ received_at_ms: Date.now(), type, ...details }) + '\n');
  }

  accept(topic, buffer, { retain = false } = {}) {
    const receivedAt = Date.now();
    const raw = buffer.toString('utf8');
    const prefix = `beltguard/${this.metadata.site}/${this.metadata.conveyor}/`;
    const suffix = topic.startsWith(prefix) ? topic.slice(prefix.length) : '';
    const status = /^node\/([^/]+)\/status$/.exec(suffix);
    const kind = status ? 'status' : suffix;
    const exclude = (reason) => {
      this.counts.excluded++;
      this.write('excluded.jsonl', JSON.stringify({ received_at_ms: receivedAt, topic, reason, raw }) + '\n');
      return false;
    };
    if (!['telemetry', 'joint', 'status'].includes(kind)) return exclude('outside capture topics');
    if (retain) return exclude('retained message: may predate this session');
    let payload;
    try { payload = JSON.parse(raw); } catch { return exclude('invalid JSON'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return exclude('expected a JSON object');
    if (payload.playback) return exclude('recorded playback is not a new sensor acquisition');
    const node = typeof payload.node === 'string' && payload.node.trim() ? payload.node : status?.[1];
    if (!node) return exclude('missing node identity');
    const synthetic = node.startsWith('bench-') || Boolean(status?.[1].startsWith('bench-'));
    if ((this.metadata.source === 'synthetic') !== synthetic) return exclude('source does not match this session');

    // Keep the exact unmodified MQTT body, including fields the current schema
    // does not recognise. This is raw telemetry, not raw accelerometer samples.
    this.write('frames.jsonl', JSON.stringify({ received_at_ms: receivedAt, topic, payload }) + '\n');
    this.counts[kind]++;
    this.byNode[node] = (this.byNode[node] ?? 0) + 1;
    if (kind === 'status') return true;

    const result = validate(payload, kind === 'telemetry' ? CHANNELS : JOINT_CHANNELS);
    if (kind === 'telemetry' && result.ok) this.counts.valid_telemetry++;
    const quality = [...result.warnings, ...result.rejected.map((r) => `${r.key}: ${r.why}`)];
    if (kind === 'telemetry' && !result.ok) quality.push('no valid numeric telemetry channels');
    const row = {
      session_id: this.id, label: this.metadata.label, source: this.metadata.source,
      conveyor: this.metadata.conveyor, received_at_ms: receivedAt, ts_ms: result.ts,
      node, sensor_health: payload.sensor_health,
      seq: Number.isSafeInteger(payload.seq) && payload.seq >= 0 ? payload.seq : undefined,
      ...result.values,
    };
    if (kind === 'telemetry' && row.seq !== undefined) {
      const previous = this.previousSeq.get(node);
      if (previous !== undefined) {
        row.seq_gap = Math.max(0, row.seq - previous - 1);
        row.seq_reset = row.seq < previous ? 1 : 0;
        this.counts.sequence_gaps += row.seq_gap;
        this.counts.sequence_resets += row.seq_reset;
        if (row.seq === previous) quality.push('repeated sequence number');
        if (row.seq_reset) quality.push('sequence decreased: possible restart or out-of-order packet');
      }
      this.previousSeq.set(node, row.seq);
    }
    if (kind === 'telemetry') {
      for (const channel of Object.keys(result.values)) this.lastChannelAt.set(channel, receivedAt);
    } else {
      row.joint_id = payload.joint_id;
      row.lap = Number.isSafeInteger(payload.lap) && payload.lap >= 0 ? payload.lap : undefined;
      const speed = validate({ belt_speed: payload.belt_speed, ts: result.ts }, CHANNELS);
      row.belt_speed = speed.values.belt_speed;
      quality.push(...speed.rejected.map((r) => `${r.key}: ${r.why}`));
      if (this.metadata.hall_target !== 'belt') quality.push('Hall pulses are not verified belt-joint passages');
    }
    row.quality_issues = quality;
    const columns = kind === 'telemetry' ? TELEMETRY_COLUMNS : JOINT_COLUMNS;
    this.write(`${kind}.csv`, columns.map((column) => csvCell(row[column])).join(',') + '\n');
    return true;
  }

  signalReport(now = Date.now()) {
    return Object.fromEntries(['temperature', 'vibration_rms', 'hall_rpm', 'motor_rpm', 'belt_speed'].map((channel) => {
      const last = this.lastChannelAt.get(channel);
      return [channel, !last ? 'not seen' : now - last > 5000 ? 'stale' : 'receiving'];
    }));
  }

  flush() {
    for (const fd of this.files.values()) fsyncSync(fd);
  }

  close(reason = 'stopped') {
    if (this.closed) return;
    try {
      this.event('stopped', { reason });
      const fd = openSync(join(this.directory, 'summary.json'), 'wx');
      this.files.set('summary.json', fd);
      this.write('summary.json', JSON.stringify({
        session_id: this.id, ended_at_ms: Date.now(), reason,
        counts: this.counts, by_node: this.byNode, final_signals: this.signalReport(),
      }, null, 2) + '\n');
      this.flush();
    } finally {
      for (const fd of this.files.values()) closeSync(fd);
      this.closed = true;
    }
  }
}
