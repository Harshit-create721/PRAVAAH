# PRAVAAH — project state (checkpoint 2 + animation update, 2026-09-14)

## Animation update — 14 Sept 2026

The working tree now differs from checkpoint 2. The older archives remain intact.

- User correction: the default 3D model is **mining**, for both the live gateway
  and recorded playback. It shows the troughed belt, coal load, loading chute,
  idlers, support legs and mining drive train. The pilot rig's measured sensor
  values and calibration still drive its motion and monitoring.
- Animation refinement: replaced the fixed coal mound with an advecting bed and
  72 stable faceted fragments following hopper/carriage/discharge paths; added
  carrying and return idler surface rotation and stronger pulley marks. All motion
  freezes together on pause, missing data or zero speed. Coal throughput is not
  measured and the viewer labels the material flow as illustrative.
- Rendering refinement: 60 fps WebGL target, 24 fps SVG fallback; stationary
  geometry remains in GPU buffers between motion frames. Selection, camera,
  texture and data changes invalidate the appropriate cached buffers.

- `web/belt-motion.js` and `web/app.js`: moving belt tread bands around the full
  loop and rotating pulley index marks, driven by fresh `belt_speed` and measured
  `beltLengthM`. Static geometry and labels are reused between animation frames
  WebGL and SVG both receive moving geometry with component IDs.
- Motion holds at zero speed, lost/invalid/stale speed, offline Hall node or a
  recording segment gap. Pause/resume affects animation only. Hidden/offscreen
  scenes stop scheduling frames; reduced-motion preference starts paused.
- The animation does not estimate shaft RPM, direction, absolute marker/splice
  position, or mechanical vibration displacement. These are illustrative marks.
- `npm run demo:recording`: plays the supplied cleaned BeltData at 1x on
  http://localhost:8812, MQTT loopback port 1884, `data/replay-animation.db`, relay
  disabled. No live database or existing gateway is replaced. Ctrl+C stops both
  processes. Playback now loops through all 78 segments continuously, retaining
  the 3-second segment/cycle gaps; the model readout shows the cycle number.
- Replay frames retain sensor values and add `playback` metadata (original
  recording time, rate). The gateway exposes it for model/report labelling;
  the recorder excludes these frames from new sensor-acquisition datasets.
- Tests: elapsed-time motion and speed scaling, invalid/stale/zero inputs, path
  continuity, real BeltData speed, both geometry variants, actual scene/controller
  caching, pause/resume, visibility, replay gaps and SVG fallback.
- Verification: recorded MQTT frames reached the isolated gateway, fresh speed
  yielded ~0.34 loops/s, and the new JS assets served successfully. Browser UI
  verification was unavailable (no connected browser); scene geometry was rendered
  directly and inspected instead. The earlier review's other alarm/security
  findings remain open.
- Automated verification passed: 62 gateway/tool tests after the animation refinement;
  the earlier 84 scene checks also passed.

---

**`CLAUDE.md` in the repo root is now the central brain** — the map, the
decision record and the known-issue register. Read that first; this file is the
append-only checkpoint log behind it.

Read this first in any new session. It records what exists, what was changed on
13 Sept, how each change was verified, what is still open, and how to return to
either checkpoint.

| Checkpoint | What it is | Archive |
|---|---|---|
| **1** (~23:00 IST) | Team's UI refresh + replay tooling, **before** the product pass | `_snapshots/2026-09-13_code-state.tar.gz` |
| **2** (~23:30 IST) | **After** the product pass described in §3 — current state | `_snapshots/2026-09-13b_code-state.tar.gz` |

---

## 1. Where things stand

| Area | State |
|---|---|
| Problem statement | SIH26008 "AI-Enabled Conveyor Belt Joint Rupture and Damage Prediction" (Ministry of Steel, Smart Automation), pitched as PRAVAAH for Indian mining. Blueprint: `C:\Users\OMEN\Downloads\SIH26008_Conveyor_Belt_Technical_Feasibility_and_Solution_Blueprint.docx` |
| Physical rig | Working bench conveyor (photo `ConveryBelt/e1fbec17-….jpg`). Live data flow confirmed working by the team. |
| Sensors on rig | 3 ESP32 USB nodes, firmware `pravaah-serial-node 0.2.2`: `esp32-vibration-01` (ADXL345), `esp32-thermal-01` (MLX90614), `esp32-marker-01` (Hall, one magnet taped on belt, 1.20 m loop). 12 / 20 channels live. |
| Coming next | Vision sensor (camera) for belt rupture / splice monitoring. |
| Dashboard | Team UI refresh (see `docs/dashboard-product-refresh.md`) **plus the product pass in §3**. |
| ML | `ML/SIH-2026` IsolationForest baseline, trained 2026-09-07 on the SAME 6 Sept recording (in-sample). Supervised fault classifier is trained on SYNTHETIC labels only — never quote its F1 as real. |
| Git | Being pushed to a team branch (14 Sept). Snapshots in §6 remain as local, git-ignored checkpoints. |

