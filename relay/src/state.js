// The relay's entire memory: the most recent snapshot, and whether the gateway
// that produced it is still connected.
//
// Nothing here is persisted. If the relay restarts, the gateway reconnects and
// republishes a full snapshot, so durability would buy nothing.

const DEFAULT_STALE_AFTER_MS = 15_000;

export class RelayState {
  #snapshot = null;
  #receivedTs = null;
  #online = false;
  #now;
  #staleAfterMs;

  // `now` is injected so staleness can be tested without elapsed real time.
  constructor({ now = () => Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
    this.#now = now;
    this.#staleAfterMs = staleAfterMs;
  }

  setSnapshot(snapshot) {
    this.#snapshot = snapshot;
    this.#receivedTs = this.#now();
  }

  publisherConnected() { this.#online = true; }
  publisherDisconnected() { this.#online = false; }

  get online() { return this.#online; }
  get lastSeenTs() { return this.#receivedTs; }

  // Two independent ways to be stale: the gateway is gone, or it is nominally
  // connected but has not produced a snapshot recently (a half-open socket).
  get stale() {
    if (!this.#online || this.#receivedTs === null) return true;
    return this.#now() - this.#receivedTs > this.#staleAfterMs;
  }

  // `serverTs` on every outbound message is what lets a client correct for
  // clock skew: it has no other way to know what "now" means to us.
  envelope() {
    if (this.#snapshot === null) return null;
    return {
      ...this.#snapshot,
      type: 'snapshot',
      serverTs: this.#now(),
      stale: this.stale,
      lastSeenTs: this.#receivedTs,
    };
  }

  gatewayStateMessage() {
    return {
      type: 'gatewayState',
      online: this.#online,
      lastSeenTs: this.#receivedTs,
      serverTs: this.#now(),
    };
  }
}
