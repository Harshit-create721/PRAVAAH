import type { ChannelValue, Freshness, NodeStatus } from '../gateway/types';
import type { ServerClock } from './clock';
// Matches server/config.js. The current relay does not expose configurable freshness windows.
export const WINDOWS = { liveMs: 3000, staleMs: 10000, offlineMs: 30000 };
const rank: Record<Freshness, number> = { live: 0, stale: 1, late: 2, offline: 3, never: 4 };
export function freshnessAt(ts: number | null, clock: ServerClock): Freshness {
  const age = clock.ageOf(ts);
  if (age === null) return 'never';
  if (age <= WINDOWS.liveMs) return 'live';
  if (age <= WINDOWS.staleMs) return 'stale';
  if (age <= WINDOWS.offlineMs) return 'late';
  return 'offline';
}
export function channelState(ch: ChannelValue, clock: ServerClock, degraded = false): Freshness {
  if (ch.value === null || ch.ts === null || !Number.isFinite(ch.value)) return 'never';
  const computed = freshnessAt(ch.ts, clock);
  const state = rank[ch.state] > rank[computed] ? ch.state : computed;
  return degraded && state === 'live' ? 'stale' : state;
}
export function nodeState(node: NodeStatus, clock: ServerClock, degraded = false): Freshness {
  if (!node.online || node.state === 'offline') return 'offline';
  const computed = freshnessAt(node.ts, clock);
  const state = rank[node.state] > rank[computed] ? node.state : computed;
  return degraded && state === 'live' ? 'stale' : state;
}
export function gatewayView(input: { online: boolean; stale: boolean; lastSeenTs: number | null }, clock: ServerClock) {
  const age = clock.ageOf(input.lastSeenTs);
  if (!input.online) return { label: 'Gateway offline', degraded: true };
  if (input.stale || age === null || age > 15000) return { label: 'Gateway stale', degraded: true };
  return { label: 'Gateway live', degraded: false };
}
