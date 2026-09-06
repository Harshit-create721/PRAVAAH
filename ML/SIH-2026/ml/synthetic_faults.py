"""Physics-motivated fault injection into the real operator-attested normal recording.

READ THIS BEFORE USING ANY NUMBER DERIVED FROM THIS MODULE
==========================================================
These are **simulated** faults. Every recipe below encodes an *assumption* about how a
fault would appear on this rig's three sensors. That assumption has never been checked
against a real faulted conveyor, because no faulted conveyor was recorded.

Therefore:

* A detector scored on this data is being graded against **the recipe**, not against the
  machine. High scores prove the recipe is separable, not that the fault is detectable.
* Nothing here is evidence that the system detects real belt slip, real overheating or a
  real bearing defect.
* The one thing this data *does* answer honestly is a **sensitivity question**: "how large
  must a deviation of this shape be before the detector reacts?" That is a genuine and
  useful property of the detector, and it is what `evaluate_synthetic.py` reports.

Design decisions that keep the simulation from being trivially detectable
------------------------------------------------------------------------
1. **Injection happens at the raw frame level, not the feature level.** Perturbing
   features directly would produce impossible combinations (a higher `vib_rms_mean` with
   an unchanged `vib_rms_max`, or an RMS/crest/kurtosis triple that no waveform could
   produce). Injecting into frames and then re-running the *real* feature pipeline
   guarantees every feature stays mutually consistent.
2. **Real baseline windows are the substrate.** Each faulted window starts as an actual
   recorded window, so real sensor noise, drift, burst timing and cross-sensor
   correlation are preserved. Nothing is generated from a fitted distribution.
3. **Sensor quantisation is preserved.** Every perturbed value is re-rounded to the
   decimal resolution the real sensor reports (RPM/temperature 2 dp, vibration and
   acceleration 4 dp, shape factors 3 dp). Without this a classifier could reach perfect
   accuracy by detecting float precision rather than the fault -- it would be learning
   "synthetic" instead of "faulty".
4. **Physical bounds are enforced.** RPM stays positive, crest factor stays >= 1,
   kurtosis stays above the Gaussian floor, temperature stays above ambient.
5. **Severity is a continuous parameter**, so the output is a detection-vs-severity curve
   rather than a single accuracy number. The curve is the honest deliverable.

Fault recipes
-------------
Each is grounded in what the sensor set can actually observe. Note the rig has no motor
current and no motor-side RPM, so slip is modelled only through its belt-side signature.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import config as C

# Decimal resolution actually reported by each sensor, measured from telemetry.csv.
QUANTISATION = {
    "hall_rpm": 2,
    "temperature": 2,
    "ambient": 2,
    "vibration_rms": 4,
    "vibration_kurtosis": 3,
    "vibration_crest": 3,
    "acceleration_x": 4,
    "acceleration_y": 4,
    "acceleration_z": 4,
    "acceleration_magnitude": 4,
}

FAULT_CLASSES = ["NORMAL", "BELT_SLIP", "HIGH_VIBRATION", "OVERHEATING",
                 "RPM_INSTABILITY", "COMBINED_FAULT"]

RECIPE_DOC = {
    "BELT_SLIP": (
        "Belt slipping on the drive drum. The Hall sensor sits on the belt/drum side, so "
        "slip shows as measured RPM falling below the set point and becoming erratic "
        "(stick-slip). Friction at the drum interface adds heat, so the within-window "
        "temperature rise rate increases. Stick-slip judder raises vibration modestly and "
        "makes it slightly more impulsive. Assumption not verifiable here: the true "
        "slip signature would be motor-RPM minus belt-RPM, and this rig logs no "
        "motor-side RPM at all."),
    "HIGH_VIBRATION": (
        "Mechanical unbalance, matching the eccentric-mass experiment in the data "
        "collection plan. Broadband vibration amplitude scales up and the AC component "
        "of each acceleration axis scales with it, while the DC/gravity component stays "
        "put. Crest factor and kurtosis rise only slightly: unbalance is a sinusoidal "
        "fault, not an impulsive one. Speed and temperature are left alone."),
    "OVERHEATING": (
        "Drive-side thermal excursion. Temperature is offset upward and its within-window "
        "rise rate increases while ambient is untouched, so temperature-over-ambient is "
        "what actually moves. Vibration and RPM are left essentially alone, which is the "
        "point: this class exists to check the detector does not need vibration to fire."),
    "RPM_INSTABILITY": (
        "Speed not holding its set point. A sinusoidal modulation is added to hall_rpm "
        "with the mean preserved, so only the variability features move. A little of the "
        "speed modulation couples into vibration. This is the class the current model is "
        "least equipped for: the real recording never varied speed, so the baseline has "
        "essentially no RPM variance to compare against."),
    "COMBINED_FAULT": (
        "Two single faults applied together at reduced individual severity, to test "
        "whether the explanation layer reports multiple sensors rather than collapsing "
        "to one."),
}


def _q(values: np.ndarray, column: str) -> np.ndarray:
    """Re-round to the sensor's real reported resolution."""
    return np.round(np.asarray(values, dtype=float), QUANTISATION[column])


