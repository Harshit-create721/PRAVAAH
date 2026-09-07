# AGENTS.md — context for any agent working in `ML/SIH-2026/`

Read this before changing anything here. It exists so an agent arriving cold does not
have to re-derive the reasoning, and does not accidentally break one of the invariants
that the whole design rests on.

Companion file: [`DOCUMENTATION.md`](DOCUMENTATION.md) is the deep technical reference
(module-by-module, data dictionary, artifact schemas, decision log). This file is the
orientation and the rules.

---

## 1. What this is, in one paragraph

An **unsupervised conveyor condition-monitoring pipeline** for PRAVAAH's three-sensor USB
rig (vibration, thermal, Hall speed). It fuses the three sensor streams into 10-second
windows, learns the baseline operating behaviour with an Isolation Forest ensemble, and
scores each new window 0–100 for how unusual it is, with a plain-language explanation of
which sensor drove the score. It also contains a **simulated**-fault test bench and a
supervised classifier scaffold trained on generated fault labels derived from real sensor measurements; it has no verified real fault labels.

Parent project: **PRAVAAH**, built against **SIH26008, Ministry of Steel — *AI-Enabled
Conveyor Belt Joint Rupture and Damage Prediction***.

---

## 2. The single most important thing

**This project is built to be scientifically honest, and that is a feature, not
timidity.** The parent repo's README sets the same standard:

> *"Sensor channels display actual measurements. There is no demo data, no seeded history, no placeholder readings."*

Concretely, in this directory:

| Do not | Because |
|---|---|
| Report accuracy / precision / recall / F1 / ROC AUC as real performance | The recording has **no fault labels**. The only labels that exist are simulated ones this repo generated. |
| Describe `anomaly_score` as a probability of failure | It is a bounded unusualness score relative to a learned baseline. Calibrating it to failure probability needs run-to-failure data that does not exist. |
| Emit remaining-useful-life or "X days until failure" | Same reason. RUL needs components taken to actual failure, repeatedly, with failure times recorded. |
| Name a mechanical fault mode ("bearing failure", "splice tear") | Nothing in the data supports a diagnosis. The system says *"elevated vibration anomaly detected; possible mechanical abnormality"*. |
| Call the baseline "healthy" | It is **real, unlabelled operating data**: the operator reported the belt running; no verified health or fault labels were recorded. Early-stage degradation would be invisible to observation and is baked into the baseline. |
| Present the classifier's recipe-recovery macro-F1 as fault-detection skill | It measures recovery of hand-written injection recipes. It is circular by construction. |

If you are asked to produce any of the above, say plainly what the data can and cannot
support, then deliver the closest defensible thing. The sensitivity specification in
§7 is usually the honest substitute for a demanded accuracy number.

---

## 3. Hard invariants — breaking these silently corrupts the results

1. **A window never crosses a `segment_id` boundary.** The recording is 78 discontinuous
   intervals, not one run. Joining them would fabricate transitions across a 10-minute
   USB dropout. Enforced in `feature_engineering.enumerate_windows`.
2. **Never interpolate, resample, forward-fill or zero-fill across gaps.** Absent values
   are absent, never zero. The parent `docs/dataset-schema.md` says the same about the
   empty channels.
3. **Any train/test split is grouped, never random.** Windows overlap 75%, and in the
   synthetic set each real window spawns 51 siblings. A random split leaks massively and
   produces near-perfect nonsense. Use `GroupKFold` on `segment_id` (on real labelled
   data later: on `session_id`).
4. **Training and inference must use identical features.** `predict.py` calls the same
   `feature_engineering.compute_window_features` and reads `feature_order` from
   `models/feature_config.json`. Verify with `python ml/predict.py --self-test`
   (currently max |diff| 7.1e-15 over 225 windows). **If you change any feature, retrain —
   the artifacts encode the feature list and its order.**
5. **Synthetic data is never mixed into the unsupervised baseline.** The Isolation Forest
   is fitted on real windows only. That is precisely what makes the sensitivity test in
   §7 non-circular.
6. **Preserve sensor quantisation when generating synthetic data** (RPM/temp 2 dp,
   vibration/acceleration 4 dp, shape factors 3 dp). Without it a classifier reaches ~100%
   by detecting float precision — learning "synthetic", not "faulty".
7. **Do not edit the recording under `data/`.** It ships with `manifest.json`,
   `segments.json` and `SHA256SUMS`; editing breaks the traceability chain.

---

## 4. Orientation — where things are

