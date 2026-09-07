# Evaluation report -- conveyor condition monitoring

Model: **IsolationForest** on **225 windows** / **59 features**.

> **There are no fault labels in this dataset.** Nothing in this report is an accuracy, precision, recall, F1, ROC AUC, failure probability or remaining-useful-life figure, because none of those can be computed without ground truth. What is measured here is score distribution, stability and internal consistency.

## 1. Anomaly-score distribution over the baseline

`health_score` is defined as `100 - anomaly_score` for the same window, so the two columns below are the same windows read from opposite ends.

| percentile of anomaly_score | anomaly_score | health_score of that window |
|---|---|---|
| min | 3.24 | 96.76 |
| p25 | 6.15 | 93.85 |
| median | 8.45 | 91.55 |
| mean | 14.78 | 85.22 |
| p75 | 16.44 | 83.56 |
| p90 | 33.91 | 66.09 |
| p95 | 46.91 | 53.09 |
| p99 | 81.41 | 18.59 |
| max | 99.79 | 0.21 |

Status mix across the 225 baseline windows:

| status | windows | share |
|---|---|---|
| NORMAL | 202 | 89.8% |
| WATCH | 18 | 8.0% |
| WARNING | 3 | 1.3% |
| CRITICAL | 2 | 0.9% |

This mix is *by construction*: the thresholds were derived from these very percentiles. It says the scale behaves as designed, not that 23 windows are genuinely faulty.

## 2. Threshold derivation

| status boundary | score | derived from | realised baseline exceedance |
|---|---|---|---|
| >= WATCH | 33.9 | baseline anomaly-score p90 | 10.2% |
| >= WARNING | 62.2 | baseline anomaly-score p98 (floored at watch + 2) | 2.2% |
| >= CRITICAL | 93.7 | baseline anomaly-score p99.5 (floored at warning + 2) | 0.9% |

*PROTOTYPE THRESHOLDS. Derived from one unlabelled recording of one conveyor. They are not industrial safety limits, not certified trip points, and carry no guarantee of detecting any particular fault. Edit models/thresholds.json to retune without retraining.*

## 3. Score calibration

```
raw   = -IsolationForest.decision_function(x)      (higher = more unusual)
z     = (raw - -0.081487) / 0.020658
score = 100 / (1 + exp(-(z - 4.6163) / 1.5678))
```

Anchors: the baseline median maps to ~5, the baseline 99th percentile maps to 50. **A score of 50 therefore means 'as unusual as the most unusual 1% of the baseline' -- it does not mean a 50% chance of anything.**

## 4. Segment-grouped stability

Fit on 4/5 of the *segments*, score the held-out fifth. Windows from one segment never appear on both sides, so the 75% window overlap cannot leak across the split.

| fold | train windows | held-out windows | held-out segments | train median score | held-out median score | train %>=WATCH | held-out %>=WATCH |
|---|---|---|---|---|---|---|---|
| 0 | 180 | 45 | 6 | 5.00 | 10.53 | 10.0% | 35.6% |
| 1 | 180 | 45 | 7 | 5.00 | 4.87 | 10.0% | 2.2% |
| 2 | 180 | 45 | 8 | 5.00 | 8.79 | 10.0% | 37.8% |
| 3 | 180 | 45 | 8 | 5.00 | 10.81 | 10.0% | 17.8% |
| 4 | 180 | 45 | 8 | 5.00 | 5.43 | 10.0% | 6.7% |

Mean |held-out - train| WATCH-rate gap: **14.5 percentage points**; the held-out WATCH rate ranges from **2.2% to 37.8%** against a 10.0% in-fit rate.

> **This gap is large, and it is the most important negative result in this report.** The boundary does not transfer cleanly to segments the model has not seen: depending on which segments are held out, the alert rate on unseen data is anywhere from a third of the in-fit rate to roughly three times it. With 225 windows drawn from only 37 segments, between-segment variation dominates -- each fold removes a handful of segments that carry a meaningful share of the whole recording's behaviour. Practical consequence: **the WATCH threshold should be expected to produce an alert rate somewhere in the range above, not a stable 10%, until far more segments are recorded.** It also means the prototype thresholds are the least trustworthy part of this system.

Either way this says nothing about whether those segments were mechanically healthy -- only about how consistently the model scores them.

The grouped and chronological diagnostics below fit feature selection, scaling, the joint forest, calibration and thresholds on each training partition only. They probe the joint detector, not the full deployed ensemble, and do not provide independent field-validation estimates.

## 5. Chronological drift diagnostic

**How the split was performed.** segments ordered by start time; earliest 26 of 37 segments (70%) used to fit, remaining 11 segments scored

