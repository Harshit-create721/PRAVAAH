# Evaluation report -- conveyor condition monitoring

Model: **IsolationForest** on **225 windows** / **59 features**.

> **There are no fault labels in this dataset.** Nothing in this report is an accuracy, precision, recall, F1, ROC AUC, failure probability or remaining-useful-life figure, because none of those can be computed without ground truth. What is measured here is score distribution, stability and internal consistency.

## 1. Anomaly-score distribution over the baseline

`health_score` is defined as `100 - anomaly_score` for the same window, so the two columns below are the same windows read from opposite ends.

| percentile of anomaly_score | anomaly_score | health_score of that window |
|---|---|---|
| min | 2.87 | 97.13 |
| p25 | 6.40 | 93.60 |
| median | 8.82 | 91.18 |
| mean | 14.95 | 85.05 |
| p75 | 17.12 | 82.88 |
| p90 | 34.93 | 65.07 |
| p95 | 43.50 | 56.50 |
| p99 | 73.23 | 26.77 |
| max | 99.33 | 0.67 |

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
| >= WATCH | 34.9 | baseline anomaly-score p90 | 10.2% |
| >= WARNING | 60.6 | baseline anomaly-score p98 (floored at watch + 2) | 2.2% |
| >= CRITICAL | 91.7 | baseline anomaly-score p99.5 (floored at warning + 2) | 0.9% |

*PROTOTYPE THRESHOLDS. Derived from one unlabelled recording of one conveyor. They are not industrial safety limits, not certified trip points, and carry no guarantee of detecting any particular fault. Edit models/thresholds.json to retune without retraining.*

## 3. Score calibration

```
raw   = -IsolationForest.decision_function(x)      (higher = more unusual)
z     = (raw - -0.077047) / 0.019801
score = 100 / (1 + exp(-(z - 4.8306) / 1.6406))
```

Anchors: the baseline median maps to ~5, the baseline 99th percentile maps to 50. **A score of 50 therefore means 'as unusual as the most unusual 1% of the baseline' -- it does not mean a 50% chance of anything.**

## 4. Segment-grouped stability

Fit on 4/5 of the *segments*, score the held-out fifth. Windows from one segment never appear on both sides, so the 75% window overlap cannot leak across the split.

| fold | train windows | held-out windows | held-out segments | train median score | held-out median score | train %>=WATCH | held-out %>=WATCH |
|---|---|---|---|---|---|---|---|
| 0 | 180 | 45 | 6 | 5.00 | 10.65 | 10.0% | 28.9% |
| 1 | 180 | 45 | 7 | 5.00 | 5.03 | 10.0% | 2.2% |
| 2 | 180 | 45 | 8 | 5.00 | 8.39 | 10.0% | 28.9% |
| 3 | 180 | 45 | 8 | 5.00 | 10.66 | 10.0% | 4.4% |
| 4 | 180 | 45 | 8 | 5.00 | 5.41 | 10.0% | 6.7% |

Mean |held-out - train| WATCH-rate gap: **10.9 percentage points**; the held-out WATCH rate ranges from **2.2% to 28.9%** against a 10.0% in-fit rate.

> **This gap is large, and it is the most important negative result in this report.** The boundary does not transfer cleanly to segments the model has not seen: depending on which segments are held out, the alert rate on unseen data is anywhere from a third of the in-fit rate to roughly three times it. With 225 windows drawn from only 37 segments, between-segment variation dominates -- each fold removes a handful of segments that carry a meaningful share of the whole recording's behaviour. Practical consequence: **the WATCH threshold should be expected to produce an alert rate somewhere in the range above, not a stable 10%, until far more segments are recorded.** It also means the prototype thresholds are the least trustworthy part of this system.

Either way this says nothing about whether those segments were mechanically healthy -- only about how consistently the model scores them.

## 5. Chronological drift diagnostic

**How the split was performed.** segments ordered by start time; earliest 26 of 37 segments (70%) used to fit, remaining 11 segments scored

| | train (earlier) | evaluation (later) |
|---|---|---|
| segments | 26 | 11 |
| windows | 177 | 48 |
| session time covered | 0-1961 s | 2005-2406 s |
| mean temperature | 34.09 degC | 36.62 degC |
| mean vibration RMS | 0.06703 g | 0.06715 g |
| median anomaly score | 5.00 | 16.80 |
| %>=WATCH | 10.2% | 35.4% |

Later-window status mix under the earlier-only model: NORMAL 31, WATCH 13, WARNING 3, CRITICAL 1

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
| LocalOutlierFactor(n_neighbors=20, novelty=True) | 0.798 | 2/10 |
| OneClassSVM(rbf, nu=0.05, gamma=scale) | 0.816 | 2/10 |
| OneClassSVM(rbf, nu=0.02, gamma=scale) | 0.815 | 3/10 |

