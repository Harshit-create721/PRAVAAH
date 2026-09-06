# Synthetic fault response report

> **This report is a sensitivity test of the deployed anomaly detector, not evidence of fault detection.** The faults are simulated by `ml/synthetic_faults.py`. Each recipe encodes an assumption about how that fault would appear on this rig's three sensors; no faulted conveyor was ever recorded, so none of those assumptions has been checked against reality. Class names below denote **shapes of deviation**, not diagnosed fault modes.

What makes this test meaningful at all: the Isolation Forest was fitted only on real operator-attested normal windows and has **never seen an injection recipe**. Its response to these deviations is therefore a genuine property of the detector, in a way that a classifier trained on the same recipes could never be (see `outputs/supervised_model_report.md`).

## 1. What severity actually means physically

Severity is an abstract 0-1 knob. This table is what it produced on the sensors, averaged over all 11475 generated windows:

| fault | severity | vibration RMS | RPM mean | RPM std | temp over ambient |
|---|---|---|---|---|---|
| BELT_SLIP | 0.15 | x1.09 | -2.70% | x1.7 | +0.22 degC |
| BELT_SLIP | 0.30 | x1.18 | -5.40% | x3.0 | +0.44 degC |
| BELT_SLIP | 0.50 | x1.30 | -9.00% | x4.8 | +0.73 degC |
| BELT_SLIP | 0.75 | x1.45 | -13.49% | x6.9 | +1.09 degC |
| BELT_SLIP | 1.00 | x1.60 | -18.02% | x9.4 | +1.45 degC |
| HIGH_VIBRATION | 0.15 | x1.37 | +0.00% | x1.0 | +0.00 degC |
| HIGH_VIBRATION | 0.30 | x1.75 | +0.00% | x1.0 | +0.00 degC |
| HIGH_VIBRATION | 0.50 | x2.25 | +0.00% | x1.0 | +0.00 degC |
| HIGH_VIBRATION | 0.75 | x2.87 | +0.00% | x1.0 | +0.00 degC |
| HIGH_VIBRATION | 1.00 | x3.50 | +0.00% | x1.0 | +0.00 degC |
| OVERHEATING | 0.15 | x1.00 | +0.00% | x1.0 | +0.97 degC |
| OVERHEATING | 0.30 | x1.00 | +0.00% | x1.0 | +1.94 degC |
| OVERHEATING | 0.50 | x1.00 | +0.00% | x1.0 | +3.23 degC |
| OVERHEATING | 0.75 | x1.00 | +0.00% | x1.0 | +4.84 degC |
| OVERHEATING | 1.00 | x1.00 | +0.00% | x1.0 | +6.45 degC |
| RPM_INSTABILITY | 0.15 | x1.05 | +0.00% | x2.9 | +0.00 degC |
| RPM_INSTABILITY | 0.30 | x1.10 | +0.00% | x5.4 | +0.00 degC |
| RPM_INSTABILITY | 0.50 | x1.18 | -0.00% | x8.9 | +0.00 degC |
| RPM_INSTABILITY | 0.75 | x1.26 | +0.00% | x13.3 | +0.00 degC |
| RPM_INSTABILITY | 1.00 | x1.35 | +0.00% | x17.7 | +0.00 degC |
| COMBINED_FAULT | 0.15 | x1.19 | -0.88% | x1.7 | +0.40 degC |
| COMBINED_FAULT | 0.30 | x1.37 | -1.78% | x2.9 | +0.87 degC |
| COMBINED_FAULT | 0.50 | x1.66 | -3.20% | x4.3 | +1.46 degC |
| COMBINED_FAULT | 0.75 | x2.04 | -4.51% | x6.3 | +2.15 degC |
| COMBINED_FAULT | 1.00 | x2.36 | -5.99% | x8.6 | +2.91 degC |

## 2. Detection response curve

Percentage of injected windows that reach each threshold (WATCH 34.9, WARNING 60.6):

