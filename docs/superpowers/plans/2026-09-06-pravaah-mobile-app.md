# PRAVAAH Mobile App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **STATUS: NOT EXECUTED.** This plan is written and reviewed but no code has been
> written against it. Plan 1 (the relay) is complete, merged and deployed; this is
> the client that consumes it.

**Goal:** An Android app showing live conveyor state from the PRAVAAH gateway, raising a phone notification the moment a rule breaches, and letting an operator acknowledge and close alarms from the plant floor.

**Architecture:** React Native (Expo, TypeScript) talking to the deployed relay at `wss://api.sih.shubhang.dev/subscribe`. The transport and domain layers import nothing from React, so the logic that carries the real risk — reconnect, clock skew, staleness, alarm de-duplication — is tested in Node with no emulator. A foreground service holds the socket open so alarms arrive with the app backgrounded.

**Tech Stack:** Expo (dev build, not Expo Go — Expo Go cannot host a foreground service), TypeScript, Zustand, `expo-notifications`, `expo-secure-store`, Jest + React Native Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-06-pravaah-mobile-app-design.md`

**Depends on:** `docs/superpowers/plans/2026-09-06-pravaah-relay.md` (complete). The relay's protocol is settled and live; verify against it rather than mocking assumptions.

## Global Constraints

- TypeScript strict mode. No `any` in `gateway/` or `domain/`.
- `src/gateway/` and `src/domain/` MUST NOT import from `react`, `react-native`, or any Expo package. This is what lets them run under Jest in Node. A violation is a spec failure, not a style note.
- Relay base URL: `wss://api.sih.shubhang.dev` — reads need no credential.
- Writes (`ack`, `close`) require `RELAY_WRITE_TOKEN` as `Authorization: Bearer <token>`. `history` is a read and is never gated.
- The relay rate-limits each socket to **5 commands/sec, burst 10**, at most **8 in flight**, command ids **≤64 chars**, and frames **≤64 KB**. The client must respect these rather than discover them.
- A channel with no value renders `NO SIGNAL`. Never `0`, never `—`, never a blank that could read as zero.
- Never present stale data as live. When `stale: true` or `gatewayOnline: false`, values are visibly degraded and labelled with their age.
- Ages are computed against `serverTs`, never the phone's raw clock.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `app/` | Expo Router screens — thin, presentational |
| `src/gateway/types.ts` | Wire types: `Snapshot`, `AlarmEvent`, `GatewayState`, `CommandResult` |
| `src/gateway/connection.ts` | WS lifecycle, backoff reconnect, typed event emitter. No React. |
| `src/gateway/commands.ts` | Relayed commands (`history`/`ack`/`close`), correlation, timeouts, client-side rate limiting. No React. |
| `src/domain/clock.ts` | Server-time offset from `serverTs`; all age arithmetic |
| `src/domain/staleness.ts` | Channel and node state from timestamps + freshness windows |
| `src/domain/alarms.ts` | De-duplication by id, severity ordering, open vs closed |
| `src/domain/format.ts` | Units, decimals, `NO SIGNAL` |
| `src/store/useRelay.ts` | Zustand store: latest snapshot, connection status, alarms |
| `src/notifications/notifier.ts` | `AlarmEvent` → local notification, deduped by alarm id |
| `src/notifications/service.ts` | Foreground service lifecycle |
| `src/ui/components/` | `ChannelTile`, `AlarmCard`, `NodeBadge`, `Sparkline` |

---

## Task 1: Scaffold and the no-React boundary

**Files:**
- Create: `mobile/` (Expo TypeScript app), `mobile/jest.config.js`, `mobile/src/gateway/types.ts`
- Test: `mobile/src/gateway/types.test.ts`

**Interfaces:**
- Produces: the wire types every later task consumes. Copy them from the live contract, not from memory — `curl https://api.sih.shubhang.dev/state` and `GET /api/contract` on the gateway are the sources of truth.

- [ ] **Step 1: Create the Expo app with TypeScript**

```bash
npx create-expo-app@latest mobile --template blank-typescript
cd mobile && npx expo install expo-notifications expo-secure-store zustand
npm i -D jest @types/jest ts-jest @testing-library/react-native
```

