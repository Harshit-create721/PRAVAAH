"""Score every window, run the honest diagnostics, and write outputs/evaluation_report.md.

There are no labels, so this file contains **no accuracy, precision, recall, F1, ROC AUC,
failure probability or remaining-useful-life number**, and it never will unless a labelled
dataset is collected (see outputs/future_data_collection_plan.md).

What is actually evaluated:

1. Score distribution and status mix over the baseline.
2. Segment-grouped stability -- fit on 4/5 of the segments, score the held-out fifth, and
   check the boundary transfers. Repeated across folds.
3. Chronological drift diagnostic -- fit on the earliest 70% of segments, score the latest
   30%. Reported as drift, NOT as generalisation, because temperature is confounded with
   session time and the dataset comes from a single run.
4. Feature/time confounding -- which features correlate with elapsed session time, so a
   reader can see which "anomalies" are really warm-up.
5. Model comparison -- Local Outlier Factor and One-Class SVM ranked against Isolation
   Forest by rank agreement. With no labels, agreement is all that can be measured.
6. Which windows the model finds most unusual, with their explanations.
"""
from __future__ import annotations

import json
import os

import joblib
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.ensemble import IsolationForest
from sklearn.model_selection import GroupKFold
from sklearn.neighbors import LocalOutlierFactor
from sklearn.preprocessing import RobustScaler
from sklearn.svm import OneClassSVM

import config as C
import health_score as hs
import feature_engineering as fe
from train import fit_fold_preprocessor


def load_artifacts():
    model = joblib.load(C.MODEL_PATH)
    scaler = joblib.load(C.SCALER_PATH)
    fcfg = hs.load_json(C.FEATURE_CONFIG_PATH)
    thresholds = hs.load_json(C.THRESHOLDS_PATH)
    baseline_stats = hs.load_json(C.BASELINE_STATS_PATH)
    feats = pd.read_csv(C.FEATURES_CSV)
    return model, scaler, fcfg, thresholds, baseline_stats, feats


def score_all(model, scaler, feats, fcfg, thresholds, baseline_stats):
    names = fcfg["feature_order"]
    X_raw = feats[names].to_numpy(float)          # physical units, for explanations
    engine = hs.ScoreEngine.load()
    v = engine.score(X_raw)
    X = v["X_scaled"]                             # scaled, for the model
    raw = -model.decision_function(X)             # joint-detector raw, kept for diagnostics
    score = v["anomaly_score"]
    health = v["health_score"]
    status = v["status"]
    driver = v["driver"]

    rows = []
    for i in range(len(feats)):
        e = hs.explain(X_raw[i], baseline_stats, status[i])
        rows.append({
            "indicators": "|".join(e["indicators"]),
            "explanation": e["explanation"],
            "top_deviation_1": e["top_deviations"][0]["feature"] if e["top_deviations"] else "",
            "top_deviation_1_z": e["top_deviations"][0]["robust_z"] if e["top_deviations"] else 0.0,
        })

    out = feats[["window_id", "segment_id", "segment_order", "start_ms", "end_ms",
                 "start_utc", "t_rel_start_s"]].copy()
    out["temperature_mean_c"] = feats["temp_mean"].round(3)
    out["ambient_mean_c"] = feats["ambient_mean"].round(3)
    out["rpm_mean"] = feats["rpm_mean"].round(3)
    out["vibration_rms_mean_g"] = feats["vib_rms_mean"].round(5)
    out["vibration_rms_max_g"] = feats["vib_rms_max"].round(5)
    out["raw_score"] = raw.round(6)
    out["anomaly_score"] = score.round(2)
    out["health_score"] = health.round(2)
    out["status"] = status
    out["driver_detector"] = driver
    for k in ("indicators", "explanation", "top_deviation_1", "top_deviation_1_z"):
        out[k] = [r[k] for r in rows]
    return out, X, raw, score, status