| | train (earlier) | evaluation (later) |
|---|---|---|
| segments | 26 | 11 |
| windows | 177 | 48 |
| session time covered | 0-1961 s | 2005-2406 s |
| mean temperature | 34.09 degC | 36.62 degC |
| mean vibration RMS | 0.06703 g | 0.06715 g |
| median anomaly score | 5.00 | 15.14 |
| %>=WATCH | 10.2% | 37.5% |

Later-window status mix under the earlier-only model: NORMAL 30, WATCH 13, WARNING 4, CRITICAL 1

> **Read this as drift, not as skill.** The evaluation half is on average 2.53 degC hotter than the training half purely because the machine was warming up, while mean vibration barely moves (0.06703 -> 0.06715 g). A model fitted only on cold windows will therefore call hot windows unusual for a thermal reason. This is exactly why the *deployed* model in `models/isolation_forest.joblib` is fitted over the whole session.

> **This is not a test on an unseen conveyor.** Both halves come from one physical prototype, one belt, one motor, one 40-minute session on 2026-09-06. The dataset manifest explicitly asks for the whole session to stay in one split; that instruction is followed for the deployed model and deliberately broken here, in isolation, only to expose the drift. Nothing in this table estimates behaviour on another machine or another day.

## 6. Which features track elapsed session time

Spearman correlation between each model feature and elapsed session time. Strongly correlated features encode *when* a window was recorded as much as *how the machine behaved*, so an alert driven by them deserves extra scrutiny.

| feature | Spearman vs session time |
|---|---|
| `temp_mean` | +0.994 |
| `ambient_mean` | +0.990 |
| `temp_over_ambient_mean` | +0.983 |
| `temp_over_ambient_max` | +0.974 |
| `temp_over_ambient_min` | +0.970 |
| `acceleration_z_mean` | -0.903 |
| `temp_range` | +0.797 |
| `acceleration_magnitude_mean` | +0.786 |
| `temp_std` | +0.777 |
| `acceleration_z_min` | -0.748 |
| `acceleration_z_max` | -0.748 |
| `acceleration_magnitude_min` | +0.597 |

**11 of 59 features** exceed |rho| = 0.7 against session time, split as: temperature 7 (`temp_mean`, `ambient_mean`, `temp_over_ambient_mean`, `temp_over_ambient_max`, `temp_over_ambient_min`, `temp_range`, `temp_std`); vibration 4 (`acceleration_z_mean`, `acceleration_magnitude_mean`, `acceleration_z_min`, `acceleration_z_max`).

> The thermal features tracking session time is expected -- that is the warm-up described in the data-quality report. **The 4 static-acceleration features in that list are a separate and less obvious finding.** `acceleration_z_mean`, `acceleration_magnitude_mean` and friends are the DC / orientation component of the accelerometer, not its vibration component, and they drift monotonically across the session in step with temperature. The most likely cause is thermal bias drift in the MEMS sensor itself rather than the conveyor physically tilting. Practical consequence: an `orientation_shift` indicator raised by this system may reflect sensor warm-up rather than a mounting change, and should not be acted on alone. Confirming this needs a bench test -- log the accelerometer at rest through a full thermal cycle and see whether the same drift appears with nothing moving.

The reassuring half of the table: no `vib_*` or `rpm_*` feature reaches |rho| = 0.7 (strongest is `rpm_mean` at +0.546), so the dynamic vibration and speed channels are not simply acting as clocks.

## 7. Comparison with other unsupervised detectors

Isolation Forest is the primary model. LOF and One-Class SVM are shown only to check that the ranking is not an artefact of one algorithm. **Agreement between unlabelled detectors is consistency, not correctness** -- three models can agree and all be wrong about mechanical condition.

| model | Spearman vs Isolation Forest | shared windows in top-10 |
|---|---|---|
| LocalOutlierFactor(n_neighbors=20, novelty=True) | 0.813 | 3/10 |
| OneClassSVM(rbf, nu=0.05, gamma=scale) | 0.796 | 3/10 |
| OneClassSVM(rbf, nu=0.02, gamma=scale) | 0.796 | 4/10 |

**The global agreement is moderate but the tail agreement is poor.** Spearman sits around 0.80 across all 225 windows, yet the three detectors share only 3-4 of their top-10 most-unusual windows. The tail is precisely what an alert threshold acts on, so this is the honest reading: *which* windows get flagged as the worst offenders is substantially model-dependent, and no labelled data exists to say which detector is right. Treat any individual CRITICAL window as a prompt to inspect, not as a verdict.

