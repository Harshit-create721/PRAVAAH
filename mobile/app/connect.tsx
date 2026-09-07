import { useEffect, useState } from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { ArrowRight, BellRing, LockKeyhole, Radio, Wifi } from 'lucide-react-native';
import { useRelay, configure, clearError } from '../src/store/useRelay';
import { startMonitoring, stopMonitoring, supportsMonitoring } from '../src/notifications/service';
import { Button, Field, Page } from '../src/ui/components/Common';
import { colors, styles as s } from '../src/ui/theme';
export default function Connect() {
  const stored = useRelay(state => state.settings);
  const ready = useRelay(state => state.ready);
  const monitoring = useRelay(state => state.monitoring);
  const globalError = useRelay(state => state.error);
  const [settings, setSettings] = useState(stored);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [advanced, setAdvanced] = useState(!!stored.lanUrl);
  useEffect(() => { if (ready) setSettings(stored); }, [ready, stored]);
  async function save() {
    setBusy(true); setError(null);
    try { await configure(settings); router.replace('/'); } catch (e) { setError(e instanceof Error ? e.message : 'Connection settings could not be saved.'); }
    finally { setBusy(false); }
  }
  async function toggleMonitoring() {
    setNotificationBusy(true); setError(null);
    try { if (monitoring) await stopMonitoring(); else await startMonitoring(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Monitoring could not be started.'); }
    finally { setNotificationBusy(false); }
  }
  return <Page><View style={{ gap: 12, paddingTop: 10 }}><View style={{ alignSelf: 'flex-start', padding: 14, borderRadius: 12, borderCurve: 'continuous', backgroundColor: colors.amberBg }}><Radio size={30} color={colors.amber} /></View><Text style={s.label}>PRAVAAH MOBILE · CONNECTION</Text><Text style={[s.title, { fontSize: 48, lineHeight: 52 }]}>{stored.configured ? 'Stay connected.' : 'Your conveyor.\nWithin reach.'}</Text><Text style={s.muted}>Live readings, measured alarm evidence and maintenance actions, wherever your shift takes you.</Text></View>
    <View style={s.card}><View style={s.row}><Wifi size={19} color={colors.amber} /><Text style={s.section}>Gateway connection</Text></View>
      <Field label="RELAY ADDRESS"><TextInput accessibilityLabel="Relay address" style={s.input} value={settings.relayUrl} onChangeText={relayUrl => setSettings(v => ({ ...v, relayUrl }))} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="wss://api.sih.shubhang.dev" placeholderTextColor={colors.faint} /></Field>
      <Field label="YOUR NAME"><TextInput accessibilityLabel="Your name" style={s.input} value={settings.operator} onChangeText={operator => setSettings(v => ({ ...v, operator }))} placeholder="Technician or operator name" placeholderTextColor={colors.faint} maxLength={80} autoComplete="name" /></Field>
      <View style={s.rule} /><View style={s.row}><LockKeyhole size={17} color={colors.muted} /><Text style={s.body}>Operator access</Text></View><Text style={s.muted}>{Platform.OS === 'web' ? 'This browser preview is read-only. Enter the write token in the Android app to acknowledge and close alarms.' : 'Viewing is open. Add the relay write token to acknowledge and close alarms. It is stored securely on this device.'}</Text>
      {Platform.OS !== 'web' ? <Field label="WRITE TOKEN · OPTIONAL"><TextInput accessibilityLabel="Write token" style={s.input} value={settings.writeToken} onChangeText={writeToken => setSettings(v => ({ ...v, writeToken }))} placeholder="Leave empty for read-only access" placeholderTextColor={colors.faint} secureTextEntry autoCapitalize="none" autoCorrect={false} maxLength={1024} /></Field> : null}
      <Pressable accessibilityRole="button" onPress={() => setAdvanced(!advanced)} style={{ paddingVertical: 12 }}><Text style={[s.body, { color: colors.amber }]}>{advanced ? '−' : '+'} Local network fallback</Text></Pressable>
      {advanced ? <><Text style={s.muted}>If the relay cannot be reached, try the gateway’s LAN address. Your phone must be on the same network.</Text><Field label="LAN GATEWAY · OPTIONAL"><TextInput accessibilityLabel="LAN gateway address" style={s.input} value={settings.lanUrl} onChangeText={lanUrl => setSettings(v => ({ ...v, lanUrl }))} placeholder="http://192.168.1.10:8811" placeholderTextColor={colors.faint} autoCapitalize="none" autoCorrect={false} keyboardType="url" /></Field></> : null}
    </View>
    {error || globalError ? <View accessibilityLiveRegion="polite" style={s.card}><Text style={s.error}>{error || globalError}</Text>{globalError ? <Pressable accessibilityRole="button" onPress={clearError}><Text style={s.muted}>Dismiss</Text></Pressable> : null}</View> : null}
    <Button title={stored.configured ? 'Save & reconnect' : 'Connect to conveyor'} busy={busy} disabled={!ready} onPress={() => { void save(); }} icon={<ArrowRight size={18} color={colors.bg} />} />
    <View style={s.card}><View style={s.row}><BellRing size={20} color={colors.amber} /><Text style={s.section}>Alarms in your pocket</Text></View><Text style={s.muted}>{supportsMonitoring ? 'Keep listening when you lock your phone. Android shows an ongoing notification while monitoring is active. Each session lasts up to 5½ hours; restart it from the app.' : 'Background alarm monitoring runs in the Android development build or APK. The browser preview shows live data while it is open.'}</Text>
      <Button title={monitoring ? 'Stop background monitoring' : 'Enable background monitoring'} secondary busy={notificationBusy} disabled={!stored.configured || !supportsMonitoring} onPress={() => { void toggleMonitoring(); }} />
      {!stored.configured && supportsMonitoring ? <Text style={s.muted}>Connect once to enable monitoring.</Text> : null}
    </View>
    {stored.configured ? <Button title="Back to overview" secondary onPress={() => router.replace('/')} /> : null}
    <Text style={[s.muted, { textAlign: 'center', fontSize: 11 }]}>PRAVAAH · Conveyor joint integrity monitoring</Text>
  </Page>;
}
