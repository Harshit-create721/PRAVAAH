# Conveyor condition monitoring

This pipeline uses **real measurements recorded from PRAVAAH’s running conveyor**:
ADXL345 vibration/acceleration, MLX90614 surface and sensor-package temperatures,
and Hall magnet detections. One magnet travels around the full **1.20 m belt loop**;
`hall_rpm` is belt loops per minute and `belt_speed = hall_rpm × 1.20 / 60`.
It is not motor RPM. `ambient` is the IR sensor’s package temperature, not room temperature.

The Isolation Forest ensemble learns the recorded operating baseline and compares new
10-second windows with it. Its 0–100 anomaly score describes **baseline deviation**.
It does not estimate failure probability, diagnose splice damage, or predict remaining life.
`health_score` is simply `100 - anomaly_score`, not a measured percentage of belt health.

The recording is labelled `unlabelled`: the operator confirmed running, without verified
mechanical health/fault labels. The separate fault classifier uses **generated labels and
perturbations derived from those real recordings**. Its evaluation measures recovery of
injection recipes, not real fault detection. The gateway runs only the baseline detector.

## Install and run

From this directory, use Python 3.14.6 and the tested dependencies in `requirements.txt`:

```bash
python3.14 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python ml/run_pipeline.py
.venv/bin/python -m unittest discover -s tests -v
```

On Windows use `.venv\Scripts\python.exe` in place of `.venv/bin/python`.
The full run includes XGBoost and rebuilds all eight stages: inspection, baseline training,
evaluation, synthetic generation, sensitivity analysis, classifier training, plots and the
streaming parity test. A tested macOS run took about two minutes; runtime varies by machine.
`--fast` skips the parameter sweep and uses default parameters, so it changes the model.

```bash
.venv/bin/python ml/predict.py --self-test
.venv/bin/python ml/predict.py --demo -n 5
.venv/bin/python ml/predict.py --window-at 2093
.venv/bin/python ml/predict.py --stdin
```

Saved scikit-learn models need a compatible environment. Install the pinned versions or
retrain the complete pipeline in a new, documented environment; do not silently load a
subset of the detector artifacts. Models and outputs are generated, never hand-edited.

## Live gateway, dashboard and app

Start PRAVAAH from the repository root with `./start-pravaah.sh` or `npm start`.
The gateway automatically finds this directory’s `.venv` and starts one Python worker
for CV-01. `PRAVAAH_ML_PYTHON` can select another compatible interpreter. Missing models
or dependencies appear as data unavailable; measured channels and maintenance rules
continue to work. No training runs at gateway startup.

`server/ml-worker.js` feeds individual incoming MQTT telemetry payloads into the worker,
including sensor health, sequence numbers and diagnostics. It does not feed a merged
snapshot containing older values. The worker’s result is exposed as `conveyors[].ml` in
`/api/state` and WebSocket/relay snapshots. The web dashboard and mobile overview show an
**ML condition** card separately from sensor measurements and existing rule alarms.
The app’s native build must include the updated source to display the new card.

No generated fault class is published as a diagnosis. No model score is inserted into
the real sensor channels or used to overwrite a maintenance rule’s risk assessment.
The cards remove expired scores after five seconds or on a lost gateway connection.

## Live input contract

The predictor accepts a direct gateway payload, a recorder `{payload: ...}` envelope,
or a cleaned CSV observation converted to a dictionary:

```json
{"node":"esp32-thermal-01","ts":1788715800656,"seq":338,
 "sensor_health":{"mlx":"healthy"},"temperature":31.57,"ambient":27.91}
```

- `ts` or `ts_ms` is an integer timestamp in milliseconds, stamped on USB-bridge
  arrival. Conflicting aliases are rejected. No acquisition clock is invented.
- Node identity must match the trained mapping; unknown nodes cannot replace a sensor.
- Every required measurement must be a finite numeric value within the gateway channel
  range. Null, NaN, infinity, booleans, numeric strings and missing fields are rejected.
- `sensor_health` is required: `vibration`, `mlx`, or `speed` must be `healthy`.
  A stale Hall zero is data unavailable. A valid measured zero is not automatically missing.
  A reported vibration sample count below two also invalidates that frame.
- Explicit quality issues, a per-sensor gap over five seconds, a sequence jump/reset,
  or a backward sensor timestamp invalidate the synchronized window. Duplicate sequences
  are not counted twice; distinct acquired frames with the same burst timestamp are kept.
