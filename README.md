# PRAVAAH — conveyor integrity for Indian mining

**प्रवाह** — *flow*. Real-time monitoring and decision support for conveyor
belt joints and splices on ROM, overland and underground belts.

For the three-sensor USB rig, see [recording real conveyor runs for ML](docs/conveyor-recording.md):
mounting, calibration limitations, and the `npm run record -- --label unlabelled` session recorder.

Built against SIH26008, Ministry of Steel — *AI-Enabled Conveyor Belt Joint
Rupture and Damage Prediction*. The problem statement is a steel-plant one;
the deployment target is a mine, where the same belt carries abrasive ROM
through more dust, more water and longer distances between inspections.

> **Names on disk have not changed.** The MQTT topic prefix is still
> `beltguard/…`, the launcher is still `start-beltguard.bat`, the database is
> still `data/beltguard.db` and the firmware folder is still
> `firmware/beltguard_node/`. That is deliberate: renaming the wire protocol
> would mean reflashing every node already programmed, for no gain. PRAVAAH is
> what the product is called; `beltguard` is what the wire is called.

**This dashboard displays measurements and nothing else.** There is no demo
data, no seeded history, no placeholder readings. A channel nobody has
published shows `NO SIGNAL`. A rule that lacks its inputs is listed under
*Not yet connected* with the reason. A conveyor that has never sent a packet
reads `NO DATA`, not `HEALTHY`. If you see a number on screen, a sensor
produced it.

---

## 1. What runs where

```
  ON THE CONVEYOR                    ON THE LAPTOP                IN A BROWSER
  ───────────────                    ─────────────                ────────────

  ESP32 node                                                       Dashboard
   ├ SCT-013 CT     ──┐                                                 ▲
   ├ LM393 speed      │  WiFi        ┌──────────────────┐               │
   ├ LM393 marker ×2  ├─────MQTT────►│ embedded broker  │               │
   ├ ADXL345 ×2       │  :1883       │        ↓         │  WebSocket    │
   └ MLX90614       ──┘              │ validate + store ├───────────────┘
                                     │        ↓         │      :8811
  USB camera ────────────────────────► rules + alarms   │
   (vision_node.py, same laptop)     │        ↓         │
                                     │  SQLite (WAL)    │
                                     └──────────────────┘
```

One Node process does all four server jobs: it *is* the MQTT broker, the
validator, the database and the web server. Nothing else to install and
nothing to configure between them.

**On the control-room laptop, double-click `start-beltguard.bat`.** It checks that
Node is present and new enough, installs dependencies on first run, prints the
IP address to put in the ESP32 sketch, opens the dashboard, and starts the
gateway. Switches: `/noopen` to skip the browser, `/bench` to also start the
test harness of §9.

From a terminal, equivalently:

```bash
cd C:/Users/OMEN/beltguard && npm install && npm start
```

Either way, open <http://localhost:8811>. It will say it is waiting for the
first packet, and it will keep saying that until one arrives.

---

## 2. What you need to build this week

Straight from §8.2 of the blueprint, with what each part is actually *for* in
this dashboard and what breaks without it.

| # | Part | Qty | ≈ ₹ | Feeds these channels | If you skip it |
|---|------|-----|-----|----------------------|----------------|
| 1 | **ESP32 DevKit v1** | 1 | 350–450 | — | Nothing publishes. Not optional. |
| 2 | **LM393 slot sensor** (speed) | 1 | 41–150 | `belt_speed`, `motor_rpm` | No slip rule, no marker→distance conversion. Half the value gone. |
| 3 | **LM393 slot sensor** (joint marker, left) | 1 | 41–150 | `joint_marker_dt_left`, lap counting | **No per-joint monitoring at all.** This is the core of the project. |
| 4 | **LM393 / reed** (joint marker, right) | 1 | 41–150 | `joint_marker_dt_right` | No L/R asymmetry → mis-tracking and one-sided elongation undetectable. |
| 5 | **ADXL345** | 1–2 | 135–175 ea | `vibration_*`, `event_vibration_*` | No impact signature at joint passage. |
| 6 | **SCT-013-000 split-core CT** + burden/bias board | 1 | 399–448 | `motor_current_rms` | No load context; can't separate a heavy load from a fault. |
| 7 | **MLX90614** IR temp | 1 | 599–1062 | `temperature`, `ambient` | No thermal rule. Lowest priority of the six. |
| 8 | **USB webcam** + fixed mount + LED bar | 1 | 0–650 | `crack_length`, `opening`, `belt_offset` | No visual evidence for a technician to check. |
| 9 | **ArUco 4×4_50 tags**, laminated | 1 per joint | ~0 | joint identity | Joints can't be told apart. |
| 10 | Enclosure, DIN rail, shielded cable, ferrules, 5 V PSU | 1 set | 1500–4000 | — | Works on the bench, fails in the plant. |