### The bench rig (from the photo)
- Small **flat-belt** conveyor: green PVC belt, aluminium profile frame, white end pulleys,
  two painted end brackets standing on the floor, right-angle gear motor on the head pulley.
- No troughed idlers, hopper, take-up, scraper, stringer legs or pull-cord.
- Gearbox label reads approx **"RATIO 7.5:1, RPM 173"**; motor tag approx **25 W, 1-ph 220 V,
  0.23 A, 1300 RPM**. Partly legible — **confirm on the real nameplates** before entering
  `gearRatio`, `driveRatedCurrentA`, `driveRatedRpm` in `server/config.js`. Measure the drive
  pulley diameter for `pulleyDiameterMm` (not entered — no values are guessed).
- IR sensor target on the rig has not been surveyed; record it.

---

## 2. Session 13 Sept — before the product pass (checkpoint 1)

1. Inspected `BeltData/2026-09-06T17-29-57.647Z-a70e3e55-cleaned-v1`: ~45 min source run,
   **1062 s retained in 78 segments**, 6,527 rows. 43 % of source rows removed (USB gaps
   4.7 + 10.3 min, unhealthy/out-of-range, last 300 s). NOT 2–3 hours.
2. Added `tools/replay-recording.js` (verbatim payloads, `ts` re-stamped to now, nodes marked
   offline + ML window flushed at each segment break; `--speed 1` whenever ML matters).
3. Added `tools/gateway-offline.js` (relay OFF, separate DB default `data/replay.db`,
   refuses `data/beltguard.db`, `--fresh` wipes it).
4. Created `ML/SIH-2026/.venv` (Python 3.14.3 + pinned requirements); `ml/predict.py --self-test` 225/225 PASS.
5. Replayed the recording: live ML == `outputs/anomaly_scores.csv`; old rules raised a false
   PLAN INSPECTION (crest 6.16 > 6.0, single frame) on the healthy run.
6. Critique produced (25 flaws) — status of each is in §4.

---

## 3. Product pass (checkpoint 1 → checkpoint 2)

### Server
| File | Change |
|---|---|
| `server/config.js` | `siteLabel: 'Pilot test rig'` (display; MQTT `site` stays `factory`), `timeZone: 'Asia/Kolkata'`; **relay OFF unless `RELAY_PUBLISH_SECRET` is set or `PRAVAAH_RELAY=1`**; CV-01 `label: 'Bench test conveyor'`, **`model: 'bench'`**; threshold **`persistSamples: 3`** |
| `server/index.js` | `persistentFindings()` + `RULE_SAMPLE`: a planned-inspection alarm needs the breach on 3 consecutive NEW samples of the rule's channel; urgent/critical (≥2× limit) fire at once; component colours still show the instantaneous metric. `applyFindings` **escalates an open alarm in place** (worse level or larger ratio; never downgrades) and stores `component` + `ratio` in evidence. Open alarms re-armed from DB at start-up (no duplicates after restart). Close clears by `value.id`. Snapshot adds `server.siteLabel`, `server.timeZone`, `geometry.model`; `componentStatus` gets `model`. |
| `server/rules.js` | Findings carry `component` and `ratio`. Thermal message: "above the IR sensor body temperature" (not "ambient"). |
| `server/schema.js` | Labels: `ambient` → "IR sensor body temperature", `temperature_delta` → "Surface above sensor body". Channel keys unchanged. |
| `server/store.js` | `updateAlarm()`; `recentAlarms()` returns `closed_by` and `close_notes` from `maintenance`. |
| `server/components.js` | `alarmBelongsTo()` — alarm matched to the part its rule MEASURED (evidence.component), family fallback for legacy rows (fixes vibration alarm lighting the IR idler spot). `BENCH_PARTS` + `componentsFor(model)`: bench roster = 8 real parts; `idlers` shown as "IR temperature spot" (group belt), `gearbox` as "Right-angle gearbox". |
| `start-pravaah.sh` | Relay status line matches the new default. |