| fault | severity | n | median score | %>=WATCH | %>=WARNING |
|---|---|---|---|---|---|
| NORMAL | 0.00 | 225 | 8.8 | 10.2% | 2.2% |
| BELT_SLIP | 0.15 | 450 | 65.9 | 100.0% | 68.9% |
| BELT_SLIP | 0.30 | 450 | 78.1 | 100.0% | 100.0% |
| BELT_SLIP | 0.50 | 450 | 87.2 | 100.0% | 100.0% |
| BELT_SLIP | 0.75 | 450 | 94.1 | 100.0% | 100.0% |
| BELT_SLIP | 1.00 | 450 | 96.8 | 100.0% | 100.0% |
| HIGH_VIBRATION | 0.15 | 450 | 66.4 | 92.9% | 61.3% |
| HIGH_VIBRATION | 0.30 | 450 | 90.8 | 100.0% | 99.3% |
| HIGH_VIBRATION | 0.50 | 450 | 95.8 | 100.0% | 100.0% |
| HIGH_VIBRATION | 0.75 | 450 | 97.5 | 100.0% | 100.0% |
| HIGH_VIBRATION | 1.00 | 450 | 98.1 | 100.0% | 100.0% |
| OVERHEATING | 0.15 | 450 | 15.6 | 13.3% | 3.1% |
| OVERHEATING | 0.30 | 450 | 23.4 | 21.6% | 4.9% |
| OVERHEATING | 0.50 | 450 | 32.6 | 45.6% | 8.0% |
| OVERHEATING | 0.75 | 450 | 49.3 | 76.4% | 23.6% |
| OVERHEATING | 1.00 | 450 | 60.8 | 92.7% | 50.4% |
| RPM_INSTABILITY | 0.15 | 450 | 70.2 | 99.6% | 93.6% |
| RPM_INSTABILITY | 0.30 | 450 | 75.1 | 100.0% | 100.0% |
| RPM_INSTABILITY | 0.50 | 450 | 76.9 | 100.0% | 100.0% |
| RPM_INSTABILITY | 0.75 | 450 | 79.8 | 100.0% | 100.0% |
| RPM_INSTABILITY | 1.00 | 450 | 84.5 | 100.0% | 100.0% |
| COMBINED_FAULT | 0.15 | 450 | 66.5 | 95.6% | 64.0% |
| COMBINED_FAULT | 0.30 | 450 | 79.9 | 100.0% | 97.3% |
| COMBINED_FAULT | 0.50 | 450 | 91.8 | 100.0% | 100.0% |
| COMBINED_FAULT | 0.75 | 450 | 95.9 | 100.0% | 100.0% |
| COMBINED_FAULT | 1.00 | 450 | 97.1 | 100.0% | 100.0% |

The NORMAL row is the false-alarm rate on real attested-normal data: **10.2% reach WATCH**. Every detection rate below should be read against that floor.

## 3. Detection floor

Lowest injected severity at which at least 80% of windows reach WATCH:

| fault | detection floor | physical size of that deviation |
|---|---|---|
| BELT_SLIP | severity 0.15 | vibration x1.09, RPM -2.7%, RPM std x1.7, +0.2 degC over ambient |
| HIGH_VIBRATION | severity 0.15 | vibration x1.37 |
| OVERHEATING | severity 1.00 | +6.5 degC over ambient |
| RPM_INSTABILITY | severity 0.15 | vibration x1.05, RPM std x2.9 |
| COMBINED_FAULT | severity 0.15 | vibration x1.19, RPM -0.9%, RPM std x1.7, +0.4 degC over ambient |

**This table is the single most useful output of the whole exercise.** It says how big a change of each shape has to be before the deployed detector notices, in physical units an engineer can check against the machine.

## 4. Does the explanation name the right sensor?

For high-severity injections, how often the top feature deviations point at a sensor the fault was actually injected into:

| fault | windows checked | named an affected sensor | reported multiple sensors |
|---|---|---|---|
| BELT_SLIP | 200 | 100.0% | 2.0% |
| HIGH_VIBRATION | 200 | 100.0% | 0.0% |
| OVERHEATING | 200 | 97.0% | 19.5% |
| RPM_INSTABILITY | 200 | 100.0% | 0.0% |
| COMBINED_FAULT | 200 | 100.0% | 17.0% |

This is a check on the explanation layer's internal consistency -- that when vibration is what moved, vibration is what gets reported. It is not a diagnostic-accuracy measurement.

## 5. Honest reading

- The detector responds monotonically to every deviation shape tested, and the response is driven by the sensor that actually changed.

- The detection floors give a concrete sensitivity specification that can be quoted and later checked against real faults.

- **None of this shows the system detects real faults.** Real belt slip may look nothing like the recipe. The only way to close that gap is the measurement campaign in `outputs/future_data_collection_plan.md`.

- The class balance here (225 NORMAL against thousands of faults) is an artifact of the generation grid. In service, normal would be well over 99% of windows, so any accuracy-style figure computed on this set is inflated by construction.