**Starter set that gets the dashboard genuinely live: items 1, 2, 3, 5 —
about ₹700.** That alone gives you belt speed, lap counting, one identified
joint, and its impact signature trending against its own baseline. Add 4 and
6 next; 7 and 8 last.

### One thing to decide before you buy

Item 3/4 is the whole project. Pick the marker technology now:

| Option | Reads through | Cost | Watch out |
|--------|---------------|------|-----------|
| **Slot/IR sensor + reflective tag** | nothing — needs line of sight | ₹50 | Coal dust and belt dressing blind it within a shift. Bench use only. |
| **Reed switch + neodymium magnet** | dust, rubber, water | ₹80 | Magnet must be bonded, not bolted. Fast belts need a fast reed. |
| **Hall sensor (A3144) + magnet** | dust, rubber, water | ₹60 | **Recommended.** Solid state, no bounce, survives a factory. |
| RFID tag + reader | dust | ₹1200+ | Overkill for the MVP, but the only option that survives a wash-down bay. |

Take the Hall sensor unless the factory tells you otherwise. Wire it exactly
where the slot sensor would go — the firmware treats them identically.

---

## 3. Wiring

ESP32 DevKit v1. Pins are set at the top of
[`firmware/beltguard_node/beltguard_node.ino`](firmware/beltguard_node/beltguard_node.ino).

| Signal | ESP32 pin | Sensor pin | Notes |
|--------|-----------|------------|-------|
| Speed pulse | **GPIO 27** | LM393 `D0` / Hall `OUT` | Interrupt, `INPUT_PULLUP` |
| Marker left | **GPIO 26** | LM393 `D0` / Hall `OUT` | Interrupt, 20 ms debounce in firmware |
| Marker right | **GPIO 25** | LM393 `D0` / Hall `OUT` | Interrupt |
| CT analogue in | **GPIO 34** | burden-board output | ADC1, **input-only pin**, 0–3.3 V |
| I²C SDA | **GPIO 21** | ADXL345 `SDA`, MLX90614 `SDA` | Shared bus, 4.7 kΩ pull-ups to 3V3 |
| I²C SCL | **GPIO 22** | ADXL345 `SCL`, MLX90614 `SCL` | Shared bus |
| Power | `3V3` | ADXL345, MLX90614 | **3.3 V only.** 5 V destroys the ADXL345. |
| Power | `VIN` (5 V) | LM393 modules | Their `D0` is open-collector; safe to 3.3 V with the pull-up. |
| Ground | `GND` | every module | **One common ground.** Star it at the ESP32. |

Avoid GPIO 6–11 (flash) and don't hang anything that pulls at boot on GPIO
0, 2, 12 or 15.

### The SCT-013 is the one that can hurt you

The CT clamps *around one conductor* — never in series, never opened while
the primary is energised. Its output must go through a **burden resistor and
a 1.65 V bias divider** before GPIO 34; wired raw, it swings negative and
kills the ADC input.

```
   SCT-013 ─┬──[ 33Ω burden ]──┬── GPIO 34
            │                  │
   3V3 ──[10k]──┬──[10k]── GND  │      (mid-rail bias = 1.65 V)
                └────[10 µF]────┘
```

**A qualified electrician does the panel-side work.** Do not open a motor
panel, do not clamp anything on a VFD output, do not connect an ESP32 to
control wiring. §8.5 of the blueprint is not boilerplate. If the factory
won't allow a CT, ask whether the VFD already reports current over Modbus —
that path is safer *and* better data, and the gateway can read it instead.

---

## 4. Connecting a node to the dashboard

