import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeMessage } from './types';
import { DEFAULT_SETTINGS, endpoint, endpointsFor } from './discovery';
import { readSettings, saveSettings } from './credentials';
import { snapshot } from '../../tests/fixtures';

test('transport and domain have no React, native or Expo imports', () => {
  const offenders: string[] = [];
  for (const dir of ['src/gateway', 'src/domain']) for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    const path = join(entry.parentPath, entry.name);
    if (/(?:from\s*|require\s*\()\s*['"](?:react(?:-native)?(?:\/|['"])|expo(?:[-/]|['"]))/m.test(readFileSync(path, 'utf8'))) offenders.push(path);
  }
  expect(offenders).toEqual([]);
});
test('decodes actual LAN and relay envelopes, including all five freshness states', () => {
  const remote = snapshot(); expect(decodeMessage(JSON.stringify(remote))).toEqual(remote);
  const { serverTs, stale, lastSeenTs, ...lan } = remote;
  expect(decodeMessage(JSON.stringify(lan))).toEqual(remote);
  for (const state of ['live', 'stale', 'late', 'offline', 'never']) {
    const frame = snapshot(); frame.conveyors[0].channels.motor_rpm.state = state as 'live';
    expect(decodeMessage(JSON.stringify(frame))).not.toBeNull();
  }
});
test.each(['{broken', 'null', '[]', '{"type":"snapshot","conveyors":[null]}', '{"type":"alarm","alarm":{}}'])('rejects malformed wire payload %s', raw => {
  expect(decodeMessage(raw)).toBeNull();
});
test('rejects invalid nested channels before they reach the UI', () => {
  const frame = snapshot(); const malformed = { ...frame, conveyors: [{ ...frame.conveyors[0], channels: { speed: null } }] };
  expect(decodeMessage(JSON.stringify(malformed))).toBeNull();
});
test('normalizes secure relay and LAN paths', () => {
  expect(endpoint('https://relay.test', 'relay').url).toBe('wss://relay.test/subscribe');
  expect(endpoint('http://192.168.1.2:8811', 'lan').url).toBe('ws://192.168.1.2:8811/ws');
  expect(endpointsFor({ ...DEFAULT_SETTINGS, lanUrl: 'http://10.0.0.2:8811' })).toHaveLength(2);
});
test.each(['wss://relay.test?token=secret', 'wss://user:password@relay.test', 'http://public.test', 'https://relay.test/api/history', 'garbage'])('rejects unsafe or unusable endpoint %s', url => {
  expect(() => endpoint(url, 'relay')).toThrow();
});
test('missing credentials load read-only defaults and tokens use the storage adapter', async () => {
  let raw: string | null = null;
  const storage = { get: async () => raw, set: async (value: string) => { raw = value; } };
  expect((await readSettings(storage)).writeToken).toBe('');
  await saveSettings(storage, { ...DEFAULT_SETTINGS, writeToken: 'test-token' });
  expect((await readSettings(storage)).writeToken).toBe('test-token');
  expect((await readSettings(storage)).configured).toBe(true);
});
