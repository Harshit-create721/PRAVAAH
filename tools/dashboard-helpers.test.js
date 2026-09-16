import test from 'node:test';
import assert from 'node:assert/strict';
import { axisRange, formatTime, humanReason, nodeName, sustainedML, ruleTitle, RULE_TEXT,
  gapReason, alarmAlert, alarmStates } from '../web/dashboard-ui.js';

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

test('a coverage gap reports the reason the gateway gave, not a canned hardware shopping list', () => {
  // Permanent gap: the gateway names the unset config field, so the
  // plain-language sentence is the whole truth.
  assert.equal(gapReason('slip_ratio', 'needs pulleyDiameterMm and gearRatio in config, plus motor_rpm'),
    RULE_TEXT.slip_ratio.needs);
  assert.equal(gapReason('motor_overcurrent', 'needs driveRatedCurrentA in config, plus motor_current_rms'),
    RULE_TEXT.motor_overcurrent.needs);

  // Transient gap: the hardware is fitted and configured, the belt is just
  // stopped. Telling the operator to buy a speed sensor would be false.
  assert.equal(gapReason('slip_ratio', 'belt stopped or belt_speed missing'),
    'belt stopped or belt_speed missing');
  // Sensor fitted and rated current set; only the live channel is absent.
  assert.equal(gapReason('motor_overcurrent', 'needs motor_current_rms'), 'needs motor_current_rms');
  assert.equal(gapReason('speed_deviation', 'needs motor_rpm from the Hall sensor'),
    'needs motor_rpm from the Hall sensor');

  // Rules with no canned text always pass the gateway's reason through.
  assert.equal(gapReason('crack_growth', 'needs 6 measured passes (have 2)'), 'needs 6 measured passes (have 2)');
  assert.equal(gapReason('slip_ratio', undefined), '');
});

test('an escalation re-alerts even after the operator acknowledged the alarm', () => {
  const planned = [{ id: 1, level: 'planned_inspection', message: 'High vibration', ack_ts: null }];
  // First paint never chimes about alarms that were already open.
  assert.equal(alarmAlert(null, planned), false);

  const seen = alarmStates(planned);
  assert.equal(alarmAlert(seen, planned), false);

  // Acknowledged and unchanged: stay quiet.
  const acked = [{ id: 1, level: 'planned_inspection', message: 'High vibration', ack_ts: 1000 }];
  assert.equal(alarmAlert(alarmStates(acked), acked), false);

  // The gateway escalates in place and leaves ack_ts set. This is the case
  // that was silent before, and it is the loudest thing the dashboard has.
  const escalated = [{ id: 1, level: 'critical', message: 'High vibration', ack_ts: 1000 }];
  assert.equal(alarmAlert(alarmStates(acked), escalated), true);

  // De-escalation and a mere re-wording of an acked alarm stay quiet.
  assert.equal(alarmAlert(alarmStates(escalated), acked), false);
  const reworded = [{ id: 1, level: 'planned_inspection', message: 'High vibration 1.4 g', ack_ts: 1000 }];
  assert.equal(alarmAlert(alarmStates(acked), reworded), false);

  // An unacknowledged alarm still alerts on a new id or a changed message.
  assert.equal(alarmAlert(seen, [...planned, { id: 2, level: 'observe', message: 'Belt off-track', ack_ts: null }]), true);
  assert.equal(alarmAlert(seen, [{ id: 1, level: 'planned_inspection', message: 'changed', ack_ts: null }]), true);

  // An unknown level cannot masquerade as an escalation.
  assert.equal(alarmAlert(alarmStates(acked), [{ id: 1, level: 'bogus', message: 'x', ack_ts: 1000 }]), false);
});
