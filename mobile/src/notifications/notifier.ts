import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAlarmNotifier, parseEvidence } from '../domain/alarms';
import { humanize, numberText } from '../domain/format';

Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }) });
let enabled = false;
const LEDGER = 'pravaah.notified.v1';
let seen: string[] | null = null;
let loading: Promise<void> | null = null;
let writeChain = Promise.resolve();
export function enableAlertDelivery(value: boolean) { enabled = value; }
export async function requestNotificationPermission() {
  await Notifications.setNotificationChannelAsync('conveyor-alarms', {
    name: 'Conveyor alarms', importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 200, 250], lightColor: '#E0A03C', sound: 'default',
  });
  const permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) throw new Error('Notifications are disabled. Allow PRAVAAH notifications in Android settings.');
}
const deliver = createAlarmNotifier(async alarm => {
  loading ??= AsyncStorage.getItem(LEDGER).then(raw => {
    try { const parsed: unknown = JSON.parse(raw || '[]'); seen = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string').slice(-512) : []; }
    catch { seen = []; }
  });
  await loading;
  const key = `${alarm.conveyor}:${alarm.id}:${alarm.ts}`;
  if (seen!.includes(key)) return;
  const measured = Object.entries(parseEvidence(alarm)?.measured ?? {}).slice(0, 3)
    .map(([k, v]) => `${humanize(k)} ${numberText(v)}`).join(' · ');
  await Notifications.scheduleNotificationAsync({
    identifier: key,
    content: { title: `${alarm.conveyor} · ${humanize(alarm.level)}`, body: `${alarm.message || 'New conveyor alarm'}${measured ? `\n${measured}` : ''}`,
      sound: 'default', data: { alarmId: alarm.id }, },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 1, channelId: 'conveyor-alarms' },
  });
  seen!.push(key);
  seen = seen!.slice(-512);
  writeChain = writeChain.catch(() => {}).then(() => AsyncStorage.setItem(LEDGER, JSON.stringify(seen)));
  await writeChain;
});
export const notifyAlarm: typeof deliver = async alarm => enabled ? deliver(alarm) : false;
