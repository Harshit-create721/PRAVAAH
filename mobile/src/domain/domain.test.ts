import { ServerClock } from './clock';
import { channelState, freshnessAt, gatewayView, nodeState } from './staleness';
import { formatValue } from './format';
import { createAlarmNotifier, mergeAlarms, parseEvidence } from './alarms';
import { channel, thermalAlarm } from '../../tests/fixtures';
import type { NodeStatus } from '../gateway/types';

test.each([-30000, 0, 30000])('server time corrects phone skew %i', skew => {
  const clock = new ServerClock(() => 1000000 + skew); clock.observe(1000000);
  expect(clock.ageOf(995000)).toBe(5000); expect(clock.ageOf(null)).toBeNull();
});
test('a newer observation replaces the offset and future timestamps have nonnegative age', () => {
  const clock = new ServerClock(() => 1000000); clock.observe(900000); clock.observe(1000000);
  expect(clock.offsetMs).toBe(0); expect(clock.ageOf(1100000)).toBe(0);
});
test.each([[0, 'live'], [3000, 'live'], [3001, 'stale'], [10000, 'stale'], [10001, 'late'], [30000, 'late'], [30001, 'offline']])('freshness boundary %i -> %s', (age, result) => {
  expect(freshnessAt(1000000 - Number(age), new ServerClock(() => 1000000))).toBe(result);
});
test('absent readings are NO SIGNAL and measured zero remains zero', () => {
  expect(formatValue({ value: null, unit: 'rpm' })).toBe('NO SIGNAL');
  expect(formatValue({ value: NaN, unit: 'g' })).toBe('NO SIGNAL');
  expect(formatValue(channel)).toBe('0 rpm');
});
test('a stale gateway or node never makes recent data look live', () => {
  const clock = new ServerClock(() => 1000000);
  expect(channelState(channel, clock, true)).toBe('stale');
  expect(channelState({ ...channel, state: 'offline' }, clock)).toBe('offline');
  expect(nodeState({ ts: 1000000, state: 'live', online: 0 } as NodeStatus, clock)).toBe('offline');
  expect(gatewayView({ online: false, stale: false, lastSeenTs: 1000000 }, clock)).toEqual({ label: 'Gateway offline', degraded: true });
  expect(gatewayView({ online: true, stale: false, lastSeenTs: 980000 }, clock).degraded).toBe(true);
});
test('cached snapshots preserve sensor age even with separate gateway clock skew', () => {
  const relay = new ServerClock(() => 1000000); relay.observe(1000000);
  const gateway = new ServerClock(() => 1000000);
  gateway.observe(900000 + (relay.ageOf(970000) ?? 0));
  expect(gateway.ageOf(895000)).toBe(35000);
});
test('alarm merges dedupe ids, retain acknowledgements and order by severity', () => {
  const merged = mergeAlarms([thermalAlarm], [{ ...thermalAlarm, ack_ts: 1000000 }, { ...thermalAlarm, id: 42, level: 'critical' }]);
  expect(merged).toHaveLength(2); expect(merged[0].id).toBe(42); expect(merged[1].ack_ts).toBe(1000000);
});
test('evidence preserves measured numbers and safely rejects malformed data', () => {
  expect(parseEvidence(thermalAlarm)?.measured.delta_k).toBe(15.38);
  expect(parseEvidence({ ...thermalAlarm, evidence: '{bad' })).toBeNull();
  expect(parseEvidence({ ...thermalAlarm, evidence: '{"measured":{"bad":"NaN","good":0}}' })?.measured).toEqual({ good: 0 });
});
test('notifications dedupe concurrent alarm events and reconnect replays', async () => {
  const deliver = jest.fn(async () => {}); const notify = createAlarmNotifier(deliver);
  await Promise.all([notify(thermalAlarm), notify(thermalAlarm)]); await notify({ ...thermalAlarm });
  expect(deliver).toHaveBeenCalledTimes(1); expect(deliver.mock.calls[0]).toEqual([thermalAlarm]);
});
test('notification failures may be retried, and a new database alarm with a reused id is distinct', async () => {
  let fail = true; const deliver = jest.fn(async () => { if (fail) throw new Error('permission'); });
  const notify = createAlarmNotifier(deliver); await expect(notify(thermalAlarm)).rejects.toThrow('permission');
  fail = false; await notify(thermalAlarm); await notify({ ...thermalAlarm, ts: thermalAlarm.ts + 1 });
  expect(deliver).toHaveBeenCalledTimes(3);
});
