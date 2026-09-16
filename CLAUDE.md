# PRAVAAH — central brain

Single entry point for this repo. Read this first; it is the map and the
decision record. Detailed narrative lives elsewhere (see *Where else to look*).
Keep it short — it is loaded into every agent session.

## What this is

Real-time conveyor belt joint/splice integrity monitoring, built for
**SIH26008** — *Belt Joint Rupture and Conveyor Belt Damages in the Iron Ore
Mining Industry*. Sensors on a conveyor feed an on-site gateway that applies
threshold rules and an ML condition model, and drives a live dashboard with a
3D digital twin.

The npm package is still named `beltguard-edge` to match the MQTT topic prefix
and the firmware. Don't "fix" that; it would desync the nodes.

## The one thing to understand first

**The hardware is a 1.2 m flat-belt bench rig. The dashboard shows a troughed
mining conveyor.** This is deliberate, decided 2026-09-16.

SIH26008 is an iron ore problem, so the twin models the *target* machine
(`model: 'mining'` in `server/config.js`) — troughed belt, loading chute, impact
idlers, take-up, pull-cord. The real measurements from the bench rig drive it.

Honesty is preserved by naming, not by downgrading the model:

- conveyor label = the machine being modelled → **"Iron ore conveyor"**
- `siteLabel` = where the numbers come from → **"Pilot test rig"**

Do **not** rename CV-01 after the bench, and do **not** switch `model` back to
`'bench'`. Labelling it "Bench test conveyor" next to the 18-part mining roster
reads as a claim that the bench loop has a hopper and a pull-cord. It does not.
The `bench` code path (`BENCH_PARTS`, `drawBenchRig`) is intentionally dead in
the shipped config and survives only in tests.

## Non-negotiable principles

1. **Never fabricate a value.** Out-of-range readings are rejected, not clamped.
   An unset config field shows as "not configured", never a guess.
2. **Never claim hardware that isn't there.** If a part is not instrumented, the
   roster says so rather than showing it healthy.
3. **Plant data stays on site by default.** The relay is off unless
   `RELAY_PUBLISH_SECRET` is set or `PRAVAAH_RELAY=1`. If you enable it, also set
   `RELAY_WRITE_TOKEN` on the relay or anyone can ack/close alarms.
4. **Every on-screen time is in the plant zone and labelled** (`Asia/Kolkata`,
   "IST"). Exports stay UTC.

## Map

| Path | What lives there |
|---|---|
| `server/` | Gateway: embedded MQTT broker + HTTP + WebSocket. `index.js` (ingest, alarms), `rules.js` (thresholds), `components.js` (part roster), `store.js` (SQLite), `schema.js` (validation), `ml-worker.js`, `relay-publisher.js` |
| `server/config.js` | **All asset metadata.** Every number must be measured on the rig |
| `web/` | Dashboard. `app.js` (render/wiring), `dashboard-ui.js` (pure, tested helpers), `scene3d.js` + `webgl3d.js` (3D), `belt-motion.js` (animation), `readiness.js` |
| `tools/` | Recording/replay/dev: `record-session.js`, `replay-recording.js`, `demo-recording.js`, `gateway-offline.js`, `bench-publisher.js`, `serial-bridge.js`, and most tests |
| `firmware/` | ESP32 sketches: `beltguard_node` (WiFi/MQTT), `pravaah_serial_node` (USB serial, used by the current rig) |
| `edge/` | `vision_node.py` — camera-based joint inspection |
| `ML/SIH-2026/` | Condition-monitoring pipeline. Has its own `AGENTS.md` |
| `mobile/` | Mobile app. Has its own `AGENTS.md` / `CLAUDE.md` |
| `relay/` | Public relay service (separate npm project, own tests) |
| `BeltData/` | Cleaned 6 Sept rig recording, checksummed. Demo/replay source |

**New pure UI logic belongs in `web/dashboard-ui.js`, not `app.js`** — that is
the module the tests can import without a browser.

## Run and verify

```sh
npm start                  # gateway + dashboard -> http://localhost:8811 (MQTT 1883)
npm run demo:recording     # replay BeltData -> :8812, MQTT 1884, relay off
./start-pravaah.sh         # full demo launcher

npm test                   # 64 gateway/tool tests, then 49 relay tests
node tools/test-scene3d.js # 84 scene-geometry checks (not in npm test)
```