Isolation Forest is kept as primary anyway, on engineering grounds rather than measured superiority: it needs no distance metric over 59 heterogeneous features, trains and scores fast enough to run on an edge gateway, exposes a smooth `decision_function` suitable for the 0-100 mapping, and does not need the whole training set kept in memory at inference time the way LOF does.

## 8. Most unusual windows found

| rank | window | segment | session time | score | status | temp | RPM | vib RMS | leading deviation |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 186 | S054 | 2093 s | 99.8 | CRITICAL | 36.54 degC | 20.52 | 0.0694 g | `vib_kurt_sensor_std` (z=+147.1) |
| 2 | 13 | S003 | 341 s | 95.0 | CRITICAL | 32.74 degC | 20.50 | 0.0685 g | `vib_kurt_sensor_std` (z=+20.9) |
| 3 | 212 | S071 | 2332 s | 84.2 | WARNING | 36.52 degC | 20.56 | 0.0680 g | `temp_slope_per_s` (z=-5.0) |
| 4 | 96 | S014 | 740 s | 72.7 | WARNING | 34.05 degC | 20.57 | 0.0717 g | `rpm_max` (z=+4.0) |
| 5 | 5 | S001 | 12 s | 65.2 | WARNING | 31.19 degC | 20.45 | 0.0612 g | `rpm_min` (z=-3.0) |
| 6 | 97 | S014 | 743 s | 59.1 | WATCH | 34.02 degC | 20.56 | 0.0712 g | `rpm_range` (z=+4.4) |
| 7 | 7 | S002 | 36 s | 54.2 | WATCH | 31.53 degC | 20.46 | 0.0639 g | `rpm_min` (z=-3.4) |
| 8 | 12 | S002 | 48 s | 52.9 | WATCH | 31.62 degC | 20.46 | 0.0615 g | `vib_crest_sensor_range` (z=+4.6) |
| 9 | 185 | S053 | 2081 s | 51.7 | WATCH | 36.48 degC | 20.48 | 0.0661 g | `acceleration_x_mean` (z=+12.8) |
| 10 | 203 | S071 | 2309 s | 50.1 | WATCH | 37.07 degC | 20.54 | 0.0670 g | `acceleration_z_range` (z=+3.9) |

Example explanations produced by the system for these windows:

- **window 186 (CRITICAL, 99.8)** -- Vibration crest factor peaked above the baseline; the spread between minimum and maximum vibration is unusually wide; peak vibration in the window is above the learned baseline; and vibration is fluctuating more than the baseline. Possible mechanical or thermal abnormality -- inspect before drawing a conclusion. This is a statistical deviation from the learned baseline, not a diagnosed fault.

- **window 13 (CRITICAL, 95.0)** -- Vibration crest factor peaked above the baseline; the spread between minimum and maximum vibration is unusually wide; peak vibration in the window is above the learned baseline; and vibration is fluctuating more than the baseline. Possible mechanical or thermal abnormality -- inspect before drawing a conclusion. This is a statistical deviation from the learned baseline, not a diagnosed fault.

- **window 212 (WARNING, 84.2)** -- Multiple sensor indicators changed simultaneously: Temperature swung more within the window than the baseline. Possible mechanical or thermal abnormality -- inspect before drawing a conclusion. This is a statistical deviation from the learned baseline, not a diagnosed fault.

**The physical cause of these windows is unknown.** They are statistical deviations from the learned baseline. No bearing fault, belt slip or any other mechanical diagnosis is claimed or implied.

## 9. What this evaluation does and does not establish

**Does establish:**

- The feature pipeline runs end to end and produces 59 finite features per window with no NaN or infinity.

- The score mapping is monotone, bounded to 0-100, and calibrated to documented baseline quantiles.

- Three different unsupervised detectors agree on the broad ordering (Spearman ~0.80), so the ranking is not an artefact of one algorithm.

- Training-time and inference-time features match: `ml/predict.py --self-test` recomputed 225 windows through the streaming path and the maximum absolute feature difference against `outputs/features.csv` was **7.11e-15** across 59 features.


**Does not establish:**

- A stable alert rate. The segment-grouped folds in section 4 show the held-out WATCH rate swinging over a wide range, so the prototype thresholds are not yet dependable.

- Which windows are the *worst*. The detectors share only a few of their top-10 (section 7).

- That the conveyor was healthy during the recording.

- That the model detects any specific fault. It has never seen a labelled fault, a speed change, or a loaded belt.

- Any detection rate, false-alarm rate, lead time or RUL.

- Any behaviour on a different conveyor, a different day, or a different ambient temperature.


Closing that gap requires the controlled labelled campaign described in `outputs/future_data_collection_plan.md`.
