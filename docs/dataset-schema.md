# Dataset dictionary and processing contract

Version: proposed dataset v1, 6 September 2026. Acquisition implementation:
`tools/record-session.js` and `tools/lib/recording.js`; wire schema:
`server/schema.js`; calculations: `firmware/pravaah_serial_node/sensor_math.h`.
Use with the [collection plan](dataset-collection-plan.md).

## Sensor identities and rates

| Node | Sensor | Internal acquisition | Telemetry |
|---|---|---|---|
| `esp32-vibration-01` | ADXL345 | 200 samples/s, FIFO, full resolution ±8 g | About 2 frames/s, normally 99–100 samples/frame |
| `esp32-thermal-01` | MLX90614 | Reads object and sensor temperature registers; native conversion depends on module settings | About 2 frames/s; repeated register reads are not guaranteed independent conversions |
| `esp32-marker-01` | Hall switch | Timestamped GPIO27 transitions, 128-slot interrupt queue, 2 ms minimum HIGH and LOW phases | About 2 frames/s; independent speed updates only when a new valid period is measured |

Firmware 0.2.2 is the campaign version. Do not infer the flashed binary from a
filename or Git commit: verify per-frame firmware and preserve build/source
hashes. USB suffixes can change; printed node names are logical identities, not
unique authenticated chip serial numbers. Label the physical boards in the
experiment inventory if interchangeability matters.

## Available numeric channels

The three sensors produce eleven numeric channels; the gateway adds one thermal
difference, giving twelve live dashboard channels. Missing values are absent
from payloads and blank in CSV. They are never zero placeholders.

| Field | Unit | Exact meaning / qualification |
|---|---|---|
| `hall_rpm` | belt loops/min | `60,000,000 / period_us` for one magnet; not motor or roller RPM |
| `belt_speed` | m/s | `hall_rpm × 1.20 / 60`; calculated, not an independent speed sensor |
| `vibration_rms` | g | Dynamic three-axis vector RMS after subtracting each axis's own window mean |
| `vibration_crest` | ratio | Maximum dynamic vector magnitude / vector RMS in the half-second window |
| `vibration_kurtosis` | ratio | Pearson moment kurtosis of the signed axis having greatest variance; not excess kurtosis; selected axis may change between windows |
| `acceleration_x`, `acceleration_y`, `acceleration_z` | g | Per-axis half-second means, including gravity and sensor offset; not raw time series |
| `acceleration_magnitude` | g | Mean of per-sample vector magnitudes, including gravity; not the magnitude of mean XYZ |
| `temperature` | °C | MLX90614 object/surface estimate from register 0x07 |
| `ambient` | °C | MLX90614 sensor-package temperature from register 0x06; not an independent room-temperature probe |
| `temperature_delta` | K | Surface minus sensor temperature; gateway-derived, normally blank in the MQTT recorder CSV; calculate from the same valid thermal frame |

The firmware converts acceleration using 256 LSB/g. For samples a_i and their
three-axis mean m, dynamic RMS is `sqrt(mean(||a_i - m||²))`. Crest and kurtosis
are omitted at effectively zero variance. Kurtosis is `mean(d⁴) / mean(d²)²`
on the highest-variance axis, without small-sample bias correction. It is a
noisy statistic from approximately 100 points, not a standalone diagnosis.
These definitions come from the actual firmware, not the old dashboard labels.

MLX raw temperature conversion is `raw × 0.02 - 273.15`. Both PEC and the error
bit are checked. Decimal formatting is not a claim of thermometer accuracy.
IR target properties, aim and mounting remain part of calibration metadata.

Do not use absent `motor_current_rms`, `motor_power`, `motor_rpm`, `slip_ratio`,
`belt_offset_left/right`, `acoustic_rms` or `load_cell_kg` as zero-valued features.
Operator-supplied `load_kg` is metadata, separate from the absent load-cell channel.

## Hall semantics and edge cases

One accepted pulse requires both input phases to persist at least 2 ms. Version
0.2.2 references the qualifying rising edge for both period and pulse age. This
works with short or long LOW duty cycles. A magnet held in front of the sensor
does not count repeatedly. Motion and sensor electrical polarity still require
physical verification; a pulse counter alone does not certify one pass/loop.

The first accepted edge has no period. A second edge within the acquisition
interval is needed. Acquisition allows less than 60 seconds between edges.
After acquiring a period, the last measured RPM is held until the next valid
period or no-pulse timeout. Timeout is three periods, bounded to 5–60 seconds.
After timeout, zero RPM can be emitted if a valid period was previously measured;
health becomes `stale`. After an isolated pulse with no measured period, speed
stays absent. A restart requires two edges to measure the new period.

Therefore repeated half-second speed rows are not independent magnet detections,
and zero cannot distinguish a physical stop from missed detection. Record both
raw diagnostics and operator state. The old 0.2.1 ageing estimate could generate
an artificial slowdown, especially when LOW lasted most of a loop. Quarantine
those speed features; do not repair them silently in an original capture.

## Raw frame envelope and diagnostics

`frames.jsonl` has one JSON object per accepted MQTT message:

```json
{
  "received_at_ms": 1788711210033,
  "topic": "beltguard/factory/CV-01/telemetry",
  "payload": {"node": "esp32-marker-01", "seq": 1796, "firmware": "pravaah-serial-node 0.2.1"}
}
```

