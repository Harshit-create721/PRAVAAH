import { Text, View } from 'react-native';
import { Cpu } from 'lucide-react-native';
import { useLive } from '../../src/ui/hooks';
import { gatewayClock } from '../../src/store/useRelay';
import { nodeState } from '../../src/domain/staleness';
import { ageText, humanize } from '../../src/domain/format';
import { colors, styles as s } from '../../src/ui/theme';
import { Badge, ConnectionBanner, EmptyState, Page, SectionHeading } from '../../src/ui/components/Common';
export default function Nodes() {
  const live = useLive();
  const nodes = live.snapshot?.nodes.filter(n => n.conveyor === live.selectedId) ?? [];
  return <Page><ConnectionBanner /><View style={s.between}><View style={{ gap: 6 }}><Text style={s.label}>{live.selectedId || 'CONVEYOR'} · SENSOR NETWORK</Text><Text style={s.title}>Connected hardware</Text></View><Text style={s.mono}>04 / 04</Text></View><Text style={s.muted}>Last-seen times and health reported by each sensor node.</Text>
    {nodes.length === 0 ? <EmptyState title="No registered nodes" body="Nodes appear after the gateway receives telemetry or a status message." /> : nodes.map(node => {
      const state = nodeState(node, gatewayClock, live.view.degraded);
      const health = Object.entries(node.health ?? {});
      const channels = Object.values(live.conveyor?.channels ?? {}).filter(ch => ch.node === node.node);
      return <View key={node.node} style={s.card}><View style={s.between}><View style={{ padding: 10, backgroundColor: colors.raised, borderRadius: 8, borderCurve: 'continuous' }}><Cpu color={state === 'live' ? colors.green : colors.muted} size={25} /></View><Badge label={state} color={state === 'live' ? colors.green : colors.muted} /></View>
        <Text style={s.section}>{node.node}</Text><Text style={s.muted}>Last seen {ageText(gatewayClock.ageOf(node.ts))}</Text><View style={s.rule} />
        {[['Conveyor', node.conveyor], ['Firmware', node.firmware || 'Not reported'], ['Network address', node.ip || 'Not reported'], ['Transport', node.ip ? 'IP reported by node' : 'Not reported by gateway'], ['Uptime', node.uptime_s == null ? 'Not reported' : `${Math.floor(node.uptime_s / 60)} min`], ['RSSI', node.rssi == null ? 'Not reported' : `${node.rssi} dBm`]].map(([label, value]) => <View key={label} style={s.between}><Text style={s.muted}>{label}</Text><Text style={[s.mono, { color: colors.text, flexShrink: 1, textAlign: 'right' }]}>{value}</Text></View>)}
        <View style={s.rule} /><Text style={s.label}>SENSOR HEALTH</Text>{health.length ? health.map(([sensor, value]) => <View key={sensor} style={s.between}><Text style={s.body}>{humanize(sensor)}</Text><Badge label={live.view.degraded || state !== 'live' ? `${value} · last report` : value} color={value === 'healthy' && state === 'live' && !live.view.degraded ? colors.green : colors.muted} /></View>) : <Text style={s.muted}>No health report supplied.</Text>}
        <Text style={[s.muted, { fontSize: 11 }]}>{channels.length ? channels.map(c => c.label).join(' · ') : 'No channel values attributed in this snapshot.'}</Text>
      </View>;
    })}
    {(live.conveyor?.telemetrySkipped?.length ?? 0) > 0 ? <View style={s.stack}><SectionHeading title="Rules awaiting inputs" /><Text style={s.muted}>These checks cannot run until their sensors or calibration values are available.</Text>{live.conveyor?.telemetrySkipped?.map(rule => <View key={rule.rule} style={s.card}><Text style={s.body}>{humanize(rule.rule)}</Text><Text style={s.muted}>{rule.why}</Text></View>)}</View> : null}
  </Page>;
}
