"""Real-time conveyor condition inference.

Feeds individual sensor observations in as they arrive, maintains a per-sensor rolling
buffer, and emits a scored JSON verdict once a full window is available.

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
   "vibration_kurtosis":3.462,"vibration_crest":2.101,"acceleration_x":0.1084,
   "acceleration_y":-1.0501,"acceleration_z":-0.1527,"acceleration_magnitude":1.068}
  {"node":"esp32-thermal-01","ts_ms":1788715800657,"temperature":31.57,"ambient":27.91}
  {"node":"esp32-marker-01","ts_ms":1788715800665,"hall_rpm":20.59}

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


class ConveyorMonitor:
    """Rolling-window scorer. One instance per conveyor."""

    def __init__(self, models_dir: str = None):
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

        self.buffers = {role: deque() for role in C.REQUIRED_SENSORS}
        self.current_segment = None
        self.last_ts = None

    # ---------------------------------------------------------------- ingest
    def reset(self, segment_id=None) -> None:
        for b in self.buffers.values():
            b.clear()
        self.current_segment = segment_id
        self.last_ts = None

    def sensor_role_for(self, obs: dict):
        node = obs.get("node")
        if node in self.node_to_sensor:
            return self.node_to_sensor[node]
        # Fall back to whichever required column set the payload satisfies.
        for role, cols in self.required_cols.items():
            payload = [c for c in cols if c != "ts_ms"]
            if payload and all(c in obs for c in payload):
                return role
        return None

    def push(self, obs: dict) -> dict:
        """Add one frame. Returns a verdict when a full window is ready, else None."""
        ts = obs.get("ts_ms")
        if ts is None:
            raise ValueError("observation is missing ts_ms: %r" % obs)
        ts = int(ts)

        seg = obs.get("segment_id")
        if seg is not None and seg != self.current_segment:
            # Segment boundary: never build a window across one.
            self.reset(seg)
        elif self.last_ts is not None and ts < self.last_ts - self.window_ms:
            # Clock went backwards by more than a window -- treat as a new run.
            self.reset(seg)
        self.last_ts = ts

        role = self.sensor_role_for(obs)
        if role is None:
            return None

        missing = [c for c in self.required_cols[role] if c != "ts_ms" and c not in obs]
        if missing:
            raise ValueError("frame from role '%s' is missing %s" % (role, missing))

        rec = {C.TIME_COL: ts, C.SEGMENT_COL: seg}
        for c in self.required_cols[role]:
            if c != "ts_ms":
                rec[c] = float(obs[c])
        self.buffers[role].append(rec)

        cutoff = ts - self.window_ms
        for b in self.buffers.values():
            while b and b[0][C.TIME_COL] < cutoff:
                b.popleft()

        return self.evaluate_current_window()

    # ---------------------------------------------------------------- score
    def _frames(self):
        return {role: pd.DataFrame(list(b)) for role, b in self.buffers.items()}

    def window_ready(self) -> bool:
        parts = self._frames()
        for role in C.REQUIRED_SENSORS:
            d = parts[role]
            if len(d) < self.min_frames:
                return False
            t = d[C.TIME_COL].to_numpy()
            if (t.max() - t.min()) / 1000.0 < self.min_coverage * self.window_s:
                return False
        return True

    def evaluate_current_window(self):
        if not self.window_ready():
            return None
        parts = self._frames()
        return self.score_frames(parts["vibration"], parts["thermal"], parts["speed"])

    def score_frames(self, vib: pd.DataFrame, thermal: pd.DataFrame,
                     speed: pd.DataFrame) -> dict:
        """Score one already-assembled window. Same code path as training."""
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

        return {
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
    """Assert the streaming path reproduces the training features exactly."""
    mon = ConveyorMonitor()
    feats_tbl = pd.read_csv(C.FEATURES_CSV)
    pre = _recorded_windows()
    order = mon.feature_order

    max_diff, worst, n = 0.0, None, 0
    for row in feats_tbl.itertuples(index=False):
        parts = _window_parts(pre, int(row.start_ms), int(row.end_ms), row.segment_id)
        live = fe.compute_window_features(parts["vibration"], parts["thermal"],
                                          parts["speed"], mon.window_s)
        a = np.array([live[f] for f in order], dtype=float)
        b = np.array([getattr(row, f) for f in order], dtype=float)
        d = np.max(np.abs(a - b))
        if d > max_diff:
            max_diff, worst = float(d), order[int(np.argmax(np.abs(a - b)))]
        n += 1

    result = {
        "n_windows_checked": n,
        "n_features": len(order),
        "max_abs_diff": max_diff,
        "worst_feature": worst,
        "passed": bool(max_diff < 1e-9),
    }
    if verbose:
        print("feature parity self-test: %d windows x %d features, max |diff| = %.3e (%s)"
              % (n, len(order), max_diff, "PASS" if result["passed"] else "FAIL"))
        if worst and max_diff > 0:
            print("  largest difference in: %s" % worst)

    # Second half: drive the same windows through the real push() ingest path.
    ingest_checked = 0
    ingest_mismatch = 0
    node_of = {v: k for k, v in mon.node_to_sensor.items()}
    for row in feats_tbl.head(25).itertuples(index=False):
        parts = _window_parts(pre, int(row.start_ms), int(row.end_ms), row.segment_id)
        obs_list = []
        for role, d in parts.items():
            for r in d.to_dict(orient="records"):
                o = {"node": node_of[role], "ts_ms": int(r[C.TIME_COL]),
                     "segment_id": row.segment_id}
                for c in mon.required_cols[role]:
                    if c != "ts_ms":
                        o[c] = r[c]
                obs_list.append(o)
        obs_list.sort(key=lambda o: o["ts_ms"])
        mon.reset()
        verdict = None
        for o in obs_list:
            v = mon.push(o)
            if v is not None:
                verdict = v
        ingest_checked += 1
        if verdict is None:
            ingest_mismatch += 1
    result["ingest_windows_replayed"] = ingest_checked
    result["ingest_windows_that_failed_to_score"] = ingest_mismatch
    if verbose:
        print("streaming ingest replay: %d/%d windows produced a verdict"
              % (ingest_checked - ingest_mismatch, ingest_checked))
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
    """Read one JSON observation per line; print a verdict whenever a window closes."""
    mon = ConveyorMonitor()
    emitted = 0
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            obs = json.loads(line)
        except json.JSONDecodeError as exc:
            print(json.dumps({"error": "bad json", "detail": str(exc)}), flush=True)
            continue
        try:
            v = mon.push(obs)
        except ValueError as exc:
            print(json.dumps({"error": "bad observation", "detail": str(exc)}), flush=True)
            continue
        if v is not None:
            emitted += 1
            print(json.dumps(v), flush=True)
    if emitted == 0:
        print(json.dumps({
            "info": "no complete window was formed",
            "needed": "at least %d frames per sensor spanning >= %.1f s of a %.0f s window"
                      % (mon.min_frames, mon.min_coverage * mon.window_s, mon.window_s),
        }), flush=True)


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
