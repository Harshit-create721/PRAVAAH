import { createConnection, backoff, type Socket } from './connection';
import { ServerClock } from '../domain/clock';
import { endpoint } from './discovery';
import { snapshot } from '../../tests/fixtures';

export class FakeSocket implements Socket {
  readyState = 0;
  onopen: Socket['onopen'] = null; onclose: Socket['onclose'] = null;
  onerror: Socket['onerror'] = null; onmessage: Socket['onmessage'] = null;
  sent: string[] = [];
  send(value: string) { this.sent.push(value); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  deliver(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
function setup(lan = false) {
  const sockets: FakeSocket[] = [];
  const factory = jest.fn((_url: string, _headers?: Record<string, string>) => { const socket = new FakeSocket(); sockets.push(socket); return socket; });
  const clock = new ServerClock();
  const conn = createConnection({ endpoints: [endpoint('wss://relay.test', 'relay'), ...(lan ? [endpoint('http://192.168.1.5:8811', 'lan')] : [])], writeToken: 'test-secret', socketFactory: factory, clock, random: () => 0.5 });
  conn.start();
  return { conn, sockets, factory, clock };
}
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(1000000); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
test('receives the initial snapshot and puts credentials in an Authorization header', () => {
  const { conn, sockets, factory, clock } = setup(); const received = jest.fn(); conn.onMessage(received);
  sockets[0].open(); sockets[0].deliver(snapshot(970000));
  expect(received).toHaveBeenCalledTimes(1); expect(clock.offsetMs).toBe(-30000); expect(conn.available).toBe(true);
  expect(factory.mock.calls[0]).toEqual(['wss://relay.test/subscribe', { Authorization: 'Bearer test-secret' }]);
  conn.stop();
});
test('backoff grows exponentially, has jitter and never exceeds the cap', () => {
  expect([0, 1, 2, 3].map(i => backoff(i, () => 0.5))).toEqual([1000, 2000, 4000, 8000]);
  expect(backoff(0, () => 0)).toBe(800); expect(backoff(0, () => 1)).toBe(1200); expect(backoff(40, () => 1)).toBe(30000);
});
test('failed connections back off and a valid response resets retry delay', () => {
  const { conn, sockets } = setup(); sockets[0].close(); jest.advanceTimersByTime(1000); expect(sockets).toHaveLength(2);
  sockets[1].close(); jest.advanceTimersByTime(1999); expect(sockets).toHaveLength(2); jest.advanceTimersByTime(1);
  sockets[2].open(); sockets[2].deliver(snapshot(Date.now())); sockets[2].close(); jest.advanceTimersByTime(1000); expect(sockets).toHaveLength(4); conn.stop();
});
test('stop cancels retries and late callbacks from old sockets', () => {
  const { conn, sockets } = setup(); const callback = sockets[0].onmessage;
  const receive = jest.fn(); conn.onMessage(receive); conn.stop(); callback?.({ data: JSON.stringify(snapshot()) });
  jest.advanceTimersByTime(120000); expect(sockets).toHaveLength(1); expect(receive).not.toHaveBeenCalled();
});
test('LAN fallback uses /ws and never receives the relay credential', () => {
  const { conn, sockets, factory } = setup(true);
  for (let i = 0; i < 3; i++) { sockets[i].close(); jest.advanceTimersByTime(1000 * 2 ** i); }
  expect(conn.endpoint.mode).toBe('lan'); expect(factory.mock.calls[3]).toEqual(['ws://192.168.1.5:8811/ws', undefined]); conn.stop();
});
test('a half-open socket becomes unavailable before its watchdog reconnects', () => {
  const { conn, sockets } = setup(); sockets[0].open(); sockets[0].deliver(snapshot());
  jest.advanceTimersByTime(15001); expect(conn.available).toBe(false);
  jest.advanceTimersByTime(10000); expect(conn.status).toBe('closed'); conn.stop();
});
test('gateway offline prevents commands immediately, malformed frames do not crash', () => {
  const { conn, sockets } = setup(); sockets[0].open(); sockets[0].deliver(snapshot());
  expect(() => sockets[0].onmessage?.({ data: '{broken' })).not.toThrow();
  sockets[0].deliver({ type: 'gatewayState', online: false, serverTs: 1000000, lastSeenTs: 999000 });
  expect(conn.available).toBe(false); conn.stop();
});
