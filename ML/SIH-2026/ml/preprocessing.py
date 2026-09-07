"""Load the cleaned telemetry CSV and turn it into synchronised per-sensor streams.

Design notes that matter:

* The CSV is a sparse long/wide hybrid: one row = one frame from one ESP32 node, and
  only that node's own measurement columns are populated. A row is therefore NOT an ML
  observation. Sensors are re-associated by node identity and aligned by timestamp.
* segment_id marks discontinuous recording intervals. Nothing in this module (or
  downstream) ever merges, interpolates or windows across a segment boundary.
* Timestamps are preserved exactly as recorded. No resampling, no gap compression.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

import config as C
import data_contract as dc


@dataclass
class SensorStreams:
    """Per-sensor frames plus the segment table they belong to."""

    raw: pd.DataFrame
    streams: dict                      # sensor role -> frames (sorted by time)
    node_to_sensor: dict
    sensor_signals: dict               # sensor role -> usable numeric columns
    segments: pd.DataFrame
    dropped_all_null: list = field(default_factory=list)
    redundant_pairs: list = field(default_factory=list)
    validation: dict = field(default_factory=dict)


META_COLS = {
    "seq", "seq_gap", "seq_reset", "source_csv_row", "t_rel_s",
}


def load_raw(path=None) -> pd.DataFrame:
    path = path or C.resolve_telemetry_path()
    dc.verify_recording(path)
    df = pd.read_csv(path)
    for col in (C.TIME_COL, C.NODE_COL, C.SEGMENT_COL):
        if col not in df.columns:
            raise ValueError("telemetry.csv is missing required column '%s'" % col)
    df[C.TIME_COL] = [dc.integer(v, C.TIME_COL) for v in df[C.TIME_COL]]
    if C.RECV_TIME_COL in df.columns:
        df[C.RECV_TIME_COL] = df[C.RECV_TIME_COL].astype("int64")
    previous = {}
    for row in df.to_dict("records"):
        node, seg = row[C.NODE_COL], row[C.SEGMENT_COL]
        if node not in C.EXPECTED_NODES or pd.isna(seg):
            raise ValueError("recording contains an unknown node or missing segment_id")
        # Sparse CSV columns owned by the other nodes are absent, not zero.
        obs = {k: v for k, v in row.items() if pd.notna(v)}
        dc.validate_measurements(obs, C.EXPECTED_NODES[node])
        ts = row[C.TIME_COL]
        seq = dc.integer(obs["seq"], "seq") if "seq" in obs else None
        key = (seg, node)
        if key in previous:
            last_ts, last_seq = previous[key]
            if ts < last_ts or ts - last_ts > dc.MAX_GAP_MS:
                raise ValueError(f"discontinuous timestamps within segment {seg}: {node}")
            if seq is not None and last_seq is not None and seq != (last_seq + 1) % 2**32:
                raise ValueError(f"discontinuous sequence within segment {seg}: {node}")
        previous[key] = ts, seq
    # Stable ordering: time first, then original file order to break burst ties.
    order = [C.TIME_COL]
    if "source_csv_row" in df.columns:
        order.append("source_csv_row")
    df = df.sort_values(order, kind="mergesort").reset_index(drop=True)
    df["t_rel_s"] = (df[C.TIME_COL] - df[C.TIME_COL].min()) / 1000.0
    return df


def _numeric_signals(df: pd.DataFrame) -> list:
    """Columns that carry an actual numeric measurement somewhere in the file."""
    skip = {C.TIME_COL, C.RECV_TIME_COL, C.NODE_COL, C.SEGMENT_COL} | META_COLS
    out = []
    for col in df.columns:
        if col in skip:
            continue
        s = pd.to_numeric(df[col], errors="coerce")
        if s.notna().sum() > 0:
            out.append(col)
    return out


def detect_sensor_mapping(df: pd.DataFrame):
    """Derive node -> sensor-role and role -> signal-columns from the data itself.

    A node owns a column if that node supplies every non-null value of it. The result is
    cross-checked against config.EXPECTED_NODES but the data always wins.
    """
    live = _numeric_signals(df)
    numeric = {c: pd.to_numeric(df[c], errors="coerce") for c in live}
    node_to_cols = {}
    for node in sorted(df[C.NODE_COL].dropna().unique().tolist()):
        mask = (df[C.NODE_COL] == node).to_numpy()
        owned = []
        for col in live:
            s = numeric[col]
            total = int(s.notna().sum())
            here = int(s[mask].notna().sum())
            if total > 0 and here == total:
                owned.append(col)
        node_to_cols[str(node)] = owned

    node_to_sensor = {}
    for node, cols in node_to_cols.items():
        if node in C.EXPECTED_NODES:
            role = C.EXPECTED_NODES[node]
        else:
            role = "unknown:" + node
            for candidate, signals in C.SENSOR_SIGNALS.items():
                if set(cols) & set(signals):
                    role = candidate
                    break
        node_to_sensor[node] = role

    sensor_signals = {}
    for node, role in node_to_sensor.items():
        sensor_signals.setdefault(role, [])
        for col in node_to_cols[node]:
            if col not in sensor_signals[role]:
                sensor_signals[role].append(col)
    return node_to_sensor, sensor_signals, node_to_cols


def find_redundant_signals(df: pd.DataFrame, signals: list) -> list:
    """Flag columns that are an exact affine function of another column.

    belt_speed = hall_rpm * 0.02 in this recording: the 1.20 m full belt loop / 60,
    not an independent measurement. Keeping both would double-weight one sensor.
    """
    found = []
    dropped = set()
    for i, a in enumerate(signals):
        if a in dropped:
            continue
        for b in signals[i + 1:]:
            if b in dropped:
                continue
            sub = df[[a, b]].apply(pd.to_numeric, errors="coerce").dropna()
            if len(sub) < 30:
                continue
            x = sub[a].to_numpy(float)
            y = sub[b].to_numpy(float)
            if x.std() < C.EPS or y.std() < C.EPS:
                continue
            slope, intercept = np.polyfit(x, y, 1)
            resid = y - (slope * x + intercept)
            rel = float(np.max(np.abs(resid)) / (np.abs(y).mean() + C.EPS))
            if rel < 1e-3:
                found.append({
                    "kept": a,
                    "dropped": b,
                    "relation": "%s = %.6g * %s + %.6g" % (b, slope, a, intercept),
                    "max_relative_residual": rel,
                })
                dropped.add(b)
    return found


def build_segment_table(df: pd.DataFrame, path=None) -> pd.DataFrame:
    """Per-segment boundaries measured from the CSV, cross-checked with segments.json."""
    g = df.groupby(C.SEGMENT_COL)
    seg = pd.DataFrame({
        "segment_id": list(g.size().index),
        "n_rows": g.size().to_numpy(),
        "start_ms": g[C.TIME_COL].min().to_numpy(),
        "end_ms": g[C.TIME_COL].max().to_numpy(),
    })
    seg["duration_s"] = (seg.end_ms - seg.start_ms) / 1000.0
    seg = seg.sort_values("start_ms").reset_index(drop=True)
    seg["order"] = np.arange(len(seg))

    sidecar = C.load_sidecar("segments.json", path)
    if sidecar:
        ref = {s["segment_id"]: s for s in sidecar}
        seg["sidecar_duration_s"] = [
            ref.get(sid, {}).get("duration_seconds", np.nan) for sid in seg.segment_id
        ]
    return seg


def preprocess(path=None) -> SensorStreams:
    raw = load_raw(path)
    live = _numeric_signals(raw)

    structural = {C.TIME_COL, C.RECV_TIME_COL, C.NODE_COL, C.SEGMENT_COL} | META_COLS
    dropped_all_null = [
        c for c in raw.columns
        if c not in structural and raw[c].notna().sum() == 0
    ]

    node_to_sensor, sensor_signals, node_to_cols = detect_sensor_mapping(raw)
    redundant = find_redundant_signals(raw, live)
    drop_names = {r["dropped"] for r in redundant}
    for role in list(sensor_signals):
        sensor_signals[role] = [c for c in sensor_signals[role] if c not in drop_names]

    streams = {}
    for node, role in node_to_sensor.items():
        cols = [C.TIME_COL, C.SEGMENT_COL, "t_rel_s"] + sensor_signals.get(role, [])
        sub = raw.loc[raw[C.NODE_COL] == node, cols].copy()
        for c in sensor_signals.get(role, []):
            sub[c] = pd.to_numeric(sub[c], errors="coerce")
        if role in streams:
            sub = pd.concat([streams[role], sub], ignore_index=True)
        streams[role] = sub.sort_values(C.TIME_COL, kind="mergesort").reset_index(drop=True)

    segments = build_segment_table(raw, path)

    validation = {
        "expected_nodes_present": sorted(set(C.EXPECTED_NODES) & set(node_to_sensor)),
        "unexpected_nodes": sorted(set(node_to_sensor) - set(C.EXPECTED_NODES)),
        "missing_expected_nodes": sorted(set(C.EXPECTED_NODES) - set(node_to_sensor)),
        "required_sensors_present": sorted(set(C.REQUIRED_SENSORS) & set(streams)),
        "missing_required_sensors": sorted(set(C.REQUIRED_SENSORS) - set(streams)),
        "optional_signals_with_data": [c for c in C.OPTIONAL_SIGNALS if c in live],
        "node_owned_columns": node_to_cols,
    }
    if validation["missing_required_sensors"]:
        raise ValueError(
            "Required sensor stream(s) absent from telemetry.csv: %s"
            % validation["missing_required_sensors"]
        )

    return SensorStreams(
        raw=raw,
        streams=streams,
        node_to_sensor=node_to_sensor,
        sensor_signals=sensor_signals,
        segments=segments,
        dropped_all_null=sorted(dropped_all_null),
        redundant_pairs=redundant,
        validation=validation,
    )


if __name__ == "__main__":
    s = preprocess()
    print("nodes ->", json.dumps(s.node_to_sensor, indent=2))
    print("signals ->", json.dumps(s.sensor_signals, indent=2))
    print("dropped all-null ->", s.dropped_all_null)
    print("redundant ->", json.dumps(s.redundant_pairs, indent=2))
    print("segments:", len(s.segments), "raw rows:", len(s.raw))
    for k, v in s.streams.items():
        print("  stream %s: %d frames, cols=%s" % (k, len(v), list(v.columns)))
