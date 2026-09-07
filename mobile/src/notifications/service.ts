import { Platform } from 'react-native';
import Constants from 'expo-constants';
import type { default as Notifee } from '@notifee/react-native';
import { enableAlertDelivery, requestNotificationPermission } from './notifier';

export const supportsMonitoring = Platform.OS === 'android' && Constants.executionEnvironment !== 'storeClient';
let notifee: typeof Notifee | null = null;
let finish: (() => void) | null = null;
let deadline: ReturnType<typeof setTimeout> | undefined;
let running = false;
const listeners = new Set<(value: boolean) => void>();
function setRunning(value: boolean) { running = value; enableAlertDelivery(value); for (const fn of listeners) fn(value); }
if (supportsMonitoring) {
  notifee = (require('@notifee/react-native') as typeof import('@notifee/react-native')).default;
  notifee.registerForegroundService(() => new Promise<void>(resolve => {
    finish = resolve;
    setRunning(true);
    // Android 15+ caps background dataSync time; explicitly end this monitoring session before six hours.
    deadline = setTimeout(() => { void stopMonitoring(); }, 5.5 * 60 * 60 * 1000);
    void import('../store/useRelay').then(({ bootstrap }) => bootstrap()).catch(() => stopMonitoring());
  }));
  const onEvent = async ({ type, detail }: { type: number; detail: { pressAction?: { id: string } } }) => {
    if (type === 2 && detail.pressAction?.id === 'stop') await stopMonitoring();
  };
  notifee.onBackgroundEvent(onEvent);
  notifee.onForegroundEvent(event => { void onEvent(event); });
}
export function onMonitoringChange(listener: (value: boolean) => void) {
  listeners.add(listener); listener(running); return () => { listeners.delete(listener); };
}
export async function startMonitoring() {
  if (!notifee) throw new Error('Background monitoring requires an Android development or APK build.');
  if (running) return;
  await requestNotificationPermission();
  const channelId = await notifee.createChannel({ id: 'monitoring', name: 'Live monitoring', importance: 2 });
  await notifee.displayNotification({ id: 'pravaah-monitor', title: 'PRAVAAH monitoring is active', body: 'Listening for conveyor alarms. Open the app to check connection status.',
    android: { channelId, smallIcon: 'notification_icon', asForegroundService: true, foregroundServiceTypes: [1], ongoing: true,
      pressAction: { id: 'default', launchActivity: 'default' }, actions: [{ title: 'Stop monitoring', pressAction: { id: 'stop' } }] },
  });
  setRunning(true);
}
export async function stopMonitoring() {
  clearTimeout(deadline);
  await notifee?.stopForegroundService();
  finish?.(); finish = null;
  setRunning(false);
}
export async function updateMonitoringStatus(label: string) {
  if (!running || !notifee) return;
  await notifee.displayNotification({ id: 'pravaah-monitor', title: 'PRAVAAH · ' + label,
    body: 'Listening for conveyor alarms. Tap to open. Monitoring ends after 5½ hours.',
    android: { channelId: 'monitoring', smallIcon: 'notification_icon', asForegroundService: true, foregroundServiceTypes: [1], ongoing: true,
      pressAction: { id: 'default', launchActivity: 'default' }, actions: [{ title: 'Stop monitoring', pressAction: { id: 'stop' } }] },
  });
}