### Frontend
| File | Change |
|---|---|
| `web/index.html` | Local fonts (`/fonts/fonts.css`); **summary cards + banner above the 3D model**; tagline removed; header **Sound on/off**; **Status report** button; **Engineering detail** toggle on channels; alarms **Open / History** tabs; "Gateway activity" → collapsed **Diagnostics**; `<dialog>` form for acknowledge/close (name, finding, notes); ML transient + agreement lines. |
| `web/app.js` | IST clock/axis/alarm times; storage wrapper; **ML status only when held 3 consecutive windows**, brief spikes shown as a note, one-line **rules-vs-ML agreement**; plain-language ML reasons; uninstalled channels folded ("Not installed on this conveyor (8)"); engineering channels hidden by default; chart min-span axis; **alarm cards**: "LEVEL: fault at part", suggested check, IST opened time, worst reading; named ack/close form (name remembered); alarm history view; **chime + pulse + tab title count** on new/escalated alarm; friendly sensor names (id underneath, firmware in tooltip), health chips named; coverage panel uses rule titles + "needs a CT / motor speed sensor"; roster/tooltip use rule titles and channel labels; 3D markers for never-seen sensors (CT, CAM, MARKER L/R) hidden unless a part is inspected; **`drawBenchRig()` bench model** (flat belt, aluminium frame, end brackets, right-angle gear motor, IR spot patch) with bench label/sensor positions and camera presets pulled in; status report wired to `readiness.js`. |
| `web/dashboard-ui.js` | New pure helpers: `axisRange`, `formatTime`, `nodeName`, `humanReason`, `sustainedML`, `RULE_TEXT`, `ruleTitle`, `ENGINEERING_CHANNELS`. |
| `web/style.css` | Appended "Product pass" block (summary above model, model height `clamp(300px,44vh,680px)`, toggles, tabs, dialog, diagnostics, alarm pulse with reduced-motion fallback). |
| `web/fonts/` | IBM Plex Sans/Mono + Noto Sans Devanagari woff2 (latin, latin-ext, devanagari; OFL 1.1) + `fonts.css`. 697 KB. |

### Tests added
- `server/components.test.js` — alarm→component mapping, legacy fallback, bench roster (4 tests).
- `tools/dashboard-helpers.test.js` — axis span, IST format, reason/node wording, sustained ML, rule text (5 tests).

### Verification (all on 13 Sept)
- `node --test server/*.test.js tools/*.test.js` → **51 / 51 pass**; `node tools/test-scene3d.js` → **84 / 84 pass**.
- Alarm end-to-end against a live gateway (hand-built MQTT frames): single spike no alarm; 3 consecutive → one planned alarm on **Head shaft bearings**; 9.0 escalates same alarm; 13.0 → urgent; smaller later breach does not downgrade; close records technician + notes; new breach after close → new alarm; restart re-arms open alarm (no duplicate) → **17 / 17 pass**.
- Browser (headless Chrome over CDP, live replay): verdict visible at 1366×768, no developer strings, IST clock, folded channels, engineering toggle, friendly names, local fonts, diagnostics collapsed, no CT/CAM/MARKER labels, alarm card wording, suggested check, tab count, pulse, bearings flagged (not IR spot), dialog close, history "by R. Sharma: adjusted", status report opens, no console errors, no external requests → **29 / 29 pass**.
- **Full healthy recording replayed (10×) through the new rules: 6,527 rows, 2 crest samples > 6.0 ingested (max 7.897), 0 rule alarms, 0 rejects.**

---

## 4. Flaw list status (the 25 from the critique)

| # | Flaw | Status |
|---|---|---|
| 1 | Verdict below the fold at 1366×768 | **Fixed** |
| 2 | 3D labels tiny/overlapping; labels for sensors not installed | **Mostly fixed** (unseen sensors hidden, bench labels placed); label text size unchanged |
| 3 | 3D model ≠ real rig | **Superseded 14 Sept** — default is `model: 'mining'` by user decision (live + playback); `model: 'bench'` still available and matches the rig |
| 4 | Developer strings on screen | **Fixed** on main views (Diagnostics keeps raw topics by design) |
| 5 | Engineering channels, NO SIGNAL rows, 8-state legend | **Mostly fixed**; legend still 8 states |
| 6 | Duplicated info, marketing tagline | **Partly** (tagline removed; condition still in card and state panel) |
| 7 | Chart autoscale exaggerates noise | **Fixed** |
| 8 | "FACTORY" / "Test conveyor 1" | **Fixed** (display names); MQTT site id unchanged |
| 9 | False alarm from desk-default crest limit | **Fixed** via persistence (limit 6.0 unchanged; set a measured limit when the rig is characterised) |
| 10 | Rules vs ML contradiction/flicker | **Fixed** (sustained ML + agreement line) |
| 11 | Alarm lights wrong component | **Fixed** |
| 12 | Open alarm keeps first value | **Fixed** (escalation) |
| 13 | "Ambient" is sensor die temperature | **Fixed** (labels + message) |
| 14 | Close via `prompt()`, anonymous | **Fixed** (named form, outcome list, notes) |
| 15 | No alarm history UI | **Fixed** |
| 16 | `readiness.js` report dead code | **Fixed** (Status report button) |
| 17 | No audible/visual alarm | **Fixed** (chime needs one click on the page first — browser rule) |
| 18 | No login / roles | **Open** (names recorded, not authenticated) |
| 19 | Commissioning = editing config.js | **Open** |
| 20 | Single conveyor, no plant overview | **Open** |
| 21 | No business KPIs | **Open** |
| 22 | English only | **Open** |
| 23 | Google Fonts from internet | **Fixed** |
| 24 | Relay on by default; open writes; MQTT/HTTP unauthenticated | **Partly** — relay OFF by default; **set `RELAY_WRITE_TOKEN` on the relay** if ever enabled; MQTT + dashboard auth still open |
| 25 | No PLC/SCADA path | **Open** |

