"""Turn an Isolation Forest raw score into anomaly_score / health_score / status / reasons.

Read this before trusting any number that comes out of here:

    The anomaly score is NOT a probability of failure and NOT a remaining-useful-life
    estimate. It answers one question only -- "how unusual does this 10 s window look
    compared with the operating behaviour the model was fitted on?" -- on a bounded
    0-100 scale. Calibrating it into a failure probability would need a labelled
    run-to-failure dataset, which does not exist for this conveyor.

Calibration
-----------
`IsolationForest.decision_function` is negated so that higher = more unusual, then
converted to a robust z-score against the baseline (median / MAD, so a few unusual
baseline windows do not stretch the scale), then squashed with a logistic anchored on
two baseline quantiles:

    score(z_at_baseline_p50) ~=  5
    score(z_at_baseline_p99) ~= 50

So 50 means "as unusual as the most unusual 1% of the baseline". The mapping is
monotone and bounded, so an extreme reading saturates towards 100 instead of blowing up.
"""
from __future__ import annotations

import json

import numpy as np

import config as C

LOGIT_AT_5 = float(np.log(5.0 / 95.0))       # -2.9444


# --------------------------------------------------------------------------------------
# Calibration
# --------------------------------------------------------------------------------------
def fit_calibration(raw_baseline: np.ndarray) -> dict:
    """Derive the score mapping from the baseline raw scores (higher = more unusual)."""
    r = np.asarray(raw_baseline, dtype=float)
    r = r[np.isfinite(r)]
    if r.size < 10:
        raise ValueError("Need at least 10 baseline scores to calibrate.")

    median = float(np.median(r))
    mad = float(np.median(np.abs(r - median)) * 1.4826)
    if mad < C.EPS:
        mad = float(r.std(ddof=1)) or 1.0

    z = (r - median) / mad
    z_p50 = float(np.percentile(z, 50))
    z_p99 = float(np.percentile(z, 99))
    if z_p99 - z_p50 < 1e-6:
        z_p99 = z_p50 + 1.0

    z_mid = z_p99                              # maps to 50
    k = (z_mid - z_p50) / (-LOGIT_AT_5)        # so z_p50 -> ~5
    if k < 1e-6:
        k = 1.0

    return {
        "raw_median": median,
        "raw_mad_scaled": mad,
        "z_mid": z_mid,
        "z_scale": k,
        "baseline_raw_p50": float(np.percentile(r, 50)),
        "baseline_raw_p95": float(np.percentile(r, 95)),
        "baseline_raw_p99": float(np.percentile(r, 99)),
        "baseline_n": int(r.size),
        "note": ("anomaly_score = 100 / (1 + exp(-(z - z_mid) / z_scale)) where "
                 "z = (raw - raw_median) / raw_mad_scaled and raw = -decision_function. "
                 "50 corresponds to the baseline 99th percentile of unusualness. "
                 "This is a relative unusualness scale, not a failure probability."),
    }


def raw_to_anomaly_score(raw, calib: dict) -> np.ndarray:
    r = np.atleast_1d(np.asarray(raw, dtype=float))
    z = (r - calib["raw_median"]) / max(calib["raw_mad_scaled"], C.EPS)
    x = (z - calib["z_mid"]) / max(calib["z_scale"], C.EPS)
    score = 100.0 / (1.0 + np.exp(-np.clip(x, -60, 60)))
    return np.clip(score, 0.0, 100.0)


def health_from_anomaly(anomaly_score) -> np.ndarray:
    a = np.atleast_1d(np.asarray(anomaly_score, dtype=float))
    return np.clip(100.0 - a, 0.0, 100.0)


# --------------------------------------------------------------------------------------
# Status thresholds
# --------------------------------------------------------------------------------------
STATUSES = ["NORMAL", "WATCH", "WARNING", "CRITICAL"]


def fit_thresholds(baseline_scores: np.ndarray) -> dict:
    """Pick prototype thresholds from the baseline anomaly-score distribution.

    Anchored on baseline quantiles rather than round numbers pulled from the air, then
    rounded to one decimal for readability. The realised baseline exceedance rate of
    each threshold is stored alongside it so the choice can be audited.
    """
    s = np.asarray(baseline_scores, dtype=float)
    watch = float(np.percentile(s, 90))
    warning = float(np.percentile(s, 98))
    critical = float(np.percentile(s, 99.5))

    # Keep the bands strictly ordered and usefully apart even if the baseline is tight.
    warning = max(warning, watch + 2.0)
    critical = max(critical, warning + 2.0)

    th = {
        "watch": round(watch, 1),
        "warning": round(warning, 1),
        "critical": round(critical, 1),
    }
    return {
        "thresholds": th,
        "derivation": {
            "watch": "baseline anomaly-score p90",
            "warning": "baseline anomaly-score p98 (floored at watch + 2)",
            "critical": "baseline anomaly-score p99.5 (floored at warning + 2)",
        },
        "realised_baseline_exceedance": {
            "watch": float((s >= th["watch"]).mean()),
            "warning": float((s >= th["warning"]).mean()),
            "critical": float((s >= th["critical"]).mean()),
        },
        "status_order": STATUSES,
        "disclaimer": ("PROTOTYPE THRESHOLDS. Derived from one unlabelled recording of one "
                       "conveyor. They are not industrial safety limits, not certified trip "
                       "points, and carry no guarantee of detecting any particular fault. "
                       "Edit models/thresholds.json to retune without retraining."),
    }


