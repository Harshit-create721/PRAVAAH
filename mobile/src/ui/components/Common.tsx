import type { PropsWithChildren, ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Activity, ArrowLeft, ArrowUpRight, Settings2, Wifi, WifiOff } from 'lucide-react-native';
import { colors, fonts, styles as s } from '../theme';
import { useLive } from '../hooks';
import { ageText } from '../../domain/format';
import { relayClock, reconnect } from '../../store/useRelay';

export function Button({ title, onPress, disabled = false, busy = false, secondary = false, danger = false, icon }: {
  title: string; onPress: () => void; disabled?: boolean; busy?: boolean; secondary?: boolean; danger?: boolean; icon?: ReactNode;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled: disabled || busy, busy }}
    disabled={disabled || busy} onPress={onPress} style={({ pressed }) => [local.button, secondary && local.secondary,
      danger && local.danger, (disabled || busy) && local.disabled, pressed && { opacity: 0.8 }]}>
    {busy ? <ActivityIndicator color={secondary ? colors.text : colors.bg} /> : icon}
    <Text style={[local.buttonText, (secondary || danger) && { color: colors.text }]}>{title}</Text>
  </Pressable>;
}
export function Badge({ label, color = colors.muted }: { label: string; color?: string }) {
  return <View style={[local.badge, { borderColor: color + '55' }]}><View style={[local.dot, { backgroundColor: color }]} /><Text style={[local.badgeText, { color }]}>{label}</Text></View>;
}
export function Page({ children, scroll = true, back = false, contentStyle }: PropsWithChildren<{ scroll?: boolean; back?: boolean; contentStyle?: StyleProp<ViewStyle> }>) {
  return <SafeAreaView style={s.fill} edges={['top', 'left', 'right']}>
    <View style={local.masthead}>
      <View style={s.row}>{back ? <Pressable accessibilityRole="button" accessibilityLabel="Go back" hitSlop={14} onPress={() => router.canGoBack() ? router.back() : router.replace('/alarms')}><ArrowLeft size={22} color={colors.text} /></Pressable> : <Activity size={24} color={colors.amber} strokeWidth={2} />}
        <Text style={local.brand}>PRAVAAH<Text style={{ color: colors.amber }}>.</Text></Text><View style={local.brandRule} /><Text style={local.field}>FIELD{ '\n' }OPERATIONS</Text></View>
      <Pressable accessibilityRole="button" accessibilityLabel="Connection settings" hitSlop={14} onPress={() => router.push('/connect')}><Settings2 size={21} color={colors.muted} /></Pressable>
    </View>
    {scroll ? <ScrollView style={s.fill} contentContainerStyle={[s.content, contentStyle]} keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic">{children}</ScrollView> : children}
  </SafeAreaView>;
}
export function ConnectionBanner() {
  const live = useLive();
  const color = live.view.degraded ? colors.muted : colors.green;
  return <View style={{ gap: 10 }}><View style={local.connection}>
    <View style={[s.row, { flex: 1 }]}>{live.view.degraded ? <WifiOff size={16} color={color} /> : <Wifi size={16} color={color} />}
      <View style={{ flex: 1 }}><Text style={[s.body, { color, fontFamily: fonts.medium, fontSize: 12 }]}>{live.view.label.toUpperCase()} · {live.transport === 'lan' ? 'LOCAL NETWORK' : 'CLOUD RELAY'}</Text>
        {live.view.degraded ? <Text style={s.muted}>Last update {ageText(relayClock.ageOf(live.lastSeenTs))}</Text> : null}</View></View>
    {live.view.degraded ? <Pressable accessibilityRole="button" accessibilityLabel="Retry connection" hitSlop={10} onPress={reconnect}><Text style={[s.muted, { color: colors.amber }]}>Retry</Text></Pressable> : null}
  </View>{live.error ? <Text accessibilityLiveRegion="polite" style={s.error}>{live.error}</Text> : null}</View>;
}
export function SectionHeading({ title, detail, onPress }: { title: string; detail?: string; onPress?: () => void }) {
  return <View style={s.between}><Text style={s.section}>{title}</Text>{detail ? <Pressable disabled={!onPress} onPress={onPress} accessibilityRole={onPress ? 'button' : undefined} style={s.row}>
    <Text style={[s.muted, onPress ? { color: colors.amber } : null]}>{detail}</Text>{onPress ? <ArrowUpRight size={15} color={colors.amber} /> : null}</Pressable> : null}</View>;
}
export function EmptyState({ title, body, loading = false }: { title: string; body: string; loading?: boolean }) {
  return <View style={[s.card, { paddingVertical: 36, alignItems: 'center' }]}>{loading ? <ActivityIndicator color={colors.amber} /> : <Activity size={30} color={colors.faint} />}
    <Text style={s.section}>{title}</Text><Text style={[s.muted, { textAlign: 'center' }]}>{body}</Text></View>;
}
export function Field({ label, children }: PropsWithChildren<{ label: string }>) {
  return <View style={{ gap: 8 }}><Text style={s.label}>{label}</Text>{children}</View>;
}
const local = StyleSheet.create({
  masthead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
  brand: { fontFamily: fonts.display, fontSize: 29, color: colors.text, letterSpacing: 0.7 },
  brandRule: { height: 24, width: 1, backgroundColor: colors.border, marginHorizontal: 3 },
  field: { color: colors.faint, fontFamily: fonts.medium, fontSize: 8, letterSpacing: 1.5, lineHeight: 12 },
  connection: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 16, borderBottomColor: colors.border, borderBottomWidth: 1 },
  button: { minHeight: 52, borderRadius: 8, borderCurve: 'continuous', backgroundColor: colors.amber, padding: 14, flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'center' },
  secondary: { backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.border },
  danger: { backgroundColor: '#61342C', borderWidth: 1, borderColor: colors.red },
  disabled: { opacity: 0.4 },
  buttonText: { fontFamily: fonts.bold, fontSize: 14, color: colors.bg },
  badge: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, borderWidth: 1, borderRadius: 5, borderCurve: 'continuous', paddingHorizontal: 8, paddingVertical: 5 },
  dot: { height: 5, width: 5, borderRadius: 3, borderCurve: 'continuous' },
  badgeText: { fontFamily: fonts.medium, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
});
