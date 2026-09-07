import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { RefreshCw } from 'lucide-react-native';
import { useLive } from '../../src/ui/hooks';
import { gatewayClock, getCommands } from '../../src/store/useRelay';
import { channelState } from '../../src/domain/staleness';
import type { History } from '../../src/gateway/types';
import { formatValue, numberText } from '../../src/domain/format';
import { colors, fonts, styles as s } from '../../src/ui/theme';
import { Button, ConnectionBanner, EmptyState, Page } from '../../src/ui/components/Common';
import { Sparkline } from '../../src/ui/components/Sparkline';
export default function Trends() {
  const live = useLive();
  const params = useLocalSearchParams<{ channel?: string }>();
  const [channel, setChannel] = useState(params.channel || 'temperature');
  const [minutes, setMinutes] = useState<15 | 60>(15);
  const [history, setHistory] = useState<History | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const choices = Object.entries(live.conveyor?.channels ?? {});
  const available = !live.view.degraded;
  useEffect(() => { if (params.channel) setChannel(params.channel); }, [params.channel]);
  useEffect(() => {
    let current = true;
    setHistory(null); setError(null); setLoading(false);
    if (!live.selectedId || !available) return;
    setLoading(true);
    void getCommands().history({ conveyor: live.selectedId, channel, minutes }).then(result => {
      if (current) setHistory(result);
    }).catch(e => { if (current) setError(e instanceof Error ? e.message : 'History request failed.'); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [live.selectedId, available, live.transport, channel, minutes, refresh]);
  const meta = live.conveyor?.channels[channel];
  const freshness = meta ? channelState(meta, gatewayClock, live.view.degraded) : 'never';
  const points = history?.points ?? [];
  const values = points.map(p => p.v);
  return <Page><ConnectionBanner /><View style={s.between}><View style={{ gap: 6 }}><Text style={s.label}>{live.selectedId || 'CONVEYOR'} · RECORDED TELEMETRY</Text><Text style={s.title}>Trends</Text></View><Text style={s.mono}>03 / 04</Text></View>
    <Text style={s.muted}>Follow one signal over time. History comes from the gateway’s recorded samples.</Text>
    <View style={s.stack}><Text style={s.label}>CHANNEL</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>{choices.map(([key, ch]) => <Pressable key={key} accessibilityRole="button" accessibilityState={{ selected: channel === key }} onPress={() => setChannel(key)} style={{ padding: 12, backgroundColor: key === channel ? colors.amberBg : colors.panel, borderRadius: 6, borderCurve: 'continuous', borderWidth: 1, borderColor: key === channel ? colors.amber : colors.border }}><Text style={[s.muted, { color: channel === key ? colors.amber : colors.text }]}>{ch.label}</Text></Pressable>)}</ScrollView></View>
    <View style={[s.between, { alignItems: 'flex-start' }]}><View style={{ flex: 1, gap: 6 }}><Text style={s.label}>{meta?.label || 'CHANNEL'}</Text><Text style={[s.title, { color: freshness === 'live' ? colors.text : colors.faint }]}>{meta ? formatValue(meta) : 'NO SIGNAL'}</Text><Text style={s.muted}>Latest reading · {freshness}</Text></View><View style={[s.row, { gap: 4 }]}>{([15, 60] as const).map(m => <Pressable key={m} accessibilityRole="button" accessibilityLabel={`${m} minutes`} accessibilityState={{ selected: minutes === m }} onPress={() => setMinutes(m)} style={{ padding: 12, borderRadius: 5, borderCurve: 'continuous', backgroundColor: minutes === m ? colors.amber : colors.raised }}><Text style={[s.muted, { color: minutes === m ? colors.bg : colors.muted, fontFamily: fonts.medium }]}>{m}m</Text></Pressable>)}</View></View>
    <View style={s.card}>{loading ? <View style={{ height: 240, alignItems: 'center', justifyContent: 'center', gap: 14 }}><ActivityIndicator color={colors.amber} /><Text style={s.muted}>Fetching recorded samples…</Text></View> : error ? <><Text style={s.error}>{error}</Text><Button title="Try again" onPress={() => setRefresh(n => n + 1)} secondary /></> : !available ? <EmptyState title="Gateway unavailable" body="History can be loaded when the gateway is online. Reconnect to try again." /> : <Sparkline points={points} unit={history?.unit || meta?.unit || ''} />}</View>
    {points.length > 0 ? <View style={[s.card, s.between]}>{[{ label: 'MINIMUM', value: Math.min(...values) }, { label: 'AVERAGE', value: values.reduce((a, b) => a + b, 0) / values.length }, { label: 'MAXIMUM', value: Math.max(...values) }].map(stat => <View key={stat.label} style={{ gap: 8 }}><Text style={[s.label, { fontSize: 9 }]}>{stat.label}</Text><Text style={[s.mono, { color: colors.text, fontSize: 16 }]}>{numberText(stat.value, history?.unit)}</Text></View>)}</View> : null}
    <Text style={s.muted}>{points.length} stored samples · Last {minutes} minutes. Gaps represent missing samples. Derived channels may have no stored history.</Text>
    {points.length === 3000 ? <Text style={s.muted}>The gateway returns up to 3,000 latest samples, so this window may be truncated.</Text> : null}
    <Button title="Refresh history" secondary disabled={!available || loading} onPress={() => setRefresh(n => n + 1)} icon={<RefreshCw size={16} color={colors.text} />} />
  </Page>;
}