def classify(anomaly_score, thresholds: dict):
    """Map score(s) to NORMAL / WATCH / WARNING / CRITICAL."""
    t = thresholds["thresholds"] if "thresholds" in thresholds else thresholds
    s = np.atleast_1d(np.asarray(anomaly_score, dtype=float))
    out = np.array(["NORMAL"] * s.size, dtype=object)
    out[s >= t["watch"]] = "WATCH"
    out[s >= t["warning"]] = "WARNING"
    out[s >= t["critical"]] = "CRITICAL"
    return out


# --------------------------------------------------------------------------------------
# Explanation
# --------------------------------------------------------------------------------------
# Feature -> (indicator tag, human phrase). Only features that actually deviate are used;
# nothing here names a mechanical fault mode, because nothing in the dataset can support
# such a claim.
INDICATOR_RULES = [
    # (feature name, direction, indicator tag, phrase)
    ("vib_rms_mean", "high", "vibration_above_baseline",
     "average vibration is above the learned baseline"),
    ("vib_rms_mean", "low", "vibration_below_baseline",
     "average vibration is below the learned baseline"),
    ("vib_rms_max", "high", "vibration_peak_above_baseline",
     "peak vibration in the window is above the learned baseline"),
    ("vib_rms_std", "high", "vibration_variability_elevated",
     "vibration is fluctuating more than the baseline"),
    ("vib_rms_range", "high", "vibration_range_elevated",
     "the spread between minimum and maximum vibration is unusually wide"),
    ("vib_impulsiveness", "high", "impulsive_vibration_events",
     "impulsive vibration events (high crest factor and kurtosis) are present"),
    ("vib_crest_sensor_max", "high", "vibration_crest_elevated",
     "vibration crest factor peaked above the baseline"),
    ("vib_kurt_sensor_max", "high", "vibration_kurtosis_elevated",
     "vibration kurtosis peaked above the baseline, indicating spiky rather than "
     "steady vibration"),
    ("vib_instability_at_stable_rpm", "high", "vibration_unstable_while_rpm_steady",
     "vibration varied while the drive speed stayed steady"),
    ("temp_mean", "high", "temperature_above_baseline",
     "temperature is above the learned baseline"),
    ("temp_mean", "low", "temperature_below_baseline",
     "temperature is below the learned baseline"),
    ("temp_over_ambient_mean", "high", "temperature_rise_over_ambient_elevated",
     "temperature above ambient is larger than the baseline"),
    ("temp_rise_c_per_min", "high", "temperature_rising_fast",
     "temperature is rising faster than the baseline"),
    ("temp_rise_c_per_min", "low", "temperature_falling_fast",
     "temperature is falling faster than the baseline"),
    ("temp_range", "high", "temperature_swing_elevated",
     "temperature swung more within the window than the baseline"),
    ("rpm_mean", "high", "rpm_above_baseline", "drive speed is above the learned baseline"),
    ("rpm_mean", "low", "rpm_below_baseline", "drive speed is below the learned baseline"),
    ("rpm_std", "high", "rpm_instability", "drive speed is less steady than the baseline"),
    ("rpm_range", "high", "rpm_range_elevated",
     "the spread between minimum and maximum drive speed is unusually wide"),
    ("rpm_cv", "high", "rpm_instability",
     "relative drive-speed variation is above the baseline"),
    ("rpm_slope_per_s", "low", "rpm_decreasing", "drive speed is trending down within the window"),
    ("rpm_slope_per_s", "high", "rpm_increasing", "drive speed is trending up within the window"),
    ("vib_per_rpm", "high", "vibration_per_rpm_elevated",
     "vibration relative to drive speed is above the baseline"),
    ("acceleration_magnitude_mean", "high", "orientation_shift",
     "the static acceleration vector has shifted, which can indicate a mounting change"),
    ("acceleration_magnitude_mean", "low", "orientation_shift",
     "the static acceleration vector has shifted, which can indicate a mounting change"),
]

