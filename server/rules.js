// Deterministic, explainable rule layer.
//
// This is the MVP analysis the blueprint calls for: every joint is compared
// against ITS OWN learned baseline, and every finding carries the measured
// numbers that produced it. There is no model here and nothing is inferred -
// if a channel is absent, the rule that needs it simply does not fire, and
// the dashboard says the rule is "not evaluated" instead of showing a score.
//
// When you have a trained model, publish its output to the `analysis` topic.
// The server stores that alongside these rules; it never invents one.
//
// Every rule reports through gauge() below, which yields a METRIC whether or
// not the limit was breached. Metrics are what let the schematic show a
// component approaching damage instead of only announcing it after the fact.

import { RISK_LEVELS } from './schema.js';

const RANK = Object.fromEntries(RISK_LEVELS.map((r, i) => [r, i]));
export const worse = (a, b) => (RANK[a] >= RANK[b] ? a : b);

const pct = (v, ref) => (ref === 0 ? null : ((v - ref) / Math.abs(ref)) * 100);
const fmt = (v, d = 2) => (v === null || v === undefined ? '--' : Number(v).toFixed(d));

/**
 * Fraction of the configured limit at which a component is called
 * "approaching". Below this it reads healthy; at or above it the schematic
 * flags the component early, but no alarm is raised - crossing the limit is
 * still what raises an alarm.
 *
 * This is a judgement call about how much warning is useful, and it is the
 * one number here that is not measured. It is deliberately a single named
 * constant so it can be argued about in one place.
 */
export const APPROACH_FRACTION = 0.75;

/**
 * Score one measured value against its configured limit.
 *
 * `ratio` is the honest headroom number: 0.8 means "at 80% of the limit",
 * 1.4 means "40% past it". The severity ladder is derived from that ratio
 * alone, so a component's colour on the schematic is always traceable to a
 * measurement and a threshold the operator set.
 */
export function gauge({ rule, family, component, value, limit, unit, measured, message }) {
  const ratio = !Number.isFinite(limit) || limit === 0 ? null : Math.abs(value) / Math.abs(limit);
  let level = 'healthy';
  if (ratio !== null) {
    if (ratio >= 2) level = 'urgent_inspection';
    else if (ratio >= 1) level = 'planned_inspection';
    else if (ratio >= APPROACH_FRACTION) level = 'observe';
  }
  return { rule, family, component, value, limit, unit, ratio, level, measured, message };
}

/** True when a metric has crossed its limit and should become an alarm. */
const breached = (m) => m.ratio !== null && m.ratio >= 1;

/**
 * Least-squares fit of y over x, WITH the standard error of the slope.
 *
 * The standard error is the whole point: a handful of noisy measurements will
 * always produce some non-zero slope, and reporting that as "the crack is
 * growing" is exactly the false-alarm failure the blueprint warns about. A
 * caller must require the slope to be large relative to its own uncertainty
 * before it acts on it.
 *
 * Returns null for fewer than MIN_TREND_SAMPLES points.
 */
export const MIN_TREND_SAMPLES = 10;

export function trend(points) {
  const n = points.length;
  if (n < MIN_TREND_SAMPLES) return null;
  let sx = 0, sy = 0;
  for (const [x, y] of points) { sx += x; sy += y; }
  const mx = sx / n, my = sy / n;
  let sxx = 0, sxy = 0;
  for (const [x, y] of points) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let sse = 0;
  for (const [x, y] of points) sse += (y - (intercept + slope * x)) ** 2;
  const stderr = n > 2 ? Math.sqrt(sse / (n - 2) / sxx) : Infinity;
  return { slope, stderr, n, significant: stderr > 0 && Math.abs(slope) > 2 * stderr };
}

/**
 * Expected belt speed from the drive, in m/s, or null when the geometry
 * needed to compute it has not been entered in config.
 */
export function expectedBeltSpeed(conveyor, motorRpm) {
  const { pulleyDiameterMm, gearRatio } = conveyor;
  if (!pulleyDiameterMm || !gearRatio || !Number.isFinite(motorRpm)) return null;
  const pulleyRpm = motorRpm / gearRatio;
  return (Math.PI * (pulleyDiameterMm / 1000) * pulleyRpm) / 60;
}

/**
 * Evaluate one joint passage against its baseline.
 * Returns { findings, metrics, risk, skipped }.
 */
