// Publisher/subscriber registry, fan-out, and command correlation.
//
// Sockets here are duck-typed as { send(text), close?(code, reason),
// bufferedAmount? }. That is deliberate: none of the logic in this file needs
// a real network, so all of it tests in milliseconds without one.

// A subscriber this far behind is not going to catch up on a snapshot that is
// about to be superseded anyway. Alarms ignore this - they are rare, discrete,
// and losing one is the failure the whole system exists to prevent.
const SLOW_CLIENT_BYTES = 1_000_000;

export class Hub {
  #state;
  #publisher = null;
  #subscribers = new Set();
  #pending = new Map();   // command id -> subscriber socket

  constructor({ state }) {
    this.#state = state;
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

    for (const [id, sub] of this.#pending) {
      this.#sendTo(sub, { type: 'commandResult', id, ok: false, error: 'gateway disconnected' });
    }
    this.#pending.clear();

    this.#broadcast(this.#state.gatewayStateMessage());
    return true;
  }

  addSubscriber(socket) {
    this.#subscribers.add(socket);
    const envelope = this.#state.envelope();
    if (envelope) this.#sendTo(socket, envelope);
    this.#sendTo(socket, this.#state.gatewayStateMessage());
  }

  removeSubscriber(socket) {
    this.#subscribers.delete(socket);
    for (const [id, sub] of this.#pending) {
      if (sub === socket) this.#pending.delete(id);
    }
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
      this.#broadcast({ type: 'alarm', alarm: msg.alarm, serverTs: this.#state.gatewayStateMessage().serverTs });
      return;
    }

    if (msg.type === 'commandResult' && typeof msg.id === 'string') {
      const waiting = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (waiting) this.#sendTo(waiting, msg);
    }
  }

  handleSubscriberMessage(socket, raw, { canWrite }) {
    const msg = parse(raw);
    if (!msg || msg.type !== 'command' || typeof msg.id !== 'string') return;

    const isWrite = msg.action === 'ack' || msg.action === 'close';
    if (isWrite && !canWrite) {
      this.#sendTo(socket, { type: 'commandResult', id: msg.id, ok: false, error: 'unauthorized: write token required' });
      return;
    }

    if (!this.#publisher) {
      this.#sendTo(socket, { type: 'commandResult', id: msg.id, ok: false, error: 'gateway not connected' });
      return;
    }

    this.#pending.set(msg.id, socket);
    this.#sendTo(this.#publisher, { type: 'command', id: msg.id, action: msg.action, payload: msg.payload ?? {} });
  }

  #broadcast(message, { droppable = false } = {}) {
    for (const socket of this.#subscribers) {
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
