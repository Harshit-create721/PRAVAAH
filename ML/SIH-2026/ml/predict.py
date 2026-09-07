"""Real-time conveyor condition inference.

Feeds individual sensor observations in as they arrive, maintains a per-sensor rolling
buffer, and emits a scored JSON verdict every 2.5 s after a full 10 s window.
Live payloads require healthy sensor_health and accept the bridge timestamp `ts`
or exported `ts_ms` (both milliseconds). Unknown nodes, missing/non-finite data,
unhealthy frames and discontinuities invalidate the synchronized window.

Feature parity with training is structural, not merely intended: this module calls the
same `feature_engineering.compute_window_features` that built the training table, then
selects `feature_order` straight out of `models/feature_config.json`. `--self-test`
replays the recorded telemetry through the streaming path and asserts the resulting
features match `outputs/features.csv` exactly.

Usage
-----
  python ml/predict.py --demo                 replay N windows from the recorded dataset
  python ml/predict.py --self-test            verify streaming features == training features
  python ml/predict.py --stdin                read JSON observations from stdin, one per line
  python ml/predict.py --window-at 2093       score the window starting at that session second

An observation on stdin is one frame from one node, e.g.

  {"node":"esp32-vibration-01","ts_ms":1788715800284,"vibration_rms":0.0579,
   "sensor_health":{"vibration":"healthy"},"vibration_kurtosis":3.462,"vibration_crest":2.101,"acceleration_x":0.1084,
   "acceleration_y":-1.0501,"acceleration_z":-0.1527,"acceleration_magnitude":1.068}
  {"node":"esp32-thermal-01","ts_ms":1788715800657,"sensor_health":{"mlx":"healthy"},"temperature":31.57,"ambient":27.91}
  {"node":"esp32-marker-01","ts_ms":1788715800665,"sensor_health":{"speed":"healthy"},"hall_rpm":20.59}

`segment_id` is optional; if supplied, a change of value clears the buffers so no window
is ever built across a segment boundary.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import deque

import joblib
import numpy as np
import pandas as pd

import config as C
import feature_engineering as fe
import health_score as hs
from streaming import WindowStream


class ConveyorMonitor:
    """Rolling-window scorer. One instance per conveyor."""

    def __init__(self, models_dir: str = None, include_features=False):
        models_dir = models_dir or C.MODELS_DIR
        import os
        self.model = joblib.load(os.path.join(models_dir, "isolation_forest.joblib"))
        self.scaler = joblib.load(os.path.join(models_dir, "scaler.joblib"))
        self.fcfg = hs.load_json(os.path.join(models_dir, "feature_config.json"))
        self.thresholds = hs.load_json(os.path.join(models_dir, "thresholds.json"))
        self.baseline_stats = hs.load_json(os.path.join(models_dir, "baseline_stats.json"))

        self.feature_order = self.fcfg["feature_order"]
        self.window_ms = int(self.fcfg["window_seconds"] * 1000)
        self.window_s = float(self.fcfg["window_seconds"])
        self.min_frames = int(self.fcfg["min_frames_per_sensor"])
        self.min_coverage = float(self.fcfg["min_time_coverage"])
        self.calib = self.fcfg["score_calibration"]
        self.required_cols = self.fcfg["required_input_columns"]

        # node id -> sensor role, taken from the trained artifact so a renamed node in
        # the field cannot silently be routed to the wrong feature block.
        self.node_to_sensor = dict(self.fcfg["node_to_sensor_role"])

        self.engine = hs.ScoreEngine.load(models_dir)

        self.include_features = include_features
        self.stream = WindowStream(self.node_to_sensor, self.window_ms,
                                   int(round(self.fcfg["step_seconds"] * 1000)),
                                   self.min_frames, self.min_coverage)
        self.pending = deque()

    def reset(self, segment_id=None):
        self.stream.reset(segment_id)
        self.pending.clear()

    def data_status(self, now_ms=None):
        """Live consumers must poll with wall-clock milliseconds during silence."""
        return self.stream.tick(now_ms) if now_ms is not None else self.stream.status()

    def push(self, obs):
        """Return the first completed verdict, or None. drain() returns any others.

        Invalid frames raise ValueError AND invalidate the synchronized buffer.
        They must be rendered as data unavailable, never as a mechanical alarm.
        """
        try:
            windows = self.stream.push(obs)
        except ValueError:
            self.pending.clear()
            raise
        self.pending.extend(self._score_window(w) for w in windows)
        return self.pending.popleft() if self.pending else None

    def drain(self):
        out = list(self.pending)
        self.pending.clear()
        return out

    def finish_segment(self):
        """Flush a finite recording at its last observed timestamp; not a live timer."""
        self.pending.extend(self._score_window(w) for w in self.stream.finish_segment())
        return self.drain()

    def _score_window(self, window):
        parts = window["parts"]
        result = self.score_frames(parts["vibration"], parts["thermal"], parts["speed"])
        result.update({"start_ms": window["start_ms"], "end_ms": window["end_ms"],
                       "segment_id": window["segment_id"],
                       "window_start": pd.Timestamp(window["start_ms"], unit="ms", tz="UTC").isoformat(),
                       "timestamp": pd.Timestamp(window["end_ms"], unit="ms", tz="UTC").isoformat()})
        return result

    def score_frames(self, vib: pd.DataFrame, thermal: pd.DataFrame,
                     speed: pd.DataFrame) -> dict:
        """Score one already-assembled window. Same code path as training."""
        valid, reason = fe.window_is_valid({"vibration": vib, "thermal": thermal, "speed": speed},
                                           self.window_s, self.min_frames, self.min_coverage)
        if not valid:
            raise ValueError(reason)
        feats = fe.compute_window_features(vib, thermal, speed, self.window_s)
        missing = [f for f in self.feature_order if f not in feats]
        if missing:
            raise RuntimeError("feature contract violated, missing: %s" % missing[:5])

        x_raw = np.array([[feats[f] for f in self.feature_order]], dtype=float)
        if not np.all(np.isfinite(x_raw)):
            bad = [self.feature_order[i] for i in np.where(~np.isfinite(x_raw[0]))[0]]
            raise RuntimeError("non-finite feature values: %s" % bad)

        v = self.engine.score(x_raw)
        anomaly = float(v["anomaly_score"][0])
        health = float(v["health_score"][0])
        status = str(v["status"][0])
        driver = str(v["driver"][0])
        per_detector = {k: round(float(s[0]), 1) for k, s in v["per_detector"].items()}
        exp = hs.explain(x_raw[0], self.baseline_stats, status)

        end_ms = int(max(vib[C.TIME_COL].max(), thermal[C.TIME_COL].max(),
                         speed[C.TIME_COL].max()))
        start_ms = int(min(vib[C.TIME_COL].min(), thermal[C.TIME_COL].min(),
                           speed[C.TIME_COL].min()))

        result = {
            "type": "condition",
            "data_quality": "valid",
            "timestamp": pd.Timestamp(end_ms, unit="ms", tz="UTC").isoformat(),
            "window_start": pd.Timestamp(start_ms, unit="ms", tz="UTC").isoformat(),
            "window_seconds": self.window_s,
            "conveyor": "CV-01",
            "temperature": round(feats["temp_mean"], 2),
            "ambient": round(feats["ambient_mean"], 2),
            "temperature_over_ambient": round(feats["temp_over_ambient_mean"], 2),
            "rpm": round(feats["rpm_mean"], 2),
            "vibration_rms": round(feats["vib_rms_mean"], 4),
            "vibration_rms_peak": round(feats["vib_rms_max"], 4),
            "anomaly_score": round(anomaly, 1),
            "health_score": round(health, 1),
            "status": status,
            "driver_sensor": driver,
            "detector_scores": per_detector,
            "indicators": exp["indicators"],
            "explanation": exp["explanation"],
            "top_deviations": exp["top_deviations"],
            "frames_used": {"vibration": int(len(vib)), "thermal": int(len(thermal)),
                            "speed": int(len(speed))},
            "score_meaning": ("anomaly_score is how unusual this window is relative to the "
                              "learned baseline, on 0-100. It is not a probability of "
                              "failure and not a remaining-useful-life estimate."),
        }
        if self.include_features:
            result["features"] = {f: feats[f] for f in self.feature_order}
        return result


# --------------------------------------------------------------------------------------
# Offline helpers
# --------------------------------------------------------------------------------------
def _recorded_windows():
    """Rebuild the recorded windows so demo/self-test can replay real frames."""
    import preprocessing
    pre = preprocessing.preprocess()
    return pre


def _window_parts(pre, start_ms, end_ms, segment_id):
    out = {}
    for role in C.REQUIRED_SENSORS:
        s = pre.streams[role]
        m = ((s[C.SEGMENT_COL].to_numpy() == segment_id)
             & (s[C.TIME_COL].to_numpy() >= start_ms)
             & (s[C.TIME_COL].to_numpy() < end_ms))
        out[role] = s.loc[m].reset_index(drop=True)
    return out


def self_test(verbose: bool = True) -> dict:
    """Replay every real frame, checking actual emitted boundaries/features/scores."""
    mon = ConveyorMonitor(include_features=True)
    expected = pd.read_csv(C.FEATURES_CSV)
    pre = _recorded_windows()
    verdicts = []
    for row in pre.raw.to_dict("records"):
        observation = {k: v for k, v in row.items() if pd.notna(v)}
        verdict = mon.push(observation)
        if verdict is not None:
            verdicts.append(verdict)
        verdicts.extend(mon.drain())
    verdicts.extend(mon.finish_segment())

    key = lambda r: (r["segment_id"], int(r["start_ms"]), int(r["end_ms"]))
    expected_keys = [key(r) for r in expected.to_dict("records")]
    actual_keys = [key(r) for r in verdicts]
    boundaries_match = expected_keys == actual_keys
    max_diff, worst, mismatches = 0.0, None, []
    scored = mon.engine.score(expected[mon.feature_order].to_numpy(float))
    by_key = {key(r): r for r in verdicts}
    for i, row in enumerate(expected.to_dict("records")):
        v = by_key.get(key(row))
        if v is None:
            mismatches.append({"window_id": row["window_id"], "reason": "missing window"})
            continue
        a = np.array([v["features"][f] for f in mon.feature_order])
        b = np.array([row[f] for f in mon.feature_order])
        diff = float(np.max(np.abs(a - b)))
        if diff > max_diff:
            max_diff, worst = diff, mon.feature_order[int(np.argmax(np.abs(a - b)))]
        scores_match = all(v[name] == round(float(scored[name][i]), 1)
                           for name in ("anomaly_score", "health_score"))
        counts_match = all(v["frames_used"][r] == row["n_" + r + "_frames"]
                           for r in C.REQUIRED_SENSORS)
        if diff >= 1e-9 or not scores_match or not counts_match or v["status"] != scored["status"][i]:
            mismatches.append({"window_id": row["window_id"], "reason": "features, scores or frame counts differ"})
    result = {
        "n_windows_checked": len(expected), "n_features": len(mon.feature_order),
        "max_abs_diff": max_diff, "worst_feature": worst,
        "boundaries_match": boundaries_match,
        "ingest_windows_replayed": len(verdicts),
        "ingest_windows_that_failed_to_score": len(set(expected_keys) - set(actual_keys)),
        "mismatches": mismatches,
        "passed": bool(len(expected) > 0 and boundaries_match and not mismatches),
    }
    if verbose:
        print("streaming parity: %d/%d windows, features/scores/boundaries/counts: %s (max diff %.3e)"
              % (len(verdicts), len(expected), "PASS" if result["passed"] else "FAIL", max_diff))
    return result


def demo(n: int = 5, pick: str = "spread"):
    """Score real windows from the recorded dataset and print the JSON verdicts."""
    mon = ConveyorMonitor()
    feats_tbl = pd.read_csv(C.FEATURES_CSV)
    pre = _recorded_windows()

    if pick == "worst" and C.ANOMALY_SCORES_CSV:
        import os
        if os.path.exists(C.ANOMALY_SCORES_CSV):
            sc = pd.read_csv(C.ANOMALY_SCORES_CSV).sort_values("anomaly_score", ascending=False)
            ids = sc.window_id.head(n).tolist()
        else:
            ids = list(range(n))
    elif pick == "spread":
        import os
        if os.path.exists(C.ANOMALY_SCORES_CSV):
            sc = pd.read_csv(C.ANOMALY_SCORES_CSV).sort_values("anomaly_score")
            idx = np.linspace(0, len(sc) - 1, n).astype(int)
            ids = sc.window_id.iloc[idx].tolist()
        else:
            ids = list(range(n))
    else:
        ids = list(range(n))

    for wid in ids:
        row = feats_tbl[feats_tbl.window_id == wid].iloc[0]
        parts = _window_parts(pre, int(row.start_ms), int(row.end_ms), row.segment_id)
        v = mon.score_frames(parts["vibration"], parts["thermal"], parts["speed"])
        v["source_window_id"] = int(wid)
        v["source_segment_id"] = row.segment_id
        print(json.dumps(v, indent=2))
        print()


def window_at(second: float):
    """Score the recorded window whose session-relative start is nearest `second`."""
    mon = ConveyorMonitor()
    feats_tbl = pd.read_csv(C.FEATURES_CSV)
    pre = _recorded_windows()
    i = (feats_tbl.t_rel_start_s - second).abs().idxmin()
    row = feats_tbl.loc[i]
    parts = _window_parts(pre, int(row.start_ms), int(row.end_ms), row.segment_id)
    v = mon.score_frames(parts["vibration"], parts["thermal"], parts["speed"])
    v["source_window_id"] = int(row.window_id)
    v["source_segment_id"] = row.segment_id
    v["session_time_s"] = float(row.t_rel_start_s)
    print(json.dumps(v, indent=2))


def from_stdin():
    """JSONL live input with a silence watchdog; stdout always remains machine readable.

    A reader thread handles portable blocking stdin. The main thread polls once a
    second so unplugged sensors cannot leave a previous condition marked current.
    """
    import queue
    import threading
    import time
    lines = queue.Queue(maxsize=256)
    def read_lines():
        for line in sys.stdin:
            lines.put(line)
        lines.put(None)
    threading.Thread(target=read_lines, daemon=True).start()
    mon = ConveyorMonitor()
    print(json.dumps({"type": "worker_ready"}), flush=True)
    last_quality = None
    while True:
        try:
            line = lines.get(timeout=1)
        except queue.Empty:
            line = ""
        if line is None:
            # EOF is an explicit recording end, bounded by the last observed frame.
            for verdict in mon.finish_segment():
                print(json.dumps(verdict, allow_nan=False), flush=True)
            print(json.dumps({"type": "data_quality", "status": "DATA_UNAVAILABLE",
                              "reason": "input stream closed", "anomaly_score": None,
                              "health_score": None}), flush=True)
            break
        if line.strip():
            try:
                obs = json.loads(line)
                if isinstance(obs, dict) and obs.get("control") == "invalidate":
                    mon.reset()
                    mon.stream.invalidate(str(obs.get("reason", "acquisition interrupted")))
                    print(json.dumps(mon.data_status()), flush=True)
                    continue
                v = mon.push(obs)
            except (ValueError, TypeError) as exc:
                mon.stream.invalidate(str(exc))
                print(json.dumps(mon.data_status()), flush=True)
                continue
            for verdict in ([v] if v is not None else []) + mon.drain():
                print(json.dumps(verdict, allow_nan=False), flush=True)
        quality = mon.data_status(int(time.time() * 1000))
        signature = quality["status"], quality["reason"]
        if signature != last_quality:
            print(json.dumps(quality), flush=True)
            last_quality = signature


def main(argv=None):
    ap = argparse.ArgumentParser(description="Conveyor condition inference.")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--demo", action="store_true", help="score sample windows from the dataset")
    g.add_argument("--self-test", action="store_true", help="verify feature parity with training")
    g.add_argument("--stdin", action="store_true", help="stream JSON observations from stdin")
    g.add_argument("--window-at", type=float, metavar="SECONDS",
                   help="score the recorded window nearest this session second")
    ap.add_argument("-n", type=int, default=5, help="how many windows for --demo")
    ap.add_argument("--pick", choices=["spread", "worst", "first"], default="spread",
                    help="which windows --demo should show")
    args = ap.parse_args(argv)

    if args.self_test:
        r = self_test()
        sys.exit(0 if r["passed"] else 1)
    if args.demo:
        demo(args.n, args.pick)
    elif args.stdin:
        from_stdin()
    elif args.window_at is not None:
        window_at(args.window_at)


if __name__ == "__main__":
    main()
