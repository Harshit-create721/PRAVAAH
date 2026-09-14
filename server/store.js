// Time-series + asset-history store. Uses node:sqlite (built into Node >=22.5),
// so there is no native module to compile on the factory laptop.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CHANNELS, JOINT_CHANNELS } from './schema.js';

const TELEM_COLS = Object.keys(CHANNELS);
const JOINT_COLS = Object.keys(JOINT_CHANNELS);

export class Store {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.#migrate();
    this.#prepare();
  }

  #migrate() {
    const telemCols = TELEM_COLS.map((c) => `${c} REAL`).join(', ');
    const jointCols = JOINT_COLS.map((c) => `${c} REAL`).join(', ');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telemetry (
        ts INTEGER NOT NULL, conveyor TEXT NOT NULL, node TEXT, seq INTEGER,
        ${telemCols}
      );
      CREATE INDEX IF NOT EXISTS ix_telemetry_ts ON telemetry (conveyor, ts);

      CREATE TABLE IF NOT EXISTS joint_pass (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, conveyor TEXT NOT NULL,
        joint_id TEXT NOT NULL, lap INTEGER, belt_speed REAL,
        image_quality REAL, cv_confidence REAL, evidence_frame TEXT, source TEXT,
        ${jointCols}
      );
      CREATE INDEX IF NOT EXISTS ix_joint_pass ON joint_pass (conveyor, joint_id, ts);

      CREATE TABLE IF NOT EXISTS joint_baseline (
        conveyor TEXT NOT NULL, joint_id TEXT NOT NULL, channel TEXT NOT NULL,
        n INTEGER NOT NULL, mean REAL NOT NULL, m2 REAL NOT NULL,
        first_ts INTEGER, last_ts INTEGER, locked INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (conveyor, joint_id, channel)
      );

      CREATE TABLE IF NOT EXISTS analysis (
        ts INTEGER NOT NULL, conveyor TEXT NOT NULL, operating_state TEXT,
        load_band TEXT, risk TEXT, trend TEXT, scores TEXT, joint_scores TEXT,
        evidence TEXT, data_quality REAL, model_version TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_analysis_ts ON analysis (conveyor, ts);

      CREATE TABLE IF NOT EXISTS alarms (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, conveyor TEXT NOT NULL,
        joint_id TEXT, level TEXT NOT NULL, family TEXT, message TEXT,
        evidence TEXT, ack_ts INTEGER, ack_by TEXT,
        closed_ts INTEGER, outcome TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_alarms_open ON alarms (conveyor, closed_ts, ts);

      CREATE TABLE IF NOT EXISTS node_status (
        node TEXT PRIMARY KEY, conveyor TEXT, ts INTEGER, online INTEGER,
        firmware TEXT, rssi REAL, uptime_s INTEGER, health TEXT, ip TEXT
      );

      CREATE TABLE IF NOT EXISTS maintenance (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, conveyor TEXT NOT NULL,
        joint_id TEXT, alarm_id INTEGER, action TEXT, finding TEXT,
        technician TEXT, notes TEXT
      );

      CREATE TABLE IF NOT EXISTS rejects (
        ts INTEGER NOT NULL, topic TEXT, reason TEXT, sample TEXT
      );
    `);
    // Existing rigs retain their history when firmware adds measured channels.
    const existing = new Set(this.db.prepare('PRAGMA table_info(telemetry)').all().map((c) => c.name));
    for (const channel of TELEM_COLS) {
      if (!existing.has(channel)) this.db.exec(`ALTER TABLE telemetry ADD COLUMN ${channel} REAL`);
    }
  }

  #prepare() {
    const tCols = ['ts', 'conveyor', 'node', 'seq', ...TELEM_COLS];
    this.insTelemetry = this.db.prepare(
      `INSERT INTO telemetry (${tCols.join(',')}) VALUES (${tCols.map(() => '?').join(',')})`
    );
    const jCols = ['ts', 'conveyor', 'joint_id', 'lap', 'belt_speed', 'image_quality',
      'cv_confidence', 'evidence_frame', 'source', ...JOINT_COLS];
    this.insJoint = this.db.prepare(
      `INSERT INTO joint_pass (${jCols.join(',')}) VALUES (${jCols.map(() => '?').join(',')})`
    );
    this.insAnalysis = this.db.prepare(
      `INSERT INTO analysis (ts,conveyor,operating_state,load_band,risk,trend,scores,joint_scores,evidence,data_quality,model_version)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    );
    this.insAlarm = this.db.prepare(
      `INSERT INTO alarms (ts,conveyor,joint_id,level,family,message,evidence) VALUES (?,?,?,?,?,?,?)`
    );
    this.insReject = this.db.prepare(`INSERT INTO rejects (ts,topic,reason,sample) VALUES (?,?,?,?)`);
    this.upNode = this.db.prepare(
      `INSERT INTO node_status (node,conveyor,ts,online,firmware,rssi,uptime_s,health,ip)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(node) DO UPDATE SET conveyor=excluded.conveyor, ts=excluded.ts,
         online=excluded.online, firmware=excluded.firmware, rssi=excluded.rssi,
         uptime_s=excluded.uptime_s, health=excluded.health, ip=excluded.ip`
    );
    this.selBaseline = this.db.prepare(
      `SELECT n,mean,m2,locked FROM joint_baseline WHERE conveyor=? AND joint_id=? AND channel=?`
    );
    this.insBaseline = this.db.prepare(
      `INSERT INTO joint_baseline (conveyor,joint_id,channel,n,mean,m2,first_ts,last_ts,locked)
       VALUES (?,?,?,?,?,?,?,?,0)`
    );
    this.updBaseline = this.db.prepare(
      `UPDATE joint_baseline SET n=?, mean=?, m2=?, last_ts=?
       WHERE conveyor=? AND joint_id=? AND channel=?`
    );
  }

  telemetry(ts, conveyor, node, seq, values) {
    this.insTelemetry.run(ts, conveyor, node ?? null, seq ?? null,
      ...TELEM_COLS.map((c) => values[c] ?? null));
  }

  /**
   * Record one passage of one joint.
   *
   * The ESP32 (timing + impact) and the vision node (crack, offset) both
   * report the SAME physical passage. They are merged into ONE row keyed by
   * (conveyor, joint_id, lap) so a lap is counted once and cross-source rules
   * see all the channels together. Without a lap number they cannot be
   * correlated, so each becomes its own row.
   *
   * Returns the merged row.
   */
  jointPass(rec) {
    const scalars = ['belt_speed', 'image_quality', 'cv_confidence', 'evidence_frame'];

    if (Number.isFinite(rec.lap)) {
      const existing = this.db.prepare(
        `SELECT * FROM joint_pass WHERE conveyor=? AND joint_id=? AND lap=? ORDER BY id DESC LIMIT 1`
      ).get(rec.conveyor, rec.joint_id, rec.lap);

      if (existing) {
        // Fill only columns this row does not already carry: first writer wins,
        // so a re-sent packet cannot overwrite a measurement.
        const sets = [], vals = [];
        for (const c of JOINT_COLS) {
          if (existing[c] === null && rec.values[c] !== undefined) { sets.push(`${c}=?`); vals.push(rec.values[c]); }
        }
        for (const c of scalars) {
          if (existing[c] === null && rec[c] !== null && rec[c] !== undefined) { sets.push(`${c}=?`); vals.push(rec[c]); }
        }
        if (existing.source && rec.source && !existing.source.includes(rec.source)) {
          sets.push('source=?'); vals.push(`${existing.source}+${rec.source}`);
        }
        sets.push('ts=?'); vals.push(rec.ts);
        this.db.prepare(`UPDATE joint_pass SET ${sets.join(',')} WHERE id=?`).run(...vals, existing.id);
        return this.db.prepare(`SELECT * FROM joint_pass WHERE id=?`).get(existing.id);
      }
    }

    const r = this.insJoint.run(
      rec.ts, rec.conveyor, rec.joint_id, rec.lap ?? null, rec.belt_speed ?? null,
      rec.image_quality ?? null, rec.cv_confidence ?? null,
      rec.evidence_frame ?? null, rec.source ?? null,
      ...JOINT_COLS.map((c) => rec.values[c] ?? null)
    );
    return this.db.prepare(`SELECT * FROM joint_pass WHERE id=?`).get(Number(r.lastInsertRowid));
  }

  analysis(ts, conveyor, a) {
    this.insAnalysis.run(ts, conveyor, a.operating_state ?? null, a.load_band ?? null,
      a.risk ?? null, a.trend ?? null,
      a.scores ? JSON.stringify(a.scores) : null,
      a.joint_scores ? JSON.stringify(a.joint_scores) : null,
      a.evidence ? JSON.stringify(a.evidence) : null,
      a.data_quality ?? null, a.model_version ?? null);
  }

  alarm(ts, conveyor, jointId, level, family, message, evidence) {
    const r = this.insAlarm.run(ts, conveyor, jointId ?? null, level, family ?? null,
      message ?? null, evidence ? JSON.stringify(evidence) : null);
    return Number(r.lastInsertRowid);
  }

  /** Escalate an OPEN alarm in place when the same fault gets worse. */
  updateAlarm(id, level, message, evidence) {
    this.db.prepare(`UPDATE alarms SET level=?, message=?, evidence=? WHERE id=? AND closed_ts IS NULL`)
      .run(level, message ?? null, evidence ? JSON.stringify(evidence) : null, id);
  }

  reject(topic, reason, sample) {
    this.insReject.run(Date.now(), topic, reason, String(sample).slice(0, 500));
  }

  nodeStatus(node, conveyor, online, meta = {}) {
    this.upNode.run(node, conveyor ?? null, Date.now(), online ? 1 : 0,
      meta.firmware ?? null, meta.rssi ?? null, meta.uptime_s ?? null,
      meta.health ? JSON.stringify(meta.health) : null, meta.ip ?? null);
  }

  // Welford online update of a joint's own baseline. Only the first `maxN`
  // passes contribute, so a degrading joint cannot quietly drag its own
  // baseline along with it.
  updateBaseline(conveyor, jointId, channel, value, ts, maxN) {
    const row = this.selBaseline.get(conveyor, jointId, channel);
    if (row && (row.locked || row.n >= maxN)) {
      return { n: row.n, mean: row.mean, m2: row.m2, established: true };
    }
    const n = (row?.n ?? 0) + 1;
    const mean = row?.mean ?? 0;
    const delta = value - mean;
    const newMean = mean + delta / n;
    const m2 = (row?.m2 ?? 0) + delta * (value - newMean);
    if (row) this.updBaseline.run(n, newMean, m2, ts, conveyor, jointId, channel);
    else this.insBaseline.run(conveyor, jointId, channel, n, newMean, m2, ts, ts);
    return { n, mean: newMean, m2, established: n >= maxN };
  }

  baseline(conveyor, jointId, channel) {
    const r = this.selBaseline.get(conveyor, jointId, channel);
    if (!r) return null;
    const sd = r.n > 1 ? Math.sqrt(r.m2 / (r.n - 1)) : null;
    return { n: r.n, mean: r.mean, sd, locked: !!r.locked };
  }

  allBaselines(conveyor, jointId) {
    const rows = this.db.prepare(
      `SELECT channel,n,mean,m2 FROM joint_baseline WHERE conveyor=? AND joint_id=?`
    ).all(conveyor, jointId);
    const out = {};
    for (const r of rows) {
      out[r.channel] = { n: r.n, mean: r.mean, sd: r.n > 1 ? Math.sqrt(r.m2 / (r.n - 1)) : null };
    }
    return out;
  }

  // ---- read paths used by the HTTP API ----

  history(conveyor, channel, sinceMs, limit = 3000) {
    if (!TELEM_COLS.includes(channel)) return [];
    return this.db.prepare(
      `SELECT ts, ${channel} AS v FROM telemetry
       WHERE conveyor=? AND ts>=? AND ${channel} IS NOT NULL
       ORDER BY ts DESC LIMIT ?`
    ).all(conveyor, sinceMs, limit).reverse();
  }

  jointHistory(conveyor, jointId, limit = 500) {
    return this.db.prepare(
      `SELECT * FROM joint_pass WHERE conveyor=? AND joint_id=? ORDER BY ts DESC LIMIT ?`
    ).all(conveyor, jointId, limit).reverse();
  }

  countPasses(conveyor, jointId) {
    const r = this.db.prepare(
      `SELECT COUNT(*) AS n FROM joint_pass WHERE conveyor=? AND joint_id=?`
    ).get(conveyor, jointId);
    return Number(r?.n ?? 0);
  }

  knownJoints(conveyor) {
    return this.db.prepare(
      `SELECT joint_id, COUNT(*) AS passes, MAX(ts) AS last_ts, MIN(ts) AS first_ts
       FROM joint_pass WHERE conveyor=? GROUP BY joint_id ORDER BY joint_id`
    ).all(conveyor);
  }

  openAlarms(conveyor) {
    return this.db.prepare(
      `SELECT * FROM alarms WHERE conveyor=? AND closed_ts IS NULL ORDER BY ts DESC LIMIT 200`
    ).all(conveyor);
  }

  recentAlarms(conveyor, limit = 100) {
    return this.db.prepare(
      `SELECT a.*,
         (SELECT technician FROM maintenance m WHERE m.alarm_id = a.id ORDER BY m.ts DESC LIMIT 1) AS closed_by,
         (SELECT notes FROM maintenance m WHERE m.alarm_id = a.id ORDER BY m.ts DESC LIMIT 1) AS close_notes
       FROM alarms a WHERE a.conveyor=? ORDER BY a.ts DESC LIMIT ?`
    ).all(conveyor, limit);
  }

  lastOpenAlarm(conveyor, jointId, family) {
    return this.db.prepare(
      `SELECT * FROM alarms WHERE conveyor=? AND closed_ts IS NULL AND family=?
       AND (joint_id IS ? OR joint_id = ?) ORDER BY ts DESC LIMIT 1`
    ).get(conveyor, family, jointId ?? null, jointId ?? '');
  }

  ackAlarm(id, by) {
    this.db.prepare(`UPDATE alarms SET ack_ts=?, ack_by=? WHERE id=? AND ack_ts IS NULL`)
      .run(Date.now(), by ?? 'operator', id);
  }

  closeAlarm(id, outcome, technician, notes) {
    const a = this.db.prepare(`SELECT conveyor, joint_id FROM alarms WHERE id=?`).get(id);
    this.db.prepare(`UPDATE alarms SET closed_ts=?, outcome=? WHERE id=?`)
      .run(Date.now(), outcome ?? null, id);
    if (a) {
      this.db.prepare(
        `INSERT INTO maintenance (ts,conveyor,joint_id,alarm_id,action,finding,technician,notes)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(Date.now(), a.conveyor, a.joint_id, id, outcome ?? null, outcome ?? null,
        technician ?? null, notes ?? null);
    }
  }

  nodes() {
    return this.db.prepare(`SELECT * FROM node_status ORDER BY node`).all();
  }

  recentRejects(limit = 50) {
    return this.db.prepare(`SELECT * FROM rejects ORDER BY ts DESC LIMIT ?`).all(limit);
  }

  counts(conveyor) {
    const t = this.db.prepare(`SELECT COUNT(*) AS n FROM telemetry WHERE conveyor=?`).get(conveyor);
    const j = this.db.prepare(`SELECT COUNT(*) AS n FROM joint_pass WHERE conveyor=?`).get(conveyor);
    return { telemetry: Number(t?.n ?? 0), jointPasses: Number(j?.n ?? 0) };
  }

  prune(days) {
    const cutoff = Date.now() - days * 86400_000;
    this.db.prepare(`DELETE FROM telemetry WHERE ts < ?`).run(cutoff);
    this.db.prepare(`DELETE FROM rejects WHERE ts < ?`).run(cutoff);
  }

  close() { this.db.close(); }
}