**The global agreement is moderate but the tail agreement is poor.** Spearman sits around 0.81 across all 225 windows, yet the three detectors share only 2-3 of their top-10 most-unusual windows. The tail is precisely what an alert threshold acts on, so this is the honest reading: *which* windows get flagged as the worst offenders is substantially model-dependent, and no labelled data exists to say which detector is right. Treat any individual CRITICAL window as a prompt to inspect, not as a verdict.

Isolation Forest is kept as primary anyway, on engineering grounds rather than measured superiority: it needs no distance metric over 59 heterogeneous features, trains and scores fast enough to run on an edge gateway, exposes a smooth `decision_function` suitable for the 0-100 mapping, and does not need the whole training set kept in memory at inference time the way LOF does.

## 8. Most unusual windows found

| rank | window | segment | session time | score | status | temp | RPM | vib RMS | leading deviation |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 186 | S054 | 2093 s | 99.3 | CRITICAL | 36.54 degC | 20.52 | 0.0694 g | `vib_kurt_sensor_std` (z=+147.1) |
| 2 | 13 | S003 | 341 s | 94.1 | CRITICAL | 32.74 degC | 20.50 | 0.0685 g | `vib_kurt_sensor_std` (z=+20.9) |
| 3 | 212 | S071 | 2332 s | 73.9 | WARNING | 36.52 degC | 20.56 | 0.0680 g | `temp_slope_per_s` (z=-5.0) |
| 4 | 96 | S014 | 740 s | 71.0 | WARNING | 34.05 degC | 20.57 | 0.0717 g | `rpm_max` (z=+4.0) |
| 5 | 5 | S001 | 12 s | 62.8 | WARNING | 31.19 degC | 20.45 | 0.0612 g | `rpm_min` (z=-3.0) |
| 6 | 97 | S014 | 743 s | 58.2 | WATCH | 34.02 degC | 20.56 | 0.0712 g | `rpm_range` (z=+4.4) |
| 7 | 12 | S002 | 48 s | 53.7 | WATCH | 31.62 degC | 20.46 | 0.0615 g | `vib_crest_sensor_range` (z=+4.6) |
| 8 | 7 | S002 | 36 s | 52.0 | WATCH | 31.53 degC | 20.46 | 0.0639 g | `rpm_min` (z=-3.4) |
| 9 | 153 | S030 | 1703 s | 50.7 | WATCH | 36.26 degC | 20.55 | 0.0660 g | `ambient_slope_per_s` (z=+3.8) |
| 10 | 210 | S071 | 2327 s | 47.9 | WATCH | 36.95 degC | 20.54 | 0.0679 g | `acceleration_y_min` (z=-3.4) |

Example explanations produced by the system for these windows:

- **window 186 (CRITICAL, 99.3)** -- Vibration crest factor peaked above the baseline; the spread between minimum and maximum vibration is unusually wide; peak vibration in the window is above the learned baseline; and vibration is fluctuating more than the baseline. Possible mechanical or thermal abnormality -- inspect before drawing a conclusion. This is a statistical deviation from the learned baseline, not a diagnosed fault.

- **window 13 (CRITICAL, 94.1)** -- Vibration crest factor peaked above the baseline; the spread between minimum and maximum vibration is unusually wide; peak vibration in the window is above the learned baseline; and vibration is fluctuating more than the baseline. Possible mechanical or thermal abnormality -- inspect before drawing a conclusion. This is a statistical deviation from the learned baseline, not a diagnosed fault.

- **window 212 (WARNING, 73.9)** -- Multiple sensor indicators changed simultaneously: Temperature swung more within the window than the baseline. Possible mechanical or thermal abnormality -- inspect before drawing a conclusion. This is a statistical deviation from the learned baseline, not a diagnosed fault.

**The physical cause of these windows is unknown.** They are statistical deviations from the learned baseline. No bearing fault, belt slip or any other mechanical diagnosis is claimed or implied.

## 9. What this evaluation does and does not establish

**Does establish:**

- The feature pipeline runs end to end and produces 59 finite features per window with no NaN or infinity.

- The score mapping is monotone, bounded to 0-100, and calibrated to documented baseline quantiles.

- Three different unsupervised detectors agree on the broad ordering (Spearman ~0.81), so the ranking is not an artefact of one algorithm.

- Training-time and inference-time features match: `ml/predict.py --self-test` recomputed 225 windows through the streaming path and the maximum absolute feature difference against `outputs/features.csv` was **7.11e-15** across 59 features.


**Does not establish:**

- A stable alert rate. The segment-grouped folds in section 4 show the held-out WATCH rate swinging over a wide range, so the prototype thresholds are not yet dependable.

- Which windows are the *worst*. The detectors share only a few of their top-10 (section 7).

- That the conveyor was healthy during the recording.

- That the model detects any specific fault. It has never seen a labelled fault, a speed change, or a loaded belt.

- Any detection rate, false-alarm rate, lead time or RUL.

- Any behaviour on a different conveyor, a different day, or a different ambient temperature.


Closing that gap requires the controlled labelled campaign described in `outputs/future_data_collection_plan.md`.
