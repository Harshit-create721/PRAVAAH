import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { RelayState } from './state.js';
import { Hub } from './hub.js';

const json = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};

export function createRelayServer({ publishSecret = null, writeToken = null, staleAfterMs } = {}) {
  const state = new RelayState({ staleAfterMs });
  const hub = new Hub({ state });

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://relay.local');

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
  // unrecognised is destroyed rather than silently becoming a subscriber.
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://relay.local');
    const token = url.searchParams.get('token');

    if (url.pathname === '/publish') {
      if (publishSecret && token !== publishSecret) {
        return rejectUpgrade(req, socket, head, 4001, 'unauthorized: invalid publish token');
      }
      return wss.handleUpgrade(req, socket, head, (ws) => attachPublisher(ws));
    }

    if (url.pathname === '/subscribe') {
      // Reads are open by design. A write token is only consulted for
      // ack/close; when none is configured, writes are open too.
      const canWrite = !writeToken || token === writeToken;
      return wss.handleUpgrade(req, socket, head, (ws) => attachSubscriber(ws, canWrite));
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
  function rejectUpgrade(req, socket, head, code, reason) {
    wss.handleUpgrade(req, socket, head, (ws) => ws.close(code, reason));
  }

  function attachPublisher(ws) {
    hub.attachPublisher(ws);
    ws.on('message', (data) => hub.handlePublisherMessage(data.toString()));
    ws.on('close', () => hub.detachPublisher(ws));
    ws.on('error', () => hub.detachPublisher(ws));
  }

  function attachSubscriber(ws, canWrite) {
    ws.on('message', (data) => hub.handleSubscriberMessage(ws, data.toString(), { canWrite }));
    ws.on('close', () => hub.removeSubscriber(ws));
    ws.on('error', () => hub.removeSubscriber(ws));
    // Deferred past the current I/O poll turn: writing the replay (cached
    // snapshot + gateway state) in the same synchronous turn that completes
    // the WS handshake lets the OS coalesce them with the handshake response
    // into a single read on the client. `ws` unshifts any such leftover bytes
    // and redelivers them via a `process.nextTick`, which beats the
    // `await once(ws, 'open')` continuation's microtask - so a client that
    // only attaches its 'message' listener after 'open' resolves loses the
    // first frame. `setImmediate`/`process.nextTick` stay within the same
    // loop iteration and don't help; a real timer forces a trip through the
    // timers phase, giving the client's socket a poll turn to read and
    // process the handshake on its own before the replay is sent.
    setTimeout(() => {
      if (ws.readyState === ws.OPEN) hub.addSubscriber(ws);
    }, 0);
  }

  return {
    server,
    hub,
    state,
    listen(port) {
      return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => server.close(() => resolve()));
      });
    },
  };
}
