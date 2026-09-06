# Conveyor dataset collection plan — v1

Date: 6 September 2026. Asset: `CV-01`, one 1.20 m loop, one belt magnet,
ADXL345 vibration/acceleration and MLX90614 IR temperature.

The initial target is **detecting unusual operation relative to an inspected
normal baseline**. This is a proposed first target, pending the operator's choice;
speed/load controls and confirmed fault examples have not been supplied. An
inspection-backed normal set supports novelty detection, as described by
[scikit-learn](https://scikit-learn.org/stable/modules/outlier_detection.html).
A model score is an anomaly score, not a calibrated probability of failure.

This plan specifies collection and dataset preparation. The recorder exists;
the window builder, automated quality audit, release builder and model training
pipeline described below are **planned**, not already implemented. No trained
model or fault-labelled dataset has been produced.

## 1. What we can and cannot train now

| Objective | Current readiness |
|---|---|
| Unusual vibration, heating or belt-speed behaviour | Collect reviewed normal data across the operating conditions first; suitable initial objective |
| Stopped / starting / steady / stopping | Possible with operator-timed state labels; use a separate state dataset or a state gate |
| Named bearing, belt-tracking or splice faults | Needs independent fault evidence, adequate sensor placement and repeated distinct fault episodes |
| Joint rupture prediction / remaining useful life | Not supported by current evidence; needs identified joints, longitudinal inspections and actual deterioration/failure outcomes, including non-failing observation periods |

There is one rig and one Hall marker. The marker is not a verified splice ID.
Current and power, motor RPM, tracking, acoustic and load-cell channels are
absent. Do not populate them with zeros. A model developed here is initially
specific to this rig, mounting and operating envelope; industrial transfer
requires separate data and evaluation.

## 2. Freeze the measurement setup before labelled collection

The [debugging report](sensor-debugging.md) records the fixes and evidence;
[dataset-schema.md](dataset-schema.md) defines every available measurement.

- Use USB firmware **0.2.2** consistently. Record each node's actual firmware
  string, hashes of the sketch/header, bridge, schema, recorder and configuration,
  plus a source snapshot. The repository currently has uncommitted changes;
  `git rev-parse HEAD` alone does not identify the running source.
- Photograph or sketch the placement in your own experiment notes. Fill the
  actual ADXL location, mounting method and axis orientation; IR target, distance,
  surface and module variant; Hall gap, module identity and magnet orientation.
  No exact placement or factory accuracy calibration has been established here.
- Assign a `mount_id` and `configuration_id`. Changes in mounting, magnet count,
  firmware feature definitions or geometry start a new configuration/session.
  Keep previous captures; do not silently merge configurations.
- Independently time ten complete belt loops, from a marked pass to its eleventh
  arrival. Compare the measured average period with Hall periods. A provisional
  acceptance target is agreement within 5%, with stopwatch uncertainty recorded.
  This is a project check, not a manufacturer accuracy specification.
- Capture stationary acceleration to characterise offset/noise. Gravity should
  be interpreted with orientation and calibration uncertainty; do not force the
  observed approximately 1.07 g magnitude to 1 g without a calibration procedure.
- If a reference thermometer is available, record a comparison at the same target
  and conditions. Otherwise mark temperature absolute accuracy unverified.
- Confirm the safe speed/load envelope and inspect the rig. Do not generate
  faults by jamming, overloading, loosening moving parts or damaging the belt.
  Use naturally observed or properly engineered fault examples with independent
  inspection evidence when they become available.

Use `normal_inspected` only after an operator has documented normal condition.
Firmware `sensor_health: healthy` means a measurement passed sensor checks; it
is not a mechanical condition label.

## 3. Today's pilot: about one hour of operator-led collection

One-minute unlabelled recorder QA has already been used to test acquisition.
It exposed the 0.2.1 Hall timing artefact and was excluded from training. The
post-fix acquisition evidence is documented in the debugging report.

| Order | Condition | Duration / repetition | Purpose and label |
|---|---|---|---|
| 1 | Inspection and mount survey | Before operation | Complete annotation; use `unlabelled` until verified |
| 2 | Stationary rig, sensors powered | 5 min | Offset, thermal reference, sensor-noise check; observed state `stopped` |
| 3 | Startup then warm-up | 20 min | Record as mixed state, annotate state transitions and warm-up; do not mix into steady baseline |
| 4 | Settled, inspected normal, fixed setting and known empty belt | 3 independent runs × 10 min | Check repeatability; separate run/session IDs |
| 5 | Operator-observed stop | Record the transition | Add exact time/state annotations; this is not a fault |
| 6 | Review and backup | After runs | Inspect quality, annotate, checksum and copy |

Record the controller setting, rather than assuming that the currently observed
approximately 21.2 belt RPM is the only normal speed. For the three repeated
runs, create meaningful independent operating runs where practical and record
start/stop history. Merely splitting one continuous capture into three files
does not create three independent experiments.

A 20-minute warm-up capture may not reach thermal equilibrium. Record the
surface-temperature slope and whether it is still rising. Extend the run if
needed, or keep it labelled warm-up instead of calling it thermally steady.

Exact commands and stop behaviour are in [conveyor-recording.md](conveyor-recording.md).
Do not leave a session labelled steady running across an unrecorded belt stop.

## 4. Repeat across five collection days

The following are **pilot budgets**, not guarantees that a particular number of
rows is sufficient for fault prediction. Available controls determine the scope.

| Available control | Steady-state matrix | Total over 5 days |
|---|---|---|
| One speed and verified empty belt only | 2 separate 15-min runs/day at that setting | 10 runs, 2.5 h |
| Three safe repeatable speed settings and two known safe loads | 3 speeds × 2 loads × 2 separate 15-min runs/day | 60 runs, 15 h |
| Any intermediate capability | Available speeds × known loads × 2 runs × 15 min/day | Calculate from actual available conditions |

Add a 5-minute stopped observation and a 20-minute warm-up observation each day,
plus several observed start/stop transitions as operating procedures allow.
Keep these outside steady-normal training unless the model explicitly covers
them. Order steady conditions differently across days so temperature/time of
day does not uniquely identify speed or load. Keep hot/cold starts and elapsed
running time in the metadata.

Do not improvise load weights or speed settings to fill the matrix. If only one
setting is available, explicitly restrict the first model to that setting.
Repeat across ambient conditions and days, then later across independently
recorded mounting configurations if robustness to remounting is required.

At approximately 6 telemetry messages/second, a 15-minute run yields about
5,400 telemetry rows: 1,800 per board. These are **not 5,400 independent examples**.
At 30-second non-overlapping windows it yields at most 30 examples before
quality filtering and thermal-history requirements.

## 5. Labels and independent evidence

Use a condition label separately from operating state, measured/unknown load,
controller setting and thermal stage. The recorder accepts arbitrary label text;
this vocabulary is a dataset convention, not enforced CLI validation.

| Reviewed condition | Required evidence / use |
|---|---|
| `unlabelled` | Unknown condition or mixed/uncertain intervals; preserve, do not use as inspected normal |
| `normal_inspected` | Dated operator inspection, observed condition and unchanged configuration; eligible for normal baseline only after QA |
| `suspected_anomaly` | Observed unusual behaviour without confirmed cause; review/evaluation candidates, no named fault claim |
| `confirmed_fault` | Inspection or independent measurement identifies component, fault type and affected time interval; keep episode identity |
| `sensor_issue` | Loose mount, missed detections, electrical noise, read failure or acquisition problem; instrumentation QA, not mechanical fault ground truth |

Copy the [annotation template](templates/session-annotation.json) into each
session. Record before/after inspections where possible. If a later inspection
finds damage but onset time is unknown, mark the uncertain interval unknown;
do not label every previous frame faulty or normal retrospectively.

Use [interval annotations](templates/interval-annotations.json) for state changes,
operator interventions and uncertain boundaries. Keep timestamps in UTC epoch
milliseconds and retain local timezone for interpretation. Preserve original
labels and add reviewed labels as sidecars with reviewer/date/evidence references.
Dashboard alarms, model outputs, pass counts and `J01` history are not independent
fault evidence. Artificial/protocol-test values remain a separate synthetic set.

## Quality rules for v1

These are proposed admission rules to implement in the audit tool and adjust
only using development data. Preserve all original frames; rejection means
exclude from a particular model input, not delete the source session.

| Check | Initial rule |
|---|---|
| Provenance | Live source, expected node identity, compatible 0.2.2 source/configuration and mounting records |
| Recording completion | Clean `summary.json`; investigate partial lines, reconnects and excluded messages |
| 30-second steady window coverage | At least 57 unique valid frames of the expected 60 per required node; no inter-frame arrival gap over 1.5 s |
| Sequence and clock | No reset, duplicate sequence, out-of-order timestamp or clock jump within the window; split at these boundaries |
| ADXL quality | Healthy frames; no new read errors, invalid samples, FIFO overruns or clipped/fault windows; sample count 95–105 around the expected 100 |
| IR quality | Both temperatures valid in the same frame, PEC checked, healthy state; no increase in read/checksum errors |
| Hall quality while steady and moving | Healthy state, positive measured period, at least two new accepted passes per 30 s, no edge queue overflow, and agreement of reported RPM with period |
| Hall geometry consistency | `hall_rpm` agrees with `60000 / period_ms` within rounding tolerance; `belt_speed` agrees with `hall_rpm × 1.20 / 60` |
| Label certainty | Inspection-backed condition and one known state/configuration through the window; discard or mark mixed boundary windows |

For Hall consistency, initial numerical tolerances are 0.02 RPM and 0.0003 m/s,
chosen for the firmware's output rounding, not independent sensor accuracy.
At extremely slow settings two passes may need more than 30 seconds: use a
separately versioned longer window and check the firmware's 60-second acquisition
limit. Do not mistake a slow belt for a defective sensor solely from this rule.

Evaluate cumulative diagnostic **increments within a node boot**, not lifetime
nonzero values. A retry can increment IR errors even if it later returns a
valid temperature; quarantine that affected training window. A reboot/counter
reset starts a new segment and requires fresh QA. The first frame is a counter
reference, not evidence that the preceding interval was clean.

After a reset or operator intervention, wait for at least 30 seconds of clean
measurements and two confirmed Hall passes before admitting steady windows.
A stopped-state dataset needs separate rules: no pulses can mean stopped **or**
failed detection. Hall zero after timeout is not proof of a physical stop; use
the operator's state annotation. Never turn sensor loss into a fault label or
zero-filled mechanical feature.

Do not reject a physically plausible high-vibration/temperature window merely
because it crosses the existing alarm threshold. Preserve it for review. A
normal-looking value can still have bad acquisition quality, and an unusual
value can be a real measurement.

## 7. Construct model examples

Start with **30-second windows, 30-second stride**, independently per continuous
session segment. Merge the three streams by bounded time windows, never by row
number. Reject windows crossing state changes, resets or configuration changes.
The clocks are not hardware-synchronised; this supports slow feature fusion,
not precise phase matching of a splice impact across boards.

Proposed v1 features:

- Vibration RMS median, p95, maximum and variation; crest/kurtosis median and p95.
  Preserve their half-second definitions; an average of RMS values is not raw
  waveform RMS. Use mean axis values and total acceleration for mount/orientation
  review, or include them only with a documented rationale.
- Belt speed median and variation; accepted inter-pass period variation. Choose
  one of belt RPM and belt speed as a model input because they are deterministically
  proportional on this rig. Keep both in audit/export data.
- Surface and sensor temperatures, their same-frame difference, and a causal
  temperature slope over the preceding 120 seconds. All slope history must be
  valid and belong to the same continuous segment. The first two minutes lack
  that history: exclude those examples for the full model, or define a separate
  feature set explicitly without the slope.
- Observed state/load/controller setting and thermal stage as context for
  filtering or conditioning. Unknown context stays unknown. Do not use session
  ID, node ID, timestamps, label text, alarm outputs or reviewer information as
  predictive features.

Keep coverage, rejected-frame counts and label provenance alongside each window
for audit, separate from mechanical-model inputs. Do not let missing-data
patterns become a shortcut for a named fault label.

Raw XYZ waveforms are not saved by current firmware. FFTs of the 2 Hz RMS series
cannot recover the original 200 Hz acceleration. Frequency-specific bearing
analysis requires a separate raw-capture firmware/data version with sample
indices, acquisition timestamps, verified sampling/bandwidth, clipping/gap
checks and transport capacity validation. Choose sampling for the physical
frequencies of interest; current summary data cannot be upgraded afterward.

## 8. Split before learning or preprocessing

For a five-day pilot, reserve days 1–3 for training, day 4 for validation and
day 5 for a locked test. This is a proposed chronological split, not a split
already assigned to current files. Keep entire sessions and physical fault
episodes together; if an episode spans days, revise day assignments to keep
it in one partition. Artificially divided files from one continuous run remain
one group. Group-based validation prevents a group appearing in both training
and testing; see [scikit-learn grouped validation](https://scikit-learn.org/stable/modules/cross_validation.html#cross-validation-iterators-for-grouped-data).

Use grouped validation within training days when there are enough independent
runs. Keep all causal history and any overlapping windows inside the same split.
Do not randomly split adjacent rows or windows. A remounted sensor or another
conveyor is a separate generalisation test, not interchangeable training data.

Fit scalers, imputers if explicitly justified, feature selection and the model
on training data only. Calibrate alert thresholds on validation runs. Keep test
runs untouched until the final evaluation. Pipelines help enforce this separation;
see [scikit-learn leakage guidance](https://scikit-learn.org/stable/common_pitfalls.html#data-leakage).

## 9. First modelling experiment and evaluation

Compare a simple speed/load-conditioned robust normal-range baseline against
an Isolation Forest on inspected-normal, quality-approved steady windows. Tune
on held-out normal operation for a practical false-alarm budget. Adding a deep
network before establishing this baseline is not required for the first dataset.

Report false alerts per operating hour, valid-data coverage and detection latency.
Group adjacent flagged windows into alert episodes; document the grouping rule.
A provisional engineering target could be no more than one false alert/hour on
held-out inspected-normal runs, to be agreed with the operator and measured over
substantially more than a few minutes. This is a target, not achieved performance.

With independently confirmed abnormal events, add event recall, precision and
latency, broken down by speed/load/day/configuration. Report the number of
independent episodes, not only window count. Estimate uncertainty by resampling
runs/days rather than correlated rows. Without confirmed abnormal events, fault
recall, fault-class accuracy and remaining-life accuracy are **not measurable**.

Start in observation-only mode. Have the operator review new alerts and attach
inspection outcomes for future dataset versions. Do not connect the first model
to automatic conveyor control.

## 10. Storage, reproducibility and release

Keep original captures immutable and generate reviewed/processed exports
separately. Use [dataset-release.json](templates/dataset-release.json) as a manual
release manifest listing included session IDs, exclusions, source hashes,
feature/quality versions, labels and whole-session split assignments. Template
null values must be filled for an actual release.

Each release should include original sessions, reviewed annotations, inspection
evidence references, source snapshots, a quality report, window feature table,
explicit split lists, software versions and a checksum inventory. Dataset/model
artifacts belong outside Git unless deliberately managed with suitable storage.
Never include `deploy/.env` or relay credentials in source archives.

Measure storage from a pilot before long sessions. The initial one-minute capture
used about 252 KB before extra provenance files: approximately 15 MB/hour if that
rate persists. Budget at least twice measured storage for working copies and
another complete backup; raw-waveform acquisition would change this estimate.
Disk space was approximately 21 GiB free at planning time; recheck with `df -h .`.
No remote upload, backup destination or retention policy was configured here.

## 11. Implementation and readiness checklist

- [x] Identify connected channels and document units, rates and limitations.
- [x] Verify the existing labelled recorder on a real unlabelled pilot.
- [x] Define collection matrix, labels, quality rules, windows and split strategy.
- [ ] Operator confirms prediction target, safe controls, actual mounts and inspection evidence.
- [ ] Freeze source/configuration snapshots and begin independently labelled runs.
- [ ] Build a read-only session auditor: sequences, resets, health/counter deltas, Hall consistency and coverage; emit reasons per rejected window.
- [ ] Build annotation validation and deterministic window export from immutable captures; preserve session/episode IDs.
- [ ] Build manifest/checksum and grouped chronological split export.
- [ ] Collect/review the repeated normal campaign and reserve validation/test days.
- [ ] Compare robust baseline and Isolation Forest; record valid-data coverage and false alerts/hour.
- [ ] Add independently confirmed fault episodes before claiming fault detection performance.

The first operator action is an inspection/mount record followed by the five-minute
unlabelled capture command in the recording guide. Until that evidence exists,
current debugging and acquisition sessions remain unlabelled QA data.
