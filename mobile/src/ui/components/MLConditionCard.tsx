import { StyleSheet, Text, View } from 'react-native';
import type { MLCondition } from '../../gateway/types';
import { styles as s } from '../theme';

const labels = { NORMAL: 'Within baseline range', WATCH: 'Baseline deviation',
  WARNING: 'High baseline deviation', CRITICAL: 'Very high baseline deviation' };

export function MLConditionCard({ condition, degraded, now }: {
  condition?: MLCondition | null; degraded: boolean; now: number;
}) {
  const current = !degraded && condition?.type === 'condition'
    && now - condition.end_ms <= 5000 && now >= condition.end_ms - 1000 ? condition : null;
  const title = current ? labels[current.status]
    : !degraded && condition?.status === 'WARMING_UP' ? 'Collecting a full window' : 'Data unavailable';
  const detail = current ? `${current.window_seconds}s window · ${current.driver_sensor} contributed most. ${current.explanation}`
    : degraded ? 'Gateway connection interrupted.'
      : condition?.type === 'data_quality' ? condition.reason : 'Waiting for fresh readings from all three sensors.';
  return <View style={s.card}>
    <Text style={s.label}>ML CONDITION · RECORDED BASELINE</Text>
    <View style={s.between}><Text style={[s.section, local.title]}>{title}</Text>
      {current ? <Text style={s.mono}>{current.anomaly_score.toFixed(1)} / 100</Text> : null}</View>
    <Text style={s.muted}>{detail}</Text>
    <Text style={s.muted}>Deviation from recorded operation. This score does not estimate failure probability.</Text>
  </View>;
}
const local = StyleSheet.create({ title: { flex: 1, flexShrink: 1 } });