```
ml/                        all source (11 modules)
  config.py                paths, window geometry, schema expectations, model defaults
  preprocessing.py         load, validate, derive node->sensor mapping, split streams
  feature_engineering.py   segment-safe windowing + feature functions (shared with predict)
  health_score.py          calibration, thresholds, status, explanations, ScoreEngine
  train.py                 pruning, screening, sweep, fit ensemble, write artifacts
  evaluate.py              scoring + stability/drift/confounding/model-comparison
  synthetic_faults.py      SIMULATED fault injection
  evaluate_synthetic.py    detector sensitivity test (the legitimate synthetic use)
  train_supervised.py      RF + XGBoost on synthetic labels (scaffold)
  visualize.py             11 plots
  predict.py               real-time inference; --demo / --self-test / --stdin
  run_pipeline.py          runs all 8 stages
data/<recording>/          the telemetry, with its manifest/segments/SHA256SUMS
models/                    trained artifacts (see DOCUMENTATION.md §5)
outputs/                   generated reports, CSVs and plots — all regenerable
```

**Everything in `outputs/` and `models/` is generated.** Never hand-edit them; change the
code and re-run. `python ml/run_pipeline.py` rebuilds all of it in ~3.5 minutes.

---

## 5. What the data actually is (do not re-assume this)

Measured, not assumed — full detail in `outputs/data_quality_report.md`.

- 6,527 rows, **one row = one frame from one node**, not one ML observation. Only that
  node's own columns are populated; there is no row containing all three sensors.
- 78 segments, ~1,062 s retained from a 2,433 s span. Median segment ~8 s, so **41 of 78
  segments are too short for a 10 s window and contribute nothing**.
- 3 nodes: `esp32-vibration-01`, `esp32-thermal-01`, `esp32-marker-01`. The mapping is
  **derived from which columns each node owns**, not hardcoded.
- **9 columns are 100% null** and dropped automatically: `motor_current_rms`,
  `motor_power`, `motor_rpm`, `slip_ratio`, `temperature_delta`, `belt_offset_left/right`,
  `acoustic_rms`, `load_cell_kg`. Never treat them as zero-valued features.
- `belt_speed` is dropped: it is exactly `hall_rpm × 1.20 / 60`, a geometry constant, not
  an independent measurement.

### Four traps that catch every newcomer

1. **`hall_rpm` is belt loops per minute, not motor or roller RPM.** One magnet on a
   1.20 m belt loop. At ~20.5 the belt completes a loop every ~2.93 s.
2. **`ambient` is not room temperature.** It is the MLX90614 *sensor-package* temperature
   (register 0x06). So `temp_over_ambient_*` is object-minus-die, which reconstructs the
   documented `temperature_delta` channel. It is a good normalisation, but do not describe
   it as "above room temperature".
3. **`ts_ms` is laptop arrival time for the USB bridge, not an acquisition clock.**
   Duplicate `(node, ts_ms)` pairs rise from ~27% to ~84% across the session. This is
   expected, not a firmware bug. Window aggregates stay valid; **slope features are only
   accurate to about the 2 s burst period.**
4. **`vibration_kurtosis` is Pearson (not excess) kurtosis of the highest-variance axis,
   and that axis can change between frames.** It is a noisy statistic from ~100 samples.
   Treat large excursions as candidates, never as diagnosis.

### Two properties that dominate modelling

- **Temperature is a monotone warm-up**, r = 0.96 with session time. Absolute temperature
  encodes *when* a window was recorded. This is why the deployed model is fitted over the
  whole session and why the chronological split is reported only as a drift diagnostic.
- **Speed never varied** (20.37–20.69, 29 distinct values, held ~3 s between updates
  because RPM is held until the next valid magnet period). The model has never seen a
  speed change, so RPM-instability detection is untested on real data.

---

## 6. The model, and the one bug worth knowing about

Isolation Forest **ensemble**: a joint detector over all 59 features plus one per sensor
group (vibration 40, temperature 12, RPM 7). Reported score is the **maximum** across
detectors; `driver_sensor` records which fired.

**Why the ensemble exists.** A single joint forest was effectively a vibration detector.
A thermal excursion at 9.7–13.2 °C over ambient — far outside the 6.75 °C baseline
maximum — reached WATCH in barely half of windows, while a 1.33× vibration rise flagged
98.7%. Cause: **feature dilution**, since 40 of 59 features are vibration and random
splits rarely landed on the channel that moved. The ensemble raised thermal detection
from **54.7% → 92.7% in the historical comparison**. Current sensitivity values are regenerated in `outputs/synthetic_fault_report.md`. The 10.2% in-fit exceedance is not a false-positive rate.

If you add features, **check the group balance** — adding 20 more vibration features
would reintroduce the same dilution inside the vibration sub-detector.

`contamination` has no effect on the reported score: it only shifts
`IsolationForest.offset_` by a constant, and the score is a robust z-score that cancels
constants. Do not "tune" it expecting the score to change.

---

## 7. The honest headline numbers

Use these instead of inventing accuracy figures. Detection floors at a **10.2%
in-fit baseline threshold exceedance** (`outputs/synthetic_fault_report.md`):

