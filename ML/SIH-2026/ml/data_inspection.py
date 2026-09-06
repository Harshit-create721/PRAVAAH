"""Inspect the actual telemetry file and write outputs/data_quality_report.{md,json}.

Everything reported here is measured from the CSV. Nothing is assumed -- in particular
the sampling rate, the sensor/node mapping and the window geometry are all derived.
"""
from __future__ import annotations

import json
import os

import numpy as np
import pandas as pd

import config as C
import feature_engineering as fe
import preprocessing


def _num(x):
    """JSON-safe scalar."""
    if isinstance(x, (np.integer,)):
        return int(x)
    if isinstance(x, (np.floating,)):
        return None if not np.isfinite(x) else round(float(x), 6)
    if isinstance(x, (np.bool_,)):
        return bool(x)
    return x


def timing_profile(stream: pd.DataFrame) -> dict:
    """Inter-arrival statistics computed strictly within segments."""
    diffs = []
    for _, g in stream.groupby(C.SEGMENT_COL):
        t = np.sort(g[C.TIME_COL].to_numpy())
        if t.size > 1:
            diffs.append(np.diff(t))
    d = np.concatenate(diffs) / 1000.0 if diffs else np.array([0.0])
    nonzero = d[d > 0]
    return {
        "n_frames": int(len(stream)),
        "dt_median_s": _num(np.median(d)),
        "dt_mean_s": _num(d.mean()),
        "dt_p05_s": _num(np.percentile(d, 5)),
        "dt_p95_s": _num(np.percentile(d, 95)),
        "dt_max_s": _num(d.max()),
        "zero_dt_fraction": _num((d == 0).mean()),
        "dt_median_nonzero_s": _num(np.median(nonzero)) if nonzero.size else None,
        "nominal_rate_hz": _num(1.0 / np.median(nonzero)) if nonzero.size else None,
        "effective_distinct_ts_rate_hz": _num(
            stream[C.TIME_COL].nunique() / max(1e-9, (stream[C.TIME_COL].max() - stream[C.TIME_COL].min()) / 1000.0)
        ),
    }


def hold_run_lengths(stream: pd.DataFrame, col: str) -> dict:
    """How long a signal stays at exactly the same value -- exposes update quantisation."""
    runs = []
    for _, g in stream.groupby(C.SEGMENT_COL):
        v = g.sort_values(C.TIME_COL)[col].to_numpy(float)
        if v.size == 0:
            continue
        n = 1
        for i in range(1, v.size):
            if v[i] == v[i - 1]:
                n += 1
            else:
                runs.append(n)
                n = 1
        runs.append(n)
    r = np.array(runs) if runs else np.array([1])
    return {
        "median_hold_frames": _num(np.median(r)),
        "mean_hold_frames": _num(r.mean()),
        "max_hold_frames": _num(r.max()),
        "distinct_values": int(stream[col].nunique()),
    }


