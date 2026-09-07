import { ServerClock } from '../domain/clock';
import { decodeMessage, type Endpoint, type RelayMessage } from './types';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';
export interface Socket {
  readyState: number;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}
export type SocketFactory = (url: string, headers?: Record<string, string>) => Socket;
export function backoff(attempt: number, random = Math.random) {
  return Math.round(Math.min(30000, 1000 * 2 ** Math.min(attempt, 10) * (0.8 + random() * 0.4)));
}
export function createConnection(options: {
  endpoints: Endpoint[];
  writeToken?: string;
  socketFactory: SocketFactory;
  clock?: ServerClock;
  now?: () => number;
  random?: () => number;
}) {
  const now = options.now ?? Date.now;
  const clock = options.clock ?? new ServerClock(now);
  const listeners = new Set<(message: RelayMessage) => void>();
  const statusListeners = new Set<(status: ConnectionStatus) => void>();
  let status: ConnectionStatus = 'closed';
  let socket: Socket | null = null;
  let stopped = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let endpointIndex = 0;
  let online = false;
  let freshUntil = 0;
  let lastSnapshotReceived = 0;
  function emitStatus(next: ConnectionStatus) {
    status = next;
    for (const fn of statusListeners) fn(next);
  }
  function armWatchdog(ms: number, current: Socket) {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => disconnected(current), ms);
  }
  function disconnected(current: Socket) {
    if (current !== socket) return;
    socket = null;
    clearTimeout(watchdog);
    current.onopen = current.onclose = current.onerror = current.onmessage = null;
    try { current.close(); } catch { /* socket already gone */ }
    online = false;
    freshUntil = 0;
    emitStatus('closed');
    if (stopped) return;
    const delay = backoff(attempt++, options.random);
    // Alternate after three unsuccessful attempts. The remote credential is never sent to LAN.
    if (attempt % 3 === 0 && options.endpoints.length > 1) endpointIndex = (endpointIndex + 1) % options.endpoints.length;
    timer = setTimeout(connect, delay);
  }
  function connect() {
    if (stopped) return;
    emitStatus('connecting');
    const target = options.endpoints[endpointIndex];
    try {
      const headers = target.mode === 'relay' && options.writeToken ? { Authorization: `Bearer ${options.writeToken}` } : undefined;
      const current = options.socketFactory(target.url, headers);
      socket = current;
      // Register before open: the cached snapshot can arrive immediately after the handshake.
      current.onmessage = event => {
        if (current !== socket || typeof event.data !== 'string') return;
        const message = decodeMessage(event.data);
        if (!message) return;
        if (message.serverTs !== undefined && (target.mode === 'relay' || message.type === 'snapshot')) clock.observe(message.serverTs);
        armWatchdog(25000, current);
        attempt = 0; // A valid frame proves the connection works; a bare handshake does not.
        if (message.type === 'snapshot') {
          online = !message.stale;
          lastSnapshotReceived = now();
          const age = clock.ageOf(message.lastSeenTs);
          freshUntil = message.stale || age === null ? 0 : now() + Math.max(0, 15000 - age);
        } else if (message.type === 'gatewayState') {
          online = message.online;
          if (!online) freshUntil = 0;
        }
        for (const fn of listeners) fn(message);
      };
      current.onopen = () => { if (current === socket) emitStatus('open'); };
      current.onclose = current.onerror = () => disconnected(current);
      armWatchdog(12000, current);
    } catch {
      emitStatus('closed');
      if (!stopped) {
        const delay = backoff(attempt++, options.random);
        if (attempt % 3 === 0 && options.endpoints.length > 1) endpointIndex = (endpointIndex + 1) % options.endpoints.length;
        timer = setTimeout(connect, delay);
      }
    }
  }
  return {
    start() { if (!stopped) return; stopped = false; attempt = 0; endpointIndex = 0; connect(); },
    stop() {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(watchdog);
      if (socket) disconnected(socket); else emitStatus('closed');
    },
    send(message: unknown) {
      if (!socket || socket.readyState !== 1) return false;
      const data = JSON.stringify(message);
      // Worst-case UTF-8 size stays below the relay's 64 KiB inbound cap.
      if (data.length > 16000) return false;
      try { socket.send(data); return true; } catch { return false; }
    },
    onMessage(fn: (message: RelayMessage) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    onStatus(fn: (status: ConnectionStatus) => void) { statusListeners.add(fn); return () => { statusListeners.delete(fn); }; },
    get status() { return status; },
    get endpoint() { return options.endpoints[endpointIndex]; },
    get available() { return status === 'open' && online && now() < freshUntil && now() - lastSnapshotReceived < 15000; },
  };
}
export type Connection = ReturnType<typeof createConnection>;