SENSOR_OF_FEATURE = [
    ("vib", "vibration"), ("acceleration", "vibration"),
    ("temp", "temperature"), ("ambient", "temperature"),
    ("rpm", "rpm"),
]


def feature_sensor(name: str) -> str:
    for prefix, sensor in SENSOR_OF_FEATURE:
        if name.startswith(prefix):
            return sensor
    return "other"


def fit_baseline_feature_stats(X: np.ndarray, feature_names: list) -> dict:
    """Robust per-feature location/scale of the baseline, used for deviation reporting.

    Fit this on the **unscaled** feature matrix so that `explain()` can quote values in
    physical units (degC, g, RPM) rather than scaler-transformed units. The robust
    z-score is unaffected by the choice: RobustScaler is a per-feature affine map and a
    median/MAD z-score is invariant under affine transforms, so scaled and unscaled
    inputs give identical z values.
    """
    X = np.asarray(X, dtype=float)
    med = np.median(X, axis=0)
    mad = np.median(np.abs(X - med), axis=0) * 1.4826
    std = X.std(axis=0, ddof=1)
    scale = np.where(mad > C.EPS, mad, np.where(std > C.EPS, std, 1.0))
    return {
        "feature_names": list(feature_names),
        "median": med.tolist(),
        "scale": scale.tolist(),
        "p01": np.percentile(X, 1, axis=0).tolist(),
        "p99": np.percentile(X, 99, axis=0).tolist(),
        "min": X.min(axis=0).tolist(),
        "max": X.max(axis=0).tolist(),
    }


def explain(x_row: np.ndarray,
            baseline_stats: dict,
            status: str,
            top_k: int = 4,
            z_floor: float = 2.5) -> dict:
    """Explain one window: which features deviate, in which direction, and by how much.

    `x_row` must be the **unscaled** feature vector, in the same order as
    `baseline_stats["feature_names"]`, so reported values carry physical units.

    Returns indicators (machine-readable tags), a prose explanation and the ranked
    per-feature deviations. Only deviations that actually exceed `z_floor` are reported,
    so a NORMAL window does not get a fabricated story.
    """
    names = baseline_stats["feature_names"]
    med = np.asarray(baseline_stats["median"], dtype=float)
    scale = np.asarray(baseline_stats["scale"], dtype=float)
    x = np.asarray(x_row, dtype=float).ravel()

    z = (x - med) / np.where(scale > C.EPS, scale, 1.0)
    order = np.argsort(-np.abs(z))

    deviations = []
    for i in order[: max(top_k * 3, 12)]:
        if not np.isfinite(z[i]) or abs(z[i]) < z_floor:
            continue
        deviations.append({
            "feature": names[i],
            "sensor": feature_sensor(names[i]),
            "value": round(float(x[i]), 6),
            "baseline_median": round(float(med[i]), 6),
            "robust_z": round(float(z[i]), 2),
            "direction": "above" if z[i] > 0 else "below",
        })

    # Map the strongest deviations onto human-readable indicators. Indicators and prose
    # come from one ranked list, so the tags can never disagree with the sentence.
    ranked, seen = [], set()
    zmap = {names[i]: z[i] for i in range(len(names))}
    for feat, direction, tag, phrase in INDICATOR_RULES:
        if feat not in zmap:
            continue
        zz = zmap[feat]
        if not np.isfinite(zz) or abs(zz) < z_floor:
            continue
        if (direction == "high" and zz <= 0) or (direction == "low" and zz >= 0):
            continue
        if tag in seen:
            continue
        seen.add(tag)
        ranked.append((abs(float(zz)), tag, phrase))

    ranked.sort(key=lambda r: -r[0])
    ranked = ranked[:top_k]
    indicators = [r[1] for r in ranked]
    phrases = [r[2] for r in ranked]

    sensors_involved = sorted({d["sensor"] for d in deviations[:top_k]} - {"other"})
    if len(sensors_involved) >= 2 and "multiple_sensors_deviating" not in indicators:
        indicators.append("multiple_sensors_deviating")

    if status == "NORMAL" and not phrases:
        text = ("Operating condition is consistent with the learned baseline; no feature "
                "deviates materially.")
    elif not phrases:
        text = ("Window scored as %s by the model, but no single feature exceeds the "
                "reporting threshold -- the deviation is spread across many features "
                "rather than concentrated in one." % status)
    else:
        joined = phrases[0] if len(phrases) == 1 else \
            "; ".join(phrases[:-1]) + "; and " + phrases[-1]
        if status == "NORMAL":
            # Report the deviation, but do not let it read like an alert.
            lead = ("Overall condition is within the normal band. The only feature%s "
                    "outside the usual spread: " % ("s" if len(phrases) > 1 else ""))
            text = lead + joined + "."
        else:
            lead = ("Multiple sensor indicators changed simultaneously: "
                    if len(sensors_involved) >= 2 else "")
            text = lead + joined[0].upper() + joined[1:] + "."
        if status in ("WARNING", "CRITICAL"):
            text += (" Possible mechanical or thermal abnormality -- inspect before "
                     "drawing a conclusion. This is a statistical deviation from the "
                     "learned baseline, not a diagnosed fault.")

    return {
        "indicators": indicators,
        "explanation": text,
        "top_deviations": deviations[:top_k],
    }