- [ ] **Step 2: Add a Jest config that runs the pure layers in Node**

`mobile/jest.config.js`:

```js
// Two projects on purpose. The gateway/domain layers have no React in them and
// run in plain Node in milliseconds; only the UI needs the react-native preset,
// which is an order of magnitude slower to boot.
module.exports = {
  projects: [
    {
      displayName: 'logic',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/{gateway,domain}/**/*.test.ts'],
    },
    {
      displayName: 'ui',
      preset: 'jest-expo',
      testMatch: ['<rootDir>/src/ui/**/*.test.tsx', '<rootDir>/app/**/*.test.tsx'],
    },
  ],
};
```

- [ ] **Step 3: Write the failing boundary test**

`mobile/src/gateway/types.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// This is the architectural constraint that makes everything else testable.
// Enforce it with a test rather than a convention nobody re-reads.
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => join(e.parentPath ?? dir, e.name));
}

test('gateway and domain layers import no React or React Native', () => {
  const offenders: string[] = [];
  for (const dir of ['src/gateway', 'src/domain']) {
    for (const file of sourceFiles(dir)) {
      const src = readFileSync(file, 'utf8');
      if (/from\s+['"](react|react-native|expo[-/]?)/.test(src)) offenders.push(file);
    }
  }
  expect(offenders).toEqual([]);
});
```

- [ ] **Step 4: Run it, confirm it fails** (`src/domain` does not exist yet)

Run: `cd mobile && npx jest --selectProjects logic`
Expected: FAIL — `ENOENT: no such file or directory, scandir 'src/domain'`

- [ ] **Step 5: Create `src/gateway/types.ts` and an empty `src/domain/.gitkeep`**

```ts
// Wire types. Mirrors what the relay actually sends — verify against
// `curl https://api.sih.shubhang.dev/state` rather than trusting this comment.

export interface ChannelValue {
  value: number | null;
  unit: string;
  label: string;
  group: string;
  state: 'live' | 'late' | 'stale' | 'never';
  ts: number | null;
  node: string | null;
}

export interface Conveyor {
  id: string;
  label: string;
  risk: string;
  operating_state: string;
  channels: Record<string, ChannelValue>;
  nodes?: NodeStatus[];
  alarms?: Alarm[];
  joints?: unknown[];
}

export interface NodeStatus {
  node: string;
  state: 'live' | 'stale' | 'offline';
  ts: number | null;
  health: Record<string, string> | null;
}

export interface Alarm {
  id: number;
  ts: number;
  conveyor: string;
  level: string;
  family: string;
  message: string;
  /** JSON string: { rule, source, measured }. Parse it; never show a bare claim. */
  evidence: string;
}

export interface Snapshot {
  type: 'snapshot';
  serverTs: number;
  stale: boolean;
  lastSeenTs: number | null;
  conveyors: Conveyor[];
  nodes?: NodeStatus[];
}

export interface AlarmEvent { type: 'alarm'; serverTs: number; alarm: Alarm; }
export interface GatewayStateMsg { type: 'gatewayState'; online: boolean; lastSeenTs: number | null; serverTs: number; }
export interface CommandResult { type: 'commandResult'; id: string; ok: boolean; result?: unknown; error?: string; }

export type RelayMessage = Snapshot | AlarmEvent | GatewayStateMsg | CommandResult;
```

- [ ] **Step 6: Run the test, confirm it passes**

- [ ] **Step 7: Commit**

```bash
git add mobile/
git commit -m "feat(mobile): expo scaffold with an enforced no-React boundary"
```

---

## Task 2: Server-time offset

**Files:**
- Create: `mobile/src/domain/clock.ts`
- Test: `mobile/src/domain/clock.test.ts`

**Interfaces:**
- Produces: `class ServerClock` with `observe(serverTs: number): void`, `now(): number`, `ageOf(ts: number | null): number | null`, and getter `offsetMs`.

**Why this is Task 2 and not an afterthought:** the web dashboard runs on the same machine as the gateway, so it never encounters skew. A phone does. If the app subtracts a gateway timestamp from its own `Date.now()`, a few seconds of drift makes live data read as stale — or worse, stale data read as live, which breaks the invariant the whole system rests on.

- [ ] **Step 1: Write the failing test**

```ts
import { ServerClock } from './clock';

