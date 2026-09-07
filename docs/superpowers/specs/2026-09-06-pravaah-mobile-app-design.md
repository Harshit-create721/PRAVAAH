# PRAVAAH mobile app — design

**Date:** 2026-09-06
**Status:** implemented in `mobile/`; physical-device background-delivery acceptance pending

See [the mobile implementation guide](../../../mobile/README.md) for the
verified wire contract, run commands, implementation differences and remaining
device checks. This document preserves the original design intent.
**Context:** SIH26008 — AI-enabled conveyor belt joint rupture and damage prediction

## 1. Goal

An Android application showing live conveyor state from the PRAVAAH gateway,
raising a phone notification the moment a rule breaches, and allowing an
operator to acknowledge and close alarms from the plant floor.

Reachable over the public internet at `api.sih.shubhang.dev` so it works away
from the gateway's own network, and so a reviewer can open it without joining a
private network.

### Non-goals

- Porting the 3D machine view. The web dashboard remains the engineering
  display; the app answers different questions at a different information
  density.
- Replacing the dashboard. Both are clients of the same gateway.
- Offline history storage on the phone. History is fetched on demand.

## 2. Architecture

```
3x ESP32 --USB--> laptop: gateway (broker + rules + SQLite) + serial bridge
                      |
                      |  outbound WSS  (no inbound ports, no port forwarding)
                      v
        droplet 206.189.135.109 - Docker "sih-relay"
        Caddy vhost -> 127.0.0.1:3040 - automatic TLS
                      |
                      |  WSS + HTTPS at api.sih.shubhang.dev
                      v
                  Android app        (and any browser, read-only)
```

**The laptop dials out.** No port forwarding, no inbound firewall rule, no
router access. Works from behind any NAT or captive portal permitting outbound
HTTPS. This is the property that makes the system deployable anywhere.

**The relay is a fan-out with a last-state cache, not a database.** It holds the
most recent snapshot in memory and replays it to each subscriber on connect, so
a phone shows data immediately rather than waiting up to 2s for the next
broadcast. Nothing is persisted on the droplet; the gateway's SQLite remains the
single system of record.

### Transport fallback

The app's `gateway/` layer is transport-agnostic. If the relay is unreachable it
falls back to a configured LAN address for the gateway. A hackathon venue is the
worst case for mobile data — hundreds of devices on one cell — and this is cheap
insurance against the one failure that would end a demonstration.

## 3. Relay protocol

Two WebSocket endpoints, distinguished by path.

**`/publish`** — the gateway. At most one active publisher; **if a second
connects, the newest wins and the older socket is closed.** A half-open socket
left by a dropped mobile connection must never lock the real gateway out.

| Direction | Message |
|-----------|---------|
| gateway -> relay | `{type:'snapshot', ...}` full conveyor state |
| gateway -> relay | `{type:'alarm', alarm:{id, ts, level, family, message, evidence}}` |
| gateway -> relay | `{type:'commandResult', id, ok, result?, error?}` |
| relay -> gateway | `{type:'command', id, action:'ack'\|'close'\|'history', payload}` |

**`/subscribe`** — phones and browsers. Many.

| Direction | Message |
|-----------|---------|
| relay -> app | `{type:'snapshot', serverTs, stale, ...}` |
| relay -> app | `{type:'alarm', alarm:{...}}` |
| relay -> app | `{type:'gatewayState', online, lastSeenTs}` |
| app -> relay | `{type:'command', id, action, payload}` |

**Every gateway interaction is a command over this socket — including reads.**
The gateway is behind NAT and only ever dials out, so the app cannot call
`/api/history`, `/api/alarms/:id/ack` or any other gateway endpoint directly.
`history`, `ack` and `close` are all relayed commands, correlated by `id`, with
the result returned to the originating subscriber alone.

**`serverTs` is present on every relay message.** The app computes its clock
offset once and applies it to every age calculation. See §6.

**HTTP:** `GET /health` (liveness), `GET /state` (last snapshot, for debugging
and for a browser to read without a WebSocket).

### Why the alarm is a distinct message

The gateway already broadcasts `{type:'alarm', ...}` as a discrete event
alongside its snapshots. Notifications therefore never diff consecutive
snapshots. Snapshot-diffing is the usual source of duplicate alerts on reconnect
and of alarms missed between polls; an explicit event has neither problem.

## 4. App modules

```
src/
  gateway/     transport - no React, no react-native imports
    discovery.ts    relay URL, LAN fallback, cached
    connection.ts   WS lifecycle, backoff reconnect, typed event emitter
    commands.ts     relayed commands: history, ack, close (correlated by id)
    types.ts        Snapshot, AlarmEvent, Channel, NodeStatus
  domain/      pure logic - no React
    staleness.ts    channel and node state from ts vs freshness windows
    alarms.ts       dedupe by id, ordering, open vs closed
    format.ts       units, decimals, NO SIGNAL
  notifications/
    service.ts      foreground service lifecycle
    notifier.ts     AlarmEvent -> local notification, deduped by alarm id
  store/            latest snapshot + connection status (Zustand)
  ui/
    screens/        Connect, Overview, Alarms, AlarmDetail, Trends, Nodes
    components/     ChannelTile, AlarmCard, NodeBadge, Sparkline
```

`gateway/` and `domain/` import nothing from React or React Native, so they run
under Jest in Node with no emulator. The reconnect, staleness, de-duplication
and formatting logic — where the real risk lives — is therefore tested in
milliseconds against a mock socket. This boundary is the reason TypeScript was
chosen over Flutter.

### Channel metadata is not duplicated

The gateway serves `/api/contract` with every channel's unit, label, range and
group. The app fetches it once per connect and caches it. Labels and units come
from the same source as the dashboard's, by construction, so adding a channel
server-side cannot leave the app displaying a stale copy.

