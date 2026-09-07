import type { Connection } from './connection';
import { decodeHistory, isRecord, type Action } from './types';

interface Task {
  id: string; action: Action; payload: Record<string, unknown>;
  resolve: (result: unknown) => void; reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>; controller?: AbortController;
}
export function createCommands({ connection, now = Date.now, fetcher = fetch, timeoutMs = 12000 }: {
  connection: Connection; now?: () => number; fetcher?: typeof fetch; timeoutMs?: number;
}) {
  const queue: Task[] = [];
  const pending = new Map<string, Task>();
  let sequence = 0;
  const session = `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let tokens = 4;
  let refillAt = now();
  let pumpTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  function settle(id: string, error: Error | null, result?: unknown) {
    const task = pending.get(id);
    if (!task) return;
    pending.delete(id);
    clearTimeout(task.timer);
    if (error) { task.controller?.abort(); task.reject(error); } else task.resolve(result);
    pump();
  }
  function cancelAll(reason: string) {
    clearTimeout(pumpTimer);
    for (const task of [...pending.values(), ...queue.splice(0)]) {
      clearTimeout(task.timer);
      task.controller?.abort();
      task.reject(new Error(reason));
    }
    pending.clear();
  }
  async function lanRequest(task: Task) {
    const base = connection.endpoint.baseUrl;
    const { action, payload } = task;
    let url: string;
    const options: RequestInit = { signal: task.controller!.signal };
    if (action === 'history') {
      const params = new URLSearchParams(Object.entries(payload).map(([k, v]) => [k, String(v)]));
      url = `${base}/api/history?${params}`;
    } else {
      url = `${base}/api/alarms/${payload.alarmId}/${action}`;
      options.method = 'POST';
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(payload);
    }
    try {
      const response = await fetcher(url, options);
      const result: unknown = await response.json();
      if (!response.ok || (isRecord(result) && result.error)) throw new Error(isRecord(result) && typeof result.error === 'string' ? result.error : `Gateway request failed (${response.status}).`);
      settle(task.id, null, result);
    } catch (error) { settle(task.id, error instanceof Error ? error : new Error('Gateway request failed.')); }
  }
  function pump() {
    clearTimeout(pumpTimer);
    if (disposed) return;
    if (!connection.available) { cancelAll('Gateway unavailable. The action was not confirmed; reconnect and check its status before retrying.'); return; }
    tokens = Math.min(4, tokens + Math.max(0, now() - refillAt) * 4 / 1000);
    refillAt = now();
    while (queue.length && pending.size < 6 && tokens >= 1) {
      tokens--;
      const task = queue.shift()!;
      pending.set(task.id, task);
      task.timer = setTimeout(() => settle(task.id, new Error('Gateway response timed out. Check the alarm status before retrying.')), timeoutMs);
      if (connection.endpoint.mode === 'lan') {
        task.controller = new AbortController();
        void lanRequest(task);
      } else if (!connection.send({ type: 'command', id: task.id, action: task.action, payload: task.payload })) {
        settle(task.id, new Error('Connection lost. The action was not confirmed.'));
      }
    }
    if (queue.length && pending.size < 6) pumpTimer = setTimeout(pump, Math.max(1, Math.ceil((1 - tokens) * 250)));
  }
  function request(action: Action, payload: Record<string, unknown>): Promise<unknown> {
    if (disposed || !connection.available) return Promise.reject(new Error('Gateway offline or stale. Reconnect before sending an action.'));
    if (queue.length + pending.size >= 32) return Promise.reject(new Error('Too many requests. Wait for the current actions to finish.'));
    if (JSON.stringify(payload).length > 12000) return Promise.reject(new Error('The request is too large. Shorten the notes.'));
    return new Promise((resolve, reject) => {
      queue.push({ id: `${session}-${++sequence}`, action, payload, resolve, reject });
      pump();
    });
  }
  const unMessage = connection.onMessage(message => {
    if (message.type === 'commandResult') settle(message.id, message.ok ? null : new Error(message.error || 'Gateway rejected the action.'), message.result);
    if ((message.type === 'gatewayState' && !message.online) || (message.type === 'snapshot' && message.stale)) cancelAll('Gateway offline. Pending actions were not confirmed. Check their status after reconnecting.');
  });
  const unStatus = connection.onStatus(status => { if (status !== 'open') cancelAll('Connection lost. Pending actions were not confirmed. Check their status after reconnecting.'); });
  return {
    async history(options: { conveyor: string; channel: string; minutes: 15 | 60 }) {
      return decodeHistory(await request('history', options));
    },
    async ack(alarmId: number, by: string) {
      const result = await request('ack', { alarmId, by });
      if (!isRecord(result) || result.acked !== alarmId) throw new Error('Acknowledgement was not confirmed by the gateway.');
      return result;
    },
    async close(alarmId: number, body: { outcome: string; technician: string; notes: string }) {
      const result = await request('close', { alarmId, ...body });
      if (!isRecord(result) || result.closed !== alarmId) throw new Error('Closure was not confirmed by the gateway.');
      return result;
    },
    dispose() { disposed = true; unMessage(); unStatus(); cancelAll('Connection changed. Pending actions were not confirmed.'); },
    get pending() { return pending.size; },
  };
}
export type Commands = ReturnType<typeof createCommands>;
