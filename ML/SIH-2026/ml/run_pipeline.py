"""Run the whole pipeline end to end: inspect -> train -> evaluate -> plot -> inference test.

    python ml/run_pipeline.py              full run
    python ml/run_pipeline.py --fast       skip the parameter sweep
"""
from __future__ import annotations

import argparse
import sys
import time

import config as C


STEPS = [
    ("data inspection", "data_inspection"),
    ("training (unsupervised baseline)", "train"),
    ("evaluation + anomaly scoring", "evaluate"),
    ("synthetic fault generation", "synthetic_faults"),
    ("synthetic sensitivity test", "evaluate_synthetic"),
    ("supervised classifier (synthetic labels)", "train_supervised"),
    ("visualisation", "visualize"),
    ("inference self-test", "predict"),
]


def main(argv=None):
    ap = argparse.ArgumentParser(description="Run the full conveyor ML pipeline.")
    ap.add_argument("--fast", action="store_true", help="skip the parameter sweep")
    args = ap.parse_args(argv)

    C.ensure_dirs()
    t_all = time.time()
    failures = []

    for i, (label, module) in enumerate(STEPS, 1):
        print("\n" + "=" * 78)
        print("STEP %d/%d  %s" % (i, len(STEPS), label))
        print("=" * 78)
        t0 = time.time()
        try:
            mod = __import__(module)
            if module == "train":
                mod.main(["--no-sweep"] if args.fast else [])
            elif module == "predict":
                r = mod.self_test()
                if not r["passed"]:
                    raise RuntimeError("feature parity self-test failed: max |diff| = %.3e"
                                       % r["max_abs_diff"])
                print("\nsample inference on the most unusual recorded window:")
                mod.demo(n=1, pick="worst")
            else:
                mod.main()
        except Exception as exc:
            failures.append((label, exc))
            print("  FAILED: %s: %s" % (type(exc).__name__, exc))
            break
        print("  ok (%.1fs)" % (time.time() - t0))

    print("\n" + "=" * 78)
    if failures:
        for label, exc in failures:
            print("PIPELINE FAILED at '%s': %s" % (label, exc))
        return 1

    print("PIPELINE OK in %.1fs" % (time.time() - t_all))
    print("""
artifacts
  models/isolation_forest.joblib   models/sensor_detectors.joblib
  models/scaler.joblib             models/feature_config.json
  models/thresholds.json           models/baseline_stats.json
  models/model_metadata.json
  models/fault_classifier_rf.joblib  models/fault_classifier_xgb.joblib
outputs
  outputs/data_quality_report.md   outputs/evaluation_report.md
  outputs/synthetic_fault_report.md  outputs/supervised_model_report.md
  outputs/features.csv             outputs/anomaly_scores.csv
  outputs/synthetic_dataset.csv    outputs/synthetic_response_curve.csv
  outputs/plots/*.png              outputs/future_data_collection_plan.md
""")
    return 0


if __name__ == "__main__":
    sys.exit(main())
