#!/usr/bin/env node
/* ============================================================================
   OFFLINE GATEWAY - for UI checks and recording replays
   ----------------------------------------------------------------------------
   Starts the normal gateway (server/index.js) with two overrides, without
   editing server/config.js:
     - relay OFF: nothing is published to the public relay
     - a separate database (default data/replay.db), so data/beltguard.db is
       never polluted by replayed or test data

     node tools/gateway-offline.js                     # data/replay.db
     node tools/gateway-offline.js --db data/ui-test.db
     node tools/gateway-offline.js --fresh             # delete that db first

   Then, in a second terminal:
     node tools/replay-recording.js --dir BeltData/<session>-cleaned-v1
   ==========================================================================*/

import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : (args[i + 1]?.startsWith('--') ? true : args[i + 1] ?? true);
};

const ROOT = resolve(import.meta.dirname, '..');
const db = String(flag('db', 'data/replay.db'));
if (resolve(ROOT, db) === resolve(ROOT, 'data/beltguard.db')) {
  console.error('Refusing to use data/beltguard.db; this launcher exists to keep that file clean.');
  process.exit(2);
}
if (args.includes('--fresh')) {
  for (const f of [db, `${db}-wal`, `${db}-shm`]) {
    const p = resolve(ROOT, f);
    if (existsSync(p)) rmSync(p);
  }
}

const { default: config } = await import('../server/config.js');
config.relay.enabled = false;
config.storage.file = db;
console.log(`[offline] relay disabled; database ${resolve(ROOT, db)}`);
await import('../server/index.js');
