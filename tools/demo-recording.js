#!/usr/bin/env node
// One-command BeltData playback. Separate ports/database; never enables relay.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import config from '../server/config.js';

const root = join(import.meta.dirname, '..');
const directory = join(root, 'BeltData', '2026-09-06T17-29-57.647Z-a70e3e55-cleaned-v1');
if (!existsSync(join(directory, 'telemetry.frames.jsonl'))) throw new Error(`Recording missing: ${directory}`);
config.relay.enabled = false;
config.http = { host: '127.0.0.1', port: 8812 };
config.mqtt = { embedded: true, host: '127.0.0.1', port: 1884, url: 'mqtt://127.0.0.1:1884' };
config.storage.file = 'data/replay-animation.db';
config.siteLabel = 'Pilot test rig · recorded playback';
// Refuse an occupied port before importing the gateway or opening its database.
await Promise.all([8812, 1884].map(port => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', () => reject(new Error(`Playback port ${port} is in use. Stop the earlier playback first.`)));
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
})));
await import('../server/index.js');
for (let attempt = 0; attempt < 100; attempt++) {
  try { const response = await fetch('http://127.0.0.1:8812/api/state'); if (response.ok) break; } catch {}
  if (attempt === 99) throw new Error('Playback gateway did not start');
  await new Promise(resolve => setTimeout(resolve, 100));
}
console.log('\n[playback] Open http://localhost:8812 — BeltData loops continuously at original speed. Ctrl+C stops both processes.\n');
const replay = spawn(process.execPath, [join(import.meta.dirname, 'replay-recording.js'),
  '--dir', directory, '--mqtt', config.mqtt.url, '--speed', '1', '--gap', '3', '--loop'],
{ cwd: root, stdio: 'inherit', windowsHide: true });
replay.on('error', error => { console.error(`[playback] ${error.message}`); process.exit(1); });
replay.on('exit', code => console.log(`[playback] Recording ended (${code ?? 'stopped'}). Dashboard remains available; restart this command to play again.`));
process.on('exit', () => replay.kill());
