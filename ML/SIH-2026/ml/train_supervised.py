"""Supervised fault classifier trained on SYNTHETIC labels.

WHAT THIS MODEL IS
==================
A fully wired Random Forest / XGBoost fault-classification pipeline, trained on the
simulated faults from `ml/synthetic_faults.py`. It exists for three legitimate reasons:

1. **Plumbing.** When real labelled fault runs are collected, swap the dataset and this
   file trains the real classifier unchanged. Nothing else has to be rewritten.
2. **Demo.** It gives the dashboard something that emits a fault *type*, not just a score.
3. **Feature-importance sanity.** It shows which features carry each deviation shape.

WHAT ITS ACCURACY MEANS
=======================
**Almost nothing about real fault detection.** The labels come from injection recipes
written by hand; the classifier is graded on its ability to recover those recipes. A high
score means the recipes are mutually separable -- which they were designed to be. It is
circular by construction and is reported here only so the number is on record with its
caveat attached, never as evidence of field performance.

Two further reasons the headline number is inflated:

* **The class prior is fictional.** The generation grid produced ~50x more fault windows
  than normal ones. In service, normal would be >99% of windows, so precision on the
  fault classes would collapse relative to what is reported here.
* **Only the deviation shapes I invented are present.** A real machine produces faults
  that match none of the six labels; this classifier must assign one of them anyway.

The split is segment-grouped for a hard correctness reason: each real baseline window
spawns 51 synthetic rows, so a random split would put near-identical siblings on both
sides and report near-perfect scores from pure leakage.
"""
from __future__ import annotations

import json
import os
import platform
from datetime import datetime, timezone

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import (classification_report, confusion_matrix, f1_score)
from sklearn.model_selection import GroupKFold
from sklearn.preprocessing import LabelEncoder

import config as C
import health_score as hs
import synthetic_faults as sf

SYNTH_CSV = os.path.join(C.OUTPUTS_DIR, "synthetic_dataset.csv")
RF_PATH = os.path.join(C.MODELS_DIR, "fault_classifier_rf.joblib")
XGB_PATH = os.path.join(C.MODELS_DIR, "fault_classifier_xgb.joblib")
LABELS_PATH = os.path.join(C.MODELS_DIR, "fault_classifier_labels.json")
REPORT_MD = os.path.join(C.OUTPUTS_DIR, "supervised_model_report.md")

META_COLS = {"fault_class", "severity", "synthetic", "source_window_id",
             "segment_id", "segment_order"}


from train import prune_features


def load_dataset():
    if not os.path.exists(SYNTH_CSV):
        raise SystemExit("run `python synthetic_faults.py` first")
    df = pd.read_csv(SYNTH_CSV)
    fcfg = hs.load_json(C.FEATURE_CONFIG_PATH)
    # Candidate features are defined by the shared computation, without learning
    # a selected feature list from held-out segments.
    names = fcfg["candidate_features_before_pruning"]
    return df, names


def build_models(n_classes: int, class_weights: dict):
    import xgboost as xgb

    rf = RandomForestClassifier(
        n_estimators=400, max_depth=None, min_samples_leaf=2,
        class_weight="balanced", random_state=C.RANDOM_STATE, n_jobs=-1)

    xg = xgb.XGBClassifier(
        n_estimators=400, max_depth=6, learning_rate=0.08,
        subsample=0.85, colsample_bytree=0.85,
        objective="multi:softprob", num_class=n_classes,
        tree_method="hist", random_state=C.RANDOM_STATE, n_jobs=-1,
        eval_metric="mlogloss")
    return {"RandomForest": rf, "XGBoost": xg}


def grouped_cv(df, names, n_splits=5):
    """Segment-grouped CV. Every fold reports per-class and per-severity behaviour."""
    X = df[names].to_numpy(float)
    le = LabelEncoder().fit(sf.FAULT_CLASSES)
    y = le.transform(df.fault_class.to_numpy())
    groups = df.segment_id.to_numpy()
    sev = df.severity.to_numpy()

    counts = pd.Series(y).value_counts()
    weights = {int(k): float(len(y) / (len(counts) * v)) for k, v in counts.items()}
    gkf = GroupKFold(n_splits=min(n_splits, len(np.unique(groups))))
    results = {}
    for model_name, _ in build_models(len(le.classes_), weights).items():
        results[model_name] = {"fold_macro_f1": [], "y_true": [], "y_pred": [], "sev": []}

    for fold, (tr, te) in enumerate(gkf.split(X, y, groups=groups)):
        # Select from the original, unmodified baseline rows of the fit groups.
        # Held-out segments and their injected siblings cannot influence selection.
        train_baseline = df.iloc[tr].loc[df.iloc[tr].fault_class == "NORMAL"]
        selected, _ = prune_features(train_baseline, names)
        X_tr = df.iloc[tr][selected].to_numpy(float)
        X_te = df.iloc[te][selected].to_numpy(float)
        counts_tr = pd.Series(y[tr]).value_counts()
        weights_tr = {int(k): float(len(tr) / (len(counts_tr) * v)) for k, v in counts_tr.items()}
        models = build_models(len(le.classes_), weights_tr)
        for name, m in models.items():
            if name == "XGBoost":
                m.fit(X_tr, y[tr], sample_weight=np.array([weights_tr[i] for i in y[tr]]))
            else:
                m.fit(X_tr, y[tr])
            pred = m.predict(X_te)
            results[name]["fold_macro_f1"].append(float(f1_score(y[te], pred, average="macro")))
            results[name]["y_true"].append(y[te])
            results[name]["y_pred"].append(pred)
            results[name]["sev"].append(sev[te])
        print("    fold %d: %s" % (fold, {k: round(v["fold_macro_f1"][-1], 3)
                                          for k, v in results.items()}))

    for name in results:
        results[name]["y_true"] = np.concatenate(results[name]["y_true"])
        results[name]["y_pred"] = np.concatenate(results[name]["y_pred"])
        results[name]["sev"] = np.concatenate(results[name]["sev"])
    return results, le, weights


