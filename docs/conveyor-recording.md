# Recording the real conveyor for machine learning

The existing USB setup uses three ESP32 boards, one each for the ADXL345,
MLX90614 and A3144. It already publishes telemetry to MQTT and SQLite. The
session recorder adds labelled, permanent captures outside the dashboard's
14-day telemetry retention. It does not train a model or establish a fault diagnosis.

## What these sensors can tell us

| Sensor | Suggested first mounting position | Available readings |
|---|---|---|
| ADXL345 | Rigid mount on the stationary drive-bearing housing or adjacent rigid support; record orientation | Vibration RMS, kurtosis, crest factor |
| MLX90614 | Fixed bracket aimed at that bearing housing or motor surface, with an unobstructed view | Surface temperature and sensor-package temperature (called `ambient` in the protocol) |
| A3144 | Fixed bracket facing a securely attached magnet on a roller, at a repeatable gap | Pulse timing and rotation-speed estimate |

Mount with the conveyor powered off and isolated. Keep boards and cables on
stationary structure, clear of the moving belt and pinch points. Fix the
vibration board rigidly: a loose breadboard measures its own movement.
The ADXL345 manufacturer explains why mounting near a rigid attachment matters
in its [datasheet, mechanical mounting section](https://www.analog.com/media/en/technical-documentation/data-sheets/ADXL345.pdf).
The MLX90614 field of view depends on the variant; the target should fill it,
and shiny metal can give misleading IR temperatures. Its `ambient` reading is
the sensor's temperature, not an independent room thermometer. Check the
[manufacturer's documentation](https://www.melexis.com/en/documents/documentation/datasheets/datasheet-mlx90614).

These channels are a useful starting point for learning normal behaviour and
flagging unusual vibration, heating or speed patterns. A score alone does not
identify a broken splice or predict when rupture will occur. For that target,
collect inspected joint condition, identifiable joint passages, relevant
measurements such as images/spacing, and observed deterioration or failure
outcomes over time. Normal-only data can support novelty detection; see
[scikit-learn's explanation](https://scikit-learn.org/stable/modules/outlier_detection.html).

## Start a capture

Plug in the three ESP32 boards. From the `PRAVAAH` directory, start the existing
gateway and bridge if they are not already running:

```bash
./start-pravaah.sh
```

In a second terminal, also in `PRAVAAH`, start a run. Choose the label from
what you actually know; `unlabelled` is appropriate before inspection:

```bash
npm run record -- --label unlabelled --hall-target roller --notes "First mounting check"
```

The recorder prints the new session folder and subscription confirmation. Every
five seconds it prints counts and whether temperature, vibration and RPM are
arriving, stale or absent. `receiving` describes data arrival only; inspect the
sensor-health fields and physical readings to determine measurement quality.
Ctrl+C flushes files and writes a summary. No numeric telemetry makes the
recorder exit with a failure status so an empty run is not mistaken for success.

After confirming normal mechanical condition, an example steady, empty-belt
run is:

```bash
npm run record -- --label healthy_empty --state steady --load-kg 0 --hall-target roller --duration 600 --notes "Inspected before run; fixed sensor mounts"
```

Use `--load-kg` only for a known applied load, and `--speed-setting` for an
observed controller setting. Neither is inferred from a sensor. Use separate
captures for startup, steady operation and stopping, and stop/restart a capture
when the intended condition changes. The label applies to every row in that
session; starting a steady-state recording while the belt is still stopped
would mislabel that interval. Timed runs end the specified wall-clock duration
after the first successful subscription, including any later outages.

```bash
npm run record -- --help
```

## Files and interpretation

Every run creates a unique folder in `data/recordings/`. The recorder never
prunes these folders and never overwrites a previous session. Copy completed
folders to your dataset backup; watch free disk space during long campaigns.

| File | Contents |
|---|---|
| `session.json` | Operator label, load, speed setting, Hall target, notes, asset configuration and channel units |
| `frames.jsonl` | Unmodified accepted MQTT payloads with topic and recorder arrival time |
| `telemetry.csv` | One row per telemetry message, with validated numeric channels, node, sequence, health and quality issues |
| `joint.csv` | One row per incoming Hall/joint event; repeated lap numbers remain separate |
| `excluded.jsonl` | Rejected source, retained, malformed and unidentified messages, with reasons; exclude this file from training |
| `events.jsonl` | Subscription, disconnection, reconnection and stop events |
| `summary.json` | Final counts and signal status, created on a clean stop |

Files are appended as packets arrive and explicitly synced every five seconds
and on a clean stop. A power loss can lose recent data or leave a partial final
line; an absent summary indicates the capture did not complete normally.
The recorder cannot recover packets lost before it received them. The existing
USB bridge publishes at MQTT QoS 0, so the recorder's QoS 1 subscription alone
cannot guarantee delivery. Sequence gaps and connection events are evidence
for rejecting incomplete training windows, not a recovery mechanism.

Missing channels stay blank. The three boards publish separately, so a thermal
row does not also contain vibration and RPM. Assemble training windows using
timestamps and node identity later; do not turn blanks into zero or repeatedly
reuse stale readings. `ts_ms` is the validated publisher time, and
`received_at_ms` is recorder arrival time. USB publisher timestamps already
come from the laptop bridge; this is not hardware synchronisation. Preserve
session boundaries, quality flags, restart indicators and health information.

Known `bench-*` synthetic sources are excluded from live captures. This is a
convention check, not source authentication. Stop the bench publisher during
real acquisition. To deliberately test the recorder with the bench harness,
use `--source synthetic`; the default output becomes `data/synthetic-recordings/`.
Do not train a real-machine model on those protocol-test values.

## Firmware and calibration work before a training campaign

1. **Choose what the Hall sensor watches.** The current serial firmware emits
   both `motor_rpm` and `joint_id: J01` from the same pulse stream. A roller
   magnet measures roller rotation, not motor rotation or belt-joint passage.
   `--hall-target` records the choice but does not change firmware behaviour.
   Joint rows are flagged as unverified unless you specify `belt`; even then
   you must verify the marker actually identifies the intended physical joint.
   Do not use roller pulses as joint-degradation labels. If the magnet is on
   the belt, the current roller-RPM conversion is not valid.
2. **Measure speed geometry.** Set `MAGNETS_PER_REV` to the actual magnet count
   and `ROLLER_CIRC_MM` to the measured circumference when sensing the roller.
   Belt speed from a drive roller assumes no slip between that roller and belt.
   An independent belt-motion reference is needed to measure that slip.
   Match metadata in `server/config.js`; do not guess unknown values.
3. **Check low-speed RPM.** The current counter window is about 500 ms. With
   one magnet, one pulse changes the reported value by roughly 120 RPM.
   A slowly rotating conveyor can therefore alternate between zero and 120 RPM
   while moving steadily. For that rig, period-based timing with an appropriate
   no-pulse timeout is needed before using speed as a training feature.
4. **Decide whether raw vibration is needed.** Current firmware polls roughly
   every 5 ms and emits magnitude-based statistics every 500 ms. The buffer holds
   at most 128 samples; it normally collects about 100 per output window. Raw
   X/Y/Z samples and their timing are not transmitted or saved. `frames.jsonl`
   cannot recover them. For frequency analysis or directional fault signatures,
   add timestamped axis capture and verify actual sampling, clipping and gaps.
5. **Resolve the ADXL345 rate mismatch.** Firmware writes `BW_RATE = 0x0C`,
   whose comment says 200 Hz but whose actual output rate is 400 Hz, while the
   loop polls at about 200 Hz. The datasheet specifies `0x0B` for 200 Hz (Table
   7). Match device rate, bandwidth and acquisition timing during firmware
   calibration; do not infer an accurately sampled 200 Hz waveform from the
   current code. [ADXL345 datasheet](https://www.analog.com/media/en/technical-documentation/data-sheets/ADXL345.pdf)

The recorder does not flash boards or alter these calibration values.

## Build a dataset that can answer the prediction question

Start with an acquisition pilot: record the stationary rig, startups, empty
steady running, and known safe loads at the available speeds. For a first
check, 5–10 minutes per steady condition across several independent runs is
useful for discovering mounting noise, lost packets and repeatability issues.
This is a pilot, not a claim of sufficient data to predict failure. Thermal
behaviour may need longer runs to approach a stable temperature.

Repeat normal conditions across days. Record maintenance, inspections, mounting
changes, load, commanded speed, and confirmed fault observations. Keep unknown
conditions labelled unknown. Alarm-rule output is not independent ground truth.
Do not damage, jam or overload a moving conveyor to generate fault examples.

For an initial anomaly model, assemble complete quality-checked windows and
compare vibration statistics and temperature trends at similar speed/load.
Fit normalisation and the model only on training sessions. Hold out complete
later runs or days for evaluation, with a gap between adjacent windows; random
splitting of neighbouring samples can inflate measured performance.
[scikit-learn's guidance on grouped and time-series validation](https://scikit-learn.org/stable/modules/cross_validation.html)
explains the reason. Assess false alarms on held-out healthy operation and
detection against independently confirmed events before making prediction claims.
