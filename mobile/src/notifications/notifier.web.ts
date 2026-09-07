import type { Alarm } from '../gateway/types';
export function enableAlertDelivery(_value: boolean) {}
export async function requestNotificationPermission() { throw new Error('Background monitoring requires the Android app.'); }
export async function notifyAlarm(_alarm: Alarm) { return false; }
