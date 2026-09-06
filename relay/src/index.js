import { createRelayServer } from './server.js';

const PORT = Number(process.env.PORT ?? 3040);
const relay = createRelayServer({
  publishSecret: process.env.RELAY_PUBLISH_SECRET || null,
  writeToken: process.env.RELAY_WRITE_TOKEN || null,
});

const port = await relay.listen(PORT);
console.log(`[relay] listening on 127.0.0.1:${port}`);
console.log(`[relay] publish secret ${process.env.RELAY_PUBLISH_SECRET ? 'set' : 'NOT set'}`);
console.log(`[relay] write token ${process.env.RELAY_WRITE_TOKEN ? 'set (writes gated)' : 'NOT set (writes open)'}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log('[relay] shutting down');
    await relay.close();
    process.exit(0);
  });
}