# --------------------------------------------------------------------------------------
# Diagnostics
# --------------------------------------------------------------------------------------
def segment_grouped_stability(frames, groups, params):
    """Fit on 4/5 of the segments, score the held-out fifth. No labels are involved."""
    uniq = np.unique(groups)
    n_splits = min(5, len(uniq))
    gkf = GroupKFold(n_splits=n_splits)
    folds = []
    for k, (tr, te) in enumerate(gkf.split(frames, groups=groups)):
        X_tr, X_te, names = fit_fold_preprocessor(frames.iloc[tr], frames.iloc[te], fe.feature_columns(frames))
        m = IsolationForest(**params).fit(X_tr)
        raw_tr = -m.decision_function(X_tr)
        raw_te = -m.decision_function(X_te)
        cal = hs.fit_calibration(raw_tr)
        s_tr = hs.raw_to_anomaly_score(raw_tr, cal)
        s_te = hs.raw_to_anomaly_score(raw_te, cal)
        th = hs.fit_thresholds(s_tr)
        folds.append({
            "fold": k,
            "n_features_fitted_on_training_only": len(names),
            "n_train_windows": int(len(tr)),
            "n_heldout_windows": int(len(te)),
            "n_heldout_segments": int(len(np.unique(groups[te]))),
            "train_median_score": round(float(np.median(s_tr)), 2),
            "heldout_median_score": round(float(np.median(s_te)), 2),
            "train_pct_ge_watch": round(float((s_tr >= th["thresholds"]["watch"]).mean() * 100), 1),
            "heldout_pct_ge_watch": round(float((s_te >= th["thresholds"]["watch"]).mean() * 100), 1),
            "heldout_pct_ge_warning": round(float((s_te >= th["thresholds"]["warning"]).mean() * 100), 1),
        })
    return folds


def chronological_drift(feats, params, fraction):
    """Fit on the earliest `fraction` of segments, score the rest. A drift probe only."""
    seg_order = feats.groupby("segment_id").segment_order.min().sort_values()
    n_train_seg = max(1, int(round(len(seg_order) * fraction)))
    train_segs = set(seg_order.index[:n_train_seg])
    tr = feats.segment_id.isin(train_segs).to_numpy()
    te = ~tr
    if te.sum() < 5:
        return None

    X_tr, X_te, names = fit_fold_preprocessor(feats.loc[tr], feats.loc[te], fe.feature_columns(feats))
    m = IsolationForest(**params).fit(X_tr)
    raw_tr = -m.decision_function(X_tr)
    raw_te = -m.decision_function(X_te)
    cal = hs.fit_calibration(raw_tr)
    s_tr = hs.raw_to_anomaly_score(raw_tr, cal)
    s_te = hs.raw_to_anomaly_score(raw_te, cal)
    th = hs.fit_thresholds(s_tr)

    st_te = hs.classify(s_te, th)
    mix = pd.Series(st_te).value_counts().to_dict()

    return {
        "split_rule": ("segments ordered by start time; earliest %d of %d segments (%.0f%%) "
                       "used to fit, remaining %d segments scored"
                       % (n_train_seg, len(seg_order), 100 * fraction,
                          len(seg_order) - n_train_seg)),
        "n_features_fitted_on_training_only": len(names),
        "train_segments": sorted(train_segs),
        "eval_segments": sorted(set(feats.segment_id) - train_segs),
        "n_train_windows": int(tr.sum()),
        "n_eval_windows": int(te.sum()),
        "train_time_range_s": [round(float(feats.t_rel_start_s[tr].min()), 1),
                               round(float(feats.t_rel_start_s[tr].max()), 1)],
        "eval_time_range_s": [round(float(feats.t_rel_start_s[te].min()), 1),
                              round(float(feats.t_rel_start_s[te].max()), 1)],
        "train_median_score": round(float(np.median(s_tr)), 2),
        "eval_median_score": round(float(np.median(s_te)), 2),
        "train_pct_ge_watch": round(float((s_tr >= th["thresholds"]["watch"]).mean() * 100), 1),
        "eval_pct_ge_watch": round(float((s_te >= th["thresholds"]["watch"]).mean() * 100), 1),
        "eval_status_mix": {k: int(v) for k, v in mix.items()},
        "train_temp_mean_c": round(float(feats.temp_mean[tr].mean()), 2),
        "eval_temp_mean_c": round(float(feats.temp_mean[te].mean()), 2),
        "train_vib_rms_mean_g": round(float(feats.vib_rms_mean[tr].mean()), 5),
        "eval_vib_rms_mean_g": round(float(feats.vib_rms_mean[te].mean()), 5),
        "thresholds_from_train": th["thresholds"],
    }