Also still true: joint/splice sensing absent until the vision sensor lands; nameplate values
and pulley diameter not entered; ML model in-sample.

---

## 5. How to run (from this folder)

```bash
# Live rig (nodes on USB)
./start-pravaah.sh                       # macOS/Linux: gateway + serial bridge
npm start                                # gateway only (Windows: start-beltguard.bat)

# Demo / UI check on recorded data, nothing leaves the laptop
node tools/gateway-offline.js --fresh
node tools/replay-recording.js --dir BeltData/2026-09-06T17-29-57.647Z-a70e3e55-cleaned-v1 --gap 3
# open http://localhost:8811  (click once anywhere so the alarm chime is allowed)

# Tests
node --test server/*.test.js tools/*.test.js
node tools/test-scene3d.js
ML/SIH-2026/.venv/Scripts/python.exe ML/SIH-2026/ml/predict.py --self-test
```

Headless screenshots: Chrome over CDP (`--remote-debugging-port`, `Page.navigate`,
`Page.captureScreenshot`) with `ws` from node_modules. Never `--virtual-time-budget`
(starves the WebSocket). `Network.setBlockedURLs` does not block the WebSocket.
When injecting test frames during a replay, send them < 500 ms apart or real frames
interleave and the persistence rule (correctly) sees no sustained breach.
The laptop has run low on RAM (Windows killed the gateway once) — close heavy apps before a demo.

---

## 6. Reverting

```bash
cd PRAVAAH-main
# what changed since a checkpoint (use the matching fingerprint file)
while read h s t f; do [ "$(sha256sum "$f" 2>/dev/null | cut -c1-16)" = "$h" ] || echo "CHANGED: $f"; done < _snapshots/2026-09-13b_fingerprint.txt

# restore a checkpoint (overwrites files in the archive; files created later are NOT deleted)
sha256sum _snapshots/2026-09-13b_code-state.tar.gz     # compare with _snapshots/2026-09-13b_code-state.sha256
tar -xzf _snapshots/2026-09-13b_code-state.tar.gz -C .
npm install                                            # if node_modules is missing
```

- **Checkpoint 1 (before the product pass):** `_snapshots/2026-09-13_code-state.tar.gz`,
  SHA-256 `8dfbd643fae9c01bfda8e79c89f75955acfcaecab096ed590a18d777a62982ca`,
  fingerprints `_snapshots/2026-09-13_fingerprint.txt`.
  Restoring it does NOT delete files added later: remove `web/fonts/`,
  `server/components.test.js`, `tools/dashboard-helpers.test.js` by hand if you need an exact match.
- **Checkpoint 2 (current):** `_snapshots/2026-09-13b_code-state.tar.gz`, hash in
  `_snapshots/2026-09-13b_code-state.sha256`, fingerprints `_snapshots/2026-09-13b_fingerprint.txt`.

Archives exclude `node_modules`, `ML/SIH-2026/.venv`, `__pycache__`, `BeltData/`, `data/`,
`ConveryBelt/`, `_snapshots/`.

---

## 7. Open decisions for the team
- Next items from §4 (login/roles, settings screen, plant overview, KPIs, Hindi, MQTT/HTTP auth, SCADA).
- Confirm nameplate values and measure the pulley diameter; survey the IR sensor target.
- Measure the rig's healthy crest/RMS distribution and set `vibrationCrest` / `vibrationRmsG` from it.
- Decided 14 Sept: `model: 'mining'` is the default. Switch CV-01 to `model: 'bench'` in `server/config.js` if a demo must show the actual rig.
- Vision sensor: camera model, mount point, `edge/vision_node.py` path.
