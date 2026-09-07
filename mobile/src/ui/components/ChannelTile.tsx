import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ArrowUpRight } from 'lucide-react-native';
import type { ChannelValue, Freshness } from '../../gateway/types';
import { ageText, formatValue, numberText } from '../../domain/format';
import { colors, fonts, styles as s } from '../theme';

export const ChannelTile = memo(function ChannelTile({ channel, state, age, onPress }: {
  channel: ChannelValue; state: Freshness; age: number | null; onPress: () => void;
}) {
  const absent = channel.value === null || !Number.isFinite(channel.value);
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${channel.label}, ${formatValue(channel)}, ${state}. View trend.`}
    style={({ pressed }) => [local.card, pressed && { backgroundColor: colors.raised }]}>
    <View style={s.between}><Text style={[s.muted, { flex: 1, fontSize: 12 }]}>{channel.label}</Text><ArrowUpRight size={13} color={colors.faint} /></View>
    <View style={local.reading}><Text style={[local.value, state !== 'live' && { color: colors.faint }, absent && local.noSignal]}>{absent ? 'NO SIGNAL' : numberText(channel.value!, channel.unit)}</Text>
      {!absent ? <Text style={[s.mono, { fontSize: 11 }]}>{channel.unit}</Text> : null}</View>
    <View style={s.row}><View style={[local.dot, { backgroundColor: state === 'live' ? colors.green : colors.faint }]} /><Text style={[s.mono, { fontSize: 9, textTransform: 'uppercase' }]}>{state === 'never' ? 'Awaiting sensor' : `${state} · ${ageText(age)}`}</Text></View>
  </Pressable>;
});
const local = StyleSheet.create({
  card: { flexGrow: 1, flexBasis: '45%', minWidth: 140, padding: 14, gap: 12, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.panel, borderRadius: 10, borderCurve: 'continuous' },
  reading: { flexDirection: 'row', alignItems: 'baseline', gap: 5, minHeight: 42, flexWrap: 'wrap' },
  value: { fontFamily: fonts.display, fontSize: 38, lineHeight: 43, color: colors.text, fontVariant: ['tabular-nums'] },
  noSignal: { fontFamily: fonts.medium, fontSize: 17, letterSpacing: 0.5, lineHeight: 40 },
  dot: { width: 4, height: 4, borderRadius: 3, borderCurve: 'continuous' },
});
