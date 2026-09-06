import WebSocket from 'ws';

// Outbound client from the gateway to the public relay.
//
// The gateway dials OUT. That is the whole point: no port forwarding, no
// inbound firewall rule, no router access, and it works from behind any NAT or
// captive portal that permits outbound HTTPS.

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

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

  const target = secret ? `${url}?token=${encodeURIComponent(secret)}` : url;

  function connect() {
    if (stopped) return;
    socket = new WebSocket(target);

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
  }

  function scheduleReconnect() {
    if (stopped) return;
    const delay = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
    attempt++;
    timer = scheduleFn(connect, delay);
  }

  function send(message) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    try { socket.send(JSON.stringify(message)); return true; } catch { return false; }
  }

  return {
    start() { stopped = false; connect(); },
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
