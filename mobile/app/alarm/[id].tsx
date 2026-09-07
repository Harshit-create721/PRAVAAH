import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { CheckCircle2, X } from 'lucide-react-native';
import { useLive } from '../../src/ui/hooks';
import { gatewayClock, getCommands } from '../../src/store/useRelay';
import { parseEvidence } from '../../src/domain/alarms';
import { ageText, humanize, numberText } from '../../src/domain/format';
import { colors, riskColor, styles as s } from '../../src/ui/theme';
import { Badge, Button, ConnectionBanner, EmptyState, Field, Page } from '../../src/ui/components/Common';
import { AlarmActions } from '../../src/ui/components/AlarmActions';

export default function AlarmDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const live = useLive();
  const current = live.alarms.find(a => a.id === Number(id));
  const retained = useRef(current);
  if (current) retained.current = current;
  const alarm = current ?? (retained.current?.id === Number(id) ? retained.current : undefined);
  const removed = !!alarm && !current && !!live.snapshot && !live.view.degraded;
  const [busy, setBusy] = useState(false);
  const [ackSuccess, setAckSuccess] = useState(false);
  const [closed, setClosed] = useState(false);
  const [closing, setClosing] = useState(false);
  const [outcome, setOutcome] = useState('inspected');
  const [technician, setTechnician] = useState(live.settings.operator);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const readOnly = Platform.OS === 'web' || (live.transport === 'relay' && !live.settings.writeToken);
  const acknowledged = !!alarm?.ack_ts || ackSuccess;
  const evidence = alarm ? parseEvidence(alarm) : null;
  async function ack() {
    if (!alarm || busy) return;
    if (!technician.trim()) { setError('Enter your name below before acknowledging this alarm.'); return; }
    setBusy(true); setError(null);
    try { await getCommands().ack(alarm.id, technician.trim()); setAckSuccess(true); }
    catch (e) { setError(e instanceof Error ? e.message : 'Acknowledgement failed.'); }
    finally { setBusy(false); }
  }
  async function close() {
    if (!alarm || busy) return;
    if (!technician.trim() || !notes.trim()) { setError('Add your name and maintenance notes to close the alarm.'); return; }
    setBusy(true); setError(null);
    try { await getCommands().close(alarm.id, { outcome, technician: technician.trim(), notes: notes.trim() }); setClosed(true); setClosing(false); }
    catch (e) { setError(e instanceof Error ? e.message : 'Closure failed.'); }
    finally { setBusy(false); }
  }
  return <Page back><ConnectionBanner />
    {!alarm ? <EmptyState title="Alarm not in the open queue" body="This alarm may already be closed, or its gateway data has not arrived yet. The full maintenance record is kept on the gateway." /> : closed ? <View style={s.card}><CheckCircle2 size={38} color={colors.green} /><Text style={s.title}>Maintenance recorded.</Text><Text style={s.muted}>The gateway confirmed closure of alarm #{alarm.id}. Your outcome, name and notes were submitted.</Text><Button title="Return to alarms" onPress={() => router.replace('/alarms')} /></View> : <>
      <View style={s.between}><Text style={s.label}>{alarm.conveyor} · ALARM #{String(alarm.id).padStart(3, '0')}</Text><Badge label={humanize(alarm.level)} color={riskColor(alarm.level)} /></View>
      <Text style={s.title}>{humanize(evidence?.rule || alarm.family)}</Text><Text style={[s.body, { fontSize: 18, lineHeight: 27 }]}>{alarm.message || 'No description supplied'}</Text>
      <View style={s.card}>{[['Detected', ageText(gatewayClock.ageOf(alarm.ts))], ['Fault family', humanize(alarm.family)], ['Component / joint', alarm.joint_id || 'Conveyor-wide'], ['Source', evidence?.source || 'Not supplied'], ['Status', removed ? 'No longer in open queue' : acknowledged ? 'Acknowledged' : 'Awaiting acknowledgement']].map(([label, value]) => <View key={label} style={s.between}><Text style={s.muted}>{label}</Text><Text style={[s.body, { flexShrink: 1, textAlign: 'right' }]}>{value}</Text></View>)}{alarm.ack_by ? <Text style={s.muted}>Acknowledged by {alarm.ack_by}</Text> : null}</View>
      <View style={s.stack}><Text style={s.section}>Measured evidence</Text><Text style={s.muted}>Values captured when the rule fired. Thresholds appear when they were included in the evidence.</Text>
        {evidence && Object.keys(evidence.measured).length ? Object.entries(evidence.measured).map(([key, value]) => {
          const meta = live.conveyor?.channels[key];
          const unit = meta?.unit || (key === 'delta_k' ? 'K' : key === 'limit_g' ? 'g' : '');
          return <View key={key} style={[s.card, s.between]}><Text style={[s.body, { flex: 1 }]}>{meta?.label || humanize(key)}</Text><Text selectable style={[s.mono, { color: colors.text, fontSize: 18 }]}>{numberText(value, unit)} {unit}</Text></View>;
        }) : <EmptyState title="No evidence supplied" body="The gateway did not include parseable measured values for this alarm." />}
      </View>
      {removed ? <View style={s.card}><Text style={s.muted}>The latest gateway snapshot no longer lists this alarm as open. It may have been closed from another client.</Text><Button title="Return to alarms" secondary onPress={() => router.replace('/alarms')} /></View> : <>
        {!readOnly && !acknowledged ? <Field label="OPERATOR NAME"><TextInput accessibilityLabel="Operator name" value={technician} onChangeText={setTechnician} style={s.input} placeholder="Your name" placeholderTextColor={colors.faint} maxLength={80} /></Field> : null}
        {error && !closing ? <Text accessibilityLiveRegion="polite" style={s.error}>{error}</Text> : null}
        <AlarmActions offline={live.view.degraded} readOnly={readOnly} acknowledged={acknowledged} busy={busy} onAck={() => { void ack(); }} onClose={() => { setError(null); setClosing(true); }} />
      </>}
    </>}
    <Modal visible={closing} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => { if (!busy) setClosing(false); }}>
      <SafeAreaView style={s.fill}><KeyboardAvoidingView style={s.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <View style={s.between}><Text style={s.label}>MAINTENANCE RECORD</Text><Pressable accessibilityRole="button" accessibilityLabel="Cancel closure" disabled={busy} onPress={() => setClosing(false)} hitSlop={14}><X size={23} color={colors.text} /></Pressable></View>
        <Text style={s.title}>Close alarm #{id}</Text><Text style={s.muted}>Record what you found. Closing an alarm clears it from the open queue and writes a maintenance entry to the gateway.</Text>
        <Field label="OUTCOME"><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{['inspected', 'repaired', 'replaced', 'false_alarm'].map(value => <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: outcome === value }} onPress={() => setOutcome(value)} style={{ padding: 13, backgroundColor: outcome === value ? colors.amberBg : colors.panel, borderWidth: 1, borderColor: outcome === value ? colors.amber : colors.border, borderRadius: 6, borderCurve: 'continuous' }}><Text style={s.body}>{humanize(value)}</Text></Pressable>)}</View></Field>
        <Field label="TECHNICIAN"><TextInput accessibilityLabel="Technician" style={s.input} value={technician} onChangeText={setTechnician} placeholder="Your name" placeholderTextColor={colors.faint} maxLength={80} /></Field>
        <Field label="NOTES"><TextInput accessibilityLabel="Maintenance notes" style={[s.input, { minHeight: 130, textAlignVertical: 'top' }]} value={notes} onChangeText={setNotes} multiline maxLength={2000} placeholder="What did you inspect or repair?" placeholderTextColor={colors.faint} /></Field>
        {error ? <Text accessibilityLiveRegion="polite" style={s.error}>{error}</Text> : null}
        {live.view.degraded ? <Text style={s.error}>Gateway unavailable. Reconnect before closing this alarm.</Text> : null}
        <Button title="Save record & close alarm" busy={busy} disabled={live.view.degraded || readOnly || removed || !technician.trim() || !notes.trim()} onPress={() => { void close(); }} />
        <Button title="Cancel" secondary disabled={busy} onPress={() => setClosing(false)} />
      </ScrollView></KeyboardAvoidingView></SafeAreaView>
    </Modal>
  </Page>;
}