export function evaluateJointPass(store, conveyor, pass) {
  const th = conveyor.thresholds;
  const cid = conveyor.id;
  const v = pass.values;
  const findings = [];
  const metrics = [];
  const skipped = [];
  let risk = 'healthy';

  const comp = `joint:${pass.joint_id}`;
  const bl = (ch) => store.baseline(cid, pass.joint_id, ch);
  const ready = (b) => b && b.n >= Math.min(conveyor.baselineLaps, 5);

  // Record a metric, and promote it to a finding only once it has crossed.
  const take = (m) => {
    metrics.push(m);
    risk = worse(risk, m.level);
    if (breached(m)) findings.push({ family: m.family, level: m.level, rule: m.rule, message: m.message, measured: m.measured });
    return m;
  };

  // 1. Left/right marker asymmetry -> mis-tracking or one-sided elongation.
  const dl = v.joint_marker_dt_left, dr = v.joint_marker_dt_right;
  if (Number.isFinite(dl) && Number.isFinite(dr) && dl + dr > 0) {
    const mean = (dl + dr) / 2;
    const asym = (Math.abs(dl - dr) / mean) * 100;
    take(gauge({
      rule: 'marker_asymmetry', family: 'mistracking', component: 'belt_tracking',
      value: asym, limit: th.markerAsymmetryPct, unit: '%',
      message: `Marker timing asymmetry ${fmt(asym, 2)}% (limit ${th.markerAsymmetryPct}%)`,
      measured: { left_ms: dl, right_ms: dr, asymmetry_pct: asym },
    }));
  } else {
    skipped.push({ rule: 'marker_asymmetry', why: 'needs joint_marker_dt_left and joint_marker_dt_right' });
  }

  // 2. Marker spacing drift vs this joint's own baseline -> splice elongation.
  for (const [ch, side] of [['marker_distance_left', 'left'], ['marker_distance_right', 'right']]) {
    const val = v[ch];
    const b = bl(ch);
    if (!Number.isFinite(val)) { skipped.push({ rule: `marker_drift_${side}`, why: `needs ${ch}` }); continue; }
    if (!ready(b)) { skipped.push({ rule: `marker_drift_${side}`, why: `baseline not established (${b?.n ?? 0} passes)` }); continue; }
    const drift = pct(val, b.mean);
    if (drift === null) continue;
    take(gauge({
      rule: `marker_drift_${side}`, family: 'joint_degradation', component: comp,
      value: drift, limit: th.markerDriftPct, unit: '%',
      message: `${side} marker spacing ${drift > 0 ? '+' : ''}${fmt(drift, 2)}% vs baseline ${fmt(b.mean, 1)} mm`,
      measured: { value_mm: val, baseline_mm: b.mean, baseline_sd: b.sd, drift_pct: drift, baseline_n: b.n },
    }));
  }

  // 3. Passage impact energy vs baseline -> splice/lacing damage, hard spot.
  {
    const ch = 'event_vibration_rms';
    const val = v[ch], b = bl(ch);
    if (!Number.isFinite(val)) skipped.push({ rule: 'impact_rise', why: `needs ${ch}` });
    else if (!ready(b)) skipped.push({ rule: 'impact_rise', why: `baseline not established (${b?.n ?? 0} passes)` });
    else {
      const rise = pct(val, b.mean);
      if (rise !== null) {
        take(gauge({
          rule: 'impact_rise', family: 'joint_degradation', component: comp,
          value: rise, limit: th.impactRmsRisePct, unit: '%',
          message: `Passage impact RMS +${fmt(rise, 0)}% vs baseline ${fmt(b.mean, 3)} g`,
          measured: { value_g: val, baseline_g: b.mean, baseline_sd: b.sd, rise_pct: rise, baseline_n: b.n },
        }));
      }
    }
  }

  // 4. Lateral tracking offset (from the vision node).
  if (Number.isFinite(v.belt_offset)) {
    take(gauge({
      rule: 'belt_offset', family: 'mistracking', component: 'belt_tracking',
      value: v.belt_offset, limit: th.beltOffsetMm, unit: 'mm',
      message: `Lateral offset ${fmt(v.belt_offset, 1)} mm (limit ${th.beltOffsetMm} mm)`,
      measured: { offset_mm: v.belt_offset },
    }));
  } else {
    skipped.push({ rule: 'belt_offset', why: 'needs belt_offset from the vision node' });
  }

  // 5. Crack growth rate across recent passes of this same joint.
  if (Number.isFinite(v.crack_length)) {
    const hist = store.jointHistory(cid, pass.joint_id, 60)
      .filter((r) => Number.isFinite(r.crack_length) && Number.isFinite(r.lap))
      .map((r) => [r.lap, r.crack_length]);
    const t = trend(hist);
    if (t === null) {
      skipped.push({ rule: 'crack_growth', why: `needs ${MIN_TREND_SAMPLES} measured passes (have ${hist.length})` });
    } else if (!t.significant) {
      // No metric either: an insignificant slope has no honest ratio to report.
      skipped.push({ rule: 'crack_growth', why: `slope ${fmt(t.slope, 4)} mm/lap is within measurement noise (±${fmt(2 * t.stderr, 4)})` });
    } else {
      const m = take(gauge({
        rule: 'crack_growth', family: 'joint_degradation', component: comp,
        value: t.slope, limit: th.crackGrowthMmPerLap, unit: 'mm/lap',
        message: `Crack growing ${fmt(t.slope, 3)} ± ${fmt(t.stderr, 3)} mm/lap over ${t.n} passes (now ${fmt(v.crack_length, 1)} mm)`,
        measured: {
          crack_mm: v.crack_length, growth_mm_per_lap: t.slope,
          stderr_mm_per_lap: t.stderr, samples: t.n,
        },
      }));
      // A crack that is measurably growing is urgent regardless of the ratio.
      if (breached(m)) {
        m.level = 'urgent_inspection';
        findings[findings.length - 1].level = 'urgent_inspection';
        risk = worse(risk, 'urgent_inspection');
      }
    }
  } else {
    skipped.push({ rule: 'crack_growth', why: 'needs crack_length from the vision node' });
  }

  return { findings, metrics, risk, skipped };
}