- `segment_id` is optional for live data. A supplied change ends the previous recorded
  interval. Gap/reset detection still works when it is absent.

A full **[start, end)** 10-second window closes only when all three sensor timestamps
have reached its end. Subsequent windows start every 2.5 seconds. Each sensor must provide
at least eight frames spanning at least six seconds within that full interval. Nothing
is interpolated or zero-filled. After invalid input the model waits for fresh coverage.

`ConveyorMonitor.push(frame)` returns one verdict or `None`. Call `drain()` after each
push to collect any additional completed windows. Catch `ValueError` and show
`data_status()` rather than retaining a previous score. A live consumer must also call
`data_status(now_ms)` periodically during silence. The `--stdin` service and gateway
already implement this watchdog, structured errors, worker readiness and recovery.
`finish_segment()` is only for an explicitly ended finite recording: it never extends
past its last observed timestamp and is not a live timer.

Standard output from `--stdin` is JSONL: `worker_ready`, `condition`, or `data_quality`.
Condition packets include `start_ms`, exclusive `end_ms`, `segment_id`, `frames_used`,
per-detector scores, driving sensor and an explanation. Data-quality packets have null
scores and a `WARMING_UP` or `DATA_UNAVAILABLE` status. The gateway may send
`{"control":"invalidate","reason":"sensor disconnected"}` to clear an interrupted run.

## Recording integrity and training

The shipped recording contains 6,527 sensor frames in 78 cleaned intervals. Thirty-seven
intervals are long enough to yield **225 overlapping windows**, with 75 candidate features
and 59 retained features. These are correlated windows from one conveyor/session, not
225 independent operating runs. Nine unmeasured channels remain absent.

`CONVEYOR_TELEMETRY_CSV` can select a different cleaned recording bundle. A missing explicit
path is an error. Its `SHA256SUMS` must cover the CSV; all listed files are verified before
inspection/training, and sidecars are resolved relative to that CSV. The shipped CSVs’
original CRLF bytes were restored after an import normalized their line endings.
`.gitattributes` preserves those bytes; the sensor values and source checksums are unchanged.
Invalid health, ranges or within-segment discontinuities stop import instead of contaminating
training. Raw recording and cleanup provenance stay immutable.

Final baseline fitting uses all retained real windows. Grouped diagnostics and the parameter
sweep fit feature selection and scaling only on each training partition. The synthetic
classifier likewise selects features and calculates class weights inside each training fold;
all injected siblings of a source segment stay together. These are still same-session
diagnostics, not field validation. Future validation must hold out complete recording sessions.

## Results and limits

Current generated artifacts are the source of numerical results:

- [Evaluation report](outputs/evaluation_report.md): baseline scores, grouped stability,
  chronological warm-up drift, confounding and actual streaming parity.
- [Sensitivity report](outputs/synthetic_fault_report.md): response to generated deviations.
  The unchanged `NORMAL` recipe means real baseline input, without a verified health label.
- [Classifier report](outputs/supervised_model_report.md): simulated-label recipe recovery.
- [Feature contract](models/feature_config.json) and [model metadata](models/model_metadata.json):
  dependencies, geometry, feature order, selected parameters and source checksums.
- [Collection plan](outputs/future_data_collection_plan.md): additional operating regimes and
  independently labelled data needed for meaningful fault evaluation.

About 10.2% of the fitted baseline windows reach WATCH because the threshold is chosen
near its 90th percentile. This is **in-fit baseline threshold exceedance**, not a measured
false-alarm rate. A false-alarm estimate needs independent, labelled normal operation.
Each detector is calibrated separately; taking their maximum does not make the ensemble
score a percentile or a probability.

The available recording has a narrow speed range, substantial warm-up and discontinuities.
The detector can flag changes in these measured signals, but cannot establish whether a
joint will rupture. No camera or additional sensor is required for this implementation;
more varied, labelled operation is still needed to validate fault prediction.

`predict.py --self-test` replays **all real frames through the actual ingestion path** and
compares all 225 emitted boundaries, frame counts, features, scores and statuses against
training. The tolerance is 1e-9. Missing or extra windows fail the test. Regression tests
also reproduce invalid readings, disconnects, clock/sequence resets, premature windows,
checksum corruption and a deliberately broken `push()` that never emits a verdict.

See [DOCUMENTATION.md](DOCUMENTATION.md) for the technical reference and
[AGENTS.md](AGENTS.md) for invariants to preserve when changing the pipeline.