# --------------------------------------------------------------------------------------
# Scoring engine
# --------------------------------------------------------------------------------------
# A single Isolation Forest over all 59 features under-reacts to a deviation confined to
# one sensor: 40 of the features are vibration and only 12 are thermal, so random splits
# rarely land on the channel that moved. Measured effect (outputs/synthetic_fault_report.md):
# a thermal excursion far outside anything ever recorded -- temperature-over-ambient at
# 9.7-13.2 degC against a baseline maximum of 6.75 -- reached WATCH in barely half of
# windows, while a 1.33x vibration rise flagged 98.7% of them.
#
# The fix is an ensemble: alongside the joint detector, one Isolation Forest per sensor
# group, each calibrated on the same baseline. The reported anomaly score is the maximum
# across detectors, so a single-sensor deviation is judged against that sensor's own
# baseline spread instead of being averaged away. `driver` records which detector fired,
# which also makes the explanation sharper.
GROUP_ORDER = ["joint", "vibration", "temperature", "rpm"]


def feature_groups(feature_names: list) -> dict:
    """Map each sensor group to the indices of its features."""
    groups = {}
    for i, name in enumerate(feature_names):
        groups.setdefault(feature_sensor(name), []).append(i)
    return {g: idx for g, idx in groups.items() if g != "other" and len(idx) >= 3}


class ScoreEngine:
    """Loads the trained artifacts and scores feature matrices.

    Used identically by train.py, evaluate.py, evaluate_synthetic.py and predict.py, so
    every consumer produces the same number for the same window.
    """

    def __init__(self, models: dict, scaler, calibrations: dict, thresholds: dict,
                 feature_order: list, groups: dict):
        self.models = models
        self.scaler = scaler
        self.calibrations = calibrations
        self.thresholds = thresholds
        self.feature_order = feature_order
        self.groups = groups

    @classmethod
    def load(cls, models_dir: str = None):
        import os
        import joblib
        import config as _C

        models_dir = models_dir or _C.MODELS_DIR
        fcfg = load_json(os.path.join(models_dir, "feature_config.json"))
        scaler = joblib.load(os.path.join(models_dir, "scaler.joblib"))
        thresholds = load_json(os.path.join(models_dir, "thresholds.json"))

        models = {"joint": joblib.load(os.path.join(models_dir, "isolation_forest.joblib"))}
        sub_path = os.path.join(models_dir, "sensor_detectors.joblib")
        models.update(joblib.load(sub_path))
        if set(models) != set(fcfg["ensemble"]["detectors"]):
            raise ValueError("incomplete or mismatched detector ensemble artifacts")
        return cls(models, scaler, fcfg["score_calibration_by_group"], thresholds,
                   fcfg["feature_order"], fcfg["feature_groups"])

    def raw_scores(self, X_scaled: np.ndarray) -> dict:
        """Per-detector calibrated 0-100 scores."""
        out = {}
        for name, model in self.models.items():
            cols = slice(None) if name == "joint" else self.groups[name]
            Xg = X_scaled if name == "joint" else X_scaled[:, cols]
            raw = -model.decision_function(Xg)
            out[name] = raw_to_anomaly_score(raw, self.calibrations[name])
        return out

    def score(self, X_raw: np.ndarray) -> dict:
        """Full verdict for a batch of unscaled feature rows."""
        X = self.scaler.transform(np.atleast_2d(np.asarray(X_raw, dtype=float)))
        per = self.raw_scores(X)
        names = [g for g in GROUP_ORDER if g in per]
        stacked = np.vstack([per[g] for g in names])
        anomaly = np.clip(stacked.max(axis=0), 0.0, 100.0)
        driver = [names[i] for i in stacked.argmax(axis=0)]
        return {
            "anomaly_score": anomaly,
            "health_score": health_from_anomaly(anomaly),
            "status": classify(anomaly, self.thresholds),
            "driver": driver,
            "per_detector": per,
            "X_scaled": X,
        }


def save_json(obj, path: str) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, indent=2)


def load_json(path: str):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)
