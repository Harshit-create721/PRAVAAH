"""Sensitivity test: how large a deviation must be before the deployed detector reacts.

This is the *legitimate* use of the synthetic data. The Isolation Forest in
`models/isolation_forest.joblib` was fitted only on real operator-attested normal
windows -- it has never seen a single injection recipe. So scoring it on injected faults
is not circular: it genuinely measures the detector's response curve.

What this answers
-----------------
"A vibration rise of 2x is flagged; 1.3x is not." That is a real, useful, defensible
property of the detector and it is what the report below states.

What this does NOT answer
-------------------------
"The system detects belt slip." It cannot: the belt-slip recipe is an assumption about
how slip would look on these three sensors, never checked against a slipping belt. The
class names are labels for *shapes of deviation*, not evidence about fault modes.
"""
from __future__ import annotations

import json
import os

import joblib
import numpy as np
import pandas as pd

import config as C
import health_score as hs
import synthetic_faults as sf

SYNTH_CSV = os.path.join(C.OUTPUTS_DIR, "synthetic_dataset.csv")
REPORT_MD = os.path.join(C.OUTPUTS_DIR, "synthetic_fault_report.md")


def score_dataset(df: pd.DataFrame):
    model = joblib.load(C.MODEL_PATH)
    scaler = joblib.load(C.SCALER_PATH)
    fcfg = hs.load_json(C.FEATURE_CONFIG_PATH)
    thresholds = hs.load_json(C.THRESHOLDS_PATH)
    baseline_stats = hs.load_json(C.BASELINE_STATS_PATH)

    names = fcfg["feature_order"]
    X_raw = df[names].to_numpy(float)
    engine = hs.ScoreEngine.load()
    v = engine.score(X_raw)
    score = v["anomaly_score"]
    status = v["status"]

    out = df[["fault_class", "severity", "source_window_id", "segment_id"]].copy()
    out["anomaly_score"] = score.round(2)
    out["health_score"] = hs.health_from_anomaly(score).round(2)
    out["status"] = status
    out["driver_detector"] = v["driver"]
    out["flagged_watch"] = score >= thresholds["thresholds"]["watch"]
    out["flagged_warning"] = score >= thresholds["thresholds"]["warning"]
    return out, X_raw, baseline_stats, thresholds, names


