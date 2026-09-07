import { createCommands } from './commands';
import { createConnection, type Socket } from './connection';
import { endpoint } from './discovery';
import { snapshot } from '../../tests/fixtures';
class TestSocket implements Socket {
  readyState = 1; onopen: Socket['onopen'] = null; onclose: Socket['onclose'] = null; onerror: Socket['onerror'] = null; onmessage: Socket['onmessage'] = null;
  sent: { id: string; action: string; payload: Record<string, unknown> }[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.onclose?.(); }
  deliver(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
function setup() {
  const socket = new TestSocket();
  const conn = createConnection({ endpoints: [endpoint('wss://relay.test', 'relay')], socketFactory: () => socket });
  const commands = createCommands({ connection: conn, timeoutMs: 10000 }); conn.start(); socket.onopen?.(); socket.deliver(snapshot());
  return { socket, conn, commands, cleanup: () => { commands.dispose(); conn.stop(); } };
}
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(1000000); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
test('history results correlate by id and ignore unrelated responses', async () => {
  const { socket, commands, cleanup } = setup();
  const first = commands.history({ conveyor: 'CV-01', channel: 'temperature', minutes: 15 });
  const second = commands.ack(41, 'Technician');
  expect(socket.sent[0].id.length).toBeLessThanOrEqual(64);
  socket.deliver({ type: 'commandResult', id: 'another-client', ok: false, error: 'wrong' });
  socket.deliver({ type: 'commandResult', id: socket.sent[1].id, ok: true, result: { acked: 41 } });
  socket.deliver({ type: 'commandResult', id: socket.sent[0].id, ok: true, result: { channel: 'temperature', unit: '°C', points: [{ ts: 999000, v: 41.65 }] } });
  expect(await first).toMatchObject({ points: [{ ts: 999000, v: 41.65 }] }); expect(await second).toEqual({ acked: 41 }); cleanup();
});
test('relay rejection is a visible error rather than a successful write', async () => {
  const { socket, commands, cleanup } = setup(); const promise = commands.ack(41, 'Test');
  socket.deliver({ type: 'commandResult', id: socket.sent[0].id, ok: false, error: 'unauthorized' });
  await expect(promise).rejects.toThrow('unauthorized'); cleanup();
});
test('timeout tells the operator to check status before retrying', async () => {
  const { commands, cleanup } = setup(); const result = expect(commands.ack(41, 'Test')).rejects.toThrow('timed out');
  jest.advanceTimersByTime(10001); await result; expect(commands.pending).toBe(0); cleanup();
});
test('throttles bursts and caps in-flight requests below relay limits', async () => {
  const { commands, socket, cleanup } = setup();
  const promises = Array.from({ length: 16 }, () => commands.ack(41, 'Test').catch(e => e));
  expect(socket.sent).toHaveLength(4); jest.advanceTimersByTime(500); expect(socket.sent).toHaveLength(6);
  jest.advanceTimersByTime(1000); expect(commands.pending).toBe(6); expect(socket.sent).toHaveLength(6);
  cleanup(); await Promise.all(promises);
});
test('disconnect rejects both pending and queued writes without replay', async () => {
  const { commands, conn, socket, cleanup } = setup();
  const promises = Array.from({ length: 10 }, () => commands.ack(41, 'Test').catch(e => e as Error));
  conn.stop(); const results = await Promise.all(promises); expect(results.every(v => v instanceof Error)).toBe(true);
  await expect(commands.ack(41, 'Test')).rejects.toThrow('offline'); expect(socket.sent).toHaveLength(4); cleanup();
});
test('gatewayState offline cancels an in-flight closure', async () => {
  const { commands, socket, cleanup } = setup();
  const promise = commands.close(41, { outcome: 'inspected', technician: 'Test', notes: 'Bench check' });
  socket.deliver({ type: 'gatewayState', online: false, serverTs: 1000000, lastSeenTs: 1000000 });
  await expect(promise).rejects.toThrow('not confirmed'); cleanup();
});
test('LAN fallback uses the actual HTTP routes and does not send a relay token', async () => {
  const socket = new TestSocket();
  const conn = createConnection({ endpoints: [endpoint('http://192.168.1.5:8811', 'lan')], writeToken: 'remote-secret', socketFactory: () => socket });
  const fetcher = jest.fn(async (url: string | URL | Request, options?: RequestInit) => {
    if (String(url).includes('/api/history?')) return { ok: true, json: async () => ({ channel: 'temperature', unit: '°C', points: [] }) } as Response;
    expect(options?.headers).toEqual({ 'Content-Type': 'application/json' });
    return { ok: true, json: async () => ({ acked: 41 }) } as Response;
  });
  const commands = createCommands({ connection: conn, fetcher });
  conn.start(); socket.onopen?.(); socket.deliver(snapshot());
  await commands.history({ conveyor: 'CV-01', channel: 'temperature', minutes: 60 });
  await commands.ack(41, 'Technician');
  expect(String(fetcher.mock.calls[0][0])).toBe('http://192.168.1.5:8811/api/history?conveyor=CV-01&channel=temperature&minutes=60');
  expect(String(fetcher.mock.calls[1][0])).toBe('http://192.168.1.5:8811/api/alarms/41/ack');
  expect(fetcher.mock.calls[1][1]?.body).toBe('{"alarmId":41,"by":"Technician"}');
  commands.dispose(); conn.stop();
});
