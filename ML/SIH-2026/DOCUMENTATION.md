# Technical documentation — conveyor condition monitoring

Deep reference for `ML/SIH-2026/`. For orientation, the working rules and the honesty
constraints, read [`AGENTS.md`](AGENTS.md) first. For a user-facing overview, see
[`README.md`](README.md).

This reference describes the current code and includes clearly marked historical comparisons.
Regenerate the artifacts with `python ml/run_pipeline.py`. Seeds are fixed at 42, but code,
dependency and platform changes can change results; use the generated reports for current numbers.

**Contents**
1. [System overview](#1-system-overview) · 2. [Data](#2-data) ·
3. [Processing pipeline](#3-processing-pipeline) · 4. [Feature catalogue](#4-feature-catalogue) ·
5. [Model and artifacts](#5-model-and-artifacts) · 6. [Scoring](#6-scoring) ·
7. [Explainability](#7-explainability) · 8. [Synthetic faults](#8-synthetic-faults) ·
9. [Evaluation](#9-evaluation) · 10. [Inference](#10-inference-api) ·
11. [Decision log](#11-decision-log) · 12. [Reproducing / extending](#12-reproducing-and-extending)

---

## 1. System overview

```
telemetry.csv (6,527 rows, 3 interleaved node streams)
        │
        ▼  preprocessing.py — split by node, derive sensor roles, drop dead/redundant cols
3 time-ordered sensor streams  (vibration 2,192 · thermal 2,173 · speed 2,162 frames)
        │
        ▼  feature_engineering.py — 10 s windows, 2.5 s step, never crossing a segment
225 windows × 75 candidate features
        │
        ▼  train.py — prune to 59, RobustScaler, fit IF ensemble, calibrate
models/  (joint + 3 per-sensor detectors, scaler, calibration, thresholds)
        │
        ├─▶ evaluate.py            → anomaly_scores.csv, evaluation_report.md
        ├─▶ synthetic_faults.py    → 11,475 SIMULATED fault windows
        │      └─▶ evaluate_synthetic.py → sensitivity curve  (non-circular)
        │      └─▶ train_supervised.py   → RF/XGBoost scaffold (circular)
        ├─▶ visualize.py           → 11 plots
        └─▶ predict.py             → live JSON verdicts
```

**Historical stage timings** (original full run 210 s; current runtime depends on the environment): inspection 3 s, training 74 s (of which ~70 s is the
parameter sweep), evaluation 50 s, synthetic generation 21 s, sensitivity 1 s, supervised
21 s, plots 3 s, self-test 44 s.

---

## 2. Data

### 2.1 Location and resolution

`ml/config.py::resolve_telemetry_path()` searches, in order:
`$CONVEYOR_TELEMETRY_CSV` → `data/telemetry.csv` → `data/*/telemetry.csv`.

The shipped file is `data/2026-09-06T17-29-57.647Z-a70e3e55-cleaned-v1/telemetry.csv`,
kept in its recording directory so `manifest.json`, `segments.json`, `excluded-*` and
`SHA256SUMS` stay with it. It is **not** duplicated to `data/telemetry.csv` — a second
copy would break that traceability chain.

### 2.2 Shape

| property | value |
|---|---|
| rows | 6,527 (one row = one frame from **one** node) |
| columns | 34 |
| segments | 78 discontinuous intervals |
| retained | ~1,062 s within a 2,433 s wall-clock span |
| session | `2026-09-06T17-29-57.647Z-a70e3e55`, conveyor `CV-01` |
| `label` | `unlabelled` (operator reported running; health condition unverified) |
| firmware | `pravaah-serial-node 0.2.2` on all 6,527 frames |

The CSV is a **sparse long/wide hybrid**. A thermal row has blank vibration columns —
that is structural, not missing data. There is no row containing all three sensors, which
is why fusion is done by timestamp inside a window rather than by a row-level join.

### 2.3 Channel dictionary

Authoritative source is the parent repo's `docs/dataset-schema.md`. Summarised here with
the traps that matter for modelling:

| column | node | unit | notes |
|---|---|---|---|
| `hall_rpm` | marker | belt loops/min | `60e6 / period_us`, one magnet on a **1.20 m belt loop**. **Not** motor or roller RPM. Held until the next valid period. |
| `belt_speed` | marker | m/s | `hall_rpm × 1.20 / 60`. Derived, **dropped** by the pipeline as redundant. |
| `vibration_rms` | vibration | g | Dynamic 3-axis vector RMS after removing each axis's own window mean, over ~100 samples at 200 Hz. |
| `vibration_crest` | vibration | ratio | Max dynamic vector magnitude / vector RMS in the half-second window. |
| `vibration_kurtosis` | vibration | ratio | **Pearson (not excess) kurtosis** of the highest-variance axis; **that axis can change between frames**. Noisy from ~100 points. |
| `acceleration_x/y/z` | vibration | g | Per-axis half-second **means, including gravity**. Not a raw time series — mostly DC orientation. |
| `acceleration_magnitude` | vibration | g | Mean of per-sample vector magnitudes. Not the magnitude of the mean XYZ. |
| `temperature` | thermal | °C | MLX90614 object/surface estimate (register 0x07). |
| `ambient` | thermal | °C | MLX90614 **sensor-package** temperature (register 0x06). **Not a room-temperature probe.** |
| `ts_ms` | all | ms | For the USB bridge this is **laptop arrival time**, not an acquisition clock. |
| `seq` | all | int | Per-node counter. No gaps or resets in this recording. |
| `segment_id` | all | str | Retained-interval identity. Never window across it. |

**100% null, dropped automatically** (never use as zero-valued features):
`motor_current_rms`, `motor_power`, `motor_rpm`, `slip_ratio`, `temperature_delta`,
`belt_offset_left`, `belt_offset_right`, `acoustic_rms`, `load_cell_kg`.

Consequence: there is **no motor-side signal at all**, so slip ratio is not computable —
slip is by definition motor speed versus belt speed, and only the belt side is measured.

### 2.4 Measured characteristics

| finding | measurement | consequence |
|---|---|---|
| Sampling | 2 Hz nominal per node, delivered in ~2 s USB bursts of ~4 frames | Window aggregates valid; slopes accurate only to ~2 s |
| Timestamp collapse | duplicate `(node, ts_ms)` 27% early → 84% late | Expected (arrival time), not a firmware bug. No per-sample timing. |
| Thermal drift | temperature +5.3 °C over the session, r = 0.96 with time | Absolute temperature encodes *when*. Dominant modelling constraint. |
| Speed constancy | 20.37–20.69, 29 distinct values, held ~6 frames (~3 s) | Matches the belt-loop period (~2.93 s). One operating point only. |
| Vibration stationarity | r = 0.045 with time; 0.0672 → 0.0670 g | No degradation trend — observed during running, without verified health labels. |
| Impulsive events | 4 frames with kurtosis > 8 or crest > 4 | **Not periodic** (gaps 1270/190/292 s vs 2.93 s belt loop) → isolated transients, not a repeating splice/roller signature. |
| Segment fragmentation | median ~8 s; 41 of 78 below 10 s | Those segments yield no ML sample. |
| Accel thermal bias | `acceleration_magnitude_mean` vs `temp_mean` r = 0.76 | Static channels drift with warm-up, likely MEMS bias. |

The splice-periodicity check is directly relevant to SIH26008 (joint rupture): a belt
joint passes the sensor **once per belt loop**, so a splice defect should appear as a
periodic impulse at ~2.93 s. None was found in this recording.

---

## 3. Processing pipeline

### 3.1 `preprocessing.py`

Returns a `SensorStreams` dataclass: `raw`, `streams` (role → frames), `node_to_sensor`,
`sensor_signals`, `segments`, `dropped_all_null`, `redundant_pairs`, `validation`.

- **`detect_sensor_mapping`** — a node *owns* a column if it supplies **every** non-null
  value of it. Roles are derived from ownership, cross-checked against
  `config.EXPECTED_NODES`; **the data wins**. A renamed node cannot be silently misrouted.
- **`find_redundant_signals`** — fits `y = ax + b` between every numeric pair and drops
  the dependent one when max relative residual < 1e-3. This is what catches
  `belt_speed = 0.0199387 × hall_rpm + 0.00126` (max rel. residual 2.6e-4), matching the
  documented `× 1.20 / 60`.
- **`build_segment_table`** — boundaries measured from the CSV, cross-checked against
  `segments.json`.

### 3.2 `feature_engineering.py`

**Window geometry: 10 s window, 2.5 s step (75% overlap).** Chosen from a measured yield
study, not assumed — §8 of `outputs/data_quality_report.md` has the table:

| window | step | windows | segments covered | frames/sensor |
|---|---|---|---|---|
| 10 s | 5 s | 118 | 35 | 20 |
| **10 s** | **2.5 s** | **225** | **37** | **20** |
| 8 s | 2 s | 305 | 42 | 16 |
| 15 s | 5 s | 84 | 24 | 30 |
| 20 s | 5 s | 60 | 20 | 40 |

10 s at 2 Hz gives ~20 frames per sensor, about the minimum for a usable kurtosis or
percentile estimate; 15 s and 20 s collapse coverage because the median segment is ~8 s.

**Validity gate** — input validation rejects invalid health/non-finite/range values and discontinuities. A full window is emitted only if every required sensor has ≥ 8 frames
spanning ≥ 60% of the window. 3 of 228 candidates were rejected.

**Independence caveat:** 75% overlap means the 225 windows are correlated. Effective
independent count is nearer the 118 a 5 s step gives, and nearer still to the **37
distinct segments**. Never quote 225 as a sample size in a statistical claim.

---

## 4. Feature catalogue

**75 candidates → 59 used.** Pruning (on the fit set only): 0 zero-variance, 16
near-duplicates at |r| ≥ 0.995. Group balance of the 59: **vibration 40, temperature 12,
RPM 7** — this imbalance is what forced the ensemble in §5.

| block | features | count |
|---|---|---|
| `vib_rms_*` | mean, std, rms, min, max, range, median, p25, p75, kurtosis, crest_factor, slope_per_s | 12 |
| `vib_kurt_sensor_*`, `vib_crest_sensor_*` | mean, std, min, max, range each | 10 |
| `acceleration_{x,y,z,magnitude}_*` | mean, std, min, max, range each | 20 |
| `temp_*` | mean, min, max, std, range, slope_per_s, change | 7 |
| `ambient_*` | mean, std, slope_per_s | 3 |
| `temp_over_ambient_*` | mean, min, max, std, slope_per_s | 5 |
| `rpm_*` | mean, min, max, std, range, cv, slope_per_s, change | 8 |
| cross-sensor | `vib_per_rpm`, `vib_std_per_rpm`, `vib_peak_per_rpm`, `temp_over_ambient_per_rpm`, `temp_rise_c_per_min`, `temp_over_ambient_rise_c_per_min`, `vib_cv`, `rpm_stability`, `vib_instability_at_stable_rpm`, `vib_impulsiveness` | 10 |

Notes:

- `temp_over_ambient_*` reconstructs the documented `temperature_delta` channel
  (object minus sensor die), which is blank in the CSV. It is the drift-robust view of
  the thermal signal — but see §2.3: `ambient` is not room temperature.
- Every statistic function is **total**: it returns a finite float for any input, so a
  degenerate window can never inject NaN/inf into the model.
- Slope features use OLS against in-window seconds, returning 0.0 when there is no time
  spread to fit. Given ~2 s timestamp granularity they are coarse; do not read them as
  fine derivatives.
- Cross-sensor `*_per_rpm` features are near-degenerate **in this dataset** because RPM is
  effectively constant — they are a rescaled copy of their numerator. They are kept
  because they are the right features for a rig that varies speed.
- Metadata columns (`window_id`, `segment_id`, `n_*_frames`, `n_distinct_ts_*`, …) are
  carried in `outputs/features.csv` but are **excluded from the model** — frame counts
  describe transport quality, not machine condition.

---

## 5. Model and artifacts

### 5.1 The ensemble

Four `IsolationForest`s, all with `n_estimators=600, max_samples="auto", contamination=0.02,
random_state=42, n_jobs=-1, bootstrap=False`, on `RobustScaler`-scaled features:

| detector | features | artifact |
|---|---|---|
| `joint` | all 59 | `models/isolation_forest.joblib` |
| `vibration` | 40 | `models/sensor_detectors.joblib` |
| `temperature` | 12 | *(same file)* |
| `rpm` | 7 | *(same file)* |

Reported `anomaly_score` = **max** of the four calibrated scores; `driver_sensor` records
which won. On the real baseline the driver distribution is temperature 85, RPM 69,
vibration 65, joint 6 — i.e. all four contribute, none is vestigial.

**Parameter selection.** `n_estimators` started at the specified 300 and was chosen by a
segment-grouped 5-fold sweep with fold-local feature selection/scaling over `{100,300,600} × {auto,64,128} × {auto,0.02,0.05}`.
With no labels there is no accuracy to optimise, so the criterion is **stability**:
seed-to-seed Spearman rank agreement of held-out scores (winner 0.955), then how closely
the held-out outlier rate tracks the in-fit rate (0.027). This measures consistency, not
skill.

**`contamination` is inert** for reporting: it only shifts `offset_` by a constant, and
the score is a robust z-score that cancels constants. It affects only `predict()` labels.

**`RobustScaler`, not `StandardScaler`** — median/IQR so a handful of impulsive windows
do not compress the scale for everything else.

### 5.2 Artifact reference

| file | contents |
|---|---|
| `isolation_forest.joblib` | joint detector |
| `sensor_detectors.joblib` | dict of the 3 per-sensor detectors |
| `scaler.joblib` | fitted `RobustScaler` |
| `feature_config.json` | `feature_names`/`feature_order`, window geometry, required input columns per sensor, node→role map, `feature_groups` (name → column indices), `score_calibration`, `score_calibration_by_group`, pruning record, `ensemble` rationale, and the inference contract |
| `thresholds.json` | status thresholds, their derivation, realised baseline exceedance, disclaimer |
| `baseline_stats.json` | per-feature robust median/scale/percentiles **in physical units**, for explanations |
| `model_metadata.json` | training date, environment, dataset provenance, window/feature counts, model params, sweep results, split description, baseline screening, `known_limitations` |
| `fault_classifier_{rf,xgb}.joblib`, `fault_classifier_labels.json` | supervised scaffold — **synthetic labels**, see §8 |

**`feature_config.json` is the contract.** `predict.py` reads `feature_order` from it and
selects columns in exactly that order. Change a feature → retrain, or inference breaks
silently.

---

## 6. Scoring

### 6.1 Calibration

```
raw   = -IsolationForest.decision_function(x)            higher = more unusual
z     = (raw - raw_median) / raw_mad_scaled              robust, MAD-based
score = 100 / (1 + exp(-(z - z_mid) / z_scale))          clamped to [0, 100]
health_score = 100 - anomaly_score                       clamped to [0, 100]
```

Joint-detector constants currently: `raw_median = -0.077047`, `raw_mad_scaled = 0.019801`,
`z_mid = 4.830605`, `z_scale = 1.640586`. Each sub-detector has its own set in
`score_calibration_by_group`.

`z_mid` and `z_scale` are fitted so the **baseline median maps to ~5** and the **baseline
99th percentile maps to 50**. Hence:

> **Each detector maps its own baseline p99 raw score to 50. The maximum across detectors is not an ensemble percentile. It does not
> mean a 50% chance of anything.**

The mapping is monotone and bounded, so extremes saturate toward 100 instead of diverging.
MAD-based z is affine-invariant, which is why `baseline_stats.json` can be fitted on
unscaled features and still yield identical z-scores — that is what lets explanations
quote °C, g and RPM instead of scaler units.

### 6.2 Thresholds

| status | threshold | derivation | realised baseline exceedance |
|---|---|---|---|
| WATCH | 33.9 | baseline p90 | 10.22% |
| WARNING | 62.2 | baseline p98 (floor: watch + 2) | 2.22% |
| CRITICAL | 93.7 | baseline p99.5 (floor: warning + 2) | 0.89% |

Live in `models/thresholds.json` and **retunable without retraining**.

Two honest caveats:

1. **Circular by construction.** Thresholds are baseline percentiles, so the baseline
   status mix (NORMAL 202 / WATCH 18 / WARNING 3 / CRITICAL 2) is guaranteed, not
   discovered. It shows the scale behaves as designed, not that 23 windows are faulty.
2. **Unstable.** Under segment-grouped folds the held-out WATCH rate swings widely against
   the 10% in-fit rate. With 225 correlated windows from 37 segments, between-segment
   variation dominates. **This is the least trustworthy part of the system.**

A better scheme once more normal data exists: set thresholds from a **false-alarm budget**
("at most 1 WATCH per hour of normal running") rather than a percentile. At a 2.5 s step,
p90 implies ~2.4 WATCH alerts per minute of healthy running — nobody would leave that on.

---

## 7. Explainability

`health_score.explain(x_row_unscaled, baseline_stats, status)` returns `indicators`
(machine-readable tags), `explanation` (prose) and `top_deviations` (ranked, in physical
units).

Mechanics: per-feature robust z against the baseline → rank by |z| → keep only |z| ≥ 2.5 →
map onto `INDICATOR_RULES` (feature, direction, tag, phrase). **Indicators and prose come
from one ranked list**, so the tags can never disagree with the sentence.

Guarantees:

- A window with no material deviation gets *"Operating condition is consistent with the
  learned baseline"* — never a fabricated story.
- A NORMAL window with one mild deviation is prefixed *"Overall condition is within the
  normal band…"* so it does not read as an alert.
- WARNING/CRITICAL append *"Possible mechanical or thermal abnormality — inspect before
  drawing a conclusion. This is a statistical deviation from the learned baseline, not a
  diagnosed fault."*
- **No rule names a fault mode.** Adding one would need a validated fault model that does
  not exist.
- ≥ 2 sensors deviating adds `multiple_sensors_deviating` and a *"Multiple sensor
  indicators changed simultaneously"* lead.

---

## 8. Synthetic faults

**All fault data in this project is simulated.** `ml/synthetic_faults.py` injects five
deviation shapes into the real baseline windows at severities `{0.15, 0.3, 0.5, 0.75, 1.0}`
× 2 repeats → **11,475 rows** (225 NORMAL + 2,250 per class).

Recipes are documented in `RECIPE_DOC` inside the module. Summary of what severity 1.0
actually produces:

| class | vibration RMS | RPM mean | RPM std | temp over ambient |
|---|---|---|---|---|
| BELT_SLIP | ×1.60 | −18.0% | ×9.4 | +1.45 °C |
| HIGH_VIBRATION | ×3.50 | — | — | — |
| OVERHEATING | — | — | — | +6.45 °C |
| RPM_INSTABILITY | ×1.35 | — | ×17.7 | — |
| COMBINED_FAULT | ×2.36 | −6.0% | ×8.6 | +2.91 °C |

### Five properties that make it a usable test bench

1. **Injected at raw frame level**, then re-run through the *real* feature pipeline — so
   no physically impossible feature combination can be produced (e.g. a higher
   `vib_rms_mean` with an unchanged `vib_rms_max`).
2. **Applied onto real recorded windows**, preserving genuine noise, drift, burst timing
   and cross-sensor correlation. Nothing is drawn from a fitted distribution.
3. **Re-quantised to each sensor's real resolution** (RPM/temp 2 dp, vibration/accel 4 dp,
   shape factors 3 dp). Without this a classifier reaches ~100% by detecting float
   precision — learning "synthetic" rather than "faulty".
4. **Physically bounded** — RPM > 0, crest ≥ 1, kurtosis ≥ 1, temperature > ambient.
   Integrity check reports 0 violations and 0 non-finite values.
5. **Severity is continuous**, so the deliverable is a response *curve*, not one number.

### What it can and cannot answer

> ✅ *"How large must a deviation of this shape be before the detector reacts?"*
> ❌ *"Does the system detect belt slip?"*

The recipes encode assumptions about how faults would look on these three sensors,
never checked against a faulted conveyor. **Class names denote shapes of deviation, not
diagnosed fault modes.**

---

## 9. Evaluation

### 9.1 Unsupervised (`evaluate.py` → `outputs/evaluation_report.md`)

Contains **no** accuracy/precision/recall/F1/ROC/failure-probability/RUL figure. It reports:

1. Score distribution and status mix.
2. **Segment-grouped stability** — fit on 4/5 of segments, score the held-out fifth.
3. **Chronological drift diagnostic** — earliest 70% of segments fit, latest 30% scored.
   Reported as *drift*, never as generalisation: the evaluation half is 2.5 °C hotter
   purely from warm-up while vibration barely moves (0.06703 → 0.06715 g). Both halves
   come from one prototype on one day; the dataset manifest asks for the whole session to
   stay in one split, which the deployed model honours and this diagnostic deliberately
   breaks in isolation.
4. **Feature/time confounding** — 11 of 59 features exceed |ρ| = 0.7 with session time
   (7 thermal, 4 static-acceleration). No `vib_*` or `rpm_*` feature reaches it.
5. **Model comparison** — LOF and One-Class SVM vs Isolation Forest. Global agreement
   Spearman ~0.81, but they share only **2–3 of their top-10** most-unusual windows. The
   tail is what a threshold acts on, so *which* window is worst is model-dependent.
6. **Feature parity check** — max |diff| 7.1e-15 over 225 windows × 59 features.

### 9.2 Sensitivity (`evaluate_synthetic.py` → `outputs/synthetic_fault_report.md`)

**Non-circular**, because the unsupervised model was fitted only on real windows and has
never seen a recipe. Detection floors — lowest severity at which ≥ 80% of windows reach
WATCH, against a **10.2% in-fit baseline threshold exceedance**:

| class | floor | physical size |
|---|---|---|
| HIGH_VIBRATION | 0.15 | vibration ×1.37 |
| BELT_SLIP | 0.15 | vibration ×1.09, RPM −2.7%, RPM std ×1.7 |
| RPM_INSTABILITY | 0.15 | vibration ×1.05, RPM std ×2.9 |
| COMBINED_FAULT | 0.15 | vibration ×1.19, RPM −0.9%, RPM std ×1.7 |
| OVERHEATING | 0.75 | +4.8 °C object-minus-sensor-package change |

Also audits whether the explanation layer names a sensor the fault was actually injected
into. **This table is the honest substitute for a demanded accuracy figure.**

### 9.3 Supervised (`train_supervised.py` → `outputs/supervised_model_report.md`)

| model | macro F1, segment-grouped 5-fold |
|---|---|
| RandomForest | 0.963 ± 0.021 |
| **XGBoost** | **0.968 ± 0.021** |

**This is circular and must never be quoted as field accuracy.** The classifier recovers
hand-written recipes it was trained on. Recall is ≈0.95 even at the mildest severity —
the fingerprint of learning a deterministic transform.

Two further inflations: the class prior is fictional (~50× more fault than normal windows;
the real in-service class distribution is unknown), and only invented shapes are present, so a real fault matching
none of the six labels still gets assigned one.

The split is **segment-grouped** for a hard correctness reason: each real window spawns 51
synthetic siblings, and a random split would report near-perfect scores from leakage alone.

Its value is an implementation scaffold. Real fault evaluation additionally needs verified labels,
compatible feature windows, session-held-out splits and a separately reviewed evaluation protocol.

---

## 10. Inference API

The complete live contract and command examples are maintained in [README.md](README.md#live-input-contract).
`data_contract.py` validates identity, health, finite measurements, physical ranges and timestamps.
`streaming.py` maintains synchronized half-open 10 s windows at 2.5 s cadence, closes them on
an all-sensor watermark and resets on gaps, sequence discontinuities or reversed timestamps.
The offline finite-recording flush is bounded by the last observed timestamp, never wall time.

`ConveyorMonitor.push()` emits one verdict or `None`; `drain()` retrieves additional closed
windows. `data_status(now_ms)` expires stale input during silence. Invalid observations raise
`ValueError` after clearing buffers. The stdin worker emits structured quality states and keeps
running; its `worker_ready` handshake lets the gateway avoid queueing data while models load.

`server/ml-worker.js` supplies raw MQTT frames to `predict.py --stdin`. Results appear in
`conveyors[].ml` in gateway/relay snapshots and the web/mobile ML condition cards. Model scores
are separate from measured channels and rule-layer risk. Unknown/malformed/stale model output
is unavailable. The simulated fault classifier is not run on the live path.

The self-test replays all source frames through `push()` and compares actual output boundaries,
frame counts, all selected features, rounded scores and statuses for all 225 windows. Missing,
extra or mismatched windows fail; a broken ingestion path cannot pass on offline features alone.

---

## 11. Decision log

| # | Decision | Why |
|---|---|---|
| 1 | Unsupervised, not supervised, on the real data | No fault labels exist. |
| 2 | Keep the recording in its own directory, not `data/telemetry.csv` | A second copy breaks the manifest/SHA256SUMS traceability chain. |
| 3 | Derive node→sensor mapping from column ownership | A renamed node in the field cannot be silently misrouted. |
| 4 | Drop `belt_speed` automatically | Exactly `hall_rpm × 1.20/60`; keeping both double-weights one sensor. |
| 5 | 10 s window / 2.5 s step | Measured yield study; 10 s is the minimum for stable kurtosis, longer windows collapse coverage. |
| 6 | **Deployed model fitted on the whole session** | Temperature is a warm-up confounded with time (r = 0.96); a cold-fit model would flag every late window for a thermal reason. The manifest also requires one split. |
| 7 | Chronological split kept, but only as a drift diagnostic | Honours the user's request for a time-aware split without misrepresenting it as generalisation. |
| 8 | `RobustScaler` over `StandardScaler` | Impulsive windows would otherwise compress the scale. |
| 9 | Sweep on stability, not accuracy | There is no accuracy to optimise without labels. |
| 10 | Logistic calibration anchored on baseline p50/p99 | Monotone, bounded, and anchors each detector separately; the ensemble maximum is not a probability or percentile. |
| 11 | `baseline_stats` fitted on **unscaled** features | Lets explanations quote °C/g/RPM; MAD-z is affine-invariant so z is unchanged. |
| 12 | **Per-sensor ensemble** | A single joint forest was a de-facto vibration detector; historical run showed thermal response 54.7% → 92.7%; current regenerated sensitivity is in outputs/synthetic_fault_report.md. |
| 13 | Synthetic injection at frame level with quantisation preserved | Prevents impossible feature combinations and stops a classifier detecting float precision. |
| 14 | Synthetic never mixed into the baseline | Keeps the sensitivity test non-circular. |
| 15 | Segment-grouped splits everywhere | 75% window overlap and 51 synthetic siblings per window make random splits leak. |
| 16 | Committed models and synthetic data (~56 MB) | Explicit decision so the demo runs without retraining, knowingly breaking the parent repo's convention. |

---

## 12. Reproducing and extending

```bash
pip install -r requirements.txt
cd ml
python run_pipeline.py            # all 8 stages, ~3.5 min
python run_pipeline.py --fast     # skip the ~70 s sweep
python predict.py --self-test     # MUST pass after any feature change
```

Deterministic apart from training timestamps in `outputs/*.json`.

**Acceptance checks after any change:** self-test passes · 225 windows from 37 segments ·
`outputs/data_quality_report.md` duplicate-timestamp and segment-length rows unchanged ·
no report gained a claim the data cannot support.

### Adding a feature

1. Add it in `feature_engineering.compute_window_features` (must return a finite float
   for **any** input).
2. Check the sensor-group balance (§4) — the prefix decides the group via
   `health_score.feature_sensor`.
3. Retrain: `python train.py && python evaluate.py`.
4. Optionally add an `INDICATOR_RULES` entry so it can appear in explanations.
5. `python predict.py --self-test`.

### Swapping in real labelled data

1. Build a features table with the same columns plus `fault_class` and a `session_id`.
2. Point `train_supervised.SYNTH_CSV` at it and **change the grouping key from
   `segment_id` to `session_id`** — one session shares one belt tension, one mounting and
   one thermal state.
3. Re-run. The metrics become real and quotable.
4. Delete the synthetic caveats from the reports — **and not before**.

### Known extension points

- `telemetry.frames.jsonl` carries unused per-frame diagnostics (`read_errors`,
  `fifo_overruns`, `invalid_samples`, Hall counters). Their deltas would make good
  window-validity gates.
- **Normal-behaviour regression** (predict temperature from speed/load/ambient; residual =
  degradation signal) is the closest thing to prognostics achievable without fault data,
  and it would also neutralise the warm-up confound by making runtime an input.
- **EWMA/CUSUM on the health score** would turn per-window noise into a trend and a
  change-point alarm — the actual early-warning mechanism.
- Sequence models (LSTM/autoencoder) are **not** viable on 225 correlated windows; they
  would memorise. Revisit only after the collection campaign.