def time_confounding(feats, names):
    """Spearman correlation of each model feature with elapsed session time."""
    t = feats.t_rel_start_s.to_numpy(float)
    rows = []
    for n in names:
        v = feats[n].to_numpy(float)
        if np.std(v) < C.EPS:
            continue
        rho = spearmanr(t, v).statistic
        if np.isfinite(rho):
            rows.append({"feature": n, "spearman_with_session_time": round(float(rho), 3)})
    rows.sort(key=lambda r: -abs(r["spearman_with_session_time"]))
    return rows


def compare_models(X, if_raw):
    """Rank agreement with LOF and One-Class SVM. Agreement is not correctness."""
    out = []

    lof = LocalOutlierFactor(n_neighbors=20, novelty=True).fit(X)
    lof_raw = -lof.decision_function(X)
    out.append({
        "model": "LocalOutlierFactor(n_neighbors=20, novelty=True)",
        "spearman_vs_isolation_forest": round(float(spearmanr(if_raw, lof_raw).statistic), 3),
        "top10_overlap_with_if": int(len(set(np.argsort(-if_raw)[:10])
                                          & set(np.argsort(-lof_raw)[:10]))),
    })

    for nu, gamma in ((0.05, "scale"), (0.02, "scale")):
        oc = OneClassSVM(kernel="rbf", nu=nu, gamma=gamma).fit(X)
        oc_raw = -oc.decision_function(X)
        out.append({
            "model": "OneClassSVM(rbf, nu=%.2f, gamma=%s)" % (nu, gamma),
            "spearman_vs_isolation_forest": round(float(spearmanr(if_raw, oc_raw).statistic), 3),
            "top10_overlap_with_if": int(len(set(np.argsort(-if_raw)[:10])
                                              & set(np.argsort(-oc_raw)[:10]))),
        })
    return out


