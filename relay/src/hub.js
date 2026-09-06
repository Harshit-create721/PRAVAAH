// Publisher/subscriber registry, fan-out, and command correlation.
//
// Sockets here are duck-typed as { send(text), close?(code, reason),
// bufferedAmount? }. That is deliberate: none of the logic in this file needs
// a real network, so all of it tests in milliseconds without one.

// A subscriber this far behind is not going to catch up on a snapshot that is
// about to be superseded anyway. Alarms ignore this - they are rare, discrete,
// and losing one is the failure the whole system exists to prevent.
const SLOW_CLIENT_BYTES = 1_000_000;

// Every command a subscriber sends costs the GATEWAY work, and `history` in
// particular is a synchronous SQLite query on the gateway's event loop. An
// unthrottled anonymous client could therefore starve MQTT ingest, the local
// dashboard socket and the snapshot heartbeat from the public internet. The
// relay must never be able to degrade the gateway, so the throttle lives here,
// at the boundary, rather than relying on the gateway to defend itself.
const COMMAND_RATE_PER_SEC = 5;
const COMMAND_BURST = 10;

// A subscriber may not have more than this many commands outstanding at once.
// Rate limiting alone does not bound concurrent work: a client can stay under
// 5/s forever while the gateway falls further behind.
const MAX_INFLIGHT_PER_SOCKET = 8;

// `id` is chosen by the client and is echoed back, so it is attacker-controlled
// memory. Real ids are UUIDs or short counters.
const MAX_COMMAND_ID_LENGTH = 64;

export class Hub {
  #state;
  #now;
  #publisher = null;
  // socket -> { tokens, lastRefillTs, inflight:Set<relayId> }
  #subscribers = new Map();
  // relay-generated id -> { socket, clientId }
  //
  // Keyed on an id WE mint, never on the client's. Two subscribers that both
  // pick id "1" must not be able to steal or strand each other's results.
  #pending = new Map();
  #commandSeq = 0;

  constructor({ state, now = () => Date.now() }) {
    this.#state = state;
    this.#now = now;
  }

  get subscriberCount() { return this.#subscribers.size; }

  // Newest publisher wins. A half-open socket left behind by a dropped mobile
  // connection must never lock the real gateway out.
  attachPublisher(socket) {
    const previous = this.#publisher;
    this.#publisher = socket;
    this.#state.publisherConnected();
    if (previous && previous !== socket) {
      try { previous.close?.(4000, 'replaced by newer publisher'); } catch { /* already gone */ }
    }
    this.#broadcast(this.#state.gatewayStateMessage());
    return previous;
  }

  // Returns true only if this socket was the live publisher. A late close event
  // from a displaced socket must not mark the current gateway offline.
  detachPublisher(socket) {
    if (this.#publisher !== socket) return false;
    this.#publisher = null;
    this.#state.publisherDisconnected();

    for (const { socket: sub, clientId } of this.#pending.values()) {
      this.#sendTo(sub, { type: 'commandResult', id: clientId, ok: false, error: 'gateway disconnected' });
    }
    this.#pending.clear();
    for (const record of this.#subscribers.values()) record.inflight.clear();

    this.#broadcast(this.#state.gatewayStateMessage());
    return true;
  }

  addSubscriber(socket) {
    this.#recordFor(socket);
    const envelope = this.#state.envelope();
    if (envelope) this.#sendTo(socket, envelope);
    this.#sendTo(socket, this.#state.gatewayStateMessage());
  }

  removeSubscriber(socket) {
    const record = this.#subscribers.get(socket);
    if (record) for (const relayId of record.inflight) this.#pending.delete(relayId);
    this.#subscribers.delete(socket);
  }

  handlePublisherMessage(raw) {
    const msg = parse(raw);
    if (!msg) return;

    if (msg.type === 'snapshot') {
      this.#state.setSnapshot(msg);
      const envelope = this.#state.envelope();
      if (envelope) this.#broadcast(envelope, { droppable: true });
      return;
    }

    if (msg.type === 'alarm') {
      // An alarm with no body is not an alarm. Forwarding `{type:'alarm'}`
      // makes every client that reads `alarm.alarm.level` throw, and alarms are
      // the one message class this system must never mishandle.
      if (!msg.alarm || typeof msg.alarm !== 'object') return;
      this.#broadcast({ type: 'alarm', alarm: msg.alarm, serverTs: this.#state.gatewayStateMessage().serverTs });
      return;
    }

    if (msg.type === 'commandResult' && typeof msg.id === 'string') {
      const waiting = this.#pending.get(msg.id);
      if (!waiting) return;
      this.#pending.delete(msg.id);
      this.#subscribers.get(waiting.socket)?.inflight.delete(msg.id);
      // Translate our id back to the one the client correlates on.
      this.#sendTo(waiting.socket, { ...msg, id: waiting.clientId });
    }
  }

  handleSubscriberMessage(socket, raw, { canWrite }) {
    const msg = parse(raw);
    if (!msg || msg.type !== 'command' || typeof msg.id !== 'string') return;

    if (msg.id.length > MAX_COMMAND_ID_LENGTH) {
      // Echo back a truncated id rather than the attacker's whole string.
      this.#sendTo(socket, {
        type: 'commandResult', id: msg.id.slice(0, MAX_COMMAND_ID_LENGTH),
        ok: false, error: `command id too long (max ${MAX_COMMAND_ID_LENGTH})`,
      });
      return;
    }

    const record = this.#recordFor(socket);

    if (!this.#takeToken(record)) {
      this.#sendTo(socket, { type: 'commandResult', id: msg.id, ok: false, error: 'rate limit exceeded' });
      return;
    }

    const isWrite = msg.action === 'ack' || msg.action === 'close';
    if (isWrite && !canWrite) {
      this.#sendTo(socket, { type: 'commandResult', id: msg.id, ok: false, error: 'unauthorized: write token required' });
      return;
    }

    if (!this.#publisher) {
      this.#sendTo(socket, { type: 'commandResult', id: msg.id, ok: false, error: 'gateway not connected' });
      return;
    }

    if (record.inflight.size >= MAX_INFLIGHT_PER_SOCKET) {
      this.#sendTo(socket, {
        type: 'commandResult', id: msg.id, ok: false,
        error: `too many commands in flight (max ${MAX_INFLIGHT_PER_SOCKET})`,
      });
      return;
    }