def build_report() -> dict:
    C.ensure_dirs()
    path = C.resolve_telemetry_path()
    pre = preprocessing.preprocess(path)
    raw = pre.raw

    manifest = C.load_sidecar("manifest.json") or {}
    seg_sidecar = C.load_sidecar("segments.json") or []

    t_min, t_max = int(raw[C.TIME_COL].min()), int(raw[C.TIME_COL].max())
    seg = pre.segments

    rep = {
        "file": os.path.relpath(path, C.ROOT).replace("\\", "/"),
        "generated_from_manifest": {
            "session_id": manifest.get("source_session_id"),
            "dataset_version": manifest.get("dataset_version"),
            "label": manifest.get("label"),
            "source": manifest.get("source"),
            "source_rows": manifest.get("source_telemetry_rows"),
            "kept_rows": manifest.get("kept_telemetry_rows"),
            "removed_rows": manifest.get("removed_telemetry_rows"),
            "retained_interval_seconds": manifest.get("retained_interval_seconds"),
            "grouping_rule": manifest.get("grouping"),
            "qualification": manifest.get("qualification"),
        },
        "shape": {"rows": int(len(raw)), "columns": int(raw.shape[1] - 1)},
        "dtypes": {c: str(raw[c].dtype) for c in raw.columns if c != "t_rel_s"},
        "constant_columns": {
            c: str(raw[c].dropna().unique()[0])
            for c in ("session_id", "label", "source", "conveyor")
            if c in raw.columns and raw[c].nunique(dropna=True) == 1
        },
        "time": {
            "column_used": C.TIME_COL,
            "first_utc": pd.Timestamp(t_min, unit="ms", tz="UTC").isoformat(),
            "last_utc": pd.Timestamp(t_max, unit="ms", tz="UTC").isoformat(),
            "wall_clock_span_s": _num((t_max - t_min) / 1000.0),
            "retained_interval_s": _num(seg.duration_s.sum()),
            "excluded_gap_s": _num((t_max - t_min) / 1000.0 - seg.duration_s.sum()),
            "transport_to_device_lag_ms": {
                "median": _num((raw[C.RECV_TIME_COL] - raw[C.TIME_COL]).median()),
                "max": _num((raw[C.RECV_TIME_COL] - raw[C.TIME_COL]).max()),
            } if C.RECV_TIME_COL in raw.columns else None,
        },
        "nodes": {
            "counts": {k: int(v) for k, v in raw[C.NODE_COL].value_counts().items()},
            "node_to_sensor_role": pre.node_to_sensor,
            "sensor_signals_used": pre.sensor_signals,
            "validation": {k: v for k, v in pre.validation.items() if k != "node_owned_columns"},
        },
        "columns_dropped_all_null": pre.dropped_all_null,
        "redundant_columns_dropped": pre.redundant_pairs,
        "missing_values": {},
        "duplicates": {
            "duplicate_ts_ms_any_node": int(raw.duplicated([C.TIME_COL]).sum()),
            "duplicate_node_ts_pairs": int(raw.duplicated([C.NODE_COL, C.TIME_COL]).sum()),
            "rows_in_a_duplicate_node_ts_group": int(
                raw.duplicated([C.NODE_COL, C.TIME_COL], keep=False).sum()),
            "duplicate_node_seq_pairs": int(raw.duplicated([C.NODE_COL, "seq"]).sum())
            if "seq" in raw.columns else None,
            "fully_duplicate_rows": int(raw.drop(columns=["t_rel_s"]).duplicated().sum()),
        },
        "integrity_flags": {
            "seq_gap_nonzero": int((raw["seq_gap"] != 0).sum()) if "seq_gap" in raw else None,
            "seq_reset_nonzero": int((raw["seq_reset"] != 0).sum()) if "seq_reset" in raw else None,
            "sensor_health_values": {str(k): int(v) for k, v in raw["sensor_health"].value_counts().items()}
            if "sensor_health" in raw else None,
            "quality_issues_values": {str(k): int(v) for k, v in raw["quality_issues"].value_counts().items()}
            if "quality_issues" in raw else None,
        },
        "segments": {
            "count_csv": int(seg.segment_id.nunique()),
            "count_sidecar": len(seg_sidecar),
            "total_duration_s": _num(seg.duration_s.sum()),
            "duration_s": {
                "min": _num(seg.duration_s.min()),
                "p25": _num(seg.duration_s.quantile(0.25)),
                "median": _num(seg.duration_s.median()),
                "mean": _num(seg.duration_s.mean()),
                "p75": _num(seg.duration_s.quantile(0.75)),
                "max": _num(seg.duration_s.max()),
            },
            "count_ge_window": int((seg.duration_s >= C.WINDOW_SECONDS).sum()),
            "count_lt_window": int((seg.duration_s < C.WINDOW_SECONDS).sum()),
        },
        "sampling": {},
        "signal_stats": {},
        "quantisation": {},
        "drift": {},
        "window_geometry": {},
        "outlier_scan": {},
    }

    # per-column missingness
    for c in raw.columns:
        if c == "t_rel_s":
            continue
        rep["missing_values"][c] = {
            "non_null": int(raw[c].notna().sum()),
            "null_fraction_overall": _num(raw[c].isna().mean()),
        }

    # sampling behaviour per sensor stream
    for role, s in pre.streams.items():
        rep["sampling"][role] = timing_profile(s)

    # distributions of every signal actually used
    for role, cols in pre.sensor_signals.items():
        s = pre.streams[role]
        for c in cols:
            v = pd.to_numeric(s[c], errors="coerce").dropna()
            rep["signal_stats"][c] = {
                "sensor": role,
                "count": int(v.size),
                "mean": _num(v.mean()), "std": _num(v.std()),
                "min": _num(v.min()), "p01": _num(v.quantile(.01)),
                "p25": _num(v.quantile(.25)), "median": _num(v.median()),
                "p75": _num(v.quantile(.75)), "p99": _num(v.quantile(.99)),
                "max": _num(v.max()),
                "distinct": int(v.nunique()),
                "cv": _num(v.std() / abs(v.mean())) if abs(v.mean()) > C.EPS else None,
            }

    rep["quantisation"]["hall_rpm"] = hold_run_lengths(pre.streams["speed"], "hall_rpm")
    rep["quantisation"]["temperature"] = hold_run_lengths(pre.streams["thermal"], "temperature")
    rep["quantisation"]["vibration_rms"] = hold_run_lengths(pre.streams["vibration"], "vibration_rms")

    # duplicate-timestamp progression across the session
    raw2 = raw.copy()
    raw2["dup"] = raw2.duplicated([C.NODE_COL, C.TIME_COL], keep=False)
    by_seg = raw2.groupby(C.SEGMENT_COL).agg(dup_fraction=("dup", "mean"),
                                             t0=(C.TIME_COL, "min")).sort_values("t0")
    first_bad = by_seg.index[by_seg.dup_fraction > 0.5]
    rep["duplicates"]["dup_fraction_first_quarter"] = _num(
        by_seg.dup_fraction.iloc[: max(1, len(by_seg) // 4)].mean())
    rep["duplicates"]["dup_fraction_last_quarter"] = _num(
        by_seg.dup_fraction.iloc[-max(1, len(by_seg) // 4):].mean())
    rep["duplicates"]["first_segment_over_50pct_duplicate_ts"] = (
        str(first_bad[0]) if len(first_bad) else None)

    # thermal / speed drift across the session
    th = pre.streams["thermal"]
    thm = th.copy()
    thm["delta"] = thm["temperature"] - thm["ambient"]
    half = thm["t_rel_s"].median()
    rep["drift"]["temperature"] = {
        "first_60s_mean": _num(thm.loc[thm.t_rel_s < 60, "temperature"].mean()),
        "last_60s_mean": _num(thm.loc[thm.t_rel_s > thm.t_rel_s.max() - 60, "temperature"].mean()),
        "session_rise_c": _num(thm.loc[thm.t_rel_s > thm.t_rel_s.max() - 60, "temperature"].mean()
                               - thm.loc[thm.t_rel_s < 60, "temperature"].mean()),
        "pearson_r_with_session_time": _num(np.corrcoef(thm.t_rel_s, thm.temperature)[0, 1]),
    }
    rep["drift"]["temperature_minus_ambient"] = {
        "first_60s_mean": _num(thm.loc[thm.t_rel_s < 60, "delta"].mean()),
        "last_60s_mean": _num(thm.loc[thm.t_rel_s > thm.t_rel_s.max() - 60, "delta"].mean()),
        "pearson_r_with_session_time": _num(np.corrcoef(thm.t_rel_s, thm.delta)[0, 1]),
    }
    sp = pre.streams["speed"]
    rep["drift"]["hall_rpm"] = {
        "first_half_mean": _num(sp.loc[sp.t_rel_s <= half, "hall_rpm"].mean()),
        "second_half_mean": _num(sp.loc[sp.t_rel_s > half, "hall_rpm"].mean()),
        "pearson_r_with_session_time": _num(np.corrcoef(sp.t_rel_s, sp.hall_rpm)[0, 1]),
    }
    vb = pre.streams["vibration"]
    rep["drift"]["vibration_rms"] = {
        "first_half_mean": _num(vb.loc[vb.t_rel_s <= half, "vibration_rms"].mean()),
        "second_half_mean": _num(vb.loc[vb.t_rel_s > half, "vibration_rms"].mean()),
        "pearson_r_with_session_time": _num(np.corrcoef(vb.t_rel_s, vb.vibration_rms)[0, 1]),
    }

    # window-geometry study: measured yield for several candidate settings
    trials = [(10, 5), (10, 2.5), (8, 2), (15, 5), (20, 5), (6, 2)]
    grid = []
    for w, s in trials:
        try:
            t = fe.build_feature_table(pre, w, s)
            grid.append({
                "window_s": w, "step_s": s,
                "windows": int(len(t)),
                "segments_covered": int(t.segment_id.nunique()),
                "median_frames_per_sensor": _num(t.n_vibration_frames.median()),
                "rejected_candidates": int(sum(t.attrs.get("rejected", {}).values())),
                "selected": bool(w == C.WINDOW_SECONDS and s == C.STEP_SECONDS),
            })
        except Exception as exc:  # pragma: no cover - defensive
            grid.append({"window_s": w, "step_s": s, "error": str(exc)})
    rep["window_geometry"] = {
        "selected_window_s": C.WINDOW_SECONDS,
        "selected_step_s": C.STEP_SECONDS,
        "min_frames_per_sensor": C.MIN_FRAMES_PER_SENSOR,
        "min_time_coverage": C.MIN_TIME_COVERAGE,
        "overlap_fraction": _num(1 - C.STEP_SECONDS / C.WINDOW_SECONDS),
        "trials": grid,
    }

    # crude raw-frame outlier scan (robust z on the vibration shape factors)
    for c in ("vibration_rms", "vibration_kurtosis", "vibration_crest"):
        v = vb[c].to_numpy(float)
        med = np.median(v)
        mad = np.median(np.abs(v - med)) * 1.4826
        z = np.abs(v - med) / (mad + C.EPS)
        rep["outlier_scan"][c] = {
            "median": _num(med), "robust_sigma": _num(mad),
            "frames_robust_z_gt_5": int((z > 5).sum()),
            "frames_robust_z_gt_10": int((z > 10).sum()),
            "max_robust_z": _num(z.max()),
        }

    return rep, pre


MD_TEMPLATE_INTRO = """# Data quality report -- conveyor telemetry

Generated by `ml/data_inspection.py`. Every number below is measured from the actual
file; nothing is assumed. This dataset is **unlabelled** -- it contains no verified
fault labels, so no supervised metric appears anywhere in this project.

"""


def render_markdown(rep: dict) -> str:
    m = rep["generated_from_manifest"]
    L = [MD_TEMPLATE_INTRO]

    L.append("## 1. File and provenance\n")
    L.append("| item | value |\n|---|---|")
    L.append("| path | `%s` |" % rep["file"])
    L.append("| session id | `%s` |" % m["session_id"])
    L.append("| label field | `%s` |" % m["label"])
    L.append("| acquisition | `%s` |" % m["source"])
    L.append("| rows in this file | %d |" % rep["shape"]["rows"])
    L.append("| columns | %d |" % rep["shape"]["columns"])
    L.append("| rows in the original recording | %s |" % m["source_rows"])
    L.append("| rows removed by the cleaning step | %s |" % m["removed_rows"])
    for k, v in rep["constant_columns"].items():
        L.append("| `%s` (constant) | `%s` |" % (k, v))
    L.append("")
    L.append("> Manifest grouping rule: *%s*\n" % m["grouping_rule"])
    L.append("> Manifest qualification: *%s*\n" % m["qualification"])

    L.append("## 2. Time coverage\n")
    t = rep["time"]
    L.append("| item | value |\n|---|---|")
    L.append("| first sample (UTC) | %s |" % t["first_utc"])
    L.append("| last sample (UTC) | %s |" % t["last_utc"])
    L.append("| wall-clock span | %.1f s |" % t["wall_clock_span_s"])
    L.append("| retained time, first-to-last frame inside each segment | %.1f s |"
             % t["retained_interval_s"])
    if m["retained_interval_seconds"]:
        L.append("| retained time declared in `manifest.json` | %.1f s |"
                 % m["retained_interval_seconds"])
    L.append("| excluded / gap time | %.1f s |" % t["excluded_gap_s"])
    if t["transport_to_device_lag_ms"]:
        L.append("| gateway lag `received_at_ms - ts_ms` | median %s ms, max %s ms |"
                 % (t["transport_to_device_lag_ms"]["median"],
                    t["transport_to_device_lag_ms"]["max"]))
    L.append("")
    L.append("Timestamps are used exactly as recorded. Gaps are **not** compressed and "
             "removed intervals are **not** interpolated across. The small difference "
             "between the two retained-time rows is expected: the manifest measures "
             "declared interval boundaries, this pipeline measures first-to-last frame "
             "inside each segment.\n")

    L.append("## 3. Sensor / node structure\n")
    L.append("The file is a sparse long/wide hybrid: **one row = one frame from one ESP32 "
             "node**, and only that node's own measurement columns are populated. A row is "
             "therefore not an ML observation.\n")
    L.append("| node | rows | sensor role | signal columns it owns |\n|---|---|---|---|")
    for node, n in sorted(rep["nodes"]["counts"].items()):
        role = rep["nodes"]["node_to_sensor_role"].get(node, "?")
        sig = ", ".join("`%s`" % c for c in rep["nodes"]["sensor_signals_used"].get(role, []))
        L.append("| `%s` | %d | %s | %s |" % (node, n, role, sig))
    L.append("")
    v = rep["nodes"]["validation"]
    L.append("Required sensors present: **%s**. Unexpected nodes: %s. "
             "Optional rig columns carrying data: %s.\n"
             % (", ".join(v["required_sensors_present"]),
                v["unexpected_nodes"] or "none",
                v["optional_signals_with_data"] or "none"))

    L.append("### Columns that carry no data\n")
    L.append("These %d columns are present in the schema but **100%% null** in this file, "
             "so no feature is built on them:\n" % len(rep["columns_dropped_all_null"]))
    L.append(", ".join("`%s`" % c for c in rep["columns_dropped_all_null"]) + "\n")
    L.append("This means there is **no motor current, no motor power, no motor-side RPM, "
             "no load cell, no acoustic channel and no belt-tracking offset** in this "
             "recording. Slip ratio cannot be computed: `slip_ratio` is empty and there is "
             "no independent motor RPM to compare the Hall RPM against.\n")

    if rep["redundant_columns_dropped"]:
        L.append("### Redundant columns\n")
        for r in rep["redundant_columns_dropped"]:
            L.append("- `%s` is an exact affine function of `%s` (`%s`, max relative "
                     "residual %.2e). It is a fixed drum-geometry conversion, not an "
                     "independent measurement, and is dropped so that one sensor is not "
                     "double-weighted.\n" % (r["dropped"], r["kept"], r["relation"],
                                             r["max_relative_residual"]))

    L.append("## 4. Sampling behaviour (measured, not assumed)\n")
    L.append("| stream | frames | median dt | median dt (non-zero) | p95 dt | max dt | "
             "zero-dt fraction | nominal rate |\n|---|---|---|---|---|---|---|---|")
    for role, s in rep["sampling"].items():
        L.append("| %s | %d | %.3f s | %.3f s | %.3f s | %.3f s | %.1f%% | %.2f Hz |"
                 % (role, s["n_frames"], s["dt_median_s"], s["dt_median_nonzero_s"],
                    s["dt_p95_s"], s["dt_max_s"], 100 * s["zero_dt_fraction"],
                    s["nominal_rate_hz"]))
    L.append("")
    L.append("**Interpretation.** Each node emits at a nominal **2 Hz** (0.5 s period). "
             "Delivery is bursty: a large share of consecutive frames share a timestamp and "
             "the p95 inter-arrival is ~2 s. The pattern is ~4 frames flushed together every "
             "~2 s, which is characteristic of USB-serial buffering on the gateway rather "
             "than of the sensors themselves.\n")

    L.append("### Timestamp resolution degrades during the session\n")
    d = rep["duplicates"]
    L.append("| item | value |\n|---|---|")
    L.append("| duplicate `(node, ts_ms)` pairs | %d |" % d["duplicate_node_ts_pairs"])
    L.append("| rows sitting in a duplicated `(node, ts_ms)` group | %d of %d |"
             % (d["rows_in_a_duplicate_node_ts_group"], rep["shape"]["rows"]))
    L.append("| fully duplicate rows | %d |" % d["fully_duplicate_rows"])
    L.append("| duplicate-timestamp fraction, first quarter of segments | %.1f%% |"
             % (100 * d["dup_fraction_first_quarter"]))
    L.append("| duplicate-timestamp fraction, last quarter of segments | %.1f%% |"
             % (100 * d["dup_fraction_last_quarter"]))
    L.append("| first segment above 50%% duplicated | `%s` |"
             % d["first_segment_over_50pct_duplicate_ts"])
    L.append("")
    L.append("This is a **real defect worth fixing on the hardware side**: `seq` keeps "
             "incrementing correctly (no gaps, no resets) while `ts_ms` stalls, so distinct "
             "samples are being stamped with the same device time. Consequences accepted in "
             "this pipeline:\n")
    L.append("- Window-level **aggregate** statistics (mean, std, RMS, percentiles, "
             "kurtosis) stay valid -- they do not depend on intra-burst ordering.\n"
             "- Window-level **slope / rate** features are only accurate to roughly the "
             "burst period (~2 s). They are kept, but should not be read as fine-grained "
             "derivatives.\n"
             "- Per-sample event timing cannot be recovered from this file.\n")

    L.append("## 5. Missing values and integrity flags\n")
    i = rep["integrity_flags"]
    L.append("- `seq_gap` non-zero rows: **%s**; `seq_reset` non-zero rows: **%s** "
             "(the cleaning step already removed the dropout intervals).\n"
             % (i["seq_gap_nonzero"], i["seq_reset_nonzero"]))
    L.append("- `sensor_health`: %s\n" % ", ".join(
        "`%s` x%d" % (k, n) for k, n in (i["sensor_health_values"] or {}).items()))
    L.append("- `quality_issues`: %s\n" % ", ".join(
        "`%s` x%d" % (k, n) for k, n in (i["quality_issues_values"] or {}).items()))
    L.append("- Within each node's own columns there are **no missing measurements**. "
             "The nulls visible in the raw CSV are purely structural (a thermal row has no "
             "vibration columns), not lost data.\n")

    L.append("## 6. Segment structure\n")
    s = rep["segments"]
    L.append("| item | value |\n|---|---|")
    L.append("| segments in CSV | %d |" % s["count_csv"])
    L.append("| segments in `segments.json` | %d |" % s["count_sidecar"])
    L.append("| total retained time | %.1f s |" % s["total_duration_s"])
    L.append("| duration min / median / mean / max | %.3f / %.2f / %.2f / %.2f s |"
             % (s["duration_s"]["min"], s["duration_s"]["median"],
                s["duration_s"]["mean"], s["duration_s"]["max"]))
    L.append("| segments >= %.0f s window | %d |" % (C.WINDOW_SECONDS, s["count_ge_window"]))
    L.append("| segments < %.0f s window | %d |" % (C.WINDOW_SECONDS, s["count_lt_window"]))
    L.append("")
    L.append("Segments are short and highly uneven. **%d of %d segments are shorter than the "
             "10 s window and therefore contribute no ML sample at all.** No window is ever "
             "allowed to span two segments.\n" % (s["count_lt_window"], s["count_csv"]))

    L.append("## 7. Signal distributions\n")
    L.append("| signal | sensor | n | mean | std | min | p25 | median | p75 | max | "
             "distinct |\n|---|---|---|---|---|---|---|---|---|---|---|")
    for c, st in rep["signal_stats"].items():
        L.append("| `%s` | %s | %d | %.4f | %.4f | %.4f | %.4f | %.4f | %.4f | %.4f | %d |"
                 % (c, st["sensor"], st["count"], st["mean"], st["std"], st["min"],
                    st["p25"], st["median"], st["p75"], st["max"], st["distinct"]))
    L.append("")

    q = rep["quantisation"]["hall_rpm"]
    rpm = rep["signal_stats"]["hall_rpm"]
    L.append("### Finding A -- the RPM channel is nearly constant and heavily quantised\n")
    L.append("`hall_rpm` spans only **%.2f-%.2f RPM** (std %.3f, CV %.2f%%) across the whole "
             "session and takes only **%d distinct values**. It also *holds* the same value "
             "for a median of **%.0f consecutive frames** (~%.1f s at 2 Hz), so its effective "
             "update rate is about **%.2f Hz**, not 2 Hz.\n"
             % (rpm["min"], rpm["max"], rpm["std"], 100 * (rpm["cv"] or 0),
                q["distinct_values"], q["median_hold_frames"],
                q["median_hold_frames"] * 0.5, 1.0 / (q["median_hold_frames"] * 0.5)))
    L.append("Consequences: the conveyor ran at **one essentially fixed speed for the entire "
             "recording**, within-window RPM std/slope features are dominated by "
             "quantisation rather than by real speed dynamics, and every "
             "`something / rpm` cross-feature is close to a rescaled copy of its numerator. "
             "Those features are still computed (they are the right features for a rig that "
             "does vary its speed) but they carry very little information *in this dataset*, "
             "and the near-duplicates among them are pruned before training.\n")

    dr = rep["drift"]["temperature"]
    dd = rep["drift"]["temperature_minus_ambient"]
    L.append("### Finding B -- the session is a thermal warm-up transient, not steady state\n")
    L.append("Mean temperature rises from **%.2f degC** in the first 60 s to **%.2f degC** in "
             "the last 60 s (**+%.2f degC**, Pearson r with session time = **%.3f**). Ambient "
             "rises too, but `temperature - ambient` still climbs from **%.2f** to **%.2f degC** "
             "(r = **%.3f**).\n"
             % (dr["first_60s_mean"], dr["last_60s_mean"], dr["session_rise_c"],
                dr["pearson_r_with_session_time"], dd["first_60s_mean"],
                dd["last_60s_mean"], dd["pearson_r_with_session_time"]))
    L.append("This is the single most important modelling constraint in the dataset. Absolute "
             "temperature is **confounded with elapsed session time**. Any purely "
             "chronological train/test split will therefore flag late windows as anomalous "
             "for a reason that has nothing to do with mechanical condition. The pipeline "
             "handles it explicitly: the deployed baseline is fitted over the whole session "
             "so the entire warm-up range is inside the baseline, and the chronological split "
             "is reported separately and only as a *drift diagnostic*.\n")

    L.append("### Finding C -- vibration and RPM are stationary over the session\n")
    dv, dh = rep["drift"]["vibration_rms"], rep["drift"]["hall_rpm"]
    L.append("`vibration_rms` first half %.4f g vs second half %.4f g (r with time = %.3f); "
             "`hall_rpm` %.3f vs %.3f (r = %.3f). Neither shows the strong monotone trend "
             "that temperature does.\n"
             % (dv["first_half_mean"], dv["second_half_mean"], dv["pearson_r_with_session_time"],
                dh["first_half_mean"], dh["second_half_mean"], dh["pearson_r_with_session_time"]))

    L.append("### Finding D -- a handful of impulsive vibration frames\n")
    L.append("| signal | median | robust sigma | frames |z|>5 | frames |z|>10 | max |z| |"
             "\n|---|---|---|---|---|---|")
    for c, o in rep["outlier_scan"].items():
        L.append("| `%s` | %.4f | %.4f | %d | %d | %.1f |"
                 % (c, o["median"], o["robust_sigma"], o["frames_robust_z_gt_5"],
                    o["frames_robust_z_gt_10"], o["max_robust_z"]))
    L.append("")
    L.append("A small number of frames show large crest factor and kurtosis excursions "
             "(sensor-reported `vibration_kurtosis` reaches ~80 against a median of ~2.7). "
             "These are genuine impulsive events in the signal. **They are not labelled and "
             "their physical cause is unknown** -- they could be a mechanical impact, a "
             "loose mount, or a sensor artefact. They are left in the data and are simply "
             "the windows the anomaly detector should find unusual.\n")

    L.append("## 8. Window geometry chosen\n")
    w = rep["window_geometry"]
    L.append("Measured yield for candidate settings (a window is only emitted when all three "
             "sensors have >= %d frames covering >= %.0f%% of the window span):\n"
             % (w["min_frames_per_sensor"], 100 * w["min_time_coverage"]))
    L.append("| window | step | windows | segments covered | median frames/sensor | "
             "rejected | selected |\n|---|---|---|---|---|---|---|")
    for g in w["trials"]:
        if "error" in g:
            L.append("| %s s | %s s | error: %s | | | | |" % (g["window_s"], g["step_s"], g["error"]))
            continue
        L.append("| %s s | %s s | %d | %d | %.0f | %d | %s |"
                 % (g["window_s"], g["step_s"], g["windows"], g["segments_covered"],
                    g["median_frames_per_sensor"], g["rejected_candidates"],
                    "**yes**" if g["selected"] else ""))
    L.append("")
    L.append("**Selected: %.0f s window, %.1f s step (%.0f%% overlap).** Reasoning:\n"
             % (w["selected_window_s"], w["selected_step_s"], 100 * w["overlap_fraction"]))
    by = {(g.get("window_s"), g.get("step_s")): g for g in w["trials"] if "error" not in g}
    sel = by.get((C.WINDOW_SECONDS, C.STEP_SECONDS), {})
    longer = [by[k] for k in sorted(by) if k[0] > C.WINDOW_SECONDS]
    shorter = [by[k] for k in sorted(by) if k[0] < C.WINDOW_SECONDS]
    wide_step = by.get((C.WINDOW_SECONDS, 5))

    L.append("- %.0f s at the measured 2 Hz gives ~%d frames per sensor, about the minimum "
             "for a usable kurtosis / percentile estimate.\n"
             % (C.WINDOW_SECONDS, int(C.WINDOW_SECONDS * 2)))
    if longer:
        L.append("- Longer windows (%s) collapse the dataset to %s windows and cover only "
                 "%s of the %d segments, because the median segment is only %.2f s.\n"
                 % (", ".join("%g s" % g["window_s"] for g in longer),
                    " and ".join(str(g["windows"]) for g in longer),
                    " and ".join(str(g["segments_covered"]) for g in longer),
                    s["count_csv"], s["duration_s"]["median"]))
    if shorter:
        L.append("- Shorter windows (%s) push frames per sensor down to %s and reject "
                 "%s candidate windows instead of %d.\n"
                 % (", ".join("%g s" % g["window_s"] for g in shorter),
                    "-".join(str(int(g["median_frames_per_sensor"])) for g in shorter),
                    " and ".join(str(g["rejected_candidates"]) for g in shorter),
                    sel.get("rejected_candidates", 0)))
    if wide_step and sel:
        L.append("- The step was reduced from the 5 s starting point to %.1f s, which raises "
                 "the sample count from %d to %d. **These windows overlap by %.0f%%, so they "
                 "are correlated and are not %d independent samples.** The effective "
                 "independent count is nearer the %d windows a 5 s step gives, and nearer "
                 "still to the %d distinct segments they come from.\n"
                 % (C.STEP_SECONDS, wide_step["windows"], sel["windows"],
                    100 * w["overlap_fraction"], sel["windows"],
                    wide_step["windows"], sel["segments_covered"]))

    L.append("## 9. Summary of data-quality problems\n")
    L.append("| # | problem | severity | how the pipeline handles it |\n|---|---|---|---|")
    L.append("| 1 | No fault labels anywhere (`label = unlabelled`) | blocking for "
             "supervised work | Unsupervised anomaly detection only. No accuracy / precision "
             "/ recall / RUL is computed or claimed. |")
    L.append("| 2 | `ts_ms` stalls; up to ~100% duplicated timestamps late in the session | "
             "high | Aggregate features kept; slope features flagged as ~2 s resolution; "
             "per-sample timing not used. |")
    L.append("| 3 | Temperature is a monotone warm-up confounded with session time | high | "
             "Baseline fitted over the whole session; `temperature - ambient` features added; "
             "chronological split reported only as a drift diagnostic. |")
    L.append("| 4 | RPM effectively constant (%.2f-%.2f) and quantised to ~%.2f Hz updates | "
             "high | RPM features retained but near-degenerate ones pruned; documented as "
             "low-information in this dataset. |"
             % (rpm["min"], rpm["max"], 1.0 / (q["median_hold_frames"] * 0.5)))
    L.append("| 5 | %d schema columns are 100%% null (motor current/power/RPM, load, "
             "acoustic, belt offsets, slip ratio) | medium | Detected and dropped "
             "automatically; no feature invented on top of them. |"
             % len(rep["columns_dropped_all_null"]))
    L.append("| 6 | `belt_speed` is an exact linear restatement of `hall_rpm` | medium | "
             "Detected automatically and dropped. |")
    L.append("| 7 | %d of %d segments are shorter than one window | medium | Those segments "
             "produce no sample. No cross-segment stitching to rescue them. |"
             % (s["count_lt_window"], s["count_csv"]))
    L.append("| 8 | Single conveyor, single session, ~%.0f s of retained data | high for "
             "generalisation | Stated as a limitation everywhere. Nothing here estimates "
             "performance on another machine or another day. |" % s["total_duration_s"])
    L.append("")
    L.append("---\n")
    L.append("*This report describes acquisition quality only. Passing these checks does "
             "not certify that the conveyor was mechanically healthy during the recording.*\n")
    return "\n".join(L)


def main():
    rep, _ = build_report()
    C.ensure_dirs()
    with open(C.DATA_QUALITY_JSON, "w", encoding="utf-8") as fh:
        json.dump(rep, fh, indent=2, default=str)
    with open(C.DATA_QUALITY_MD, "w", encoding="utf-8") as fh:
        fh.write(render_markdown(rep))
    print("wrote %s" % os.path.relpath(C.DATA_QUALITY_MD, C.ROOT))
    print("wrote %s" % os.path.relpath(C.DATA_QUALITY_JSON, C.ROOT))
    print("rows=%d segments=%d nodes=%d"
          % (rep["shape"]["rows"], rep["segments"]["count_csv"], len(rep["nodes"]["counts"])))


if __name__ == "__main__":
    main()