## 5. Screens

Deliberately not a shrunken dashboard. The web UI is dense because it is a
control-room display; a phone at arm's length needs one question answered per
screen.

| Screen | Answers |
|--------|---------|
| **Overview** | Conveyor risk headline, live channel tiles by group, node strip |
| **Alarms** | Open alarms, most severe first, each with the numbers that produced it |
| **Alarm detail** | Rule, family, component, measured values, threshold, ratio. ACK and CLOSE |
| **Trends** | One channel over 15/60 min via a relayed `history` command |
| **Nodes** | The three ESP32s: live/stale/offline, last seen, `sensor_health`, transport |
| **Connect** | First launch only; afterwards a status chip in the header |

Closing an alarm prompts for outcome, technician and notes, because the existing
endpoint accepts all three and an unexplained close is a worse maintenance
record than none.

**The `NO SIGNAL` rule carries over unchanged.** A channel nobody has published
shows `NO SIGNAL`, never a zero. It would be incoherent for the phone to be less
honest than the screen beside it.

## 6. Failure modes

Every failure must be visible. The dangerous outcome is not an error message —
it is frozen numbers that look live.

| Failure | Behaviour |
|---------|-----------|
| Gateway -> relay drops | Relay marks state stale with last-seen time; app shows `GATEWAY OFFLINE - last seen 43s ago` over greyed values |
| App -> relay drops | Exponential backoff with cap; after N failures try the LAN fallback |
| Relay restarts | Cache lost by design; gateway detects close, reconnects, republishes a full snapshot |
| Sensor node dies | Already modelled by the gateway as live/stale/offline; propagated unchanged |
| Clock skew | Every relay message carries `serverTs`; app computes offset once and applies to all ages |
| Write while gateway offline | Fails loudly. No optimistic UI, no silent queue |
| Duplicate alarms on reconnect | Deduped by alarm id, which SQLite assigns and which survives restarts |
| Slow subscriber | Superseded snapshots dropped; alarm events never dropped |

**Clock skew deserves emphasis.** The dashboard runs on the same machine as the
gateway and so never encounters it. A phone subtracting a laptop timestamp from
its own `Date.now()` will, with a few seconds of drift, render live data as
stale or — worse — stale data as live.

## 7. Security

`api.sih.shubhang.dev` is public, so the trade that was acceptable on a private
network no longer is.

- **Reads are open.** Anyone with the URL can watch. This is intended.
- **Writes are token-gated, but the gate is off by default.** Controlled by an
  environment variable. Set `RELAY_WRITE_TOKEN` and `ack`/`close` require it;
  leave it unset and writes are open.
- **The publish endpoint takes a shared secret** so an outsider cannot
  impersonate the gateway and inject fabricated readings.

Both modes are covered by tests. Defaulting the write gate off keeps the
demonstration frictionless while ensuring the code path exists the moment the
URL is shared more widely.

## 8. Deployment

**Relay:** Docker container on `206.189.135.109`, bound to `127.0.0.1:3040`,
memory-limited to 128 MB so it cannot starve the five existing services. The
droplet has ~284 MB available following the removal of `jansarthi`.

**Caddy:** a new fragment at `/etc/caddy/sites/sih-api.caddy`, matching the
established `import /etc/caddy/sites/*.caddy` convention. No existing site file
is modified. Validate with `caddy validate` *before* reloading — five production
sites share this proxy.

**DNS:** `api.sih.shubhang.dev` A record already points at the droplet.

**Gateway:** one addition — an outbound relay publisher client, enabled by
config, that connects to `/publish` and mirrors what it already broadcasts
locally. The dashboard's own WebSocket path is untouched.

## 9. Test strategy

Server-side follows the convention established by `tools/record-session.test.js`:
**`node:test` with `node:assert/strict`, integration-first with real
dependencies** rather than mocks.

**Relay suite** — real `ws` server and clients:

- new subscriber receives the cached snapshot immediately on connect
- alarm event fans out to every subscriber
- publisher disconnect marks state stale and notifies subscribers
- publisher reconnect replaces stale state with a fresh snapshot
- command routes to the publisher and the result returns to the originating subscriber only
- command with no publisher attached returns an explicit error, never silent success
- `history` command round-trips: subscriber -> relay -> publisher -> result, correlated by `id`
- a second publisher displaces the first rather than being refused
- superseded snapshots dropped under backpressure; alarm events never dropped
- malformed and oversized frames rejected without killing the process
- auth enabled: bad secret rejected; auth disabled: writes permitted

**App logic suite** — Jest over `gateway/` and `domain/` only, Node-speed:

- reconnect backoff sequence, jitter bounds, cap
- staleness boundaries at the live/stale/offline edges
- clock skew: inject +/-30s offset, assert ages remain correct
- alarm de-duplication across a reconnect
- formatting: `null` renders `NO SIGNAL`, never `0`

**Component suite** — React Native Testing Library, thin: absent channel renders
`NO SIGNAL`; ack and close disabled when the gateway is offline.

**End-to-end without hardware.** `tools/record-session.js` already captures
labelled runs as JSONL. Those recordings replay as fixtures: drive
gateway -> relay -> test subscriber and assert a `thermal_delta` alarm arrives
with its measured values intact. Runs in CI and on any laptop, and reuses an
existing tool rather than inventing a fake-node script.

## 10. Open items

- `nominalRpm` remains unmeasured, so `speed_deviation` stays inactive. See
  `docs/05-calibration.md`.
- `vibrationRmsG` is a bench figure, not a conveyor figure.
- Notification channel behaviour under Doze has to be verified on a physical
  device; emulators do not reproduce Android's battery-optimisation behaviour
  faithfully.
