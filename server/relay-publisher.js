import WebSocket from 'ws';

// Outbound client from the gateway to the public relay.
//
// The gateway dials OUT. That is the whole point: no port forwarding, no
// inbound firewall rule, no router access, and it works from behind any NAT or
// captive portal that permits outbound HTTPS.
//
// Nothing in this file may ever be able to stop the gateway. The local
// dashboard working with no internet at all is the property the whole product
// rests on; the relay is an addition to it, never a dependency of it.

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

// Mirrors the relay's own slow-client guard. A relay socket that is open but
// not draining (a stalled TCP connection, a wedged proxy) would otherwise
// accumulate one snapshot every 2 s in the laptop's heap, without bound.
export const SLOW_SOCKET_BYTES = 1_000_000;

// Snapshots are superseded every 2 s, so dropping one costs nothing. Alarms and
// command results are not: an alarm is discrete and losing one is the failure
// this system exists to prevent, and a dropped result strands a caller.
export function droppableUnderBackpressure(message, bufferedAmount) {
  return message?.type === 'snapshot' && (bufferedAmount ?? 0) > SLOW_SOCKET_BYTES;
}

export function createRelayPublisher({
  url,
  secret = null,
  onCommand,
  log = console.log,
  scheduleFn = setTimeout,
}) {
  let socket = null;
  let stopped = false;
  let attempt = 0;
  let timer = null;

  // The credential travels as an Authorization header, not a query parameter:
  // query strings are logged verbatim by every reverse proxy in the path.
  const options = secret ? { headers: { authorization: `Bearer ${secret}` } } : undefined;

  function connect() {
    if (stopped) return;
    // `new WebSocket(url)` throws SYNCHRONOUSLY on a malformed URL. This runs
    // at gateway boot and again from the reconnect timer, so an unguarded throw
    // here means one bad config value stops the local dashboard from ever
    // starting. Retry instead - the operator sees the log, the plant keeps its
    // display.
    try {
      socket = new WebSocket(url, options);

      socket.on('open', () => {
        attempt = 0;
        log(`[relay] connected to ${url}`);
      });

      socket.on('message', async (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg?.type !== 'command' || typeof msg.id !== 'string') return;

        // A failing command must come back as a result, never as an unhandled
        // rejection that takes the gateway down.
        try {
          const result = await onCommand({ action: msg.action, payload: msg.payload ?? {} });
          send({ type: 'commandResult', id: msg.id, ok: true, result });
        } catch (err) {
          send({ type: 'commandResult', id: msg.id, ok: false, error: String(err?.message ?? err) });
        }
      });

      socket.on('close', () => {
        socket = null;
        scheduleReconnect();
      });

      // 'error' is always followed by 'close', so reconnection is handled there.
      socket.on('error', (err) => log(`[relay] ${err.message}`));
    } catch (err) {
      socket = null;
      log(`[relay] cannot connect to ${url}: ${err?.message ?? err}`);
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (stopped) return;
    const delay = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
    attempt++;
    timer = scheduleFn(connect, delay);
  }

  function send(message) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    if (droppableUnderBackpressure(message, socket.bufferedAmount)) return false;
    try { socket.send(JSON.stringify(message)); return true; } catch { return false; }
  }

  return {
    start() {
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      try { socket?.close(); } catch { /* already closing */ }
      socket = null;
    },
    send,
    get connected() { return socket?.readyState === WebSocket.OPEN; },
  };
}