1. **Find the laptop's IP** on the factory WiFi:

   ```bash
   ipconfig
   ```

   Take the IPv4 address of the wireless adapter, e.g. `192.168.1.100`.

2. **Set five lines** at the top of the sketch:

   ```c
   #define WIFI_SSID   "your-ssid"
   #define WIFI_PASS   "your-password"
   #define MQTT_HOST   "192.168.1.100"   // the laptop
   #define CONVEYOR_ID "CV-01"           // must match server/config.js
   #define NODE_ID     "esp32-drive-01"  // any unique name
   ```

3. **Enable only the sensors you actually wired:**

   ```c
   #define ENABLE_SPEED  1
   #define ENABLE_MARKER 1
   #define ENABLE_ADXL   1
   #define ENABLE_CT     0   // still off — not wired yet
   ```

   Leaving a flag at `0` means that field is omitted from the JSON, and the
   dashboard shows `NO SIGNAL`. **Never set a flag to 1 to make the screen
   look full** — you would be publishing a number no sensor produced, and the
   baseline would learn it.

4. **Allow the port through Windows Firewall**, once:

   ```bash
   netsh advfirewall firewall add rule name="PRAVAAH MQTT" dir=in action=allow protocol=TCP localport=1883
   ```

   ```bash
   netsh advfirewall firewall add rule name="PRAVAAH HTTP" dir=in action=allow protocol=TCP localport=8811
   ```

5. **Flash and watch.** The serial monitor at 115200 prints the IP and each
   joint pass. The dashboard's *Sensor nodes* panel shows the node within a
   second of its first packet; the banner clears on the first telemetry frame.

Both ports also make the dashboard reachable from a phone on the same WiFi at
`http://192.168.1.100:8811` — useful when the technician is at the belt and
the laptop is not.

### Camera node

Runs on the same laptop, publishes to the same broker:

```bash
pip install -r edge/requirements.txt
```

```bash
python edge/vision_node.py --calibrate
```

Click two points a known distance apart on a ruler laid in the belt plane, then:

```bash
python edge/vision_node.py --marker-mm 40 --reference-centre 360
```

`--marker-mm` is the printed side length of your ArUco tag and gives a scale
measured in every frame, so the numbers survive the camera being nudged.
Without a scale the node **suppresses** its millimetre outputs rather than
publishing pixel counts that look like millimetres.

---

## 5. The wire contract

Every topic is `beltguard/<site>/<conveyor_id>/<kind>`. Site and conveyor come
from `server/config.js`; the live version is served at
<http://localhost:8811/api/contract>.

| Topic | Published by | When |
|-------|--------------|------|
| `beltguard/factory/CV-01/telemetry` | ESP32 | every 500 ms |
| `beltguard/factory/CV-01/joint` | ESP32 | on each marker passage |
| `beltguard/factory/CV-01/vision` | camera node | on each marker passage |
| `beltguard/factory/CV-01/analysis` | your model, later | whenever it scores |
| `beltguard/factory/CV-01/node/<id>/status` | every node | retained, + last will |

**telemetry**

```json
{ "ts": 1756012345678, "node": "esp32-drive-01", "seq": 10422,
  "motor_current_rms": 6.42, "belt_speed": 1.83, "motor_rpm": 1452,
  "vibration_rms": 0.084, "vibration_kurtosis": 3.12, "vibration_crest": 4.05,
  "temperature": 41.2, "ambient": 29.8,
  "sensor_health": { "speed": "healthy", "ct": "missing" } }
```

**joint** — the ESP32 half of one passage

```json
{ "ts": 1756012345678, "node": "esp32-drive-01", "joint_id": "J01", "lap": 214,
  "belt_speed": 1.83,
  "joint_marker_dt_left": 812.4, "joint_marker_dt_right": 828.9,
  "marker_distance_left": 1486.7, "marker_distance_right": 1516.9,
  "event_vibration_rms": 0.31, "event_vibration_peak": 1.42, "event_kurtosis": 7.9 }
```

**vision** — the camera half of the *same* passage

```json
{ "ts": 1756012345690, "node": "vision-01", "joint_id": "J01", "lap": 214,
  "belt_offset": -4.2, "crack_length": 12.4, "opening": 1.1,
  "image_quality": 0.91, "cv_confidence": 0.86,
  "evidence_frame": "/evidence/J01_20260824-201530.jpg" }
```

