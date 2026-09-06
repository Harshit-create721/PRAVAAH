import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { RelayState } from './state.js';
import { Hub } from './hub.js';

// The largest legitimate subscriber message is a small command envelope. ws
// defaults to 100 MiB, which against a 128 MB container with no swap is a
// single-frame OOM kill of a box that hosts five other production services.
const SUBSCRIBER_MAX_PAYLOAD = 64 * 1024;

// The publisher is authenticated (see index.js, which refuses to serve an
// exposed bind without a secret) and its `history` command results can carry
// several minutes of telemetry, so it gets a larger - but still bounded - cap.
const PUBLISHER_MAX_PAYLOAD = 4 * 1024 * 1024;

// A public read endpoint with no ceiling is an unbounded Set on a 128 MB box.
const MAX_SUBSCRIBERS = 200;

// Without this, a laptop that drops off the network without sending a FIN is
// never noticed: the relay keeps reporting the gateway online and already-
// connected subscribers keep their last `stale:false` snapshot forever.
const HEARTBEAT_MS = 10_000;
const MISSED_PONG_LIMIT = 2;

const json = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};

// Constant-time comparison so a token cannot be recovered a byte at a time.
// Length is compared first and therefore leaks; that is inherent to comparing
// strings of unequal length and is not the part worth defending.
function secretEquals(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Tokens in a query string end up in every proxy access log verbatim. The
// header is the correct place for a credential; the query parameter is kept
// only so an older client keeps working.
function credentialFrom(req, url) {
  const header = req.headers?.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1];
  }
  return url.searchParams.get('token');
}

