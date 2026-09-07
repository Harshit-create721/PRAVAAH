import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ArrowUpRight, BellRing, ChevronDown, Cpu, ShieldCheck, TriangleAlert } from 'lucide-react-native';
import { useLive } from '../../src/ui/hooks';
import { channelState, nodeState } from '../../src/domain/staleness';
import { ageText, humanize } from '../../src/domain/format';
import { gatewayClock, selectConveyor } from '../../src/store/useRelay';
import { colors, fonts, riskColor, styles as s } from '../../src/ui/theme';
import { Badge, ConnectionBanner, EmptyState, Page, SectionHeading } from '../../src/ui/components/Common';
import { ChannelTile } from '../../src/ui/components/ChannelTile';
import { AlarmCard } from '../../src/ui/components/AlarmCard';
import { MLConditionCard } from '../../src/ui/components/MLConditionCard';

const headings: Record<string, string> = { healthy: 'No active alarms', observe: 'Keep an eye on it', planned_inspection: 'Inspection due', urgent_inspection: 'Inspection urgent', critical: 'Critical alarm', unknown: 'Awaiting signal' };
export default function Overview() {
  const live = useLive();
  const [choose, setChoose] = useState(false);
  const conveyor = live.conveyor;
  const channels = Object.entries(conveyor?.channels ?? {});
  const alarms = live.alarms.filter(a => a.conveyor === live.selectedId);
  const nodes = live.snapshot?.nodes.filter(n => n.conveyor === live.selectedId) ?? [];
  const activeChannels = channels.filter(([, c]) => channelState(c, gatewayClock, live.view.degraded) === 'live').length;
  const activeNodes = nodes.filter(n => nodeState(n, gatewayClock, live.view.degraded) === 'live').length;
  const groups = [...new Set(channels.map(([, ch]) => ch.group))].sort((a, b) => {
    const order = ['thermal', 'vibration', 'drive', 'tracking', 'acoustic', 'load']; return order.indexOf(a) - order.indexOf(b);
  });
  const risk = conveyor?.risk ?? 'unknown';
  const color = live.view.degraded ? colors.muted : riskColor(risk);
  return <Page><ConnectionBanner />
    <View style={s.between}><View style={{ gap: 6 }}><Text style={s.label}>THE PLANT FLOOR, IN VIEW</Text><Text style={s.title}>Conveyor overview</Text></View><Text style={[s.mono, { color: colors.faint }]}>01 / 04</Text></View>
    {!conveyor ? <EmptyState loading={live.status === 'connecting' || live.status === 'open'} title="Waiting for the gateway" body="Your conveyor, channels and sensor nodes appear when the first snapshot arrives." /> : <>
      <Pressable accessibilityRole="button" accessibilityLabel="Select conveyor" onPress={() => setChoose(!choose)} style={[s.between, { paddingVertical: 5 }]}>
        <View style={s.row}><View style={local.asset}><Text style={[s.mono, { color: colors.amber }]}>{conveyor.id}</Text></View><Text style={s.body}>{conveyor.label}</Text></View><ChevronDown size={16} color={colors.muted} />
      </Pressable>
      {choose ? <View style={s.card}>{live.snapshot?.conveyors.map(c => <Pressable key={c.id} accessibilityRole="button" onPress={() => { selectConveyor(c.id); setChoose(false); }} style={{ padding: 12 }}><Text style={s.body}>{c.id} · {c.label}</Text></Pressable>)}</View> : null}
      <View style={[local.hero, { borderTopColor: color }]}>
        <View style={s.between}><Text style={s.label}>{live.view.degraded ? 'LAST KNOWN CONDITION' : 'CONVEYOR CONDITION'}</Text>{risk === 'healthy' ? <ShieldCheck size={24} color={color} /> : <TriangleAlert size={24} color={color} />}</View>
        <Text style={[local.headline, { color }]}>{headings[risk] ?? humanize(risk)}</Text>
        <Text style={s.muted}>{live.view.degraded ? 'Connection interrupted. Readings below are last known values.' : activeChannels === 0 ? 'No live sensor channels. Existing alarms still need review.' : conveyor.riskSource === 'rules' ? 'A sensor rule has raised an alarm. Review the measured evidence before taking action.' : humanize(conveyor.riskSource)}</Text>
        <View style={[s.row, { marginTop: 6 }]}><Badge label={humanize(conveyor.operating_state)} /><Text style={[s.mono, { fontSize: 10 }]}>Belt operating state</Text></View>
        <View style={local.stats}>{[{ value: `${activeChannels}/${channels.length}`, label: 'LIVE CHANNELS' }, { value: String(alarms.length).padStart(2, '0'), label: 'OPEN ALARMS' }, { value: `${activeNodes}/${nodes.length}`, label: 'LIVE NODES' }].map((stat, i) => <View key={stat.label} style={[local.stat, i > 0 && { borderLeftWidth: 1, borderLeftColor: colors.border }]}><Text style={[local.statValue, i === 1 && alarms.length > 0 && { color: colors.amber }]}>{stat.value}</Text><Text style={local.statLabel}>{stat.label}</Text></View>)}</View>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Configure background alarm monitoring" onPress={() => router.push('/connect')} style={[s.row, local.monitor]}>
        <BellRing size={18} color={live.monitoring ? colors.green : colors.muted} /><View style={{ flex: 1 }}><Text style={[s.body, { fontSize: 13 }]}>{live.monitoring ? 'Background monitoring is on' : 'Take your alarms with you'}</Text><Text style={[s.muted, { fontSize: 11 }]}>{live.monitoring ? 'You can lock your phone during this session.' : 'Enable Android notifications in connection settings.'}</Text></View><ArrowUpRight size={16} color={colors.muted} />
      </Pressable>
      <MLConditionCard condition={conveyor.ml} degraded={live.view.degraded} now={gatewayClock.now()} />
      {alarms.length > 0 ? <View style={s.stack}><SectionHeading title="Needs your attention" detail={`View all ${alarms.length}`} onPress={() => router.navigate('/alarms')} /><AlarmCard alarm={alarms[0]} age={gatewayClock.ageOf(alarms[0].ts)} onPress={() => router.push({ pathname: '/alarm/[id]', params: { id: String(alarms[0].id) } })} /></View> : null}
      <View style={s.stack}><SectionHeading title="Sensor readings" detail={`${activeChannels} live`} /><Text style={s.muted}>Direct from the gateway. Tap a channel to see its history.</Text></View>
      {groups.map(group => <View style={s.stack} key={group}><Text style={s.label}>{group}</Text><View style={local.grid}>{channels.filter(([, c]) => c.group === group).map(([key, channel]) => <ChannelTile key={key} channel={channel} state={channelState(channel, gatewayClock, live.view.degraded)} age={gatewayClock.ageOf(channel.ts)} onPress={() => router.navigate({ pathname: '/trends', params: { channel: key } })} />)}</View></View>)}
      <View style={s.stack}><SectionHeading title="Sensor network" detail="Inspect nodes" onPress={() => router.navigate('/nodes')} />{nodes.length ? nodes.map(node => <View key={node.node} style={[s.row, { paddingVertical: 8 }]}><Cpu size={18} color={colors.muted} /><View style={{ flex: 1 }}><Text style={[s.body, { fontSize: 12 }]}>{node.node}</Text><Text style={s.muted}>{ageText(gatewayClock.ageOf(node.ts))}</Text></View><Badge label={nodeState(node, gatewayClock, live.view.degraded)} color={nodeState(node, gatewayClock, live.view.degraded) === 'live' ? colors.green : colors.muted} /></View>) : <Text style={s.muted}>No nodes have registered with the gateway.</Text>}</View>
      <Text style={[s.label, { textAlign: 'center', color: colors.faint, fontSize: 9 }]}>PRAVAAH · CONVEYOR INTEGRITY · {live.snapshot?.server.site}</Text>
    </>}
  </Page>;
}
const local = StyleSheet.create({
  asset: { padding: 8, backgroundColor: colors.amberBg, borderRadius: 4, borderCurve: 'continuous' },
  hero: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderTopWidth: 3, borderRadius: 12, borderCurve: 'continuous', padding: 20, gap: 14 },
  headline: { fontFamily: fonts.display, fontSize: 48, lineHeight: 52 },
  stats: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 18, marginTop: 6 },
  stat: { flex: 1, alignItems: 'center', gap: 6 },
  statValue: { fontFamily: fonts.display, fontSize: 30, lineHeight: 32, color: colors.text },
  statLabel: { fontFamily: fonts.medium, fontSize: 8, letterSpacing: 0.8, color: colors.muted },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  monitor: { paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: colors.border },
});