All three suites must pass before merging. `node tools/test-scene3d.js` is easy
to forget — it is not wired into `npm test`.

## Known open issues

Verified, deliberately not fixed. **KI-1..KI-3 are Harshit's design area —
raise them with him rather than silently changing his work.**

| ID | Where | Issue | Bites when |
|---|---|---|---|
| **KI-1** | `web/app.js` (`mlWindows`) | `mlWindows` is a module-level array shared by every conveyor. `renderML` pushes into it; switching conveyor tabs never clears it. ML windows from different machines pool into one sustained run, so the headline can describe a machine whose data isn't in the run | A 2nd conveyor is configured. Unreachable today (only CV-01) |
| **KI-2** | `web/app.js` (`benchFramed`) | A one-shot latch multiplies `cam`, `HOME` and every `VIEWS` preset by 0.7 the first time a bench conveyor is drawn, and never undoes it. Switching back to a mining conveyor leaves every camera preset shrunk until reload | A bench conveyor and a mining conveyor both exist. Unreachable today |
| **KI-3** | `web/dashboard-ui.js` (`sustainedML`) | Headline status is the **least severe** of the last 3 ML windows. Documented and intentional, but an alternating CRITICAL/NORMAL machine always displays "Within baseline range", and de-escalation is instant while escalation needs 3 windows — biased toward "normal" in exactly the flapping case that signals an intermittent fault | Any intermittent fault. **Live now** |
| **KI-4** | `firmware/beltguard_node/*.ino:404`, `server/schema.js` | Firmware sends `ts` = ms since boot and its comment claims "the GATEWAY restamps it on arrival". It does not. `schema.js` sees a value `< 1e12`, reads it as Unix **seconds** and multiplies by 1000, producing 1970 dates. Verified: `ts: 500000` is stored as `1970-01-06T18:53:20Z`. The serial node sends no `ts` and is stamped correctly, which is why the bench rig never showed it | The WiFi/MQTT ESP32 node is used. Pre-existing, predates the dashboard work |
| **KI-5** | `tools/gateway-offline.js`, `tools/replay-recording.js` | `flag()` returns boolean `true` for a value-less flag. `--db` with no value writes a database named `true`, and `--fresh` deletes it. `--limit` with no value becomes 1. `--from` with an unknown segment id silently replays from the first segment instead of erroring | A typo'd or incomplete CLI invocation, e.g. mid-demo |
| **KI-6** | `server/index.js` (`persistentFindings`) | The `persistSamples` counter is never reset across a sensor outage. A node that drops out with `count >= 3` alarms on its first breaching sample after it returns, so the 3-sample debounce silently doesn't apply after any gap | A node reconnects while still breaching |

Smaller cleanups, not tracked above: three private copies of the same HTML-escape
helper (`web/app.js:91`, `web/scene3d.js:299`, `web/readiness.js:3` — the last
one escapes operator-typed close notes, so it is the copy that matters if they
drift); `no_rule` and `blind` now render the same colour `#8a9ca8`, so a dead
sensor looks identical to an unconfigured threshold on the 3D model, and the
dashed-outline mechanism that used to distinguish them is dead code.

## Where else to look

- `PROJECT_STATE.md` — append-only session checkpoint log: what changed when, how
  it was verified, how to roll back to a snapshot. Narrative, not reference.
- `docs/` — `dataset-schema.md`, `dataset-collection-plan.md`,
  `conveyor-recording.md`, `sensor-debugging.md`, ML review notes.
- `README.md` — full setup, wiring and sensor integration.
- `ML/SIH-2026/AGENTS.md`, `mobile/AGENTS.md` — scoped rules for those subtrees.

## Conventions

- Comments explain **why**, especially where a value was measured or a choice
  looks wrong at a glance. Several near-misses in this repo were caused by
  someone "fixing" a deliberate decision — leave the reasoning in place.
- Asset metadata goes in `server/config.js` and must be measured, never guessed.
- Update the *Known open issues* table when one is fixed or a new one is found.
