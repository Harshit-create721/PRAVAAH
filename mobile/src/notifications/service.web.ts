export const supportsMonitoring = false;
export function onMonitoringChange(listener: (value: boolean) => void) { listener(false); return () => {}; }
export async function startMonitoring() { throw new Error('Background monitoring requires the Android app.'); }
export async function stopMonitoring() {}
export async function updateMonitoringStatus(_label: string) {}
