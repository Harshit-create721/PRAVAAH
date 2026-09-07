"""Fit the baseline anomaly model and write every artifact inference needs.

What is trained
---------------
An unsupervised Isolation Forest over 10 s windows of fused vibration / temperature /
RPM features. There are no fault labels in this dataset, so nothing here is a classifier
and no supervised metric is produced.

What "baseline" means
---------------------
"Baseline observed operating behaviour" -- the distribution of windows actually recorded
in this session. It is explicitly NOT "confirmed healthy behaviour": nobody verified the
conveyor's mechanical condition during the recording.

Why the deployed model is fitted on the whole session
-----------------------------------------------------
Temperature rises monotonically for the entire recording (r = 0.96 with session time; see
outputs/data_quality_report.md, Finding B). Fitting only on early windows would make every
late window "anomalous" purely because the machine warmed up. The dataset manifest says
the same thing from the provenance side: "Keep this entire source session/day in one ML
split." So the deployed baseline covers the whole warm-up range, and the chronological
early/late split is trained and reported separately in evaluate.py as a *drift diagnostic*
rather than as a performance estimate.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
from datetime import datetime, timezone

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import RobustScaler

import config as C
import feature_engineering as fe
import health_score as hs
import preprocessing


# --------------------------------------------------------------------------------------
# Feature selection
# --------------------------------------------------------------------------------------
def prune_features(df: pd.DataFrame, candidates: list) -> tuple:
    """Drop constant and near-duplicate features. Decided on the fit set only."""
    X = df[candidates].to_numpy(float)
    report = {"dropped_zero_variance": [], "dropped_redundant": []}

    std = X.std(axis=0, ddof=1)
    keep = [c for c, s in zip(candidates, std) if s > C.NEAR_ZERO_VARIANCE_STD]
    report["dropped_zero_variance"] = [c for c in candidates if c not in keep]

    if not keep:
        raise ValueError("no varying features in fit partition")
    corr = np.atleast_2d(np.corrcoef(df[keep].to_numpy(float), rowvar=False))
    corr = np.nan_to_num(corr, nan=0.0)
    final, dropped = [], {}
    for i, name in enumerate(keep):
        red = None
        for j, kept in enumerate(final):
            if abs(corr[i, keep.index(kept)]) >= C.REDUNDANT_CORRELATION:
                red = kept
                break
        if red is None:
            final.append(name)
        else:
            dropped[name] = {"duplicate_of": red,
                             "abs_corr": round(float(abs(corr[i, keep.index(red)])), 6)}
    report["dropped_redundant"] = dropped
    return final, report


def fit_fold_preprocessor(train_frames, heldout_frames, candidates):
    """All learned selection/scaling is fitted on the training partition only."""
    names, _ = prune_features(train_frames, candidates)
    scaler = RobustScaler().fit(train_frames[names].to_numpy(float))
    return (scaler.transform(train_frames[names].to_numpy(float)),
            scaler.transform(heldout_frames[names].to_numpy(float)), names)


# --------------------------------------------------------------------------------------
# Baseline screening
# --------------------------------------------------------------------------------------
def screen_baseline(X: np.ndarray, feature_names: list, quantile: float = 0.995) -> dict:
    """Look for obviously abnormal windows *before* fitting, and decide contamination.

    A first-pass Isolation Forest with contamination='auto' flags candidates; a robust
    Mahalanobis-free screen (max robust-z across features) gives an independent view.
    We do not delete anything -- the fit uses the full set with a contamination value
    chosen from what the screen found, so the boundary is not dragged out by a few
    extreme windows.
    """
    med = np.median(X, axis=0)
    mad = np.median(np.abs(X - med), axis=0) * 1.4826
    scale = np.where(mad > C.EPS, mad, np.where(X.std(axis=0) > C.EPS, X.std(axis=0), 1.0))
    z = np.abs((X - med) / scale)
    max_z = z.max(axis=1)

    probe = IsolationForest(n_estimators=300, contamination="auto",
                            random_state=C.RANDOM_STATE, n_jobs=-1).fit(X)
    probe_out = probe.predict(X) == -1

    flagged = np.where(max_z > 6.0)[0]
    ranked = flagged[np.argsort(-max_z[flagged])][:15]
    detail = []
    for i in ranked:
        j = int(np.argmax(z[i]))
        detail.append({
            "row": int(i),
            "max_robust_z": round(float(max_z[i]), 2),
            "driving_feature": feature_names[j],
            "also_flagged_by_probe_forest": bool(probe_out[i]),
        })

    return {
        "n_windows": int(X.shape[0]),
        "n_max_robust_z_gt_6": int((max_z > 6).sum()),
        "n_max_robust_z_gt_10": int((max_z > 10).sum()),
        "probe_forest_outlier_fraction": round(float(probe_out.mean()), 4),
        "extreme_windows": detail,
        "max_robust_z_percentiles": {
            "p50": round(float(np.percentile(max_z, 50)), 2),
            "p90": round(float(np.percentile(max_z, 90)), 2),
            "p99": round(float(np.percentile(max_z, 99)), 2),
            "max": round(float(max_z.max()), 2),
        },
    }


# --------------------------------------------------------------------------------------
# Parameter sweep
# --------------------------------------------------------------------------------------
def sweep_parameters(frames: pd.DataFrame, candidates: list, groups: np.ndarray) -> list:
    """Compare Isolation Forest settings on *held-out segments*, not on the fit data.

    Without labels there is no accuracy to optimise, so the criterion is stability:
    for each of 5 segment-grouped folds, fit on the other folds and score the held-out
    windows, then measure (a) how close the held-out outlier rate is to the in-fit
    outlier rate -- large drift means the boundary does not transfer to unseen
    segments -- and (b) the rank correlation of held-out scores between folds trained
    with different seeds. Purely a stability/consistency check; it is not a
    performance metric and cannot be, because there are no labels.
    """
    from sklearn.model_selection import GroupKFold
    from scipy.stats import spearmanr

    uniq = np.unique(groups)
    n_splits = min(5, len(uniq))
    gkf = GroupKFold(n_splits=n_splits)

    # Cache independently fitted transforms, never transform held-out data with
    # a selector/scaler learned from the full recording.
    partitions = [fit_fold_preprocessor(frames.iloc[tr], frames.iloc[te], candidates)
                  for tr, te in gkf.split(frames, groups=groups)]
    grid = []
    for n_est in (100, 300, 600):
        for max_samples in ("auto", 64, 128):
            for contamination in ("auto", 0.02, 0.05):
                grid.append({"n_estimators": n_est, "max_samples": max_samples,
                             "contamination": contamination})

    results = []
    for params in grid:
        gaps, rhos = [], []
        for X_tr, X_te, _ in partitions:
            m1 = IsolationForest(random_state=C.RANDOM_STATE, n_jobs=-1, **params).fit(X_tr)
            m2 = IsolationForest(random_state=C.RANDOM_STATE + 7, n_jobs=-1, **params).fit(X_tr)
            in_rate = float((m1.predict(X_tr) == -1).mean())
            out_rate = float((m1.predict(X_te) == -1).mean())
            gaps.append(abs(out_rate - in_rate))
            s1 = m1.decision_function(X_te)
            s2 = m2.decision_function(X_te)
            if len(s1) > 2 and np.std(s1) > 0 and np.std(s2) > 0:
                rhos.append(float(spearmanr(s1, s2).statistic))
        results.append({
            "params": params,
            "mean_abs_outlier_rate_gap": round(float(np.mean(gaps)), 4),
            "seed_rank_stability_spearman": round(float(np.mean(rhos)) if rhos else float("nan"), 4),
            "folds": n_splits,
        })

    # Prefer stable-across-seeds first, then a boundary that transfers to unseen segments.
    results.sort(key=lambda r: (-round(r["seed_rank_stability_spearman"], 2),
                                r["mean_abs_outlier_rate_gap"]))
    return results


# --------------------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------------------
def main(argv=None) -> dict:
    ap = argparse.ArgumentParser(description="Train the conveyor anomaly baseline.")
    ap.add_argument("--no-sweep", action="store_true",
                    help="skip the parameter stability sweep (faster)")
    ap.add_argument("--window", type=float, default=C.WINDOW_SECONDS)
    ap.add_argument("--step", type=float, default=C.STEP_SECONDS)
    args = ap.parse_args(argv)

    C.ensure_dirs()
    started = datetime.now(timezone.utc)

    print("[1/7] preprocessing ...")
    pre = preprocessing.preprocess()
    print("      %d raw frames, %d segments, %d sensor streams"
          % (len(pre.raw), len(pre.segments), len(pre.streams)))

    print("[2/7] windowing + feature engineering (window=%.1fs step=%.1fs) ..."
          % (args.window, args.step))
    feats = fe.build_feature_table(pre, args.window, args.step)
    candidates = fe.feature_columns(feats)
    print("      %d windows from %d segments, %d candidate features"
          % (len(feats), feats.segment_id.nunique(), len(candidates)))
    feats.to_csv(C.FEATURES_CSV, index=False)

    print("[3/7] pruning degenerate features ...")
    selected, prune_report = prune_features(feats, candidates)
    print("      kept %d, dropped %d constant, %d near-duplicate"
          % (len(selected), len(prune_report["dropped_zero_variance"]),
             len(prune_report["dropped_redundant"])))

    X_raw = feats[selected].to_numpy(float)

    print("[4/7] screening the baseline for obviously abnormal windows ...")
    scaler = RobustScaler().fit(X_raw)
    X = scaler.transform(X_raw)
    screen = screen_baseline(X, selected)
    print("      %d/%d windows exceed robust-z 6; probe-forest outlier rate %.1f%%"
          % (screen["n_max_robust_z_gt_6"], screen["n_windows"],
             100 * screen["probe_forest_outlier_fraction"]))

    sweep = []
    chosen = dict(C.IF_PARAMS)
    if not args.no_sweep:
        print("[5/7] parameter stability sweep (segment-grouped folds) ...")
        sweep = sweep_parameters(feats, candidates, feats.segment_id.to_numpy())
        best = sweep[0]["params"]
        print("      best-by-stability: %s (spearman %.3f, rate gap %.3f)"
              % (best, sweep[0]["seed_rank_stability_spearman"],
                 sweep[0]["mean_abs_outlier_rate_gap"]))
        chosen.update(best)
        chosen["random_state"] = C.RANDOM_STATE
        chosen["n_jobs"] = -1
    else:
        print("[5/7] sweep skipped; using config defaults")

    print("[6/7] fitting the deployed baseline on all %d windows ..." % len(X))
    model = IsolationForest(**chosen).fit(X)

    # Per-sensor sub-detectors. A single forest over all features under-reacts to a
    # deviation confined to one channel, because 40 of the 59 features are vibration and
    # only 12 are thermal -- measured in outputs/synthetic_fault_report.md, where a
    # thermal excursion well outside anything ever recorded reached WATCH in barely half
    # of windows. Each group gets its own forest, calibrated on the same baseline; the
    # reported score is the maximum across detectors.
    groups = hs.feature_groups(selected)
    sub_models, calibs = {}, {}
    raw = -model.decision_function(X)
    calibs["joint"] = hs.fit_calibration(raw)
    for gname, idx in groups.items():
        gm = IsolationForest(**chosen).fit(X[:, idx])
        sub_models[gname] = gm
        calibs[gname] = hs.fit_calibration(-gm.decision_function(X[:, idx]))
        print("      sub-detector '%s': %d features" % (gname, len(idx)))

    engine = hs.ScoreEngine(dict(joint=model, **sub_models), scaler, calibs,
                            {"thresholds": {"watch": 50, "warning": 75, "critical": 90}},
                            selected, groups)
    per = engine.raw_scores(X)
    scores = np.clip(np.vstack([per[g] for g in hs.GROUP_ORDER if g in per]).max(axis=0),
                     0, 100)
    calib = calibs["joint"]
    thresholds = hs.fit_thresholds(scores)
    # Fitted on the UNSCALED matrix so explanations quote degC / g / RPM, not
    # scaler units. Robust z-scores are identical either way (affine invariance).
    baseline_stats = hs.fit_baseline_feature_stats(X_raw, selected)
    baseline_stats["units"] = "raw feature units (unscaled)"

    status = hs.classify(scores, thresholds)
    counts = pd.Series(status).value_counts().to_dict()
    print("      baseline status mix: %s" % counts)

    print("[7/7] writing artifacts ...")
    joblib.dump(model, C.MODEL_PATH)
    joblib.dump(scaler, C.SCALER_PATH)
    joblib.dump(sub_models, os.path.join(C.MODELS_DIR, "sensor_detectors.joblib"))

    feature_config = {
        "schema_version": 2,
        "feature_names": selected,
        "feature_order": selected,
        "n_features": len(selected),
        "window_seconds": args.window,
        "step_seconds": args.step,
        "min_frames_per_sensor": C.MIN_FRAMES_PER_SENSOR,
        "min_time_coverage": C.MIN_TIME_COVERAGE,
        "required_sensors": C.REQUIRED_SENSORS,
        "input_validation": {
            "sensor_health_required": True, "max_sensor_gap_ms": 5000,
            "timestamp_aliases": ["ts_ms", "ts"],
            "timestamp_meaning": "laptop USB-bridge arrival, integer milliseconds",
            "invalid_input_action": "clear all sensor buffers; data unavailable; warm up again",
            "window_interval": "[start_ms, end_ms), emitted on all-sensor watermark",
            "sequence_discontinuity_action": "restart synchronized window",
        },
        "required_input_columns": {
            "vibration": ["ts_ms", "vibration_rms", "vibration_kurtosis", "vibration_crest",
                          "acceleration_x", "acceleration_y", "acceleration_z",
                          "acceleration_magnitude"],
            "thermal": ["ts_ms", "temperature", "ambient"],
            "speed": ["ts_ms", "hall_rpm"],
        },
        "node_to_sensor_role": pre.node_to_sensor,
        "preprocessing": {
            "scaler": "RobustScaler",
            "scaler_artifact": os.path.basename(C.SCALER_PATH),
            "fitted_on": "all %d windows of the baseline session" % len(X),
            "center_": scaler.center_.tolist(),
            "scale_": scaler.scale_.tolist(),
            "notes": ("RobustScaler (median / IQR) is used instead of StandardScaler so a "
                      "handful of impulsive windows do not compress the rest of the scale."),
        },
        "candidate_features_before_pruning": candidates,
        "pruning": prune_report,
        "dropped_source_columns": {
            "all_null": pre.dropped_all_null,
            "redundant": pre.redundant_pairs,
        },
        "score_calibration": calib,
        "score_calibration_by_group": calibs,
        "feature_groups": {g: list(map(int, idx)) for g, idx in groups.items()},
        "ensemble": {
            "detectors": ["joint"] + sorted(groups),
            "combination": "anomaly_score = max over detectors of each detector's "
                           "own baseline-calibrated 0-100 score",
            "rationale": ("A single forest over all %d features under-reacts to a "
                          "deviation confined to one sensor: %d features are "
                          "vibration and only %d are thermal, so random splits "
                          "rarely land on the channel that moved. Measured in "
                          "outputs/synthetic_fault_report.md."
                          % (len(selected),
                             len(groups.get("vibration", [])),
                             len(groups.get("temperature", [])))),
        },
        "thresholds_artifact": os.path.basename(C.THRESHOLDS_PATH),
        "contract": ("ml/predict.py must build features with "
                     "feature_engineering.compute_window_features and then select "
                     "feature_order in exactly this order before scaling."),
    }
    hs.save_json(feature_config, C.FEATURE_CONFIG_PATH)
    hs.save_json(thresholds, C.THRESHOLDS_PATH)
    hs.save_json(baseline_stats, C.BASELINE_STATS_PATH)

    manifest = C.load_sidecar("manifest.json") or {}
    seg_used = (feats.groupby("segment_id")
                .agg(windows=("window_id", "size"),
                     start_ms=("start_ms", "min"))
                .sort_values("start_ms"))
    metadata = {
        "model_name": "conveyor-condition-isolation-forest",
        "task": ("Unsupervised conveyor condition/anomaly detection using vibration, "
                 "temperature and RPM sensor fusion."),
        "not_a_classifier": ("This model does not predict fault types, failure "
                             "probability or remaining useful life. The dataset is "
                             "unlabelled, so no such claim is supportable."),
        "training_date_utc": started.isoformat(),
        "training_duration_s": round((datetime.now(timezone.utc) - started).total_seconds(), 2),
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "numpy": np.__version__,
            "pandas": pd.__version__,
            "scikit_learn": __import__("sklearn").__version__,
        },
        "dataset": {
            "path": os.path.relpath(C.resolve_telemetry_path(), C.ROOT).replace("\\", "/"),
            "session_id": manifest.get("source_session_id"),
            "dataset_version": manifest.get("dataset_version"),
            "label_field": manifest.get("label"),
            "conveyor": "CV-01",
            "raw_rows": int(len(pre.raw)),
            "raw_rows_by_node": {k: int(v) for k, v in
                                 pre.raw[C.NODE_COL].value_counts().items()},
            "segments_total": int(len(pre.segments)),
            "segments_yielding_windows": int(feats.segment_id.nunique()),
            "retained_seconds": round(float(pre.segments.duration_s.sum()), 3),
            "verified_sha256": __import__("data_contract").verify_recording(C.resolve_telemetry_path()),
        },
        "windows": {
            "n_windows": int(len(feats)),
            "window_seconds": args.window,
            "step_seconds": args.step,
            "overlap_fraction": round(1 - args.step / args.window, 3),
            "independence_caveat": ("Windows overlap by %.0f%%. They are correlated and "
                                    "must not be treated as %d independent observations; "
                                    "they come from only %d distinct segments."
                                    % (100 * (1 - args.step / args.window), len(feats),
                                       feats.segment_id.nunique())),
        },
        "features": {
            "n_candidate": len(candidates),
            "n_used": len(selected),
            "feature_names": selected,
            "pruning": prune_report,
        },
        "model": {
            "algorithm": "sklearn.ensemble.IsolationForest",
            "parameters": {k: (v if not isinstance(v, np.generic) else v.item())
                           for k, v in chosen.items()},
            "config_defaults": C.IF_PARAMS,
            "parameter_selection": ("segment-grouped 5-fold stability sweep with fold-local selection/scaling; see "
                                    "parameter_sweep_top below"
                                    if sweep else "config defaults (sweep skipped)"),
            "parameter_sweep_top": sweep[:5],
            "contamination_note": ("`contamination` only sets IsolationForest.offset_, a "
                                   "constant shift of decision_function. The anomaly score "
                                   "here is a robust z-score of -decision_function, so that "
                                   "constant cancels: contamination does not change any "
                                   "reported anomaly_score, health_score or status. It "
                                   "affects only the model's own predict() labels."),
            "sweep_criterion": ("No labels exist, so there is no accuracy to optimise. The "
                                "sweep ranks settings by seed-to-seed Spearman rank "
                                "stability of held-out scores, then by how closely the "
                                "held-out outlier rate matches the in-fit rate under "
                                "segment-grouped folds. It measures consistency, not skill."),
        },
        "training_split": {
            "deployed_model_fitted_on": "all %d windows from all %d segments"
                                        % (len(feats), feats.segment_id.nunique()),
            "reason": ("Temperature is a monotone warm-up confounded with session time, "
                       "and the dataset manifest requires the whole session to stay in one "
                       "split. Fitting on early windows only would flag late windows as "
                       "anomalous for a thermal reason, not a mechanical one."),
            "chronological_drift_diagnostic": ("evaluate.py additionally fits on the "
                                               "earliest %.0f%% of segments and scores the "
                                               "rest. That is a drift diagnostic, not a "
                                               "generalisation estimate."
                                               % (100 * C.DRIFT_SPLIT_FRACTION)),
            "segments_used": {str(k): int(v) for k, v in seg_used.windows.items()},
        },
        "scoring": {
            "raw_score": "-IsolationForest.decision_function (higher = more unusual)",
            "calibration": calib,
            "thresholds": thresholds,
        },
        "baseline_screening": screen,
        "known_limitations": [
            "The dataset carries no verified fault labels. Nothing here is validated "
            "against ground truth, and no accuracy, precision, recall, F1, failure "
            "probability or remaining-useful-life figure is produced.",
            "'Baseline observed operating behaviour' is not 'confirmed healthy behaviour'. "
            "The conveyor's mechanical condition during the recording was never verified.",
            "One conveyor (CV-01), one session, %.0f s of retained data. Nothing here "
            "estimates behaviour on a different machine, a different day or a different "
            "belt loading." % pre.segments.duration_s.sum(),
            "Temperature is confounded with elapsed session time (r = 0.96). A rising "
            "temperature reading may reflect normal warm-up rather than a fault.",
            "hall_rpm varied only between 20.37 and 20.69 RPM and updates roughly every "
            "3 s. The model has never seen a speed change, so RPM-instability detection "
            "is untested.",
            "Device timestamps stall during the session (up to ~100%% duplicated "
            "(node, ts_ms) pairs late on). Slope features are accurate only to about the "
            "2 s burst period.",
            "No motor current, motor power, motor-side RPM, load cell, acoustic or "
            "belt-offset channel is present, so slip, load and drive-side faults cannot "
            "be observed at all.",
            "Windows overlap by 75%%, so the %d samples are correlated, not independent."
            % len(feats),
            "41 of 78 segments are shorter than the 10 s window and contribute nothing.",
            "Thresholds are prototype values from one recording, not industrial safety "
            "limits.",
        ],
    }
    hs.save_json(metadata, C.MODEL_METADATA_PATH)

    for p in (C.MODEL_PATH, C.SCALER_PATH, C.FEATURE_CONFIG_PATH,
              C.THRESHOLDS_PATH, C.BASELINE_STATS_PATH, C.MODEL_METADATA_PATH,
              C.FEATURES_CSV):
        print("      wrote %s" % os.path.relpath(p, C.ROOT))

    print("\nDone. %d windows, %d features, thresholds %s"
          % (len(feats), len(selected), thresholds["thresholds"]))
    return metadata


if __name__ == "__main__":
    main()