test('with no observation yet, ages fall back to the local clock', () => {
  const clock = new ServerClock(() => 1_000_000);
  expect(clock.offsetMs).toBe(0);
  expect(clock.ageOf(999_000)).toBe(1_000);
});

test('a phone clock 30s fast still reports correct ages', () => {
  // Phone believes it is T+30s; the relay says it is T.
  const clock = new ServerClock(() => 1_030_000);
  clock.observe(1_000_000);
  expect(clock.offsetMs).toBe(-30_000);
  // A snapshot stamped 5s before the relay's "now" is 5s old, not 35s.
  expect(clock.ageOf(995_000)).toBe(5_000);
});

test('a phone clock 30s slow also reports correct ages', () => {
  const clock = new ServerClock(() => 970_000);
  clock.observe(1_000_000);
  expect(clock.offsetMs).toBe(30_000);
  expect(clock.ageOf(995_000)).toBe(5_000);
});

test('ageOf(null) is null - absent is not zero', () => {
  const clock = new ServerClock(() => 1_000_000);
  expect(clock.ageOf(null)).toBeNull();
});

test('later observations replace earlier ones', () => {
  const clock = new ServerClock(() => 1_000_000);
  clock.observe(900_000);
  expect(clock.offsetMs).toBe(-100_000);
  clock.observe(1_000_000);
  expect(clock.offsetMs).toBe(0);
});
```

- [ ] **Step 2: Run it, confirm it fails** (`Cannot find module './clock'`)

- [ ] **Step 3: Implement**

```ts
/**
 * Translates between this device's clock and the relay's.
 *
 * Every relay message carries `serverTs`. The difference between that and the
 * local clock at the moment of receipt is the offset; applying it to every age
 * calculation means a wrong phone clock cannot make stale data look fresh.
 */
export class ServerClock {
  #offsetMs = 0;
  #localNow: () => number;

  constructor(localNow: () => number = () => Date.now()) {
    this.#localNow = localNow;
  }

  /** Call with `serverTs` from any relay message. */
  observe(serverTs: number): void {
    if (!Number.isFinite(serverTs)) return;
    this.#offsetMs = serverTs - this.#localNow();
  }

