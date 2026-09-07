import { isRecord, type Alarm } from '../gateway/types';
export const severity: Record<string, number> = { critical: 5, urgent_inspection: 4, planned_inspection: 3, observe: 2, healthy: 1, unknown: 0 };
export function mergeAlarms(existing: Alarm[], incoming: Alarm[]): Alarm[] {
  const byId = new Map(existing.map(a => [a.id, a]));
  for (const a of incoming) byId.set(a.id, { ...byId.get(a.id), ...a });
  return [...byId.values()].sort((a, b) => (severity[b.level] ?? 0) - (severity[a.level] ?? 0) || b.ts - a.ts);
}
export function parseEvidence(alarm: Alarm): { rule?: string; source?: string; measured: Record<string, number> } | null {
  try {
    const e: unknown = JSON.parse(alarm.evidence || 'null');
    if (!isRecord(e)) return null;
    const measured: Record<string, number> = {};
    if (isRecord(e.measured)) for (const [key, value] of Object.entries(e.measured)) {
      if (typeof value === 'number' && Number.isFinite(value)) measured[key] = value;
    }
    return { rule: typeof e.rule === 'string' ? e.rule : undefined, source: typeof e.source === 'string' ? e.source : undefined, measured };
  } catch { return null; }
}
/** Event-only notifications: snapshots are never notification triggers. */
export function createAlarmNotifier(deliver: (alarm: Alarm) => Promise<void>) {
  const seen = new Set<string>();
  return async (alarm: Alarm) => {
    const key = `${alarm.conveyor}:${alarm.id}:${alarm.ts}`;
    if (seen.has(key)) return false;
    seen.add(key); // mark before awaiting, including simultaneous deliveries
    try { await deliver(alarm); } catch (error) { seen.delete(key); throw error; }
    if (seen.size > 10000) seen.delete(seen.values().next().value!);
    return true;
  };
}