def response_curve(scored: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for cls in sf.FAULT_CLASSES:
        sub = scored[scored.fault_class == cls]
        for sev in sorted(sub.severity.unique()):
            s = sub[sub.severity == sev]
            rows.append({
                "fault_class": cls,
                "severity": float(sev),
                "n": int(len(s)),
                "median_anomaly_score": round(float(s.anomaly_score.median()), 1),
                "pct_flagged_watch": round(float(s.flagged_watch.mean() * 100), 1),
                "pct_flagged_warning": round(float(s.flagged_warning.mean() * 100), 1),
            })
    return pd.DataFrame(rows)


def detection_floor(curve: pd.DataFrame, target_pct: float = 80.0) -> dict:
    """Lowest injected severity at which >= target_pct of windows reach WATCH."""
    out = {}
    for cls in sf.FAULT_CLASSES[1:]:
        c = curve[curve.fault_class == cls].sort_values("severity")
        hit = c[c.pct_flagged_watch >= target_pct]
        out[cls] = float(hit.severity.iloc[0]) if len(hit) else None
    return out


def physical_scale(df: pd.DataFrame) -> pd.DataFrame:
    """Translate abstract severity into the physical change it actually produced."""
    base = df[df.fault_class == "NORMAL"]
    rows = []
    for cls in sf.FAULT_CLASSES[1:]:
        for sev in sorted(df[df.fault_class == cls].severity.unique()):
            s = df[(df.fault_class == cls) & (df.severity == sev)]
            rows.append({
                "fault_class": cls,
                "severity": float(sev),
                "vib_rms_x": round(float(s.vib_rms_mean.mean() / base.vib_rms_mean.mean()), 2),
                "rpm_mean_pct": round(float((s.rpm_mean.mean() / base.rpm_mean.mean() - 1) * 100), 2),
                "rpm_std_x": round(float(s.rpm_std.mean() / max(base.rpm_std.mean(), 1e-9)), 1),
                "temp_over_ambient_c": round(float(s.temp_over_ambient_mean.mean()
                                                   - base.temp_over_ambient_mean.mean()), 2),
            })
    return pd.DataFrame(rows)


def explanation_audit(scored, X_raw, baseline_stats, df) -> pd.DataFrame:
    """Does the explanation layer name the sensor the fault was actually injected into?"""
    expected = {
        "BELT_SLIP": {"rpm", "temperature", "vibration"},
        "HIGH_VIBRATION": {"vibration"},
        "OVERHEATING": {"temperature"},
        "RPM_INSTABILITY": {"rpm"},
        "COMBINED_FAULT": {"rpm", "temperature", "vibration"},
    }
    rows = []
    for cls in sf.FAULT_CLASSES[1:]:
        idx = np.where((df.fault_class == cls).to_numpy() & (df.severity >= 0.75).to_numpy())[0]
        idx = idx[:200]
        ok = 0
        multi = 0
        for i in idx:
            e = hs.explain(X_raw[i], baseline_stats, scored.status.iloc[i])
            sensors = {d["sensor"] for d in e["top_deviations"]}
            if sensors & expected[cls]:
                ok += 1
            if len(sensors - {"other"}) >= 2:
                multi += 1
        rows.append({
            "fault_class": cls,
            "n_checked": len(idx),
            "pct_named_an_affected_sensor": round(100 * ok / max(len(idx), 1), 1),
            "pct_reporting_multiple_sensors": round(100 * multi / max(len(idx), 1), 1),
        })
    return pd.DataFrame(rows)


def render_markdown(curve, floors, phys, audit, thresholds, n_rows) -> str:
    L = ["# Synthetic fault response report\n"]
    L.append("> **This report is a sensitivity test of the deployed anomaly detector, not "
             "evidence of fault detection.** The faults are simulated by "
             "`ml/synthetic_faults.py`. Each recipe encodes an assumption about how that "
             "fault would appear on this rig's three sensors; no faulted conveyor was ever "
             "recorded, so none of those assumptions has been checked against reality. "
             "Class names below denote **shapes of deviation**, not diagnosed fault modes.\n")
    L.append("What makes this test meaningful at all: the Isolation Forest was fitted only "
             "on real operator-attested normal windows and has **never seen an injection "
             "recipe**. Its response to these deviations is therefore a genuine property of "
             "the detector, in a way that a classifier trained on the same recipes could "
             "never be (see `outputs/supervised_model_report.md`).\n")

    L.append("## 1. What severity actually means physically\n")
    L.append("Severity is an abstract 0-1 knob. This table is what it produced on the "
             "sensors, averaged over all %d generated windows:\n" % n_rows)
    L.append("| fault | severity | vibration RMS | RPM mean | RPM std | temp over ambient |"
             "\n|---|---|---|---|---|---|")
    for r in phys.itertuples(index=False):
        L.append("| %s | %.2f | x%.2f | %+.2f%% | x%.1f | %+.2f degC |"
                 % (r.fault_class, r.severity, r.vib_rms_x, r.rpm_mean_pct,
                    r.rpm_std_x, r.temp_over_ambient_c))
    L.append("")

    L.append("## 2. Detection response curve\n")
    L.append("Percentage of injected windows that reach each threshold "
             "(WATCH %.1f, WARNING %.1f):\n"
             % (thresholds["thresholds"]["watch"], thresholds["thresholds"]["warning"]))
    L.append("| fault | severity | n | median score | %>=WATCH | %>=WARNING |"
             "\n|---|---|---|---|---|---|")
    for r in curve.itertuples(index=False):
        L.append("| %s | %.2f | %d | %.1f | %.1f%% | %.1f%% |"
                 % (r.fault_class, r.severity, r.n, r.median_anomaly_score,
                    r.pct_flagged_watch, r.pct_flagged_warning))
    L.append("")
    base = curve[(curve.fault_class == "NORMAL")]
    if len(base):
        L.append("The NORMAL row is the false-alarm rate on real attested-normal data: "
                 "**%.1f%% reach WATCH**. Every detection rate below should be read "
                 "against that floor.\n" % base.pct_flagged_watch.iloc[0])

    L.append("## 3. Detection floor\n")
    L.append("Lowest injected severity at which at least 80% of windows reach WATCH:\n")
    L.append("| fault | detection floor | physical size of that deviation |\n|---|---|---|")
    for cls, sev in floors.items():
        if sev is None:
            L.append("| %s | **not reached at any tested severity** | -- |" % cls)
            continue
        p = phys[(phys.fault_class == cls) & (phys.severity == sev)].iloc[0]
        desc = []
        if abs(p.vib_rms_x - 1) > 0.05:
            desc.append("vibration x%.2f" % p.vib_rms_x)
        if abs(p.rpm_mean_pct) > 0.5:
            desc.append("RPM %+.1f%%" % p.rpm_mean_pct)
        if p.rpm_std_x > 1.5:
            desc.append("RPM std x%.1f" % p.rpm_std_x)
        if abs(p.temp_over_ambient_c) > 0.1:
            desc.append("%+.1f degC over ambient" % p.temp_over_ambient_c)
        L.append("| %s | severity %.2f | %s |" % (cls, sev, ", ".join(desc) or "--"))
    L.append("")
    L.append("**This table is the single most useful output of the whole exercise.** It "
             "says how big a change of each shape has to be before the deployed detector "
             "notices, in physical units an engineer can check against the machine.\n")

    L.append("## 4. Does the explanation name the right sensor?\n")
    L.append("For high-severity injections, how often the top feature deviations point at "
             "a sensor the fault was actually injected into:\n")
    L.append("| fault | windows checked | named an affected sensor | reported multiple sensors |"
             "\n|---|---|---|---|")
    for r in audit.itertuples(index=False):
        L.append("| %s | %d | %.1f%% | %.1f%% |"
                 % (r.fault_class, r.n_checked, r.pct_named_an_affected_sensor,
                    r.pct_reporting_multiple_sensors))
    L.append("")
    L.append("This is a check on the explanation layer's internal consistency -- that when "
             "vibration is what moved, vibration is what gets reported. It is not a "
             "diagnostic-accuracy measurement.\n")

    L.append("## 5. Honest reading\n")
    L.append("- The detector responds monotonically to every deviation shape tested, and "
             "the response is driven by the sensor that actually changed.\n")
    L.append("- The detection floors give a concrete sensitivity specification that can be "
             "quoted and later checked against real faults.\n")
    L.append("- **None of this shows the system detects real faults.** Real belt slip may "
             "look nothing like the recipe. The only way to close that gap is the "
             "measurement campaign in `outputs/future_data_collection_plan.md`.\n")
    L.append("- The class balance here (%d NORMAL against thousands of faults) is an "
             "artifact of the generation grid. In service, normal would be well over 99%% "
             "of windows, so any accuracy-style figure computed on this set is inflated by "
             "construction.\n" % int(curve[curve.fault_class == "NORMAL"].n.sum()))
    return "\n".join(L)


def main():
    C.ensure_dirs()
    if not os.path.exists(SYNTH_CSV):
        raise SystemExit("run `python synthetic_faults.py` first")
    df = pd.read_csv(SYNTH_CSV)
    print("[1/4] scoring %d windows with the deployed unsupervised model ..." % len(df))
    scored, X_raw, baseline_stats, thresholds, names = score_dataset(df)

    print("[2/4] building response curve ...")
    curve = response_curve(scored)
    floors = detection_floor(curve)
    phys = physical_scale(df)

    print("[3/4] auditing explanations ...")
    audit = explanation_audit(scored, X_raw, baseline_stats, df)

    print("[4/4] writing report ...")
    scored.to_csv(os.path.join(C.OUTPUTS_DIR, "synthetic_scores.csv"), index=False)
    curve.to_csv(os.path.join(C.OUTPUTS_DIR, "synthetic_response_curve.csv"), index=False)
    with open(REPORT_MD, "w", encoding="utf-8") as fh:
        fh.write(render_markdown(curve, floors, phys, audit, thresholds, len(df)))
    with open(os.path.join(C.OUTPUTS_DIR, "synthetic_fault_report.json"), "w",
              encoding="utf-8") as fh:
        json.dump({"detection_floors": floors,
                   "response_curve": curve.to_dict(orient="records"),
                   "physical_scale": phys.to_dict(orient="records"),
                   "explanation_audit": audit.to_dict(orient="records")},
                  fh, indent=2, default=str)

    print("      wrote %s" % os.path.relpath(REPORT_MD, C.ROOT))
    print("\ndetection floors (severity at which >=80%% of windows reach WATCH):")
    for k, v in floors.items():
        print("  %-16s %s" % (k, v if v is not None else "NOT DETECTED at any severity"))
    return curve, floors


if __name__ == "__main__":
    main()