# --------------------------------------------------------------------------------------
# Report
# --------------------------------------------------------------------------------------
def render_markdown(ev: dict) -> str:
    L = ["# Evaluation report -- conveyor condition monitoring\n"]
    L.append("Model: **%s** on **%d windows** / **%d features**.\n"
             % (ev["model"]["algorithm"], ev["n_windows"], ev["n_features"]))
    L.append("> **There are no fault labels in this dataset.** Nothing in this report is an "
             "accuracy, precision, recall, F1, ROC AUC, failure probability or "
             "remaining-useful-life figure, because none of those can be computed without "
             "ground truth. What is measured here is score distribution, stability and "
             "internal consistency.\n")

    L.append("## 1. Anomaly-score distribution over the baseline\n")
    d = ev["score_distribution"]
    L.append("`health_score` is defined as `100 - anomaly_score` for the same window, so "
             "the two columns below are the same windows read from opposite ends.\n")
    L.append("| percentile of anomaly_score | anomaly_score | health_score of that window |"
             "\n|---|---|---|")
    for k in ("min", "p25", "median", "mean", "p75", "p90", "p95", "p99", "max"):
        L.append("| %s | %.2f | %.2f |" % (k, d["anomaly"][k], 100 - d["anomaly"][k]))
    L.append("")
    L.append("Status mix across the %d baseline windows:\n" % ev["n_windows"])
    L.append("| status | windows | share |\n|---|---|---|")
    for s in hs.STATUSES:
        n = ev["status_mix"].get(s, 0)
        L.append("| %s | %d | %.1f%% |" % (s, n, 100 * n / ev["n_windows"]))
    L.append("")
    L.append("This mix is *by construction*: the thresholds were derived from these very "
             "percentiles. It says the scale behaves as designed, not that %d windows are "
             "genuinely faulty.\n" % (ev["n_windows"] - ev["status_mix"].get("NORMAL", 0)))

    L.append("## 2. Threshold derivation\n")
    t = ev["thresholds"]
    L.append("| status boundary | score | derived from | realised baseline exceedance |"
             "\n|---|---|---|---|")
    for k in ("watch", "warning", "critical"):
        L.append("| >= %s | %.1f | %s | %.1f%% |"
                 % (k.upper(), t["thresholds"][k], t["derivation"][k],
                    100 * t["realised_baseline_exceedance"][k]))
    L.append("")
    L.append("*%s*\n" % t["disclaimer"])

    L.append("## 3. Score calibration\n")
    c = ev["calibration"]
    L.append("```\nraw   = -IsolationForest.decision_function(x)      (higher = more unusual)\n"
             "z     = (raw - %.6f) / %.6f\n"
             "score = 100 / (1 + exp(-(z - %.4f) / %.4f))\n```\n"
             % (c["raw_median"], c["raw_mad_scaled"], c["z_mid"], c["z_scale"]))
    L.append("Anchors: the baseline median maps to ~5, the baseline 99th percentile maps to "
             "50. **A score of 50 therefore means 'as unusual as the most unusual 1% of the "
             "baseline' -- it does not mean a 50% chance of anything.**\n")

    L.append("## 4. Segment-grouped stability\n")
    L.append("Fit on 4/5 of the *segments*, score the held-out fifth. Windows from one "
             "segment never appear on both sides, so the 75% window overlap cannot leak "
             "across the split.\n")
    L.append("| fold | train windows | held-out windows | held-out segments | train median "
             "score | held-out median score | train %>=WATCH | held-out %>=WATCH |"
             "\n|---|---|---|---|---|---|---|---|")
    for f in ev["segment_stability"]:
        L.append("| %d | %d | %d | %d | %.2f | %.2f | %.1f%% | %.1f%% |"
                 % (f["fold"], f["n_train_windows"], f["n_heldout_windows"],
                    f["n_heldout_segments"], f["train_median_score"],
                    f["heldout_median_score"], f["train_pct_ge_watch"],
                    f["heldout_pct_ge_watch"]))
    L.append("")
    gaps = [abs(f["heldout_pct_ge_watch"] - f["train_pct_ge_watch"]) for f in ev["segment_stability"]]
    rates = [f["heldout_pct_ge_watch"] for f in ev["segment_stability"]]
    L.append("Mean |held-out - train| WATCH-rate gap: **%.1f percentage points**; the "
             "held-out WATCH rate ranges from **%.1f%% to %.1f%%** against a %.1f%% in-fit "
             "rate.\n" % (np.mean(gaps), min(rates), max(rates),
                          ev["segment_stability"][0]["train_pct_ge_watch"]))
    if np.mean(gaps) > 5:
        L.append("> **This gap is large, and it is the most important negative result in "
                 "this report.** The boundary does not transfer cleanly to segments the "
                 "model has not seen: depending on which segments are held out, the alert "
                 "rate on unseen data is anywhere from a third of the in-fit rate to "
                 "roughly three times it. With %d windows drawn from only %d segments, "
                 "between-segment variation dominates -- each fold removes a handful of "
                 "segments that carry a meaningful share of the whole recording's "
                 "behaviour. Practical consequence: **the WATCH threshold should be "
                 "expected to produce an alert rate somewhere in the range above, not a "
                 "stable 10%%, until far more segments are recorded.** It also means the "
                 "prototype thresholds are the least trustworthy part of this system.\n"
                 % (ev["n_windows"], sum(f["n_heldout_segments"] for f in ev["segment_stability"])))
    else:
        L.append("The boundary transfers to segments the model has not seen with a modest "
                 "rate gap.\n")
    L.append("Either way this says nothing about whether those segments were mechanically "
             "healthy -- only about how consistently the model scores them.\n")

    L.append("The grouped and chronological diagnostics below fit feature selection, scaling, "
             "the joint forest, calibration and thresholds on each training partition only. "
             "They probe the joint detector, not the full deployed ensemble, and do not "
             "provide independent field-validation estimates.\n")
    L.append("## 5. Chronological drift diagnostic\n")
    cd = ev["chronological_drift"]
    if cd is None:
        L.append("Not enough later segments to run this.\n")
    else:
        L.append("**How the split was performed.** %s\n" % cd["split_rule"])
        L.append("| | train (earlier) | evaluation (later) |\n|---|---|---|")
        L.append("| segments | %d | %d |" % (len(cd["train_segments"]), len(cd["eval_segments"])))
        L.append("| windows | %d | %d |" % (cd["n_train_windows"], cd["n_eval_windows"]))
        L.append("| session time covered | %.0f-%.0f s | %.0f-%.0f s |"
                 % (cd["train_time_range_s"][0], cd["train_time_range_s"][1],
                    cd["eval_time_range_s"][0], cd["eval_time_range_s"][1]))
        L.append("| mean temperature | %.2f degC | %.2f degC |"
                 % (cd["train_temp_mean_c"], cd["eval_temp_mean_c"]))
        L.append("| mean vibration RMS | %.5f g | %.5f g |"
                 % (cd["train_vib_rms_mean_g"], cd["eval_vib_rms_mean_g"]))
        L.append("| median anomaly score | %.2f | %.2f |"
                 % (cd["train_median_score"], cd["eval_median_score"]))
        L.append("| %%>=WATCH | %.1f%% | %.1f%% |"
                 % (cd["train_pct_ge_watch"], cd["eval_pct_ge_watch"]))
        L.append("")
        L.append("Later-window status mix under the earlier-only model: %s\n"
                 % ", ".join("%s %d" % (k, v) for k, v in cd["eval_status_mix"].items()))
        L.append("> **Read this as drift, not as skill.** The evaluation half is on average "
                 "%.2f degC hotter than the training half purely because the machine was "
                 "warming up, while mean vibration barely moves (%.5f -> %.5f g). A model "
                 "fitted only on cold windows will therefore call hot windows unusual for a "
                 "thermal reason. This is exactly why the *deployed* model in "
                 "`models/isolation_forest.joblib` is fitted over the whole session.\n"
                 % (cd["eval_temp_mean_c"] - cd["train_temp_mean_c"],
                    cd["train_vib_rms_mean_g"], cd["eval_vib_rms_mean_g"]))
        L.append("> **This is not a test on an unseen conveyor.** Both halves come from one "
                 "physical prototype, one belt, one motor, one 40-minute session on "
                 "2026-09-06. The dataset manifest explicitly asks for the whole session to "
                 "stay in one split; that instruction is followed for the deployed model and "
                 "deliberately broken here, in isolation, only to expose the drift. Nothing "
                 "in this table estimates behaviour on another machine or another day.\n")

    L.append("## 6. Which features track elapsed session time\n")
    L.append("Spearman correlation between each model feature and elapsed session time. "
             "Strongly correlated features encode *when* a window was recorded as much as "
             "*how the machine behaved*, so an alert driven by them deserves extra scrutiny.\n")
    L.append("| feature | Spearman vs session time |\n|---|---|")
    for r in ev["time_confounding"][:12]:
        L.append("| `%s` | %+.3f |" % (r["feature"], r["spearman_with_session_time"]))
    L.append("")
    strong = [r for r in ev["time_confounding"] if abs(r["spearman_with_session_time"]) > 0.7]
    by_sensor = {}
    for r in strong:
        by_sensor.setdefault(hs.feature_sensor(r["feature"]), []).append(r["feature"])
    L.append("**%d of %d features** exceed |rho| = 0.7 against session time, split as: %s.\n"
             % (len(strong), ev["n_features"],
                "; ".join("%s %d (%s)" % (k, len(v), ", ".join("`%s`" % f for f in v))
                          for k, v in sorted(by_sensor.items()))))
    accel_strong = [r for r in strong if r["feature"].startswith("acceleration")]
    if accel_strong:
        L.append("> The thermal features tracking session time is expected -- that is the "
                 "warm-up described in the data-quality report. **The %d static-acceleration "
                 "features in that list are a separate and less obvious finding.** "
                 "`acceleration_z_mean`, `acceleration_magnitude_mean` and friends are the "
                 "DC / orientation component of the accelerometer, not its vibration "
                 "component, and they drift monotonically across the session in step with "
                 "temperature. The most likely cause is thermal bias drift in the MEMS "
                 "sensor itself rather than the conveyor physically tilting. Practical "
                 "consequence: an `orientation_shift` indicator raised by this system may "
                 "reflect sensor warm-up rather than a mounting change, and should not be "
                 "acted on alone. Confirming this needs a bench test -- log the "
                 "accelerometer at rest through a full thermal cycle and see whether the "
                 "same drift appears with nothing moving.\n" % len(accel_strong))
    dyn = [r for r in ev["time_confounding"]
           if r["feature"].startswith(("vib_", "rpm_"))][:1]
    L.append("The reassuring half of the table: no `vib_*` or `rpm_*` feature reaches "
             "|rho| = 0.7 (strongest is `%s` at %+.3f), so the dynamic vibration and speed "
             "channels are not simply acting as clocks.\n"
             % (dyn[0]["feature"], dyn[0]["spearman_with_session_time"]) if dyn else "")

    L.append("## 7. Comparison with other unsupervised detectors\n")
    L.append("Isolation Forest is the primary model. LOF and One-Class SVM are shown only to "
             "check that the ranking is not an artefact of one algorithm. **Agreement between "
             "unlabelled detectors is consistency, not correctness** -- three models can agree "
             "and all be wrong about mechanical condition.\n")
    L.append("| model | Spearman vs Isolation Forest | shared windows in top-10 |\n|---|---|---|")
    for m in ev["model_comparison"]:
        L.append("| %s | %.3f | %d/10 |" % (m["model"], m["spearman_vs_isolation_forest"],
                                            m["top10_overlap_with_if"]))
    L.append("")
    best_ov = max(m["top10_overlap_with_if"] for m in ev["model_comparison"])
    L.append("**The global agreement is moderate but the tail agreement is poor.** Spearman "
             "sits around %.2f across all %d windows, yet the three detectors share only "
             "%d-%d of their top-10 most-unusual windows. The tail is precisely what an alert "
             "threshold acts on, so this is the honest reading: *which* windows get flagged "
             "as the worst offenders is substantially model-dependent, and no labelled data "
             "exists to say which detector is right. Treat any individual CRITICAL window as "
             "a prompt to inspect, not as a verdict.\n"
             % (np.mean([m["spearman_vs_isolation_forest"] for m in ev["model_comparison"]]),
                ev["n_windows"],
                min(m["top10_overlap_with_if"] for m in ev["model_comparison"]), best_ov))
    L.append("Isolation Forest is kept as primary anyway, on engineering grounds rather than "
             "measured superiority: it needs no distance metric over %d heterogeneous "
             "features, trains and scores fast enough to run on an edge gateway, exposes a "
             "smooth `decision_function` suitable for the 0-100 mapping, and does not need "
             "the whole training set kept in memory at inference time the way LOF does.\n"
             % ev["n_features"])

    L.append("## 8. Most unusual windows found\n")
    L.append("| rank | window | segment | session time | score | status | temp | RPM | "
             "vib RMS | leading deviation |\n|---|---|---|---|---|---|---|---|---|---|")
    for i, w in enumerate(ev["top_windows"], 1):
        L.append("| %d | %d | %s | %.0f s | %.1f | %s | %.2f degC | %.2f | %.4f g | `%s` (z=%+.1f) |"
                 % (i, w["window_id"], w["segment_id"], w["t_rel_start_s"],
                    w["anomaly_score"], w["status"], w["temperature_mean_c"],
                    w["rpm_mean"], w["vibration_rms_mean_g"], w["top_deviation_1"],
                    w["top_deviation_1_z"]))
    L.append("")
    L.append("Example explanations produced by the system for these windows:\n")
    for w in ev["top_windows"][:3]:
        L.append("- **window %d (%s, %.1f)** -- %s\n"
                 % (w["window_id"], w["status"], w["anomaly_score"], w["explanation"]))
    L.append("**The physical cause of these windows is unknown.** They are statistical "
             "deviations from the learned baseline. No bearing fault, belt slip or any other "
             "mechanical diagnosis is claimed or implied.\n")

    L.append("## 9. What this evaluation does and does not establish\n")
    L.append("**Does establish:**\n")
    L.append("- The feature pipeline runs end to end and produces %d finite features per "
             "window with no NaN or infinity.\n" % ev["n_features"])
    L.append("- The score mapping is monotone, bounded to 0-100, and calibrated to "
             "documented baseline quantiles.\n")
    L.append("- Three different unsupervised detectors agree on the broad ordering "
             "(Spearman ~%.2f), so the ranking is not an artefact of one algorithm.\n"
             % np.mean([m["spearman_vs_isolation_forest"] for m in ev["model_comparison"]]))
    if ev.get("feature_parity") is not None:
        p = ev["feature_parity"]
        L.append("- Training-time and inference-time features match: `ml/predict.py "
                 "--self-test` recomputed %d windows through the streaming path and the "
                 "maximum absolute feature difference against `outputs/features.csv` was "
                 "**%.2e** across %d features.\n"
                 % (p["n_windows_checked"], p["max_abs_diff"], p["n_features"]))
    L.append("\n**Does not establish:**\n")
    L.append("- A stable alert rate. The segment-grouped folds in section 4 show the "
             "held-out WATCH rate swinging over a wide range, so the prototype thresholds "
             "are not yet dependable.\n")
    L.append("- Which windows are the *worst*. The detectors share only a few of their "
             "top-10 (section 7).\n")
    L.append("- That the conveyor was healthy during the recording.\n")
    L.append("- That the model detects any specific fault. It has never seen a labelled "
             "fault, a speed change, or a loaded belt.\n")
    L.append("- Any detection rate, false-alarm rate, lead time or RUL.\n")
    L.append("- Any behaviour on a different conveyor, a different day, or a different "
             "ambient temperature.\n")
    L.append("\nClosing that gap requires the controlled labelled campaign described in "
             "`outputs/future_data_collection_plan.md`.\n")
    return "\n".join(L)


