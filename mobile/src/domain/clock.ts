/** Relay time and gateway time use separate instances: either host can have clock skew. */
export class ServerClock {
  private offset = 0;
  constructor(private localNow: () => number = Date.now) {}
  observe(serverTs: number) { if (Number.isFinite(serverTs)) this.offset = serverTs - this.localNow(); }
  get offsetMs() { return this.offset; }
  now() { return this.localNow() + this.offset; }
  ageOf(ts: number | null | undefined): number | null {
    return ts == null || !Number.isFinite(ts) ? null : Math.max(0, this.now() - ts);
  }
}
