# Supervised fault classifier report (synthetic labels)

> **The labels this model was trained and scored on are simulated.** They come from the hand-written injection recipes in `ml/synthetic_faults.py`, not from a faulted conveyor. Every number below measures how well the classifier recovers those recipes. **It is not a measurement of real fault detection and must not be presented as one.**

Two specific reasons the headline figure is optimistic:

1. **The class prior is fictional.** The generation grid made ~50x more fault windows than unchanged baseline ones. The real deployment class prior is unknown; precision under that prior has not been measured.
2. **Only invented deviation shapes are present.** A real fault matching none of the six labels still gets assigned one of them.

Split: **segment-grouped 5-fold CV**, with training-fold-only feature selection and class weights. Each real baseline window spawns 51 synthetic rows, so a random split would place near-identical siblings on both sides and report near-perfect scores from leakage alone. Grouping by `segment_id` prevents that.

## 1. Cross-validated performance

| model | macro F1 (mean +- sd across folds) | fold range |
|---|---|---|
| RandomForest | 0.963 +- 0.021 | 0.934 - 0.996 |
| XGBoost | 0.968 +- 0.021 | 0.943 - 0.999 |

### Per-class detail (XGBoost, pooled over folds)

| class | precision | recall | F1 | support |
|---|---|---|---|---|
| BELT_SLIP | 0.996 | 0.999 | 0.998 | 2250 |
| COMBINED_FAULT | 0.925 | 0.988 | 0.955 | 2250 |
| HIGH_VIBRATION | 0.996 | 0.961 | 0.978 | 2250 |
| NORMAL | 0.865 | 0.942 | 0.902 | 225 |
| OVERHEATING | 0.994 | 0.966 | 0.979 | 2250 |
| RPM_INSTABILITY | 0.995 | 0.980 | 0.988 | 2250 |

### Confusion matrix (XGBoost, rows = true)

| | BELT_SLIP | COMBINED_FAULT | HIGH_VIBRATION | NORMAL | OVERHEATING | RPM_INSTABILITY |
|---|---|---|---|---|---|---|
| **BELT_SLIP** | 2248 | 2 | 0 | 0 | 0 | 0 |
| **COMBINED_FAULT** | 8 | 2222 | 9 | 0 | 3 | 8 |
| **HIGH_VIBRATION** | 0 | 88 | 2162 | 0 | 0 | 0 |
| **NORMAL** | 0 | 0 | 0 | 212 | 11 | 2 |
| **OVERHEATING** | 0 | 45 | 0 | 32 | 2173 | 0 |
| **RPM_INSTABILITY** | 0 | 44 | 0 | 1 | 0 | 2205 |

## 2. Recall by injected severity

The single most informative table here: a classifier that only works on severe faults is not an early-warning system.

| severity | windows | recall | note |
|---|---|---|---|
| 0.00 | 225 | 0.942 | NORMAL windows (real, unmodified) |
| 0.15 | 2250 | 0.951 |  |
| 0.30 | 2250 | 0.979 |  |
| 0.50 | 2250 | 0.987 |  |
| 0.75 | 2250 | 0.988 |  |
| 1.00 | 2250 | 0.988 |  |

## 3. Feature importance (XGBoost)

Which features carry each deviation shape. Useful as a sanity check that the model keys on the sensor the fault was injected into, and as guidance for which channels matter when real data is collected.

| rank | feature | importance |
|---|---|---|
| 1 | `vib_rms_mean` | 0.2183 |
| 2 | `vib_rms_p25` | 0.1293 |
| 3 | `rpm_max` | 0.1083 |
| 4 | `rpm_mean` | 0.0872 |
| 5 | `temp_over_ambient_min` | 0.0686 |
| 6 | `rpm_range` | 0.0516 |
| 7 | `rpm_min` | 0.0473 |
| 8 | `vib_rms_median` | 0.0425 |
| 9 | `vib_rms_min` | 0.0379 |
| 10 | `temp_over_ambient_mean` | 0.0361 |
| 11 | `ambient_mean` | 0.0190 |
| 12 | `rpm_std` | 0.0179 |
| 13 | `temp_mean` | 0.0143 |
| 14 | `acceleration_z_mean` | 0.0118 |
| 15 | `vib_kurt_sensor_min` | 0.0090 |

## 4. How to retrain this on real labelled data

Nothing in this file assumes the data is synthetic beyond the input path. Once real labelled runs exist:

1. Produce a features table with the same columns plus a `fault_class` column and a `segment_id` (or better, a `session_id`) grouping column.
2. Point `SYNTH_CSV` at it, and change the grouping key to `session_id` -- with real data the split must be **session**-grouped, not segment-grouped, because one session shares one belt tension, one mounting and one thermal state.
3. Re-run. The reported metrics then become real and quotable.

At that point delete the synthetic caveats from the top of this report -- and not before.
