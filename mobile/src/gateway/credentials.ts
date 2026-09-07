import { DEFAULT_SETTINGS, endpointsFor } from './discovery';
import { isRecord, type Settings } from './types';
export interface CredentialStorage { get(): Promise<string | null>; set(value: string): Promise<void> }
export async function readSettings(storage: CredentialStorage): Promise<Settings> {
  const raw = await storage.get();
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return { ...DEFAULT_SETTINGS };
    const result = { ...DEFAULT_SETTINGS };
    for (const key of ['relayUrl', 'lanUrl', 'writeToken', 'operator'] as const) {
      if (typeof value[key] === 'string') result[key] = value[key];
    }
    result.configured = value.configured === true;
    endpointsFor(result);
    return result;
  } catch { return { ...DEFAULT_SETTINGS }; }
}
export async function saveSettings(storage: CredentialStorage, settings: Settings) {
  endpointsFor(settings);
  if (settings.writeToken.length > 1024 || /[\r\n]/.test(settings.writeToken)) throw new Error('Invalid write token.');
  await storage.set(JSON.stringify({ ...settings, configured: true }));
}