Both carry the same `joint_id` and `lap`, so the gateway **merges them into
one pass record**. That is why the camera node must count laps the same way
the ESP32 does — one increment per marker detection.

### Three rules that keep the data honest

1. **Omit what you did not measure.** No `0`, no `-1`, no `null`. Absent means
   absent, and the dashboard says so.
2. **Out-of-range is rejected, not clamped.** A clamped value is an invented
   value. Rejects appear with their reason in the *Ingest* panel — watch that
   panel when you first bring a sensor up; it is the fastest debugger you have.
3. **Field names are fixed** (Appendix C of the blueprint). Anything else is
   ignored silently — check `/api/contract` if a value isn't appearing.

---

## 6. Calibration — do this before you trust a single number

Nothing below is optional. Every derived figure inherits these errors.

| # | What | How | Goes in |
|---|------|-----|---------|
| 1 | `PULSES_PER_REV` | Count the slots in the encoder disc | sketch |
| 2 | `WHEEL_CIRC_MM` | Measure the wheel Ø, ×π | sketch |
| 3 | Belt speed check | Chalk mark, stopwatch over 10 laps, vs displayed `belt_speed` | must agree within 2 % |
| 4 | `pulleyDiameterMm`, `gearRatio` | Drive pulley Ø and motor:pulley ratio | `server/config.js` |
| 5 | `beltLengthM` | Tape measure round the loop | `server/config.js` |
| 6 | `CT_CALIBRATION` | Compare against a clamp meter on a known load | sketch |
| 7 | `mm_per_px` / `--marker-mm` | Ruler in the belt plane | camera CLI |
| 8 | Camera focus | Run `--calibrate`, keep the focus score over 60 | lens |

Until #4 and #5 are entered the dashboard shows an amber banner and disables
the slip rule — it will not pretend to compute what it cannot.

**Then let it learn.** Each joint needs `baselineLaps` (default 20) clean
passes before it is compared against itself. During that window the joint
table shows `7/20` instead of a risk. The baseline **locks** at 20 passes, so
a joint that degrades later cannot drag its own reference along with it.

---

## 7. What the dashboard does with the data

Deterministic and explainable — every alarm carries the numbers that produced
it. No black box, and no model is claimed where none exists.

| Rule | Fires on | Needs |
|------|----------|-------|
| `marker_asymmetry` | L/R marker timing differs > 1.5 % | both marker sensors |
| `marker_drift_left/right` | Spacing drifts > 2 % from that joint's own baseline | marker + speed |
| `impact_rise` | Passage vibration RMS > 40 % above baseline | ADXL345 + marker |
| `belt_offset` | Lateral displacement > 15 mm | camera |
| `crack_growth` | Crack trend exceeds its own uncertainty **and** 0.05 mm/lap | camera, ≥ 10 passes |
| `slip_ratio` | Measured speed > 5 % below what the drive should give | speed + config geometry |
| `thermal_delta` | Surface > 15 K above ambient | MLX90614 |
| `motor_overcurrent` | Motor current against rated current | CT + `driveRatedCurrentA` |

`crack_growth` deserves a note, because it is where a demo usually lies: the
fit must beat **twice its own standard error** before it counts. Four noisy
measurements always produce *some* slope; this refuses to call that a growing
crack, and says so in *Not yet connected* instead.

Thresholds live in `server/config.js` and are all **deviations from each
joint's own learned baseline**, not absolute limits — which is what makes them
safe to ship without knowing your belt.

### Headroom, not just breaches

Every rule reports a **ratio** — the measured value over its configured limit
— whether or not it breached. `0.82` means "at 82 % of the limit". The
severity of a component follows from that ratio alone:

| Ratio | State | Alarm raised |
|-------|-------|--------------|
| < 0.75 | nominal | no |
| 0.75 – 1.0 | **approaching limit** | no |
| 1.0 – 2.0 | plan inspection | yes |
| ≥ 2.0 | urgent | yes |

The 0.75 figure is `APPROACH_FRACTION` in `server/rules.js` — the one number
here that is a judgement rather than a measurement, kept in a single named
constant so it can be argued about in one place. Approaching parts are flagged
on the schematic but raise **no alarm**; crossing the limit is still what
raises one.