def _rel_seconds(df: pd.DataFrame) -> np.ndarray:
    t = df[C.TIME_COL].to_numpy(float)
    return (t - t.min()) / 1000.0


def inject(vib: pd.DataFrame, thermal: pd.DataFrame, speed: pd.DataFrame,
           fault: str, severity: float, rng: np.random.Generator):
    """Return perturbed copies of one window's three frame sets.

    `severity` is 0..1 within each class's documented range. 0 returns the window
    unchanged apart from the copy.
    """
    vib, thermal, speed = vib.copy(), thermal.copy(), speed.copy()
    if fault == "NORMAL" or severity <= 0:
        return vib, thermal, speed

    if fault == "COMBINED_FAULT":
        a, b = rng.choice(["BELT_SLIP", "HIGH_VIBRATION", "OVERHEATING",
                           "RPM_INSTABILITY"], size=2, replace=False)
        vib, thermal, speed = inject(vib, thermal, speed, str(a), severity * 0.7, rng)
        return inject(vib, thermal, speed, str(b), severity * 0.7, rng)

    s = float(np.clip(severity, 0.0, 1.0))

    # ---------------------------------------------------------------- vibration
    if fault in ("HIGH_VIBRATION", "BELT_SLIP", "RPM_INSTABILITY"):
        if fault == "HIGH_VIBRATION":
            gain = 1.0 + 2.5 * s          # up to ~3.5x RMS at full severity
            crest_gain = 1.0 + 0.15 * s   # unbalance is sinusoidal, not impulsive
            kurt_gain = 1.0 + 0.20 * s
        elif fault == "BELT_SLIP":
            gain = 1.0 + 0.6 * s          # judder: modest amplitude rise
            crest_gain = 1.0 + 0.45 * s   # ...but noticeably more impulsive
            kurt_gain = 1.0 + 0.90 * s
        else:  # RPM_INSTABILITY couples weakly into vibration
            gain = 1.0 + 0.35 * s
            crest_gain = 1.0 + 0.10 * s
            kurt_gain = 1.0 + 0.15 * s

        jitter = 1.0 + rng.normal(0.0, 0.04 * s, size=len(vib))
        vib["vibration_rms"] = _q(vib["vibration_rms"].to_numpy(float) * gain * jitter,
                                  "vibration_rms")
        # Crest factor cannot fall below 1; kurtosis cannot fall below the Gaussian floor.
        vib["vibration_crest"] = _q(np.maximum(
            1.0, vib["vibration_crest"].to_numpy(float) * crest_gain), "vibration_crest")
        vib["vibration_kurtosis"] = _q(np.maximum(
            1.0, vib["vibration_kurtosis"].to_numpy(float) * kurt_gain), "vibration_kurtosis")

        # Scale only the AC component of each axis; the DC/gravity component is a
        # mounting property and does not change because the machine vibrates more.
        for axis in ("acceleration_x", "acceleration_y", "acceleration_z",
                     "acceleration_magnitude"):
            v = vib[axis].to_numpy(float)
            dc = v.mean()
            vib[axis] = _q(dc + (v - dc) * gain, axis)

    # ---------------------------------------------------------------- speed
    if fault == "BELT_SLIP":
        r = speed["hall_rpm"].to_numpy(float)
        nominal = r.mean()
        slip = 0.18 * s                                   # up to 18% speed loss
        # Stick-slip: the belt grabs and releases rather than sliding smoothly.
        t = _rel_seconds(speed)
        judder = 0.020 * s * nominal * np.sin(2 * np.pi * t / 1.7 + rng.uniform(0, 6.28))
        noise = rng.normal(0.0, 0.012 * s * nominal, size=len(r))
        speed["hall_rpm"] = _q(np.maximum(0.0, r * (1.0 - slip) + judder + noise), "hall_rpm")

    elif fault == "RPM_INSTABILITY":
        r = speed["hall_rpm"].to_numpy(float)
        nominal = r.mean()
        t = _rel_seconds(speed)
        period = rng.uniform(2.5, 6.0)
        swing = 0.045 * s * nominal                       # up to ~4.5% peak deviation
        osc = swing * np.sin(2 * np.pi * t / period + rng.uniform(0, 6.28))
        noise = rng.normal(0.0, 0.015 * s * nominal, size=len(r))
        # Mean preserved: only the variability features should move.
        pert = r + osc + noise
        pert = pert - pert.mean() + nominal
        speed["hall_rpm"] = _q(np.maximum(0.0, pert), "hall_rpm")

    # ---------------------------------------------------------------- thermal
    if fault in ("OVERHEATING", "BELT_SLIP"):
        tp = thermal["temperature"].to_numpy(float)
        amb = thermal["ambient"].to_numpy(float)
        t = _rel_seconds(thermal)
        span = max(t.max(), 1e-6)

        if fault == "OVERHEATING":
            offset = 6.0 * s                              # up to +6 degC over baseline
            extra_rate = 0.9 * s                          # up to +0.9 degC across the window
        else:                                             # friction heating from slip
            offset = 1.2 * s
            extra_rate = 0.5 * s

        ramp = extra_rate * (t / span)
        noise = rng.normal(0.0, 0.02 * s, size=len(tp))
        pert = tp + offset + ramp + noise
        # Physical floor: the belt cannot read colder than the ambient probe.
        thermal["temperature"] = _q(np.maximum(amb + 0.05, pert), "temperature")

    return vib, thermal, speed