    const relayId = `r${++this.#commandSeq}`;
    this.#pending.set(relayId, { socket, clientId: msg.id });
    record.inflight.add(relayId);
    this.#sendTo(this.#publisher, { type: 'command', id: relayId, action: msg.action, payload: msg.payload ?? {} });
  }

  // Re-states the current view to everyone already connected. Called by the
  // heartbeat while the gateway looks stale: a subscriber that connected while
  // things were healthy would otherwise never hear about a half-open gateway,
  // and its last message said `stale:false`.
  broadcastCurrentState() {
    const envelope = this.#state.envelope();
    if (envelope) this.#broadcast(envelope, { droppable: true });
    this.#broadcast(this.#state.gatewayStateMessage());
  }

  #recordFor(socket) {
    let record = this.#subscribers.get(socket);
    if (!record) {
      record = { tokens: COMMAND_BURST, lastRefillTs: this.#now(), inflight: new Set() };
      this.#subscribers.set(socket, record);
    }
    return record;
  }

  // Token bucket: `COMMAND_BURST` immediately, refilling at
  // `COMMAND_RATE_PER_SEC`. Cheap, allocation-free, and it lets a phone opening
  // a screen fire several reads at once without being punished for it.
  #takeToken(record) {
    const now = this.#now();
    const elapsed = Math.max(0, now - record.lastRefillTs);
    record.lastRefillTs = now;
    record.tokens = Math.min(COMMAND_BURST, record.tokens + (elapsed / 1000) * COMMAND_RATE_PER_SEC);
    if (record.tokens < 1) return false;
    record.tokens -= 1;
    return true;
  }

  #broadcast(message, { droppable = false } = {}) {
    for (const socket of this.#subscribers.keys()) {
      if (droppable && (socket.bufferedAmount ?? 0) > SLOW_CLIENT_BYTES) continue;
      this.#sendTo(socket, message);
    }
  }

  // A send that throws (socket closed between iteration and write) must not
  // abort the fan-out to everyone else.
  #sendTo(socket, message) {
    try { socket.send(JSON.stringify(message)); } catch { /* client is gone */ }
  }
}

function parse(raw) {
  try {
    const msg = JSON.parse(raw);
    return msg && typeof msg === 'object' ? msg : null;
  } catch {
    return null;
  }
}

export const LIMITS = {
  COMMAND_RATE_PER_SEC,
  COMMAND_BURST,
  MAX_INFLIGHT_PER_SOCKET,
  MAX_COMMAND_ID_LENGTH,
  SLOW_CLIENT_BYTES,
};
