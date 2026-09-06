import { createRelayServer } from './server.js';

const PORT = Number(process.env.PORT ?? 3040);
const HOST = process.env.HOST ?? '127.0.0.1';
const publishSecret = process.env.RELAY_PUBLISH_SECRET || null;
const writeToken = process.env.RELAY_WRITE_TOKEN || null;

// Anything that is not loopback is reachable by something other than this
// process - in production that is the container bind (0.0.0.0) sitting behind a
// public Caddy vhost. An open /publish endpoint on a public address is not a
// degraded mode, it is a takeover: newest-publisher-wins hands an anonymous
// caller the gateway's role, so it can inject fabricated snapshots and alarms
// and read every subscriber's command traffic. Fail closed instead.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
if (!LOOPBACK.has(HOST) && !publishSecret) {
  console.error(`[relay] FATAL: HOST is ${HOST} (not loopback) but RELAY_PUBLISH_SECRET is not set.`);
  console.error('[relay] Refusing to serve an unauthenticated /publish endpoint on a reachable address.');
  console.error('[relay] Set RELAY_PUBLISH_SECRET (see deploy/.env.example), or bind HOST=127.0.0.1.');
  process.exit(1);
}

// Last line of defence. The relay is a public endpoint on a droplet shared with
// five production services; an unhandled throw from any library callback must
// degrade one request, not stop answering altogether. Every known crash path
// has a specific fix - this exists so the NEXT unknown one is a log line.
process.on('uncaughtException', (err) => {
  console.error('[relay] uncaught exception (continuing):', err?.stack ?? err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[relay] unhandled rejection (continuing):', reason?.stack ?? reason);
});

const relay = createRelayServer({ publishSecret, writeToken });

const port = await relay.listen(PORT, HOST);
console.log(`[relay] listening on ${HOST}:${port}`);
console.log(`[relay] publish secret ${publishSecret ? 'set' : 'NOT set'}`);
console.log(`[relay] write token ${writeToken ? 'set (writes gated)' : 'NOT set (writes open)'}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log('[relay] shutting down');
    await relay.close();
    process.exit(0);
  });
}