| simulated deviation shape | reliably flagged from |
|---|---|
| HIGH_VIBRATION | vibration ×1.37 |
| BELT_SLIP | vibration ×1.09, RPM −2.7%, RPM std ×1.7 |
| RPM_INSTABILITY | vibration ×1.05, RPM std ×2.9 |
| OVERHEATING | +4.8 °C object-minus-sensor-package change (current simulation) |

Say *"the detector responds to a 1.37× vibration rise"* (measured, defensible). Do **not**
say *"97% accuracy detecting belt slip"* — that grades an injection recipe against itself.

---

## 8. Known weaknesses, stated plainly

1. No real fault labels anywhere. Nothing is validated against ground truth.
2. One conveyor, one session, ~1,062 s. Nothing estimates behaviour on another machine
   or another day.
3. **The alert rate is not stable.** Under segment-grouped folds the held-out WATCH rate
   swings widely against the 10% in-fit rate. Thresholds are the least trustworthy part.
4. Isolation Forest, LOF and One-Class SVM agree broadly (Spearman ~0.81) but share only
   2–3 of their top-10 most-unusual windows. Which window is "worst" is model-dependent.
5. Static acceleration channels drift with temperature (r = 0.76), most likely MEMS
   thermal bias — an `orientation_shift` indicator may be sensor warm-up, not a mounting
   change.
6. Windows overlap 75%; the 225 samples are correlated, not independent.
7. All fault data is simulated (§2).

---

## Live correctness requirements

- Validate raw frames with `data_contract.py`; never replace invalid values with zero.
- Keep offline and streaming window geometry identical. Check all 225 real emitted windows.
- Preserve no-cross-gap windows even without caller-provided segment IDs. Poll freshness during silence.
- Fit data-dependent pruning/scaling/class weights inside every diagnostic training fold.
- Verify all recording checksums before importing; `.gitattributes` preserves original CRLF bytes.
- Run `python -m unittest discover -s tests -v` plus the full pipeline after changes.
- Parent gateway worker and mobile tests cover the live adapter and stale-score rendering.

## 9. Working here

```bash
cd ml
python run_pipeline.py          # all 8 stages, ~3.5 min
python run_pipeline.py --fast   # skips the ~70 s parameter sweep
python predict.py --self-test   # MUST pass after any feature change
```

**After any change, re-run the pipeline and check:** the self-test passes, window count is
still 225 from 37 segments, and no report gained a claim the data cannot support.

The pipeline is deterministic (`random_state=42`) apart from `outputs/*.json` training
timestamps, so a clean re-run should reproduce the same numbers.

### Highest-value next work

Not more modelling — **more data**. In priority order:

1. **Normal across the operating envelope** (several speeds, several loads). The model
   currently calls any speed change CRITICAL because it has only seen one operating point.
   This is cheap and fixes the largest weakness.
2. Fix the acquisition issues listed in `outputs/future_data_collection_plan.md` §0.
3. Real labelled fault runs — the safe induction protocol is in that same file.
4. Then retrain `train_supervised.py` on real labels, switching the grouping key to
   `session_id`, and delete the synthetic caveats from the reports — **not before**.

### Unused data worth exploiting

`data/<recording>/telemetry.frames.jsonl` carries per-frame diagnostics the CSV drops:
`samples`, `odr_hz`, `read_errors`, `invalid_samples`, `fifo_overruns`, and the Hall
counters. Live input rejects invalid health and insufficient acquired sample counts;
sequence discontinuities and stale Hall health also invalidate windows. Cumulative error
counter deltas are not yet used as window features. Firmware is **0.2.2 throughout**, so the 0.2.1 speed-quarantine
warning in `docs/dataset-schema.md` does not apply to this recording.

---

## 10. Relationship to the rest of PRAVAAH

The Python pipeline is self-contained and imports no parent application code. The parent
`server/ml-worker.js` now launches `predict.py --stdin`, feeds raw live MQTT frames, and
exposes `conveyors[].ml` in snapshots for the dashboard and app. It uses only the baseline
model, never generated fault classifications. Keep this field separate from measured
channels and rule-layer risk. See README for readiness, watchdog and environment setup.

Authoritative upstream docs — **prefer these over re-deriving**:

- `docs/dataset-schema.md` — the data dictionary and processing contract. Channel
  semantics, Hall edge cases, diagnostics.
- `docs/dataset-collection-plan.md` — the team's collection plan.
- `docs/conveyor-recording.md` — recording commands.
- `docs/sensor-debugging.md` — verified sensor fixes.

Note `outputs/future_data_collection_plan.md` here was written **from the ML side** (what
the model needs) and overlaps `docs/dataset-collection-plan.md` (what the rig needs).
Where they disagree about hardware, the parent doc wins.

The parent `.gitignore` excludes `data/recordings/` and the team tracks no model binaries.
**This directory deliberately breaks that convention** — it commits the recording, the
trained models and the synthetic dataset (~56 MB of 63 MB) so the demo runs without
retraining. That was an explicit decision, not an oversight.
