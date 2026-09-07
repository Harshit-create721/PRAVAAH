import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useLive } from '../../src/ui/hooks';
import { gatewayClock } from '../../src/store/useRelay';
import type { Alarm } from '../../src/gateway/types';
import { colors, styles as s } from '../../src/ui/theme';
import { ConnectionBanner, EmptyState, Page } from '../../src/ui/components/Common';
import { AlarmCard } from '../../src/ui/components/AlarmCard';
const keyExtractor = (alarm: Alarm) => String(alarm.id);
const Separator = () => <View style={{ height: 12 }} />;
export default function Alarms() {
  const live = useLive();
  const [filter, setFilter] = useState('All open');
  const alarms = useMemo(() => live.alarms.filter(a => a.conveyor === live.selectedId && (filter === 'All open' || (filter === 'Unacknowledged' ? !a.ack_ts : !!a.ack_ts))), [live.alarms, live.selectedId, filter]);
  const renderItem = useCallback(({ item }: { item: Alarm }) => <AlarmCard alarm={item} age={gatewayClock.ageOf(item.ts)} onPress={() => router.push({ pathname: '/alarm/[id]', params: { id: String(item.id) } })} />, []);
  return <Page scroll={false}><FlatList data={alarms} extraData={live.tick} keyExtractor={keyExtractor} renderItem={renderItem} ItemSeparatorComponent={Separator}
    contentContainerStyle={s.content} initialNumToRender={8} windowSize={5}
    ListHeaderComponent={<View style={[s.stack, { gap: 22, marginBottom: 20 }]}><ConnectionBanner /><View style={s.between}><View style={{ gap: 6 }}><Text style={s.label}>{live.selectedId || 'CONVEYOR'} · MAINTENANCE QUEUE</Text><Text style={s.title}>Alarms</Text></View><Text style={s.mono}>02 / 04</Text></View><Text style={s.muted}>Highest severity first. Every alarm carries the measurements that raised it.</Text>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{['All open', 'Unacknowledged', 'Acknowledged'].map(label => <Pressable key={label} accessibilityRole="button" accessibilityState={{ selected: filter === label }} onPress={() => setFilter(label)} style={{ paddingVertical: 11, paddingHorizontal: 12, backgroundColor: filter === label ? colors.amberBg : colors.panel, borderWidth: 1, borderColor: filter === label ? colors.amber : colors.border, borderRadius: 6, borderCurve: 'continuous' }}><Text style={[s.muted, { color: filter === label ? colors.amber : colors.muted, fontSize: 11 }]}>{label}</Text></Pressable>)}</View>
      <Text style={s.label}>{alarms.length} {alarms.length === 1 ? 'ALARM' : 'ALARMS'} · {live.view.degraded ? 'LAST KNOWN STATE' : 'CURRENT OPEN SET'}</Text></View>}
    ListEmptyComponent={<EmptyState title={live.snapshot ? 'Nothing in this queue' : 'Waiting for alarm data'} body={live.snapshot ? 'There are no open alarms matching this filter. Closed alarms remain in the gateway maintenance record.' : 'Connect to the gateway to load the maintenance queue.'} />} />
  </Page>;
}
