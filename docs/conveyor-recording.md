# Record the three-sensor conveyor

Updated 6 September 2026. This is the operating guide for the USB rig. Read the
[collection plan](dataset-collection-plan.md) for the campaign and model scope,
the [data dictionary](dataset-schema.md) before preparing training rows, and
the [debugging report](sensor-debugging.md) for firmware changes and evidence.
Earlier roller-magnet examples and half-second pulse counting instructions are
superseded for this rig.

## Confirmed setup

| Item | Configuration |
|---|---|
| Conveyor | `factory / CV-01` |
| Full belt loop | **1.20 m**, confirmed by the operator |
| Hall target | One taped magnet on the moving belt, one detection per loop |
| Hall calculation | `hall_rpm = 60 / loop_seconds`; `belt_speed = 1.20 / loop_seconds` |
| Hall input | GPIO27, input pull-up; actual module supply/output wiring needs inspection |
| Acceleration/vibration | ADXL345, SDA21/SCL22, 200 Hz FIFO, ±8 g; summaries every 500 ms |
| Temperature | MLX90614, SDA21/SCL22, 100 kHz SMBus with PEC checks; reads every 500 ms |
| Transport | Three ESP32 USB serial ports at 115200 baud → bridge → local MQTT → recorder and gateway |
| Dashboard | `http://localhost:8811` |

Identify ports from each board's published `node`, not USB suffix alone. The
verified mapping was thermal `usbserial-0001`, vibration `usbserial-5`, Hall
`usbserial-6`. Record actual mounting location, orientation and IR target; these
have not been independently surveyed. Online sensors do not establish normal
mechanical condition.

Use USB firmware **0.2.2** for the new campaign. It retains the 0.2.1 temperature
and vibration definitions and corrects Hall pulse timestamping and artificial
between-pass RPM decline. Verify version strings in raw frames and preserve
source hashes. Do not mix older speed features without a compatibility review.

## Before each run

1. Record an inspection and the actual condition, speed setting and load.
   Unknown load stays unknown; `--load-kg 0` means verified no load.
2. Keep sensor mounting, aim, magnet count and wiring fixed within a run. Make
   physical adjustments with the conveyor stopped and isolated; keep stationary
   boards and cables clear of the moving belt and pinch points.
3. Leave the gateway running if it is already up. Otherwise start it from this
   repository with `./start-pravaah.sh`.
4. Check all three nodes and actual channels: advancing Hall pass count while
   moving, valid temperature and acceleration/vibration. `Motor speed` stays
   absent because the belt magnet does not measure motor RPM. **12/20 channels**
   is expected; the others require additional sensors.
5. Stop any bench publisher. The live recorder filters known `bench-*` sources;
   this is a naming convention, not authentication.
6. Check disk space and laptop clock. Avoid flashes, bridge restarts, laptop
   sleep and clock changes during a labelled run.

Secure the ADXL rigidly at an appropriate stationary measurement point and
record that point. Mounting affects vibration; see the [ADXL345 mounting
guidance](https://www.analog.com/media/en/technical-documentation/data-sheets/ADXL345.pdf).
Record IR target, gap and variant; surface properties and field of view affect
its reading. See the [MLX90614 documentation](https://www.melexis.com/en/documents/documentation/datasheets/datasheet-mlx90614).

## Start and stop recording

In a second terminal inside `PRAVAAH`, this five-minute check requires no claim
about the mechanical condition:

```bash
npm run record -- --label unlabelled --state unknown --hall-target belt --duration 300 --notes "Acquisition check; condition and load not verified"
```

Only after operator inspection and after settling at a constant speed, an
inspected empty-belt example is:

```bash
npm run record -- --label normal_inspected --state steady --load-kg 0 --hall-target belt --duration 900 --notes "Inspection evidence and mount details recorded in annotation.json"
```

Add `--speed-setting` with the actual observed controller setting. Replace load
zero with a measured mass for a loaded run. For unknown condition use
`unlabelled`; for unknown load omit `--load-kg`.

Wait for `Recording subscribed`. Timed runs end the specified wall-clock duration
after the first subscription, including any later outages. Ctrl+C closes and
syncs an untimed capture. Start a new session whenever speed, load, mounting or
intended condition changes.

For startup/shutdown, record with `--label unlabelled --state unknown` and add
observed state intervals afterward. The recorder has no interactive state-change
command: its label/state describe the whole session. Never label a mixed
stopped/startup/steady capture entirely `steady`.

```bash
npm run record -- --help
```

## Files and interpretation

Each run creates a unique directory under `data/recordings/`. These directories
are gitignored, never automatically pruned by the recorder, and **not automatically
backed up**. The dashboard database has **14-day telemetry retention**; session
files are the dataset acquisition source.

| File | Meaning |
|---|---|
| `session.json` | Original operator label/state/load/notes, configuration snapshot, units and timestamp interpretation |
| `frames.jsonl` | MQTT topic, arrival time and parsed payload, including firmware/diagnostics; raw telemetry, **not raw acceleration samples** |
| `telemetry.csv` | One message per row; validated channels, sequence, node, health and validation issues; blanks mean missing |
| `joint.csv` | Legacy event table; current belt-magnet firmware emits no joint events, so a header-only file is expected |
| `excluded.jsonl` | Retained, malformed, unidentified or wrong-source messages, with reasons |
| `events.jsonl` | Recorder subscription, connection and stop events |
| `summary.json` | Counts and final signal arrival status, written on clean completion |

Sync occurs every five seconds and on close. Missing summaries and partial
final lines require review; preserve originals. Retained startup status messages
are normally excluded, so inspect reasons before interpreting exclusions as loss.

Three nodes publish roughly two telemetry frames/second each; status messages
are additional. A thermal row does not contain vibration or RPM. Firmware and
diagnostics are **not** flattened into the CSV: keep `frames.jsonl`. The recorder
subscribes to MQTT, so the gateway-derived `temperature_delta` is normally absent;
derive it from valid paired temperature registers during preprocessing.

The bridge publishes at QoS 0. A recorder QoS 1 subscription cannot recover
upstream losses. Timestamps are laptop bridge/recorder arrival times, not
hardware-synchronised sample times. Never fill missing sensors with zeros or
reuse stale readings. See the [data dictionary](dataset-schema.md).

## Review and preserve each run

1. Check `summary.json` and numeric telemetry from each expected node. `receiving`
   describes arrival only; it does not prove measurement quality.
2. Apply the [v1 quality rules](dataset-collection-plan.md#quality-rules-for-v1)
   to health, diagnostics, sequences, timing and Hall periods. The recorder does
   **not** perform this full dataset acceptance review automatically.
3. Copy [session-annotation.json](templates/session-annotation.json) into the
   capture as `annotation.json`. Fill inspection evidence, mount identity and
   reviewed label. Use [interval-annotations.json](templates/interval-annotations.json)
   for mixed-state runs. These are manual sidecars; the recorder does not read them.
4. Keep unreviewed sessions out of normal-model training. Preserve the original
   label; record later corrections, evidence and review dates in the annotation.
5. Copy complete sessions, annotations and source snapshots to a second storage
   location. Verify SHA-256 checksums. A backup destination is still to be selected.

The recorder does not train models, diagnose faults or control the conveyor.