# --------------------------------------------------------------------------------------
# Dataset construction
# --------------------------------------------------------------------------------------
def build_synthetic_dataset(pre, feats: pd.DataFrame,
                            severities=(0.15, 0.3, 0.5, 0.75, 1.0),
                            repeats: int = 2,
                            seed: int = C.RANDOM_STATE) -> pd.DataFrame:
    """Inject every fault at every severity into every real baseline window.

    The returned table has the same feature columns as `outputs/features.csv`, plus
    `fault_class`, `severity` and `source_window_id`, so it can be scored by the existing
    unsupervised model or used to fit a supervised one.
    """
    import feature_engineering as fe

    rng = np.random.default_rng(seed)
    streams = pre.streams
    rows = []

    def parts_for(row):
        out = {}
        for role in C.REQUIRED_SENSORS:
            s = streams[role]
            m = ((s[C.SEGMENT_COL].to_numpy() == row.segment_id)
                 & (s[C.TIME_COL].to_numpy() >= row.start_ms)
                 & (s[C.TIME_COL].to_numpy() < row.end_ms))
            out[role] = s.loc[m].reset_index(drop=True)
        return out

    for row in feats.itertuples(index=False):
        base = parts_for(row)

        # The unmodified real window is the NORMAL class. It is included once, not
        # `repeats` times, because duplicating identical rows would silently reweight it.
        f = fe.compute_window_features(base["vibration"], base["thermal"],
                                       base["speed"], C.WINDOW_SECONDS)
        f.update({"fault_class": "NORMAL", "severity": 0.0,
                  "source_window_id": int(row.window_id),
                  "segment_id": row.segment_id,
                  "segment_order": int(row.segment_order),
                  "synthetic": False})
        rows.append(f)

        for fault in FAULT_CLASSES[1:]:
            for sev in severities:
                for _ in range(repeats):
                    v, t, sp = inject(base["vibration"], base["thermal"], base["speed"],
                                      fault, sev, rng)
                    f = fe.compute_window_features(v, t, sp, C.WINDOW_SECONDS)
                    f.update({"fault_class": fault, "severity": float(sev),
                              "source_window_id": int(row.window_id),
                              "segment_id": row.segment_id,
                              "segment_order": int(row.segment_order),
                              "synthetic": True})
                    rows.append(f)

    df = pd.DataFrame(rows)
    lead = ["fault_class", "severity", "synthetic", "source_window_id",
            "segment_id", "segment_order"]
    return df[lead + [c for c in df.columns if c not in lead]]


