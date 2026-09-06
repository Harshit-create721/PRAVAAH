# Conveyor condition monitoring -- SIH 2026

**Unsupervised conveyor condition/anomaly detection using vibration, temperature and RPM
sensor fusion.**

Three ESP32 sensor nodes on conveyor CV-01 are fused into 10-second windows of operating
condition. An Isolation Forest learns the baseline observed operating behaviour and scores
each new window for how unusual it is, with a plain-language explanation of which sensor
drove the score.

```json
{
  "timestamp": "2026-09-06T18:05:01.585000+00:00",
  "temperature": 36.54,
  "ambient": 30.28,
  "rpm": 20.52,
  "vibration_rms": 0.0695,
  "anomaly_score": 99.3,
  "health_score": 0.7,
  "status": "CRITICAL",
  "driver_sensor": "vibration",
  "detector_scores": {
    "joint": 97.1,
    "vibration": 99.3,
    "temperature": 4.3,
    "rpm": 19.7
  },
  "indicators": [
    "vibration_crest_elevated",
    "vibration_range_elevated",
    "vibration_peak_above_baseline",
    "vibration_variability_elevated"
  ],
  "explanation": "Vibration crest factor peaked above the baseline; the spread between minimum and maximum vibration is unusually wide; peak vibration in the window is above the learned baseline; and vibration is fluctuating more than the baseline. Possible mechanical or thermal abnormality -- inspect before drawing a conclusion. This is a statistical deviation from the learned baseline, not a diagnosed fault."
}
```

---

## What this is not

Read this before using any number the system produces.

- **The recorded dataset has no fault labels.** The operator attests the conveyor was
  running normally, so it is treated as an operator-attested normal baseline -- but no
  faulted conveyor was ever recorded. **No real accuracy, precision, recall, F1, failure
  probability or remaining-useful-life figure exists anywhere in this project.**
