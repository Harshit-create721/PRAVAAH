import { AppState, Platform } from 'react-native';
import { create } from 'zustand';
import { ServerClock } from '../domain/clock';
import { mergeAlarms } from '../domain/alarms';
import { gatewayView } from '../domain/staleness';
import { createConnection, type Connection, type ConnectionStatus } from '../gateway/connection';
import { createCommands, type Commands } from '../gateway/commands';
import { readSettings, saveSettings } from '../gateway/credentials';
import { DEFAULT_SETTINGS, endpointsFor } from '../gateway/discovery';
import type { Alarm, Settings, Snapshot } from '../gateway/types';
import { credentialStorage } from '../platform/storage';
import { socketFactory } from '../platform/socket';
import { notifyAlarm } from '../notifications/notifier';
import { onMonitoringChange, updateMonitoringStatus } from '../notifications/service';

export const relayClock = new ServerClock();
export const gatewayClock = new ServerClock();
interface State {
  ready: boolean; settings: Settings; snapshot: Snapshot | null; status: ConnectionStatus;
  transport: 'relay' | 'lan'; online: boolean; stale: boolean; lastSeenTs: number | null;
  selectedId: string | null; alarms: Alarm[]; monitoring: boolean; error: string | null;
}
export const useRelay = create<State>(() => ({ ready: false, settings: DEFAULT_SETTINGS, snapshot: null,
  status: 'closed', transport: 'relay', online: false, stale: true, lastSeenTs: null,
  selectedId: null, alarms: [], monitoring: false, error: null }));
let connection: Connection | null = null;
let commands: Commands | null = null;
let boot: Promise<void> | null = null;
let lastNotificationStatus = '';

export function getGatewayView() {
  const s = useRelay.getState();
  if (s.status !== 'open') return { label: s.status === 'connecting' ? 'Connecting' : 'Disconnected', degraded: true };
  return gatewayView({ online: s.online, stale: s.stale, lastSeenTs: s.lastSeenTs }, relayClock);
}
export function getCommands() {
  if (!commands) throw new Error('Connect to a gateway first.');
  return commands;
}
function connect(settings: Settings) {
  const targets = endpointsFor(settings);
  commands?.dispose(); connection?.stop();
  useRelay.setState({ snapshot: null, alarms: [], online: false, stale: true, lastSeenTs: null, error: null });
  const current = createConnection({ endpoints: targets, writeToken: Platform.OS === 'web' ? '' : settings.writeToken,
    socketFactory, clock: relayClock });
  connection = current;
  commands = createCommands({ connection: current });
  current.onStatus(status => {
    if (connection !== current) return;
    const changedTransport = useRelay.getState().transport !== current.endpoint.mode;
    useRelay.setState({ status, transport: current.endpoint.mode, ...(status !== 'open' ? { online: false, stale: true } : {}),
      ...(changedTransport ? { snapshot: null, alarms: [], lastSeenTs: null } : {}) });
  });
  current.onMessage(message => {
    if (connection !== current) return;
    if (message.type === 'snapshot') {
      // Sensor timestamps belong to the gateway, which can itself differ from relay time.
      gatewayClock.observe(message.server.now + (relayClock.ageOf(message.lastSeenTs) ?? 0));
      const selectedId = useRelay.getState().selectedId;
      useRelay.setState({ snapshot: message, online: !message.stale, stale: message.stale, lastSeenTs: message.lastSeenTs,
        selectedId: message.conveyors.some(c => c.id === selectedId) ? selectedId : message.conveyors[0]?.id ?? null,
        // A snapshot is the authoritative OPEN set. Do not merge closed alarms back into it.
        alarms: mergeAlarms([], message.conveyors.flatMap(c => c.alarms)) });
    } else if (message.type === 'gatewayState') {
      useRelay.setState({ online: message.online, ...(message.online ? {} : { stale: true }), lastSeenTs: message.lastSeenTs });
    } else if (message.type === 'alarm') {
      useRelay.setState(s => ({ alarms: mergeAlarms(s.alarms, [message.alarm]) }));
      void notifyAlarm(message.alarm).catch(error => useRelay.setState({ error: `Alarm notification failed: ${String(error)}` }));
    }
  });
  current.start();
}
export function bootstrap() {
  boot ??= (async () => {
    try {
      const settings = await readSettings(credentialStorage);
      useRelay.setState({ settings, ready: true });
      if (settings.configured) connect(settings);
    } catch { useRelay.setState({ ready: true, error: 'Connection settings could not be read. Enter them again.' }); }
  })();
  return boot;
}
export async function configure(settings: Settings) {
  const clean = { ...settings, relayUrl: settings.relayUrl.trim(), lanUrl: settings.lanUrl.trim(), writeToken: settings.writeToken.trim(), operator: settings.operator.trim(), configured: true };
  await saveSettings(credentialStorage, clean);
  useRelay.setState({ settings: clean });
  connect(clean);
}
export function reconnect() { connect(useRelay.getState().settings); }
export function selectConveyor(selectedId: string) { useRelay.setState({ selectedId }); }
export function clearError() { useRelay.setState({ error: null }); }

onMonitoringChange(monitoring => {
  useRelay.setState({ monitoring });
  if (!monitoring && AppState.currentState === 'background') connection?.stop();
});
AppState.addEventListener('change', state => {
  if (state === 'active' && useRelay.getState().settings.configured) connection?.start();
  else if (state !== 'active' && !useRelay.getState().monitoring) connection?.stop();
});
setInterval(() => {
  if (!useRelay.getState().monitoring) return;
  const label = getGatewayView().label;
  if (label !== lastNotificationStatus) {
    lastNotificationStatus = label;
    void updateMonitoringStatus(label).catch(error => useRelay.setState({ error: String(error) }));
  }
}, 5000);