### The machine is the diagnostic surface

The conveyor is drawn as an interactive **3D model** — not a schematic. It is
a mining ROM belt with the parts a fitter would name: a troughed carrying run
on three-roll idler sets, impact idlers under the loading chute, a
self-aligning set, flat return idlers, head and tail pulleys with a snub and a
bend pulley, a screw take-up at the tail, a shaft-mounted gearbox and motor at
the head, the belt scraper, the stringer frame, and the statutory pull-cord.

That level of detail is not decoration. Wear is reported **per component**, so
an operator has to be able to match the part on screen to the part in front of
them, and that only works if the picture is of their machine rather than of
two circles and a line.

Drag to orbit, scroll or `+`/`-` to zoom, arrow keys to rotate from the
keyboard, `ISO / SIDE / TOP / HEAD / TAIL` for named positions and `Reset` to
come home. Every part is a hit target coloured by what the rules currently
measure about it — hover for the cause: the rule, the measured value, the
limit, and a bar showing where it sits between them.

Beside the model, **Component health** lists every part with its state and its
wear bar, grouped by assembly. The 3D view answers *where*; the list answers
*how many, and which ones* without orbiting to find the parts hiding behind
the belt. Click a row to pick the part out in the model; click again to clear.

The wear bar is the fraction of its allowed deviation a part has already used,
taken straight from the rule that judged it. Nothing is extrapolated and no
remaining-life figure is invented: a part with no rule gets a dashed, empty
track, not a full green bar.

The renderer is `web/scene3d.js`: rotation matrices, perspective divide,
back-face culling, painter's depth sort, flat shading from a single light,
plus lofted surfaces for the troughed belt and arbitrary-axis cylinders for
the wing rolls. No three.js, no CDN, no build step — this runs on a plant
laptop that may have no internet, and vendoring an engine is a bad trade. It
draws to SVG rather than WebGL so every face stays a DOM element: hover, click
and keyboard focus work without raycasting, and it stays sharp at any zoom.

A settled frame is about 1100 faces; while you are dragging it drops detail
and draws about half that, then redraws at full quality the moment you let go.
The frame an operator actually reads is never the cheap one.

It does **not** auto-rotate. This sits on a wall display for a whole shift, and
something that never stops moving is something people stop looking at.

Check the maths with:

```bash
node tools/test-scene3d.js
```

Those tests are not ceremony. The renderer is the one part of this dashboard
that can be wrong in a way you cannot see by looking at it: with the camera
pitch inverted, the machine renders from *underneath* and every stringer and
leg counts as nearer than the belt, so the frame paints straight over the load
it carries. It shades plausibly and looks almost right. `pitch puts the camera
above the machine` is the test that pins it down.

Attribution comes from `server/components.js`, which maps each part to the
channels that watch it and the finding families that belong to it. Evidence can
arrive either from a telemetry channel or from a joint passage — belt tracking
is judged by marker asymmetry and lateral offset at each joint, not by any
channel of its own.

Most of this machine is **unmonitored**, and the model says so rather than
hiding it: the parts nothing can see are drawn as bare steel with a dashed
outline. Every one of them carries a `sensorHint` — the one sensor that would
light it up — shown in the roster and in the tooltip. That turns the picture
into a coverage map and an instrumentation roadmap at the same time, which is
the conversation a mine's E&M department will actually want to have.

Four states mean **"we cannot vouch for this"**, and none of them is green:

| State | Meaning |
|-------|---------|
| `UNMONITORED` | No sensor on this rig reports on it. The tail pulley is the honest example — the blueprint's sensor set has nothing at that end. The roster names the sensor that would fix it. |
| `NO RULE` | Signal is arriving but no rule evaluates it, usually a missing config value such as the geometry `slip_ratio` needs. |
| `SENSOR LOST` | It had a sensor and the sensor stopped reporting. |
| `NOMINAL` | A rule actually ran, reached a verdict, and the verdict was clean. |

The distinction between the first three and the last is the whole point: *"we
have no sensor here"* and *"this part is fine"* must never look the same. A
component is only green when a rule reached a verdict — having a live reading
is not enough. The idler colour speaks for the **one spot** the IR sensor
reads, and its tooltip says so; a seizing idler elsewhere is invisible to it.