- **The fault classifier is trained on simulated faults.** Its 0.97 macro-F1 measures
  recovery of hand-written injection recipes, not real fault detection. See
  [Simulated faults](#simulated-faults-and-the-supervised-classifier).
- **`anomaly_score` is not a probability of failure.** It measures how unusual a window is
  relative to the learned baseline, on a 0-100 scale where 50 means "as unusual as the most
  unusual 1% of the baseline".
- **Operator-attested normal is not "verified healthy".** The operator observed normal
  running; nobody inspected bearings, belt or drum. Early-stage degradation would be
  invisible to observation and is therefore baked into the baseline.
- **The system never names a fault mode.** It reports which features deviated. It will say
  "elevated vibration anomaly detected; possible mechanical abnormality", never "bearing
  failure".
- **Thresholds are prototype values**, derived from one recording of one machine. They are
  not industrial safety limits.

Section 9 of `outputs/evaluation_report.md` lists exactly what the evaluation does and does
not establish.

---

## Quick start

```bash
pip install -r requirements.txt

cd ml
python run_pipeline.py            # all 8 stages, ~3.5 min
python run_pipeline.py --fast     # same, skipping the ~70 s parameter sweep
```

Stages: inspect -> train baseline -> evaluate -> generate synthetic faults ->
sensitivity test -> supervised classifier -> plots -> inference self-test. Then:

```bash
python predict.py --demo -n 5               # score 5 windows spanning the score range
python predict.py --demo -n 3 --pick worst  # the 3 most unusual windows found
python predict.py --window-at 2093          # the window at session second 2093
python predict.py --self-test               # verify inference features == training features
```

### Individual stages

```bash
cd ml
python data_inspection.py     # -> outputs/data_quality_report.{md,json}
python preprocessing.py       # print the detected sensor/node structure
python feature_engineering.py # print window and feature counts
python train.py               # -> models/*  outputs/features.csv
python train.py --no-sweep    # skip the parameter sweep
python evaluate.py            # -> outputs/anomaly_scores.csv, evaluation_report.md
python visualize.py           # -> outputs/plots/*.png

python synthetic_faults.py    # -> outputs/synthetic_dataset.csv (simulated faults)
python evaluate_synthetic.py  # -> outputs/synthetic_fault_report.md (sensitivity curve)
python train_supervised.py    # -> models/fault_classifier_{rf,xgb}.joblib
```

### Retrain from scratch

```bash
cd ml && python train.py && python evaluate.py && python visualize.py
```

`train.py` overwrites every artifact in `models/`. Nothing else needs to be cleared.

---

## The data

`ml/config.py` resolves the telemetry file in this order:

1. `$CONVEYOR_TELEMETRY_CSV`
2. `data/telemetry.csv`
3. `data/<recording-dir>/telemetry.csv` -- **where the file actually is in this repo**

The shipped file is
`data/2026-09-06T17-29-57.647Z-a70e3e55-cleaned-v1/telemetry.csv`, left in its recording
directory so its `manifest.json`, `segments.json` and `SHA256SUMS` stay with it. It is not
copied to `data/telemetry.csv`, because a second copy would break that traceability.

### What the file actually contains

| | |
|---|---|
| rows | 6,527 (one row = one frame from one node, **not** one ML observation) |
| segments | 78 discontinuous recording intervals, ~1,062 s retained out of a 2,433 s span |
| nodes | `esp32-vibration-01`, `esp32-thermal-01`, `esp32-marker-01` |
| signals | `vibration_rms`, `vibration_kurtosis`, `vibration_crest`, `acceleration_x/y/z`, `acceleration_magnitude`, `temperature`, `ambient`, `hall_rpm` |
| empty columns | 9 (`motor_current_rms`, `motor_power`, `motor_rpm`, `slip_ratio`, `temperature_delta`, `belt_offset_left`, `belt_offset_right`, `acoustic_rms`, `load_cell_kg`) -- detected and dropped automatically |
| redundant | `belt_speed = 0.0199 x hall_rpm` exactly -- detected and dropped automatically |
| sampling | 2 Hz per node, delivered in ~2 s USB bursts |

Four data-quality problems shape every design decision downstream, all documented with
measurements in `outputs/data_quality_report.md`:

1. **`ts_ms` stalls.** Duplicate `(node, ts_ms)` pairs rise from ~27% early to ~84% late
   while `seq` keeps counting correctly. Window aggregates stay valid; slope features are
   only accurate to about the 2 s burst period.
2. **Temperature is a monotone warm-up**, r = 0.96 with session time. Absolute temperature
   is confounded with *when* a window was recorded.
3. **RPM is effectively constant** (20.37-20.69 RPM, 29 distinct values) and updates only
   every ~3 s. The model has never seen a speed change.
4. **41 of 78 segments are shorter than one window** and contribute nothing.

---

## How it works

### 1. Sensor synchronisation

Each CSV row carries one node's frame with only that node's columns populated. The pipeline
splits rows by `node` into three time-ordered streams, then re-associates them **by
timestamp inside a shared window** -- there is no row-level join, because no row contains
more than one sensor. `preprocessing.detect_sensor_mapping` derives the node/role mapping
from which columns each node actually owns, so a renamed node cannot be silently routed to
the wrong feature block.

### 2. Windowing

**10 s window, 2.5 s step**, chosen from a measured yield study (section 8 of the
data-quality report), not assumed. 10 s at 2 Hz gives ~20 frames per sensor -- about the
minimum for a usable kurtosis estimate -- while 15 s and 20 s windows would drop the
dataset to 84 and 60 windows because the median segment is only ~8 s. The step was reduced
from the 5 s starting point to 2.5 s to double the sample count.

A window is emitted only if all three sensors have >= 8 frames covering >= 60% of its span.
**No window ever crosses a `segment_id` boundary**, and nothing is interpolated across the
removed intervals. Result: **225 windows from 37 segments**. Those windows overlap by 75%,
so they are correlated -- they are not 225 independent observations.

### 3. Features

**75 candidates -> 59 used** after dropping constant and near-duplicate (|r| >= 0.995)
features on the fit set.

| group | features |
|---|---|
| vibration RMS | mean, std, rms, min, max, range, median, p25, p75, kurtosis, crest factor, slope |
| sensor shape factors | mean/std/min/max/range of `vibration_kurtosis` and `vibration_crest` |
| acceleration | mean/std/min/max/range for x, y, z and magnitude |
| temperature | mean, min, max, std, range, slope, change; ambient mean/std/slope |
| temp vs ambient | mean, min, max, std, slope (the drift-robust view) |
| RPM | mean, min, max, std, range, CV, slope, change |
| cross-sensor | `vib_per_rpm`, `vib_std_per_rpm`, `vib_peak_per_rpm`, `temp_over_ambient_per_rpm`, `temp_rise_c_per_min`, `vib_cv`, `rpm_stability`, `vib_instability_at_stable_rpm`, `vib_impulsiveness` |

Features are only built on signals that exist. No feature is invented on top of an empty
column, and slip ratio is not computed because there is no motor-side RPM to compute it
against.

### 4. Model

`IsolationForest`, `n_estimators=600`, `max_samples=128`, `random_state=42`, `n_jobs=-1`,
on `RobustScaler`-scaled features, as an **ensemble**: one joint detector over all 59
features plus one per sensor group (vibration 40, temperature 12, RPM 7), with the
reported score the maximum across detectors. Rationale and measured effect in
[Simulated faults](#simulated-faults-and-the-supervised-classifier). Started from the specified `n_estimators=300` and
selected by a segment-grouped 5-fold sweep over `n_estimators` x `max_samples` x
`contamination`. With no labels there is no accuracy to optimise, so the sweep ranks
settings by seed-to-seed rank stability of held-out scores and by how well the in-fit
outlier rate transfers to held-out segments.

`contamination` turns out not to matter: it only shifts `IsolationForest.offset_` by a
constant, and the score mapping is a robust z-score that cancels constants.

**The deployed model is fitted on all 225 windows.** Fitting only on early windows would
flag every late window as anomalous purely because the machine warmed up, and the dataset
manifest independently requires the whole session to stay in one split. The chronological
early/late split is still run, but reported separately as a *drift diagnostic* (section 5
of the evaluation report), never as a generalisation estimate.

### 5. Score

```
raw   = -IsolationForest.decision_function(x)            higher = more unusual
z     = (raw - baseline_median) / (1.4826 * baseline_MAD)
score = 100 / (1 + exp(-(z - z_mid) / z_scale))          clamped to 0-100
health_score = 100 - anomaly_score                       clamped to 0-100
```

`z_mid` and `z_scale` are fitted so the baseline median maps to ~5 and the baseline 99th
percentile maps to 50. Monotone, bounded, and calibrated to stated baseline quantiles.

Status thresholds come from baseline percentiles (WATCH = p90, WARNING = p98,
CRITICAL = p99.5), rounded, with the realised exceedance rate recorded next to each.
Current values: **WATCH 34.9, WARNING 60.6, CRITICAL 91.7**. They live in
`models/thresholds.json` and can be retuned **without retraining**.

### 6. Explanation

For each window the system computes a robust z-score per feature against the baseline, in
**physical units** (degC, g, RPM), ranks them, and maps deviations above z = 2.5 onto
indicator tags and prose. Indicators and prose come from one ranked list, so the tags can
never disagree with the sentence. If nothing exceeds the threshold the system says so
rather than inventing a story, and no output ever names a mechanical fault mode.

---

## Live ESP32 integration

`ml/predict.py` maintains its own rolling buffers, so the gateway only has to forward
frames as they arrive.

```python
from predict import ConveyorMonitor

monitor = ConveyorMonitor()          # loads model, scaler, feature config, thresholds

for frame in esp32_stream():          # one dict per node frame
    verdict = monitor.push(frame)     # None until a full window is available
    if verdict:
        publish(verdict)              # MQTT / HTTP / dashboard
```

Or pipe newline-delimited JSON:

```bash
your-gateway --json | python ml/predict.py --stdin
```

Each observation is one frame from one node:

```json
{"node":"esp32-vibration-01","ts_ms":1788715800284,"segment_id":"S001",
 "vibration_rms":0.0579,"vibration_kurtosis":3.462,"vibration_crest":2.101,
 "acceleration_x":0.1084,"acceleration_y":-1.0501,"acceleration_z":-0.1527,
 "acceleration_magnitude":1.068}
{"node":"esp32-thermal-01","ts_ms":1788715800657,"segment_id":"S001",
 "temperature":31.57,"ambient":27.91}
{"node":"esp32-marker-01","ts_ms":1788715800665,"segment_id":"S001","hall_rpm":20.59}
```

`ts_ms` is required. `segment_id` is optional but recommended: when it changes the buffers
are cleared, so no window is ever built across a recording boundary. Missing required
fields raise rather than being silently zero-filled, and a backwards clock jump larger than
one window resets the buffers.

With three 2 Hz nodes the first verdict appears after ~10 s of stream and then on roughly
every subsequent frame, since each new frame re-evaluates the current rolling window.
Node names are read from `models/feature_config.json`, so renaming a node in the field
means retraining or editing that file -- it will not be silently misrouted.

**Feature parity is verified, not assumed.** `predict.py` calls the same
`feature_engineering.compute_window_features` as training and reads `feature_order`
straight from the trained artifact. `python predict.py --self-test` replays all 225 recorded
windows through the streaming path: max absolute difference **7.1e-15** across 59 features
(one float ULP), and 25/25 windows re-scored through the real `push()` ingest path.

---

## Simulated faults and the supervised classifier

No faulted conveyor was ever recorded, so `ml/synthetic_faults.py` injects five
deviation shapes (BELT_SLIP, HIGH_VIBRATION, OVERHEATING, RPM_INSTABILITY,
COMBINED_FAULT) into the real baseline windows at five severities.

**The boundary, stated once:** each recipe encodes an *assumption* about how that fault
would look on these three sensors. Nothing here validates that assumption. The class
names denote **shapes of deviation, not diagnosed fault modes**.

Injection is done carefully enough to be worth trusting as a test bench:

- **at raw frame level**, then re-run through the real feature pipeline, so no physically
  impossible feature combination can be produced;
- **onto real recorded windows**, preserving genuine sensor noise, drift and burst timing;
- **re-quantised to each sensor's actual resolution** (RPM/temp 2 dp, vibration 4 dp) --
  otherwise a classifier reaches 100% by detecting float precision, learning "synthetic"
  instead of "faulty";
- **bounded** (RPM > 0, crest >= 1, temperature > ambient).

### The legitimate use: a sensitivity specification

The unsupervised detector never saw a recipe, so its response to these deviations is a
real property of the detector. `outputs/synthetic_fault_report.md` and
`outputs/plots/11_detection_vs_severity.png` give the curve. Detection floors at a 10.2%
false-alarm rate on real normal data:

| deviation shape | detected (>=80% of windows) from |
|---|---|
| HIGH_VIBRATION | ~1.3x vibration RMS |
| BELT_SLIP | ~2.7% speed loss with raised variability |
| RPM_INSTABILITY | ~2x RPM standard deviation |
| COMBINED_FAULT | mildest tested severity |
| OVERHEATING | only at ~+5.7 degC over ambient -- **the weak channel** |

### A real weakness this exposed, and the fix

The first run showed **OVERHEATING was essentially undetectable**: a thermal excursion at
9.7-13.2 degC over ambient, far outside the 6.75 degC baseline maximum, reached WATCH in
barely half of windows, while a 1.33x vibration rise flagged 98.7%.

Cause: **feature dilution.** 40 of the 59 features are vibration and only 12 are thermal,
so Isolation Forest's random splits rarely landed on the channel that had moved.

Fix: an **ensemble of per-sensor sub-detectors** (`models/sensor_detectors.joblib`)
alongside the joint model, each calibrated on the same baseline, with the reported score
being the maximum. At an identical 10.2% false-alarm rate, thermal detection went from
**54.7% to 92.7%**. Inference now also reports `driver_sensor` and per-detector scores,
so the responsible channel is explicit.

OVERHEATING remains the least sensitive channel, and that part is physical rather than a
modelling defect: the baseline legitimately spans a 7 degC warm-up, so temperature must
move a long way before it leaves the observed envelope.

### The supervised classifier: what its 0.97 means

`train_supervised.py` trains Random Forest and XGBoost on the synthetic labels, with a
**segment-grouped** split (each real window spawns 51 synthetic siblings, so a random
split would report near-perfect scores from leakage alone).

| model | macro F1 (segment-grouped 5-fold) |
|---|---|
| RandomForest | 0.966 +- 0.022 |
| XGBoost | **0.973 +- 0.018** |

**Do not present this as fault-detection accuracy.** The classifier is recovering
hand-written recipes it was trained on -- it is graded against my assumptions, not against
the machine. Two further inflations: the class prior is fictional (the grid made ~50x more
fault than normal windows; in service normal is >99%), and only invented deviation shapes
are present, so a real fault matching none of the six labels still gets assigned one.

Its genuine value is **plumbing**: point it at real labelled runs, change the grouping key
to `session_id`, re-run, and the metrics become real. See
`outputs/supervised_model_report.md`.

## Project layout

```
data/2026-09-06T.../telemetry.csv   the recording, with its manifest and segment sidecars
ml/
  config.py                paths, window geometry, schema expectations, model defaults
  preprocessing.py         load, validate, derive node->sensor mapping, split streams
  feature_engineering.py   segment-safe windowing + the feature functions (shared with predict)
  health_score.py          score calibration, thresholds, status, explanations
  train.py                 pruning, baseline screening, sweep, fit, write all artifacts
  evaluate.py              scoring + stability, drift, confounding, model comparison
  visualize.py             the ten plots
  predict.py               real-time inference, --demo / --self-test / --stdin
  run_pipeline.py          run everything
models/
  isolation_forest.joblib  scaler.joblib
  feature_config.json      feature names and order, window geometry, preprocessing, contract
  thresholds.json          prototype status thresholds (editable without retraining)
  baseline_stats.json      per-feature robust baseline, for explanations
  model_metadata.json      training date, dataset, params, splits, known limitations
outputs/
  data_quality_report.md   what the file actually contains, measured
  evaluation_report.md     diagnostics and what they do/don't establish
  features.csv             225 windows x 75 candidate features + metadata
  anomaly_scores.csv       per-window score, status, indicators, explanation
  future_data_collection_plan.md
  plots/                   10 PNGs
```

## Known limitations

Also in `models/model_metadata.json` under `known_limitations`.

1. No fault labels. Nothing is validated against ground truth.
2. One conveyor, one session, ~1,062 s of retained data. Nothing here estimates behaviour
   on another machine, another day or another belt loading.
3. Temperature is confounded with session time (r = 0.96). A rising temperature reading may
   be normal warm-up.
4. The static acceleration channels also drift with session temperature (`temp_mean` vs
   `acceleration_magnitude_mean`, r = 0.76), most likely MEMS thermal bias. An
   `orientation_shift` indicator may reflect sensor warm-up, not a mounting change.
5. RPM varied only between 20.37 and 20.69 and updates every ~3 s. The model has never seen
   a speed change, so RPM-instability detection is untested.
6. Device timestamps stall; slope features are accurate only to ~2 s.
7. No motor current, motor power, motor-side RPM, load, acoustic or belt-offset channel, so
   slip and drive-side faults cannot be observed at all.
8. Windows overlap by 75%; the 225 samples are correlated, not independent.
9. **The alert rate is not yet stable.** Under segment-grouped folds the held-out WATCH rate
   varies widely against the 10% in-fit rate. The thresholds are the least trustworthy part
   of the system.
12. **All fault data is simulated.** The five fault classes are deviation shapes invented in
    `ml/synthetic_faults.py`, never checked against a faulted conveyor. The supervised
    classifier's metrics are circular by construction. A real fault matching none of the six
    labels will still be assigned one of them.
13. **OVERHEATING is the weakest detection channel** -- it needs roughly +5.7 degC over
    ambient before it reliably flags, because the baseline legitimately spans a 7 degC
    warm-up. Physical, not a modelling defect.
10. Isolation Forest, LOF and One-Class SVM agree on the broad ordering (Spearman ~0.81) but
    share only 2-3 of their top-10 most-unusual windows. Which window is "worst" is
    model-dependent.
11. Prototype thresholds, not industrial safety limits.