export function createRelayServer({
  publishSecret = null,
  writeToken = null,
  staleAfterMs,
  heartbeatMs = HEARTBEAT_MS,
  maxSubscribers = MAX_SUBSCRIBERS,
} = {}) {
  const state = new RelayState({ staleAfterMs });
  const hub = new Hub({ state });

  const server = createServer((req, res) => {
    // Node's HTTP parser accepts request targets that WHATWG `URL` rejects
    // ("//[", "//user:pass@[bad"). Unguarded, those throw out of this callback
    // and take the process down.
    let url;
    try {
      url = new URL(req.url, 'http://relay.local');
    } catch {
      return json(res, 400, { error: 'bad request target' });
    }

    if (url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        gatewayOnline: state.online,
        stale: state.stale,
        lastSeenTs: state.lastSeenTs,
        subscribers: hub.subscriberCount,
      });
    }

    if (url.pathname === '/state') {
      const envelope = state.envelope();
      // 503 rather than an empty 200: "no gateway has ever published" is not a
      // successful read of an empty machine.
      if (!envelope) return json(res, 503, { error: 'no snapshot yet' });
      return json(res, 200, envelope);
    }

    return json(res, 404, { error: 'not found' });
  });

  // noServer + manual upgrade so the path decides the role, and anything
  // unrecognised is destroyed rather than silently becoming a subscriber. Two
  // servers rather than one purely so the payload ceiling can differ by role.
  const subscriberWss = new WebSocketServer({ noServer: true, maxPayload: SUBSCRIBER_MAX_PAYLOAD });
  const publisherWss = new WebSocketServer({ noServer: true, maxPayload: PUBLISHER_MAX_PAYLOAD });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://relay.local');
    } catch {
      // No HTTP response is possible on a path we could not even parse.
      return socket.destroy();
    }
    const token = credentialFrom(req, url);

    if (url.pathname === '/publish') {
      if (publishSecret && !secretEquals(token, publishSecret)) {
        return rejectUpgrade(req, socket, head, 4001, 'unauthorized: invalid publish token');
      }
      return publisherWss.handleUpgrade(req, socket, head, (ws) => attachPublisher(ws));
    }

    if (url.pathname === '/subscribe') {
      if (hub.subscriberCount >= maxSubscribers) {
        return rejectUpgrade(req, socket, head, 4009, 'too many subscribers');
      }
      // Reads are open by design. A write token is only consulted for
      // ack/close; when none is configured, writes are open too.
      const canWrite = !writeToken || secretEquals(token, writeToken);
      return subscriberWss.handleUpgrade(req, socket, head, (ws) => attachSubscriber(ws, canWrite));
    }

    return rejectUpgrade(req, socket, head, 4004, 'not found');
  });

  // Completes the WS opening handshake and immediately closes it with an
  // application close code, instead of `socket.destroy()`-ing a half-open
  // connection. The socket is never handed to the hub, so it never functions
  // as a publisher or subscriber either way - but a raw destroy makes `ws`
  // emit an 'error' before 'close' on the client (confirmed against ws's own
  // source: a failed opening handshake always routes through
  // `emitErrorAndClose`), and `events.once()` installs its own 'error'
  // listener that rejects the pending promise on ANY prior 'error' event,
  // even with a no-op listener already attached. Finishing the handshake and
  // closing cleanly with a code produces an ordinary 'close' with no 'error',
  // which is what a caller using `await once(ws, 'close')` needs to observe.
  //
  // The 'error' listener is not optional. Between the 101 and the client's
  // close handshake the socket is a live WebSocket, so a rejected client can
  // still push raw frames at it - and an unmasked or otherwise malformed frame
  // makes ws emit 'error'. On an EventEmitter with no 'error' listener that
  // THROWS, which killed the whole relay with five bytes from an anonymous,
  // unauthenticated client.
  function rejectUpgrade(req, socket, head, code, reason) {
    subscriberWss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => { /* rejected client; nothing left to salvage */ });
      ws.close(code, reason);
    });
  }

  function attachPublisher(ws) {
    trackLiveness(ws);
    hub.attachPublisher(ws);
    ws.on('message', (data) => hub.handlePublisherMessage(data.toString()));
    ws.on('close', () => { missedPongs.delete(ws); hub.detachPublisher(ws); });
    ws.on('error', () => { missedPongs.delete(ws); hub.detachPublisher(ws); });
  }

  function attachSubscriber(ws, canWrite) {
    trackLiveness(ws);
    hub.addSubscriber(ws);
    ws.on('message', (data) => hub.handleSubscriberMessage(ws, data.toString(), { canWrite }));
    ws.on('close', () => { missedPongs.delete(ws); hub.removeSubscriber(ws); });
    ws.on('error', () => { missedPongs.delete(ws); hub.removeSubscriber(ws); });
  }

  const missedPongs = new Map();

  function trackLiveness(ws) {
    missedPongs.set(ws, 0);
    ws.on('pong', () => { if (missedPongs.has(ws)) missedPongs.set(ws, 0); });
  }

  function sweep() {
    for (const wss of [publisherWss, subscriberWss]) {
      for (const ws of wss.clients) {
        const missed = (missedPongs.get(ws) ?? 0) + 1;
        if (missed > MISSED_PONG_LIMIT) {
          // A socket this far gone is not coming back. terminate() fires
          // 'close', which is what tells the hub the gateway is offline and
          // frees the subscriber slot.
          missedPongs.delete(ws);
          try { ws.terminate(); } catch { /* already gone */ }
          continue;
        }
        missedPongs.set(ws, missed);
        try { ws.ping(); } catch { /* already gone */ }
      }
    }

    // Belt and braces for the half-open gateway: `stale` is computed correctly
    // for /health, /state and new subscribers, but an ALREADY-connected
    // subscriber last heard `stale:false` and would sit on frozen numbers that
    // look live. Re-stating the current view is the whole point of the relay.
    if (state.stale) hub.broadcastCurrentState();
  }

  let heartbeat = null;

  return {
    server,
    hub,
    state,
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          heartbeat = setInterval(sweep, heartbeatMs);
          // Never hold the process open on the heartbeat alone.
          heartbeat.unref?.();
          resolve(server.address().port);
        });
      });
    },
    close() {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      missedPongs.clear();
      return new Promise((resolve) => {
        for (const wss of [publisherWss, subscriberWss]) {
          for (const client of wss.clients) client.terminate();
        }
        publisherWss.close(() => subscriberWss.close(() => server.close(() => resolve())));
      });
    },
  };
}