def sanity_check(df: pd.DataFrame) -> dict:
    """Confirm the injection did what the recipes claim, and nothing physically absurd."""
    out = {}
    base = df[df.fault_class == "NORMAL"]
    for cls in FAULT_CLASSES[1:]:
        hi = df[(df.fault_class == cls) & (df.severity >= 0.75)]
        if hi.empty:
            continue
        out[cls] = {
            "vib_rms_mean_ratio": round(float(hi.vib_rms_mean.mean() / base.vib_rms_mean.mean()), 3),
            "rpm_mean_ratio": round(float(hi.rpm_mean.mean() / base.rpm_mean.mean()), 4),
            "rpm_std_ratio": round(float(hi.rpm_std.mean() / max(base.rpm_std.mean(), 1e-9)), 2),
            "temp_over_ambient_delta_c": round(float(hi.temp_over_ambient_mean.mean()
                                                     - base.temp_over_ambient_mean.mean()), 2),
            "temp_rise_delta_c_per_min": round(float(hi.temp_rise_c_per_min.mean()
                                                     - base.temp_rise_c_per_min.mean()), 3),
        }
    feat_cols = [c for c in df.columns if c not in
                 ("fault_class", "severity", "synthetic", "source_window_id",
                  "segment_id", "segment_order")]
    X = df[feat_cols].to_numpy(float)
    out["_integrity"] = {
        "rows": int(len(df)),
        "non_finite_values": int((~np.isfinite(X)).sum()),
        "negative_rpm_rows": int((df.rpm_min < 0).sum()),
        "crest_below_1_rows": int((df.vib_crest_sensor_min < 1.0).sum()),
        "temp_below_ambient_rows": int((df.temp_over_ambient_min < 0).sum()),
    }
    return out


def main():
    import preprocessing
    import os

    C.ensure_dirs()
    pre = preprocessing.preprocess()
    feats = pd.read_csv(C.FEATURES_CSV)
    print("injecting faults into %d real baseline windows ..." % len(feats))
    df = build_synthetic_dataset(pre, feats)
    path = os.path.join(C.OUTPUTS_DIR, "synthetic_dataset.csv")
    df.to_csv(path, index=False)
    print("wrote %s  (%d rows)" % (os.path.relpath(path, C.ROOT), len(df)))
    print(df.fault_class.value_counts().to_string())
    print()
    chk = sanity_check(df)
    for k, v in chk.items():
        print("%-18s %s" % (k, v))
    return df


if __name__ == "__main__":
    main()