/**
 * Evaluate a telemetry frame (drive-level rules). Runs on every frame but
 * only reports on transitions, so it does not spam.
 * Returns { findings, metrics, risk, skipped, derived }.
 */
export function evaluateTelemetry(conveyor, values) {
  const th = conveyor.thresholds;
  const findings = [];
  const metrics = [];
  const skipped = [];
  let risk = 'healthy';

  const take = (m) => {
    metrics.push(m);
    risk = worse(risk, m.level);
    if (breached(m)) findings.push({ family: m.family, level: m.level, rule: m.rule, message: m.message, measured: m.measured });
    return m;
  };

  // Slip / tension: measured belt speed vs speed the drive should produce.
  const expected = expectedBeltSpeed(conveyor, values.motor_rpm);
  if (expected !== null && Number.isFinite(values.belt_speed) && expected > 0.05) {
    const slip = ((expected - values.belt_speed) / expected) * 100;
    take(gauge({
      rule: 'slip_ratio', family: 'slip_tension', component: 'drive_pulley',
      value: slip, limit: th.slipRatioPct, unit: '%',
      message: `Belt slip ${fmt(slip, 1)}% (measured ${fmt(values.belt_speed, 2)} m/s vs expected ${fmt(expected, 2)} m/s)`,
      measured: { slip_pct: slip, belt_speed: values.belt_speed, expected_speed: expected, motor_rpm: values.motor_rpm },
    }));
  } else {
    skipped.push({
      rule: 'slip_ratio',
      why: expected === null
        ? 'needs pulleyDiameterMm and gearRatio in config, plus motor_rpm'
        : 'belt stopped or belt_speed missing',
    });
  }

  // Thermal delta above ambient.
  if (Number.isFinite(values.temperature) && Number.isFinite(values.ambient)) {
    const d = values.temperature - values.ambient;
    take(gauge({
      rule: 'thermal_delta', family: 'idler_anomaly', component: 'idlers',
      value: d, limit: th.tempRiseC, unit: 'K',
      message: `Surface ${fmt(d, 1)} K above ambient (limit ${th.tempRiseC} K)`,
      measured: { temperature: values.temperature, ambient: values.ambient, delta_k: d },
    }));
  } else {
    skipped.push({ rule: 'thermal_delta', why: 'needs temperature and ambient' });
  }

  // Motor current against the drive's rated current, when that is configured.
  if (Number.isFinite(values.motor_current_rms) && Number.isFinite(conveyor.driveRatedCurrentA)) {
    take(gauge({
      rule: 'motor_overcurrent', family: 'slip_tension', component: 'drive_motor',
      value: values.motor_current_rms, limit: conveyor.driveRatedCurrentA, unit: 'A',
      message: `Motor current ${fmt(values.motor_current_rms, 1)} A against ${fmt(conveyor.driveRatedCurrentA, 1)} A rated`,
      measured: { current_a: values.motor_current_rms, rated_a: conveyor.driveRatedCurrentA },
    }));
  } else {
    skipped.push({
      rule: 'motor_overcurrent',
      why: Number.isFinite(conveyor.driveRatedCurrentA)
        ? 'needs motor_current_rms'
        : 'needs driveRatedCurrentA in config, plus motor_current_rms',
    });
  }

  // Steady-state vibration amplitude at the head shaft bearing.
  if (Number.isFinite(values.vibration_rms) && Number.isFinite(th.vibrationRmsG)) {
    take(gauge({
      rule: 'vibration_high', family: 'idler_anomaly', component: 'drive_bearing',
      value: values.vibration_rms, limit: th.vibrationRmsG, unit: 'g',
      message: `Vibration ${fmt(values.vibration_rms, 3)} g RMS (limit ${fmt(th.vibrationRmsG, 2)} g)`,
      measured: { vibration_rms: values.vibration_rms, limit_g: th.vibrationRmsG },
    }));
  } else {
    skipped.push({ rule: 'vibration_high', why: 'needs vibration_rms and vibrationRmsG in config' });
  }

  // Crest factor separates "running rough" from "being hit". A rising RMS with
  // a flat crest is more load; a rising crest at the same RMS is impacts, which
  // is the early signature of bearing and idler damage. Worth its own rule
  // because the two call for different maintenance.
  const crestFloor = Number.isFinite(th.vibrationCrestMinRmsG) ? th.vibrationCrestMinRmsG : 0;
  const crestHasSignal = Number.isFinite(values.vibration_rms) && values.vibration_rms >= crestFloor;
  if (Number.isFinite(values.vibration_crest) && Number.isFinite(th.vibrationCrest) && crestHasSignal) {
    take(gauge({
      rule: 'vibration_impulsive', family: 'idler_anomaly', component: 'drive_bearing',
      value: values.vibration_crest, limit: th.vibrationCrest, unit: '',
      message: `Crest factor ${fmt(values.vibration_crest, 2)} (limit ${fmt(th.vibrationCrest, 1)}) - impulsive, not steady, vibration`,
      measured: { vibration_crest: values.vibration_crest, vibration_rms: values.vibration_rms ?? null, limit: th.vibrationCrest },
    }));
  } else if (Number.isFinite(values.vibration_crest) && Number.isFinite(th.vibrationCrest) && !crestHasSignal) {
    skipped.push({
      rule: 'vibration_impulsive',
      why: `vibration ${fmt(values.vibration_rms ?? 0, 3)} g RMS is below the ${fmt(crestFloor, 2)} g floor `
        + 'where crest factor is meaningful - machine is effectively still',
    });
  } else {
    skipped.push({ rule: 'vibration_impulsive', why: 'needs vibration_crest and vibrationCrest in config' });
  }

  // Rotation speed against the nominal the operator recorded for this drive.
  // Two-sided on purpose: a belt running slow is slip or an overload, a belt
  // running fast is an empty belt or a lost load, and both are worth knowing.
  if (Number.isFinite(values.motor_rpm) && Number.isFinite(conveyor.nominalRpm) && conveyor.nominalRpm > 0) {
    const devPct = ((values.motor_rpm - conveyor.nominalRpm) / conveyor.nominalRpm) * 100;
    take(gauge({
      rule: 'speed_deviation', family: 'slip_tension', component: 'drive_pulley',
      value: devPct, limit: th.speedTolerancePct, unit: '%',
      message: `Speed ${fmt(Math.abs(devPct), 1)}% ${devPct < 0 ? 'below' : 'above'} nominal `
        + `(${fmt(values.motor_rpm, 0)} rpm vs ${fmt(conveyor.nominalRpm, 0)} rpm)`,
      measured: { motor_rpm: values.motor_rpm, nominal_rpm: conveyor.nominalRpm, deviation_pct: devPct },
    }));
  } else {
    skipped.push({
      rule: 'speed_deviation',
      why: Number.isFinite(conveyor.nominalRpm) && conveyor.nominalRpm > 0
        ? 'needs motor_rpm from the Hall sensor'
        : 'needs nominalRpm in config - run the belt, read motor_rpm, record it there',
    });
  }

  return { findings, metrics, risk, skipped, derived: { expected_belt_speed: expected } };
}

/** Operating state from the drive channels alone. `unknown` when we cannot tell. */
export function inferOperatingState(values, prev) {
  const s = values.belt_speed;
  if (!Number.isFinite(s)) return 'unknown';
  if (s < 0.05) return 'stopped';
  if (!prev || prev.state === 'unknown') return 'steady';
  const rising = Number.isFinite(prev.speed) && s - prev.speed > 0.15;
  const falling = Number.isFinite(prev.speed) && prev.speed - s > 0.15;
  if (prev.state === 'stopped' || rising) return 'starting';
  if (falling) return 'stopping';
  return 'steady';
}
