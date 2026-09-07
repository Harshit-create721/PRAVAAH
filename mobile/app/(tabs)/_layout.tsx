import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { Redirect } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { useRelay } from '../../src/store/useRelay';
import { colors, styles } from '../../src/ui/theme';
export default function TabsLayout() {
  const ready = useRelay(s => s.ready);
  const configured = useRelay(s => s.settings.configured);
  const alarmCount = useRelay(s => s.alarms.length);
  if (!ready) return <View style={[styles.fill, { justifyContent: 'center' }]}><ActivityIndicator color={colors.amber} /></View>;
  if (!configured) return <Redirect href="/connect" />;
  return <NativeTabs backgroundColor={colors.panel} tintColor={colors.amber} iconColor={{ default: colors.faint, selected: colors.amber }}
    labelStyle={{ default: { color: colors.muted, fontSize: 11 }, selected: { color: colors.amber } }}
    indicatorColor={colors.amberBg} badgeBackgroundColor={colors.amber} badgeTextColor={colors.bg}>
    <NativeTabs.Trigger name="index"><NativeTabs.Trigger.Icon sf="square.grid.2x2" md="dashboard" /><NativeTabs.Trigger.Label>Overview</NativeTabs.Trigger.Label></NativeTabs.Trigger>
    <NativeTabs.Trigger name="alarms"><NativeTabs.Trigger.Icon sf="bell" md="notifications_none" /><NativeTabs.Trigger.Label>Alarms</NativeTabs.Trigger.Label>{alarmCount > 0 ? <NativeTabs.Trigger.Badge>{String(alarmCount)}</NativeTabs.Trigger.Badge> : null}</NativeTabs.Trigger>
    <NativeTabs.Trigger name="trends"><NativeTabs.Trigger.Icon sf="waveform.path" md="show_chart" /><NativeTabs.Trigger.Label>Trends</NativeTabs.Trigger.Label></NativeTabs.Trigger>
    <NativeTabs.Trigger name="nodes"><NativeTabs.Trigger.Icon sf="sensor" md="sensors" /><NativeTabs.Trigger.Label>Nodes</NativeTabs.Trigger.Label></NativeTabs.Trigger>
  </NativeTabs>;
}