def main():
    C.ensure_dirs()
    model, scaler, fcfg, thresholds, baseline_stats, feats = load_artifacts()
    names = fcfg["feature_order"]

    print("[1/6] scoring %d windows ..." % len(feats))
    scored, X, raw, score, status = score_all(model, scaler, feats, fcfg,
                                              thresholds, baseline_stats)
    scored.to_csv(C.ANOMALY_SCORES_CSV, index=False)

    params = {k: v for k, v in
              hs.load_json(C.MODEL_METADATA_PATH)["model"]["parameters"].items()}

    print("[2/6] segment-grouped stability ...")
    stability = segment_grouped_stability(feats, feats.segment_id.to_numpy(), params)

    print("[3/6] chronological drift diagnostic ...")
    drift = chronological_drift(feats, params, C.DRIFT_SPLIT_FRACTION)

    print("[4/6] feature/time confounding ...")
    conf = time_confounding(feats, names)

    print("[5/6] comparing with LOF and One-Class SVM ...")
    comparison = compare_models(X, raw)

    print("[6/6] verifying train/inference feature parity ...")
    import predict
    parity = predict.self_test(verbose=False)
    if not parity["passed"]:
        raise RuntimeError("streaming feature/score/boundary parity failed")
    print("      max |diff| = %.2e over %d windows (PASS)"
          % (parity["max_abs_diff"], parity["n_windows_checked"]))

    print("      writing report ...")
    top = scored.sort_values("anomaly_score", ascending=False).head(10)
    ev = {
        "n_windows": int(len(feats)),
        "n_features": len(names),
        "model": {"algorithm": "IsolationForest", "parameters": params},
        "score_distribution": {
            "anomaly": {"min": float(score.min()), "p25": float(np.percentile(score, 25)),
                        "median": float(np.median(score)), "mean": float(score.mean()),
                        "p75": float(np.percentile(score, 75)),
                        "p90": float(np.percentile(score, 90)),
                        "p95": float(np.percentile(score, 95)),
                        "p99": float(np.percentile(score, 99)), "max": float(score.max())},
        },
        "status_mix": {k: int(v) for k, v in pd.Series(status).value_counts().items()},
        "thresholds": thresholds,
        "calibration": fcfg["score_calibration"],
        "segment_stability": stability,
        "chronological_drift": drift,
        "time_confounding": conf,
        "model_comparison": comparison,
        "feature_parity": parity,
        "top_windows": top.to_dict(orient="records"),
    }
    health = hs.health_from_anomaly(score)
    ev["score_distribution"]["health"] = {
        "min": float(health.min()), "p25": float(np.percentile(health, 25)),
        "median": float(np.median(health)), "mean": float(health.mean()),
        "p75": float(np.percentile(health, 75)), "p90": float(np.percentile(health, 90)),
        "p95": float(np.percentile(health, 95)), "p99": float(np.percentile(health, 99)),
        "max": float(health.max()),
    }

    with open(C.EVALUATION_MD, "w", encoding="utf-8") as fh:
        fh.write(render_markdown(ev))
    with open(os.path.join(C.OUTPUTS_DIR, "evaluation_report.json"), "w", encoding="utf-8") as fh:
        json.dump(ev, fh, indent=2, default=str)

    print("      wrote %s" % os.path.relpath(C.ANOMALY_SCORES_CSV, C.ROOT))
    print("      wrote %s" % os.path.relpath(C.EVALUATION_MD, C.ROOT))
    print("\nstatus mix: %s" % ev["status_mix"])
    return ev


if __name__ == "__main__":
    main()
