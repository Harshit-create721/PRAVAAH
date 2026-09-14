import test from 'node:test';
import assert from 'node:assert/strict';
import { axisRange, formatTime, humanReason, nodeName, sustainedML, ruleTitle, RULE_TEXT } from '../web/dashboard-ui.js';

test('axis range keeps a minimum span so a steady belt does not look unstable', () => {
  const [lo, hi] = axisRange([20.37, 20.5, 20.69]);
  assert.ok(hi - lo >= 20.5 * 0.05, `span ${hi - lo}`);
  assert.ok(lo < 20.37 && hi > 20.69);
  // A genuinely wide signal keeps its own range (plus padding).
  const [l2, h2] = axisRange([0.05, 0.13]);
  assert.ok(l2 < 0.05 && h2 > 0.13 && h2 - l2 < 0.2);
  // Constant and zero signals still get a drawable range; empty gives null.
  const [l3, h3] = axisRange([0, 0, 0]);
  assert.ok(h3 > l3);
  assert.equal(axisRange([]), null);
  assert.equal(axisRange([NaN]), null);
});

test('times are shown in the plant zone and labelled', () => {
  const ts = Date.UTC(2026, 8, 13, 16, 45, 48);
  assert.equal(formatTime(ts, 'Asia/Kolkata'), '22:15:48 IST');
  assert.equal(formatTime(NaN, 'Asia/Kolkata'), '--:--:--');
});

test('ML reason codes and node ids become operator language', () => {
  assert.equal(nodeName('esp32-marker-01'), 'Belt speed sensor');
  assert.equal(nodeName('esp32-vibration-01'), 'Vibration sensor');
  assert.equal(nodeName('esp32-thermal-01'), 'Temperature sensor');
  assert.equal(humanReason('Sensor disconnected: esp32-marker-01'), 'Belt speed sensor disconnected');
  assert.equal(humanReason('insufficient_time_coverage:thermal'), 'Not enough recent temperature readings to fill a 10-second window');
  assert.equal(humanReason('sequence discontinuity:speed'), 'Some belt speed readings were skipped');
  assert.equal(humanReason('sensor_health:vibration:fault'), 'Vibration sensor reports "fault"');
  assert.equal(humanReason('acceleration_x must be a finite number'), 'An incomplete sensor reading arrived; the 10-second window restarted');
  assert.equal(humanReason('temperature outside range -40..380'), 'A reading was outside its valid range; the 10-second window restarted');
  assert.equal(humanReason('Something new'), 'Something new');
});

test('a single CRITICAL ML window is transient; three in a row are sustained', () => {
  const w = (end_ms, status, anomaly_score = 10) => ({ end_ms, status, anomaly_score });
  assert.equal(sustainedML([w(0, 'CRITICAL')]).sustained, null);
  let r = sustainedML([w(0, 'NORMAL'), w(2500, 'NORMAL'), w(5000, 'CRITICAL', 95)]);
  assert.equal(r.sustained.status, 'NORMAL');
  assert.equal(r.transient, true);
  assert.equal(r.latest.anomaly_score, 95);
  r = sustainedML([w(0, 'WARNING'), w(2500, 'CRITICAL'), w(5000, 'CRITICAL')]);
  assert.equal(r.sustained.status, 'WARNING');
  r = sustainedML([w(0, 'CRITICAL'), w(2500, 'CRITICAL'), w(5000, 'CRITICAL'), w(5000, 'CRITICAL')]);
  assert.equal(r.sustained.status, 'CRITICAL');
  assert.equal(r.transient, false);
  // A gap (segment break) restarts the run instead of joining across it.
  r = sustainedML([w(0, 'NORMAL'), w(2500, 'NORMAL'), w(20000, 'CRITICAL'), w(22500, 'CRITICAL')]);
  assert.equal(r.sustained, null);
});

test('every rule has a readable title; rules needing hardware say what they need', () => {
  assert.equal(ruleTitle('vibration_impulsive'), 'Impulsive vibration (shocks)');
  assert.equal(ruleTitle('crack_growth_rate'), 'Crack growth rate');
  for (const rule of ['slip_ratio', 'motor_overcurrent', 'speed_deviation']) assert.ok(RULE_TEXT[rule].needs);
  assert.ok(!/config|pulleyDiameterMm|_/.test(RULE_TEXT.slip_ratio.needs));
});