This is an abbreviated structural illustration of an earlier message, not a
complete current training example. Real payloads retain numeric channels,
health and diagnostics. The recorder parses and reserialises JSON; it preserves
field values, including unknown fields, not the original byte formatting.
Malformed/source-rejected messages go to `excluded.jsonl` with their original
text and reason. Accepted health-only telemetry is preserved even without numbers.

| Diagnostic | Meaning and dataset use |
|---|---|
| `sensor_health.mlx/vibration/speed` | Sensor-side validity; healthy, fault, clipped, missing or stale as appropriate; not a machine fault label |
| `firmware` | Actual version reported by the node; retain even though CSV omits it |
| `seq` | Per-node telemetry counter; detect gaps, duplicate/reset/out-of-order data; not a time or mechanical label |
| ADXL `samples`, `odr_hz` | Frame sample count and configured output data rate |
| `read_errors` | Cumulative I2C/validation failures since boot; thermal retries can increase this even if a later retry succeeds |
| ADXL `invalid_samples`, `fifo_overruns` | Cumulative invalid raw values and full/overflow-risk FIFO observations |
| MLX `pec_checked` | Whether checked temperature reads are used |
| Hall `pulses` | Cumulative qualified pulses since boot; increments, not the absolute value, describe the window |
| Hall `raw_edges` | Cumulative GPIO interrupts before qualification; includes noise; not magnet count |
| Hall `period_ms` | Last accepted inter-edge period; 0 means no current measured period |
| Hall `last_pulse_age_ms` | Time since the qualified edge in 0.2.2; absent before any accepted edge |
| Hall `pin_level` | Instantaneous 0/1 electrical input; not a velocity |
| Hall `low_pulses`, `last_low_us`, `max_low_us` | Completed LOW count and widths; maximum is lifetime-since-boot, not a per-window maximum |
| Hall `edge_overflows` | Cumulative full interrupt-queue observations; affected windows need review |
| Hall `magnets_per_cycle`, `hall_target` | Flashed calibration/target, expected 1 and `belt` |

Counter deltas require a preceding frame within the same boot/segment. Nonzero
old counts do not invalidate all subsequent data; increasing counts or resets
need interval-specific review. Record boot boundaries and guard intervals.

## Recorder CSV and metadata

Each telemetry CSV row starts with:

| Column | Meaning |
|---|---|
| `session_id` | Immutable unique capture folder identity |
| `label`, `source`, `conveyor` | Original operator description, live/synthetic source, asset ID |
| `received_at_ms` | Recorder's laptop receipt time, UTC epoch milliseconds |
| `ts_ms` | Validated publisher time; USB bridge supplies laptop arrival time |
| `node`, `seq` | Logical source and node-local telemetry sequence |
| `seq_gap` | Positive missing-sequence count relative to previous received frame for that node |
| `seq_reset` | 1 when sequence decreases; may indicate reboot or reordering |
| `sensor_health` | JSON text within the CSV cell |
| `quality_issues` | JSON text listing schema warnings/rejections/repeated or reset sequence; not a full dataset QA result |

Then come the channel columns from `server/schema.js`. Finite range validation
only establishes plausibility. Validated rows can still have sensor-quality
problems; the parser does not automatically exclude every unhealthy numeric row.
`summary.counts.valid_telemetry` means at least one numeric channel validated,
not that all expected sensors or every diagnostic passed.

A status frame is stored in `frames.jsonl`, but does not generate a telemetry
CSV row. `summary.by_node` includes status messages; use telemetry rows to
calculate the approximately 2 Hz sample coverage. The first sequence row lacks
a previous-frame comparison. Retained messages are excluded, even if recent.

`session.json` format version 1 records label, `operating_state`, known/null
`load_kg`, `speed_setting`, `hall_target`, notes, channel schema and asset config.
It does not automatically snapshot source code, actual mount geometry, inspection
evidence or the firmware binary. Add the manual annotation and provenance files.

## Proposed reviewed export

A future window builder should emit one row per 30-second window. This table is
an implementation contract, not an existing export command:

| Field group | Proposed fields |
|---|---|
| Identity and boundaries | `dataset_version`, `session_id`, `segment_id`, `episode_id`, `window_start_ms`, `window_end_ms`, `window_seconds` |
| Provenance | `configuration_id`, `mount_id`, `feature_version`, `quality_version`, `annotation_revision` |
| Context and truth | `reviewed_condition`, `operating_state`, known/null `load_kg`, `speed_setting`, `thermal_stage`, `label_confidence` |
| Validity | `usable_for_normal_training`, `rejection_reasons`, unique valid counts per node, gaps, diagnostic increments |
| Measurements | Explicitly named aggregates such as `vibration_rms_median_g`, `belt_speed_median_mps`, `surface_temperature_median_c`, `temperature_slope_c_per_min` |
| Split | `train`, `validation`, `test` or `quarantine`, assigned to whole independent groups |

Intervals use `[start_ms, end_ms)` boundaries. Join each node's samples inside
the same window, not by CSV row position. Thermal differences use paired reads
from the same frame. Do not interpolate across reboots/outages or into the
future. Quality thresholds, features, causal lookback and grouping are defined
in the [collection plan](dataset-collection-plan.md).

Current CSV/JSONL files can support slow statistical features. They cannot
reconstruct raw XYZ waveforms, precise cross-board phase or verified joint
passages. New raw-waveform collection needs a separately versioned contract.