Risk ladder: `HEALTHY → OBSERVE → PLAN INSPECTION → URGENT INSPECTION →
CRITICAL`, plus `NO DATA` before anything is measured. The conveyor's level is
the worst open alarm. Acknowledge an alarm from the dashboard, and close it
with what the inspection found — that outcome is written to the `maintenance`
table and is your labelled dataset for the model later.

### Adding your model

Train offline on the SQLite file, then publish scores to the `analysis` topic:

```json
{ "ts": 1756012345678, "model_version": "iforest-v0.3",
  "operating_state": "steady", "risk": "urgent_inspection", "trend": "rapid_deterioration",
  "scores": { "joint_degradation": 0.84, "mistracking": 0.18, "slip_tension": 0.31 },
  "joint_scores": { "J01": 0.84 },
  "evidence": ["left marker timing +2.2%", "impact RMS +63%"],
  "data_quality": 0.93 }
```

A model score outranks the rule layer in the header. Until you publish one,
the header says `rule layer` — it never shows a model that isn't running.

---

## 8. Suggested order for the week

| Day | Do | You'll know it worked when |
|-----|----|----------------------------|
| 1 | ESP32 + WiFi + MQTT, all sensor flags `0` | node appears in *Sensor nodes*, all channels `NO SIGNAL` |
| 2 | Speed sensor, calibrate #1–#3 | `belt_speed` matches your stopwatch within 2 % |
| 3 | Marker sensor (left) | J01 appears in the joint table and lap count climbs |
| 4 | ADXL345 + right marker | `impact_rise` and `marker_asymmetry` leave *Not yet connected* |
| 5 | Run 20+ clean laps | joint table shows `20/20`, baseline locks |
| 6 | Camera + calibrate #7–#8 | evidence frames open from the joint drawer |
| 7 | Controlled fault on a **spare** joint | an alarm fires with its measured evidence |

Day 7 is the SIH demo. A belt going healthy → warning → urgent on stage, with
the numbers behind it on screen, is the whole pitch.

---

## 9. Testing the plumbing before hardware exists

```bash
node tools/bench-publisher.js --fault splice --reject
```

This is a **wire-protocol test harness, not a demo mode**. It proves topics
route, payloads validate, rows store, rules fire and the browser updates. Its
numbers mean nothing about any belt, it publishes under a `bench-*` node id,
and the dashboard shows a red **BENCH SOURCE ACTIVE** banner the whole time
it runs.

Kill it and delete `data/beltguard.db` before your first real capture, so
bench rows never contaminate a baseline.

---

## 10. Safety

- Qualified electrician for anything inside a motor panel. No exceptions.
- Never clamp a CT on a VFD output; never connect the ESP32 to control wiring.
- Lockout/tagout before mounting anything. Never adjust a moving conveyor.
- Mount sensors, markers and cameras so they cannot become a snag, a
  projectile or a source of belt damage. Bond tags outside the load-carrying
  area and clear of the splice itself.
- Do not modify an airport/X-ray machine's radiation generator, curtains,
  interlocks or certified control chain. Use external modules or
  decommissioned equipment.
- **The alarms are decision support, not a safety system.** Nothing here is
  wired to stop a machine, and it must not be until it has been validated,
  hazard-assessed and interlocked properly.

---

## 11. Layout

```
beltguard/
├── server/
│   ├── index.js      gateway: broker, ingest, HTTP, WebSocket
│   ├── config.js      ← your site, geometry and thresholds go here
│   ├── schema.js      the wire contract + range validation
│   ├── store.js       SQLite time series, baselines, alarms, maintenance
│   └── rules.js       the explainable rule layer
├── web/               dashboard (no build step, no framework)
├── firmware/beltguard_node/   ESP32 sketch
├── edge/vision_node.py        camera node
├── start-beltguard.bat        double-click launcher (Windows)
├── tools/bench-publisher.js   protocol test harness
└── data/
    ├── beltguard.db   raw telemetry pruned at 14 days; joints/alarms kept
    └── evidence/      captured frames
```

**Files to edit:** `server/config.js` (geometry, thresholds) and the top of
the `.ino` (WiFi, broker, pins, calibration). The rest runs as-is.