  get offsetMs(): number { return this.#offsetMs; }

  /** Local time expressed in the relay's frame of reference. */
  now(): number { return this.#localNow() + this.#offsetMs; }

  /** Milliseconds since `ts`, or null when there is no timestamp at all. */
  ageOf(ts: number | null): number | null {
    if (ts === null || !Number.isFinite(ts)) return null;
    return this.now() - ts;
  }
}
```

- [ ] **Step 4: Run the test, confirm it passes**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(mobile): server-time offset so a wrong phone clock cannot fake freshness"
```

---

## Task 3: Relay connection

**Files:**
- Create: `mobile/src/gateway/connection.ts`
- Test: `mobile/src/gateway/connection.test.ts`

**Interfaces:**
- Consumes: `RelayMessage` (Task 1), `ServerClock` (Task 2).
- Produces: `createConnection({ url, writeToken, clock, socketFactory, scheduleFn })` returning `{ start(), stop(), send(msg), on(event, fn), get status }` where `status` is `'connecting' | 'open' | 'closed'`. `socketFactory` is injected so tests use a fake socket rather than a real network.

- [ ] **Step 1: Write the failing test**

```ts
import { createConnection } from './connection';
import { ServerClock } from '../domain/clock';

class FakeSocket {
  static last: FakeSocket;
  sent: string[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (e: { data: string }) => void;
  onerror?: (e: unknown) => void;
  readyState = 0;
  constructor(public url: string, public protocols?: unknown) { FakeSocket.last = this; }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  deliver(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

const setup = (over: Partial<Parameters<typeof createConnection>[0]> = {}) => {
  const delays: number[] = [];
  const conn = createConnection({
    url: 'wss://relay.test/subscribe',
    clock: new ServerClock(() => 1_000_000),
    socketFactory: (url) => new FakeSocket(url) as never,
    scheduleFn: (fn, ms) => { delays.push(ms); return setTimeout(fn, 0) as never; },
    ...over,
  });
  return { conn, delays };
};

test('emits snapshots and feeds serverTs to the clock', () => {
  const clock = new ServerClock(() => 1_030_000);
  const { conn } = setup({ clock });
  const seen: unknown[] = [];
  conn.on('snapshot', (s) => seen.push(s));
  conn.start();
  FakeSocket.last.open();
  FakeSocket.last.deliver({ type: 'snapshot', serverTs: 1_000_000, stale: false, conveyors: [] });

  expect(seen).toHaveLength(1);
  expect(clock.offsetMs).toBe(-30_000);
});

test('backoff is exponential and capped', () => {
  const { conn, delays } = setup();
  conn.start();
  for (let i = 0; i < 8; i++) { FakeSocket.last.open(); FakeSocket.last.close(); }
  expect(delays[0]).toBe(1_000);
  expect(delays[1]).toBe(2_000);
  expect(Math.max(...delays)).toBeLessThanOrEqual(30_000);
});

test('a successful open resets the backoff', () => {
  const { conn, delays } = setup();
  conn.start();
  FakeSocket.last.open(); FakeSocket.last.close();
  FakeSocket.last.open(); FakeSocket.last.close();
  expect(delays.at(-1)).toBe(1_000);
});

test('stop() prevents further reconnection', () => {
  const { conn, delays } = setup();
  conn.start();
  FakeSocket.last.open();
  conn.stop();
  FakeSocket.last.close();
  expect(delays).toHaveLength(0);
});

test('malformed frames are ignored, not thrown', () => {
  const { conn } = setup();
  conn.start();
  FakeSocket.last.open();
  expect(() => FakeSocket.last.onmessage?.({ data: '{not json' })).not.toThrow();
});

test('the write token travels as a bearer subprotocol, never in the URL', () => {
  const { conn } = setup({ writeToken: 'secret-token' });
  conn.start();
  expect(FakeSocket.last.url).not.toContain('secret-token');
});
```

- [ ] **Step 2: Run it, confirm it fails**

- [ ] **Step 3: Implement `connection.ts`**

Key requirements, in the order they matter:

1. Attach `onmessage` **before** the socket can open — a frame can arrive in the same tick as `open`, and the relay replays its cached snapshot immediately on connect. This is the exact bug Plan 1 hit; do not rediscover it.
2. Feed `serverTs` from every message into `clock.observe()` before emitting.
3. Backoff `Math.min(1000 * 2 ** attempt, 30_000)`, reset `attempt = 0` on open.
4. `stopped` flag checked on every reconnect path.
5. React Native's `WebSocket` has no header option; pass the write token as a `Sec-WebSocket-Protocol` value rather than a query parameter, so it never lands in the relay's or Caddy's access log.

- [ ] **Step 4: Run the tests, confirm they pass**

- [ ] **Step 5: Commit**

---

## Task 4: Staleness, alarms and formatting

**Files:**
- Create: `mobile/src/domain/staleness.ts`, `mobile/src/domain/alarms.ts`, `mobile/src/domain/format.ts`
- Test: one `*.test.ts` beside each

**Interfaces:**
- Consumes: `ServerClock` (Task 2), wire types (Task 1).
- Produces:
  - `channelState(ch, clock): 'live' | 'late' | 'stale' | 'never'`
  - `gatewayView({ online, stale, lastSeenTs }, clock): { label: string; degraded: boolean }`
  - `mergeAlarms(existing, incoming): Alarm[]` — deduped by id, most severe first, then newest
  - `parseEvidence(alarm): { rule?: string; measured?: Record<string, number> } | null`
  - `formatValue(ch): string` — `NO SIGNAL` when `value == null`

- [ ] **Step 1: Write the failing tests**

The cases that must be present, because each encodes a rule from the spec:

```ts
test('a channel with a null value formats as NO SIGNAL, never 0', () => {
  expect(formatValue({ value: null, unit: '°C' } as never)).toBe('NO SIGNAL');
});

test('a measured zero formats as 0, not NO SIGNAL', () => {
  // motor_rpm = 0 means "not turning" and IS a measurement.
  expect(formatValue({ value: 0, unit: 'rpm' } as never)).toBe('0 rpm');
});

test('alarms dedupe by id across a reconnect', () => {
  const a = { id: 41, level: 'planned_inspection' } as never;
  expect(mergeAlarms([a], [a])).toHaveLength(1);
});

test('a gateway that is offline is never labelled live, however fresh the snapshot', () => {
  const clock = new ServerClock(() => 1_000_000);
  const view = gatewayView({ online: false, stale: true, lastSeenTs: 999_000 }, clock);
  expect(view.degraded).toBe(true);
  expect(view.label).toMatch(/offline/i);
});

test('evidence is parsed, so an alarm never shows a claim with no numbers', () => {
  const alarm = { evidence: '{"rule":"thermal_delta","measured":{"delta_k":15.38}}' } as never;
  expect(parseEvidence(alarm)?.measured?.delta_k).toBe(15.38);
});

test('unparseable evidence returns null rather than throwing', () => {
  expect(parseEvidence({ evidence: 'not json' } as never)).toBeNull();
});
```

- [ ] **Step 2: Run, confirm they fail**
- [ ] **Step 3: Implement the three modules**
- [ ] **Step 4: Run, confirm they pass**
- [ ] **Step 5: Commit**

---

## Task 5: Relayed commands

**Files:**
- Create: `mobile/src/gateway/commands.ts`
- Test: `mobile/src/gateway/commands.test.ts`

**Interfaces:**
- Consumes: `createConnection` (Task 3).
- Produces: `createCommands({ connection, now })` returning `{ history(opts), ack(alarmId, by), close(alarmId, body), pending: number }`, each returning a Promise that resolves with the result or rejects with the relay's error.

**The relay's limits are not suggestions.** It enforces 5 commands/sec (burst 10), 8 in flight, and ids ≤64 chars. Exceeding them gets commands rejected, not queued. The client must throttle on its own side so a user mashing a button produces a queue, not a wall of `rate limited` errors.

- [ ] **Step 1: Write the failing test**

```ts
test('a command resolves with the relay result, correlated by id', async () => { /* … */ });
test('a command rejects with the relay error rather than resolving falsely', async () => { /* … */ });
test('a command times out rather than hanging forever', async () => { /* … */ });
test('ids are under the relay 64-char limit', () => { /* … */ });
test('no more than 8 commands are in flight at once', async () => { /* … */ });
test('commands issued while disconnected reject immediately, not silently queue', async () => { /* … */ });
```

That last case matters most: an `ack` the operator believes succeeded but which never reached the gateway is worse than a visible failure. No optimistic UI.

- [ ] **Step 2-5:** fail → implement → pass → commit

---

## Task 6: Store and the Overview screen

**Files:**
- Create: `mobile/src/store/useRelay.ts`, `mobile/app/index.tsx`, `mobile/src/ui/components/ChannelTile.tsx`, `NodeBadge.tsx`
- Test: `mobile/src/ui/components/ChannelTile.test.tsx`

Overview is the screen that has to make the demo obvious: risk headline, channel tiles grouped thermal / vibration / drive, node strip. Big numbers, readable at arm's length. This is **not** a shrunken dashboard — one question answered per screen.

- [ ] **Step 1:** Test that `ChannelTile` renders `NO SIGNAL` for a null value and the value with its unit otherwise
- [ ] **Step 2:** Test that a degraded gateway visibly greys the tiles and shows the age
- [ ] **Steps 3-5:** implement store + screen, pass, commit

---

## Task 7: Alarms, detail, and the write actions

**Files:**
- Create: `mobile/app/alarms.tsx`, `mobile/app/alarm/[id].tsx`, `mobile/src/ui/components/AlarmCard.tsx`
- Test: `mobile/src/ui/components/AlarmCard.test.tsx`

- [ ] **Step 1:** Test that an alarm card shows the measured values from `evidence`, not just the message
- [ ] **Step 2:** Test that ACK and CLOSE are **disabled** when the gateway is offline
- [ ] **Step 3:** Close prompts for outcome, technician and notes — the endpoint accepts all three, and an unexplained close is a worse maintenance record than none
- [ ] **Steps 4-6:** implement, pass, commit

---

## Task 8: Trends

**Files:**
- Create: `mobile/app/trends.tsx`, `mobile/src/ui/components/Sparkline.tsx`

Channel picker, 15/60 min windows, backed by the `history` command from Task 5. Show a temperature climbing *before* it alarmed.

- [ ] **Steps 1-5:** test → implement → pass → commit

---

## Task 9: Notifications and the foreground service

**Files:**
- Create: `mobile/src/notifications/notifier.ts`, `mobile/src/notifications/service.ts`
- Test: `mobile/src/notifications/notifier.test.ts`

**Interfaces:**
- Consumes: `AlarmEvent` (Task 1), `mergeAlarms` (Task 4).
- Produces: `createNotifier({ present })` with `handle(alarm): boolean` — true when a notification was raised, false when suppressed as a duplicate.

**Push (FCM) is not used.** It needs internet *and* a Google project; the relay already delivers alarms over a socket we hold open. A foreground service with a persistent notification is the only reliable way to keep that socket alive on modern Android — anything else gets killed by Doze, and "the alarm didn't arrive" is worse than having no notifications at all.

- [ ] **Step 1: Write the failing test**

```ts
test('an alarm raises exactly one notification', () => { /* … */ });
test('the same alarm id twice raises one notification, not two', () => { /* … */ });
test('the notification body carries the measured values', () => { /* … */ });
test('a replayed alarm after reconnect does not re-notify', () => { /* … */ });
```

- [ ] **Steps 2-4:** fail → implement → pass
- [ ] **Step 5:** Configure the Android notification channel and the foreground service in `app.json`
- [ ] **Step 6: Commit**

---

## Task 10: Connect screen and credential storage

**Files:**
- Create: `mobile/app/connect.tsx`, `mobile/src/gateway/credentials.ts`
- Test: `mobile/src/gateway/credentials.test.ts`

Relay URL defaults to `wss://api.sih.shubhang.dev`. Reads need nothing. The write token is entered once and stored in `expo-secure-store` — never in `AsyncStorage`, which is plain text on disk.

- [ ] **Step 1:** Test that a stored token is returned and that a missing one yields read-only mode rather than an error
- [ ] **Steps 2-5:** implement, pass, commit

---

## Task 11: Dev build and on-device verification

**Files:**
- Modify: `mobile/app.json`, `mobile/eas.json`

Expo Go **cannot** host a foreground service, so this needs a dev build. That is a one-time setup cost, not an optional nicety.

- [ ] **Step 1:** `eas build --profile development --platform android`, or a local Gradle build
- [ ] **Step 2:** Install on a physical device — emulators do not reproduce Doze faithfully
- [ ] **Step 3: Verify against the LIVE relay, not a mock:**
  - App shows current conveyor state within 2 s of launch (the relay replays its cache on connect)
  - Heat the MLX90614 until `thermal_delta` fires → **phone notification arrives with the app backgrounded**
  - Airplane-mode the phone → app shows disconnected, then recovers on its own
  - Stop the gateway → app shows `GATEWAY OFFLINE` with a last-seen age, and values visibly degrade rather than freezing
  - ACK an alarm on the phone → it shows acknowledged in the web dashboard
- [ ] **Step 4:** Leave it backgrounded for 30 minutes, then trigger an alarm. If the notification does not arrive, the foreground service is being killed and that is the real work of this task.
- [ ] **Step 5: Commit**

---

## Risks worth naming before starting

- **Doze and OEM battery managers** are where this class of app actually fails. Xiaomi, Oppo and Samsung all kill background sockets more aggressively than stock Android. Task 11 Step 4 is the acceptance test that matters.
- **The relay is a single instance with no failover.** If it dies, the app shows disconnected and there is no second path. Acceptable for a demonstration.
- **`RELAY_WRITE_TOKEN` is currently set on the deployed relay**, so writes need it. Reads do not. If the token is rotated, every installed app needs re-entry — there is no push mechanism for it.
- **The relay's rate limits will reject a chatty client.** Respect them in `commands.ts` (Task 5) rather than discovering them as user-visible errors.