def per_severity_recall(y_true, y_pred, sev, le):
    """Recall by injected severity -- the informative view, unlike a single accuracy."""
    rows = []
    for s in sorted(np.unique(sev)):
        m = sev == s
        if s == 0:
            rows.append({"severity": float(s), "n": int(m.sum()),
                         "recall": float((y_pred[m] == y_true[m]).mean()),
                         "note": "NORMAL windows (real, unmodified)"})
        else:
            rows.append({"severity": float(s), "n": int(m.sum()),
                         "recall": float((y_pred[m] == y_true[m]).mean()), "note": ""})
    return rows


def render_markdown(results, le, cv_meta, importances, per_sev) -> str:
    L = ["# Supervised fault classifier report (synthetic labels)\n"]
    L.append("> **The labels this model was trained and scored on are simulated.** They "
             "come from the hand-written injection recipes in `ml/synthetic_faults.py`, "
             "not from a faulted conveyor. Every number below measures how well the "
             "classifier recovers those recipes. **It is not a measurement of real fault "
             "detection and must not be presented as one.**\n")
    L.append("Two specific reasons the headline figure is optimistic:\n")
    L.append("1. **The class prior is fictional.** The generation grid made ~50x more "
             "fault windows than unchanged baseline ones. The real deployment class prior is unknown; "
             "precision under that prior has not been measured.\n"
             "2. **Only invented deviation shapes are present.** A real fault matching "
             "none of the six labels still gets assigned one of them.\n")
    L.append("Split: **segment-grouped %d-fold CV**, with training-fold-only feature selection and class weights. Each real baseline window spawns 51 "
             "synthetic rows, so a random split would place near-identical siblings on "
             "both sides and report near-perfect scores from leakage alone. Grouping by "
             "`segment_id` prevents that.\n" % cv_meta["n_splits"])

    L.append("## 1. Cross-validated performance\n")
    L.append("| model | macro F1 (mean +- sd across folds) | fold range |\n|---|---|---|")
    for name, r in results.items():
        f = np.array(r["fold_macro_f1"])
        L.append("| %s | %.3f +- %.3f | %.3f - %.3f |"
                 % (name, f.mean(), f.std(), f.min(), f.max()))
    L.append("")

    best = max(results, key=lambda k: np.mean(results[k]["fold_macro_f1"]))
    L.append("### Per-class detail (%s, pooled over folds)\n" % best)
    rep = classification_report(results[best]["y_true"], results[best]["y_pred"],
                                target_names=le.classes_, output_dict=True, zero_division=0)
    L.append("| class | precision | recall | F1 | support |\n|---|---|---|---|---|")
    for cls in le.classes_:
        d = rep[cls]
        L.append("| %s | %.3f | %.3f | %.3f | %d |"
                 % (cls, d["precision"], d["recall"], d["f1-score"], int(d["support"])))
    L.append("")

    L.append("### Confusion matrix (%s, rows = true)\n" % best)
    cm = confusion_matrix(results[best]["y_true"], results[best]["y_pred"])
    L.append("| | " + " | ".join(le.classes_) + " |")
    L.append("|---|" + "---|" * len(le.classes_))
    for i, cls in enumerate(le.classes_):
        L.append("| **%s** | " % cls + " | ".join(str(int(v)) for v in cm[i]) + " |")
    L.append("")

    L.append("## 2. Recall by injected severity\n")
    L.append("The single most informative table here: a classifier that only works on "
             "severe faults is not an early-warning system.\n")
    L.append("| severity | windows | recall | note |\n|---|---|---|---|")
    for r in per_sev:
        L.append("| %.2f | %d | %.3f | %s |" % (r["severity"], r["n"], r["recall"], r["note"]))
    L.append("")

    L.append("## 3. Feature importance (%s)\n" % best)
    L.append("Which features carry each deviation shape. Useful as a sanity check that the "
             "model keys on the sensor the fault was injected into, and as guidance for "
             "which channels matter when real data is collected.\n")
    L.append("| rank | feature | importance |\n|---|---|---|")
    for i, (f, v) in enumerate(importances[:15], 1):
        L.append("| %d | `%s` | %.4f |" % (i, f, v))
    L.append("")

    L.append("## 4. How to retrain this on real labelled data\n")
    L.append("Nothing in this file assumes the data is synthetic beyond the input path. "
             "Once real labelled runs exist:\n")
    L.append("1. Produce a features table with the same columns plus a `fault_class` "
             "column and a `segment_id` (or better, a `session_id`) grouping column.\n"
             "2. Point `SYNTH_CSV` at it, and change the grouping key to `session_id` -- "
             "with real data the split must be **session**-grouped, not segment-grouped, "
             "because one session shares one belt tension, one mounting and one thermal "
             "state.\n"
             "3. Re-run. The reported metrics then become real and quotable.\n")
    L.append("At that point delete the synthetic caveats from the top of this report -- "
             "and not before.\n")
    return "\n".join(L)


