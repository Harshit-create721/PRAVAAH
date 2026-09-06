"""Window the synchronised sensor streams and compute one feature vector per window.

One ML sample = one time window of the conveyor's operating condition, NOT one CSV row.

Hard rules enforced here:
  * A window lives entirely inside a single segment_id. Windows never span a boundary.
  * Nothing is interpolated, resampled, forward-filled or zero-filled across gaps.
  * A window is emitted only if every required sensor genuinely covers it.

The same functions are used by training and by ml/predict.py, so training-time and
inference-time features cannot diverge.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy import stats

import config as C


# --------------------------------------------------------------------------------------
# Low-level statistic helpers. Every one is total: it returns a finite float for any
# input, so a degenerate window can never inject NaN/inf into the model.
# --------------------------------------------------------------------------------------
def _f(x, default=0.0) -> float:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return float(default)
    return v if np.isfinite(v) else float(default)


def _slope_per_s(values: np.ndarray, times_s: np.ndarray) -> float:
    """OLS slope in units/second. 0.0 when the window has no time spread to fit on."""
    if len(values) < 2:
        return 0.0
    t = np.asarray(times_s, dtype=float)
    v = np.asarray(values, dtype=float)
    if np.unique(t).size < 2 or t.std() < C.EPS:
        return 0.0
    return _f(np.polyfit(t - t.mean(), v, 1)[0])


def basic_stats(prefix: str, v: np.ndarray) -> dict:
    """mean/std/rms/min/max/range/median/p25/p75/kurtosis/crest for one signal."""
    v = np.asarray(v, dtype=float)
    v = v[np.isfinite(v)]
    if v.size == 0:
        keys = ["mean", "std", "rms", "min", "max", "range", "median",
                "p25", "p75", "kurtosis", "crest_factor"]
        return {"%s_%s" % (prefix, k): 0.0 for k in keys}
    rms = float(np.sqrt(np.mean(v ** 2)))
    kurt = stats.kurtosis(v, fisher=True, bias=False) if v.size > 3 and v.std() > C.EPS else 0.0
    return {
        "%s_mean" % prefix: _f(v.mean()),
        "%s_std" % prefix: _f(v.std(ddof=1) if v.size > 1 else 0.0),
        "%s_rms" % prefix: _f(rms),
        "%s_min" % prefix: _f(v.min()),
        "%s_max" % prefix: _f(v.max()),
        "%s_range" % prefix: _f(v.max() - v.min()),
        "%s_median" % prefix: _f(np.median(v)),
        "%s_p25" % prefix: _f(np.percentile(v, 25)),
        "%s_p75" % prefix: _f(np.percentile(v, 75)),
        "%s_kurtosis" % prefix: _f(kurt),
        "%s_crest_factor" % prefix: _f(np.max(np.abs(v)) / rms if rms > C.EPS else 0.0),
    }


def compact_stats(prefix: str, v: np.ndarray) -> dict:
    """mean/std/min/max/range -- for signals where the full 11-stat block is overkill."""
    v = np.asarray(v, dtype=float)
    v = v[np.isfinite(v)]
    if v.size == 0:
        return {"%s_%s" % (prefix, k): 0.0
                for k in ["mean", "std", "min", "max", "range"]}
    return {
        "%s_mean" % prefix: _f(v.mean()),
        "%s_std" % prefix: _f(v.std(ddof=1) if v.size > 1 else 0.0),
        "%s_min" % prefix: _f(v.min()),
        "%s_max" % prefix: _f(v.max()),
        "%s_range" % prefix: _f(v.max() - v.min()),
    }


# --------------------------------------------------------------------------------------
# Window enumeration
# --------------------------------------------------------------------------------------
def enumerate_windows(segments: pd.DataFrame,
                      window_s: float = None,
                      step_s: float = None) -> list:
    """Candidate [start_ms, end_ms) windows, each fully inside one segment."""
    window_s = C.WINDOW_SECONDS if window_s is None else window_s
    step_s = C.STEP_SECONDS if step_s is None else step_s
    w_ms = int(round(window_s * 1000))
    s_ms = int(round(step_s * 1000))
    out = []
    for row in segments.itertuples(index=False):
        t = int(row.start_ms)
        last = int(row.end_ms)
        while t + w_ms <= last + 1:
            out.append({
                "segment_id": row.segment_id,
                "segment_order": int(row.order),
                "start_ms": t,
                "end_ms": t + w_ms,
            })
            t += s_ms
    return out


def _slice(stream: pd.DataFrame, segment_id, start_ms: int, end_ms: int) -> pd.DataFrame:
    m = ((stream[C.SEGMENT_COL].to_numpy() == segment_id)
         & (stream[C.TIME_COL].to_numpy() >= start_ms)
         & (stream[C.TIME_COL].to_numpy() < end_ms))
    return stream.loc[m]


def window_is_valid(parts: dict, window_s: float,
                    min_frames: int = None, min_coverage: float = None) -> tuple:
    """Every required sensor must have enough frames AND span enough of the window."""
    min_frames = C.MIN_FRAMES_PER_SENSOR if min_frames is None else min_frames
    min_coverage = C.MIN_TIME_COVERAGE if min_coverage is None else min_coverage
    for role in C.REQUIRED_SENSORS:
        d = parts.get(role)
        if d is None or len(d) < min_frames:
            return False, "insufficient_frames:%s" % role
        t = d[C.TIME_COL].to_numpy()
        if (t.max() - t.min()) / 1000.0 < min_coverage * window_s:
            return False, "insufficient_time_coverage:%s" % role
    return True, "ok"


# --------------------------------------------------------------------------------------
# Feature computation for a single window
# --------------------------------------------------------------------------------------
def compute_window_features(vib: pd.DataFrame,
                            thermal: pd.DataFrame,
                            speed: pd.DataFrame,
                            window_s: float = None) -> dict:
    """Feature vector for one window. `vib`/`thermal`/`speed` are the raw frames in it.

    Accepts plain DataFrames so ml/predict.py can call it on a live rolling buffer
    without going through the file-based pipeline.
    """
    window_s = C.WINDOW_SECONDS if window_s is None else window_s
    f = {}

    # ---------------- vibration ----------------
    vr = vib["vibration_rms"].to_numpy(float)
    f.update(basic_stats("vib_rms", vr))
    f.update(compact_stats("vib_kurt_sensor", vib["vibration_kurtosis"].to_numpy(float)))
    f.update(compact_stats("vib_crest_sensor", vib["vibration_crest"].to_numpy(float)))
    for axis in ("acceleration_x", "acceleration_y", "acceleration_z",
                 "acceleration_magnitude"):
        if axis in vib.columns:
            f.update(compact_stats(axis, vib[axis].to_numpy(float)))
    vib_t = (vib[C.TIME_COL].to_numpy(float) - vib[C.TIME_COL].to_numpy(float).min()) / 1000.0
    f["vib_rms_slope_per_s"] = _slope_per_s(vr, vib_t)

    # ---------------- temperature ----------------
    tp = thermal["temperature"].to_numpy(float)
    th_t = (thermal[C.TIME_COL].to_numpy(float) - thermal[C.TIME_COL].to_numpy(float).min()) / 1000.0
    f["temp_mean"] = _f(np.mean(tp))
    f["temp_min"] = _f(np.min(tp))
    f["temp_max"] = _f(np.max(tp))
    f["temp_std"] = _f(np.std(tp, ddof=1) if tp.size > 1 else 0.0)
    f["temp_range"] = _f(np.max(tp) - np.min(tp))
    f["temp_slope_per_s"] = _slope_per_s(tp, th_t)
    f["temp_change"] = _f(tp[-1] - tp[0]) if tp.size else 0.0

    amb = thermal["ambient"].to_numpy(float)
    f["ambient_mean"] = _f(np.mean(amb))
    f["ambient_std"] = _f(np.std(amb, ddof=1) if amb.size > 1 else 0.0)
    f["ambient_slope_per_s"] = _slope_per_s(amb, th_t)

    # Temperature relative to ambient: the drift-robust view of the thermal signal.
    dl = tp - amb
    f["temp_over_ambient_mean"] = _f(np.mean(dl))
    f["temp_over_ambient_min"] = _f(np.min(dl))
    f["temp_over_ambient_max"] = _f(np.max(dl))
    f["temp_over_ambient_std"] = _f(np.std(dl, ddof=1) if dl.size > 1 else 0.0)
    f["temp_over_ambient_slope_per_s"] = _slope_per_s(dl, th_t)

    # ---------------- RPM ----------------
    rp = speed["hall_rpm"].to_numpy(float)
    sp_t = (speed[C.TIME_COL].to_numpy(float) - speed[C.TIME_COL].to_numpy(float).min()) / 1000.0
    rmean = _f(np.mean(rp))
    rstd = _f(np.std(rp, ddof=1) if rp.size > 1 else 0.0)
    f["rpm_mean"] = rmean
    f["rpm_min"] = _f(np.min(rp))
    f["rpm_max"] = _f(np.max(rp))
    f["rpm_std"] = rstd
    f["rpm_range"] = _f(np.max(rp) - np.min(rp))
    f["rpm_cv"] = _f(rstd / rmean if abs(rmean) > C.EPS else 0.0)
    f["rpm_slope_per_s"] = _slope_per_s(rp, sp_t)
    f["rpm_change"] = _f(rp[-1] - rp[0]) if rp.size else 0.0

    # ---------------- cross-sensor ----------------
    vmean = f["vib_rms_mean"]
    vstd = f["vib_rms_std"]
    rpm_safe = rmean if abs(rmean) > C.EPS else C.EPS
    vib_cv = _f(vstd / vmean if abs(vmean) > C.EPS else 0.0)
    rpm_stability = _f(1.0 / (1.0 + f["rpm_cv"]))

    f["vib_cv"] = vib_cv
    f["rpm_stability"] = rpm_stability
    f["vib_per_rpm"] = _f(vmean / rpm_safe)
    f["vib_std_per_rpm"] = _f(vstd / rpm_safe)
    f["vib_peak_per_rpm"] = _f(f["vib_rms_max"] / rpm_safe)
    f["temp_over_ambient_per_rpm"] = _f(f["temp_over_ambient_mean"] / rpm_safe)
    f["temp_rise_c_per_min"] = _f(f["temp_slope_per_s"] * 60.0)
    f["temp_over_ambient_rise_c_per_min"] = _f(f["temp_over_ambient_slope_per_s"] * 60.0)
    # Vibration variability weighted by how steady the RPM was: high when vibration
    # wanders while the drive speed does not.
    f["vib_instability_at_stable_rpm"] = _f(vib_cv * rpm_stability)
    # Impulsiveness composite from the sensor's own per-frame shape factors.
    f["vib_impulsiveness"] = _f(f["vib_crest_sensor_max"] * f["vib_kurt_sensor_max"])

    return f


FEATURE_PREFIXES_BY_SENSOR = {
    "vibration": ("vib_", "acceleration_"),
    "thermal": ("temp_", "ambient_"),
    "speed": ("rpm_",),
}


def build_feature_table(pre, window_s: float = None, step_s: float = None) -> pd.DataFrame:
    """Full feature table for a preprocessed recording."""
    window_s = C.WINDOW_SECONDS if window_s is None else window_s
    step_s = C.STEP_SECONDS if step_s is None else step_s

    vib_s, th_s, sp_s = pre.streams["vibration"], pre.streams["thermal"], pre.streams["speed"]
    t0_global = int(pre.raw[C.TIME_COL].min())

    rows, rejects = [], []
    for w in enumerate_windows(pre.segments, window_s, step_s):
        parts = {
            "vibration": _slice(vib_s, w["segment_id"], w["start_ms"], w["end_ms"]),
            "thermal": _slice(th_s, w["segment_id"], w["start_ms"], w["end_ms"]),
            "speed": _slice(sp_s, w["segment_id"], w["start_ms"], w["end_ms"]),
        }
        ok, reason = window_is_valid(parts, window_s)
        if not ok:
            rejects.append(reason)
            continue
        feats = compute_window_features(parts["vibration"], parts["thermal"],
                                        parts["speed"], window_s)
        meta = {
            "segment_id": w["segment_id"],
            "segment_order": w["segment_order"],
            "start_ms": w["start_ms"],
            "end_ms": w["end_ms"],
            "t_rel_start_s": (w["start_ms"] - t0_global) / 1000.0,
            "start_utc": pd.Timestamp(w["start_ms"], unit="ms", tz="UTC").isoformat(),
            "n_vibration_frames": len(parts["vibration"]),
            "n_thermal_frames": len(parts["thermal"]),
            "n_speed_frames": len(parts["speed"]),
            "n_distinct_ts_vibration": int(parts["vibration"][C.TIME_COL].nunique()),
            "n_distinct_ts_thermal": int(parts["thermal"][C.TIME_COL].nunique()),
            "n_distinct_ts_speed": int(parts["speed"][C.TIME_COL].nunique()),
        }
        meta.update(feats)
        rows.append(meta)

    df = pd.DataFrame(rows)
    if df.empty:
        raise RuntimeError("No valid windows produced. Loosen window/coverage settings.")
    df = df.sort_values(["start_ms"]).reset_index(drop=True)
    df.insert(0, "window_id", np.arange(len(df)))
    df.attrs["rejected"] = pd.Series(rejects).value_counts().to_dict() if rejects else {}
    return df


META_COLUMNS = [
    "window_id", "segment_id", "segment_order", "start_ms", "end_ms",
    "t_rel_start_s", "start_utc",
    "n_vibration_frames", "n_thermal_frames", "n_speed_frames",
    "n_distinct_ts_vibration", "n_distinct_ts_thermal", "n_distinct_ts_speed",
]


def feature_columns(df: pd.DataFrame) -> list:
    return [c for c in df.columns if c not in META_COLUMNS]


if __name__ == "__main__":
    import preprocessing

    pre = preprocessing.preprocess()
    tbl = build_feature_table(pre)
    fc = feature_columns(tbl)
    print("windows:", len(tbl), "features:", len(fc))
    print("rejected:", tbl.attrs.get("rejected"))
    print("segments represented:", tbl.segment_id.nunique())
    print(tbl[fc].describe().T[["mean", "std", "min", "max"]].head(20).to_string())
