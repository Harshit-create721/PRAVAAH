import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { ArrowUpRight, Check } from 'lucide-react-native';
import type { Alarm } from '../../gateway/types';
import { ageText, humanize, numberText } from '../../domain/format';
import { parseEvidence } from '../../domain/alarms';
import { colors, fonts, riskColor, styles as s } from '../theme';
import { Badge } from './Common';

export const AlarmCard = memo(function AlarmCard({ alarm, age, onPress }: { alarm: Alarm; age: number | null; onPress: () => void }) {
  const evidence = parseEvidence(alarm);
  const color = riskColor(alarm.level);
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Alarm ${alarm.id}: ${alarm.message}. ${humanize(alarm.level)}. View details.`}
    style={({ pressed }) => [s.card, { borderLeftWidth: 3, borderLeftColor: color, opacity: pressed ? 0.8 : 1 }]}>
    <View style={s.between}><Badge label={humanize(alarm.level)} color={color} /><Text style={s.mono}>#{String(alarm.id).padStart(3, '0')}</Text></View>
    <Text style={[s.body, { fontFamily: fonts.medium, fontSize: 16, lineHeight: 23 }]}>{alarm.message || humanize(alarm.family)}</Text>
    {evidence && Object.keys(evidence.measured).length ? <Text style={s.muted} numberOfLines={2}>{Object.entries(evidence.measured).slice(0, 3).map(([key, value]) => `${humanize(key)} ${numberText(value)}`).join('  ·  ')}</Text> : <Text style={s.muted}>No measured evidence supplied</Text>}
    <View style={s.rule} />
    <View style={s.between}><Text style={[s.mono, { fontSize: 10 }]}>{alarm.conveyor} · {ageText(age)}</Text><View style={s.row}>
      {alarm.ack_ts ? <><Check size={13} color={colors.green} /><Text style={[s.muted, { color: colors.green, fontSize: 11 }]}>Acknowledged</Text></> : <Text style={[s.muted, { fontSize: 11 }]}>Needs review</Text>}
      <ArrowUpRight size={15} color={colors.muted} /></View></View>
  </Pressable>;
});