def main():
    C.ensure_dirs()
    started = datetime.now(timezone.utc)
    df, names = load_dataset()
    print("[1/4] %d windows, %d features, %d classes, %d segments"
          % (len(df), len(names), df.fault_class.nunique(), df.segment_id.nunique()))
    print("      class counts: %s" % df.fault_class.value_counts().to_dict())

    print("[2/4] segment-grouped cross-validation ...")
    results, le, weights = grouped_cv(df, names)

    print("[3/4] fitting final models on all data ...")
    names, _ = prune_features(df.loc[df.fault_class == "NORMAL"], names)
    X = df[names].to_numpy(float)
    y = le.transform(df.fault_class.to_numpy())
    counts = pd.Series(y).value_counts()
    w = {int(k): float(len(y) / (len(counts) * v)) for k, v in counts.items()}
    sample_w = np.array([w[i] for i in y])

    finals = build_models(len(le.classes_), w)
    finals["RandomForest"].fit(X, y)
    finals["XGBoost"].fit(X, y, sample_weight=sample_w)
    joblib.dump(finals["RandomForest"], RF_PATH)
    joblib.dump(finals["XGBoost"], XGB_PATH)

    best = max(results, key=lambda k: np.mean(results[k]["fold_macro_f1"]))
    imp = sorted(zip(names, finals[best].feature_importances_),
                 key=lambda t: -t[1])
    per_sev = per_severity_recall(results[best]["y_true"], results[best]["y_pred"],
                                  results[best]["sev"], le)

    hs.save_json({
        "classes": list(le.classes_),
        "feature_order": names,
        "best_model": best,
        "artifacts": {"RandomForest": os.path.basename(RF_PATH),
                      "XGBoost": os.path.basename(XGB_PATH)},
        "trained_on": "SYNTHETIC labels from ml/synthetic_faults.py",
        "warning": ("Labels are simulated. Reported metrics measure recovery of "
                    "hand-written injection recipes, not real fault detection. Do not "
                    "quote them as field accuracy."),
        "split": "segment-grouped 5-fold with fold-local feature selection and class weights (siblings never straddle a split)",
        "class_prior_caveat": ("Generation grid produced ~50x more fault than normal "
                               "windows; the real in-service class distribution is unknown."),
        "training_date_utc": started.isoformat(),
        "environment": {"python": platform.python_version(),
                        "xgboost": __import__("xgboost").__version__,
                        "scikit_learn": __import__("sklearn").__version__},
        "cv_macro_f1": {k: {"mean": float(np.mean(v["fold_macro_f1"])),
                            "std": float(np.std(v["fold_macro_f1"])),
                            "folds": v["fold_macro_f1"]} for k, v in results.items()},
    }, LABELS_PATH)

    print("[4/4] writing report ...")
    with open(REPORT_MD, "w", encoding="utf-8") as fh:
        fh.write(render_markdown(results, le, {"n_splits": len(results[best]["fold_macro_f1"])},
                                 imp, per_sev))
    print("      wrote %s" % os.path.relpath(REPORT_MD, C.ROOT))
    print("      wrote %s" % os.path.relpath(RF_PATH, C.ROOT))
    print("      wrote %s" % os.path.relpath(XGB_PATH, C.ROOT))
    for name, r in results.items():
        f = np.array(r["fold_macro_f1"])
        print("\n%s macro-F1 %.3f +- %.3f (synthetic labels -- not field accuracy)"
              % (name, f.mean(), f.std()))
    return results


if __name__ == "__main__":
    main()
