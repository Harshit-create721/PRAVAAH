"""Shared recording/live input checks. Invalid measurements never become zero."""
from __future__ import annotations

import hashlib
import json
import math
from numbers import Real
from pathlib import Path

import config as C

HEALTH_KEYS = {"vibration": "vibration", "thermal": "mlx", "speed": "speed"}
REQUIRED = {role: [c for c in cols if c != "belt_speed"]
            for role, cols in C.SENSOR_SIGNALS.items()}
# Match the gateway's sensor channel ranges (server/schema.js), not the narrow
# observed baseline range. A valid excursion must still reach the anomaly model.
BOUNDS = {
    "vibration_rms": (0, 16), "vibration_kurtosis": (0, 100),
    "vibration_crest": (0, 100), "acceleration_x": (-8, 8),
    "acceleration_y": (-8, 8), "acceleration_z": (-8, 8),
    "acceleration_magnitude": (0, 14), "temperature": (-40, 380),
    "ambient": (-40, 125), "hall_rpm": (0, 6000), "belt_speed": (0, 12),
}
MAX_GAP_MS = 5000


def number(value, name):
    if isinstance(value, bool) or not isinstance(value, Real) or not math.isfinite(value):
        raise ValueError(f"{name} must be a finite number")
    return float(value)


def integer(value, name):
    v = number(value, name)
    if v < 0 or v != int(v):
        raise ValueError(f"{name} must be a nonnegative integer")
    return int(v)


def json_field(value, name, expected):
    if isinstance(value, str):  # CSV exports store health/quality objects as JSON.
        try:
            value = json.loads(value)
        except (ValueError, TypeError) as exc:
            raise ValueError(f"invalid {name}") from exc
    if not isinstance(value, expected):
        raise ValueError(f"invalid {name}")
    return value


def validate_measurements(obs, role, require_health=True):
    if require_health or "sensor_health" in obs:
        health = json_field(obs.get("sensor_health"), "sensor_health", dict)
        if health.get(HEALTH_KEYS[role]) != "healthy":
            raise ValueError(f"sensor_health:{role}:{health.get(HEALTH_KEYS[role], 'missing')}")
    if "quality_issues" in obs:
        if json_field(obs["quality_issues"], "quality_issues", list):
            raise ValueError("quality_issues reported by gateway")
    values = {}
    for col in REQUIRED[role]:
        value = number(obs.get(col), col)
        lo, hi = BOUNDS[col]
        if not lo <= value <= hi:
            raise ValueError(f"{col} outside range {lo}..{hi}")
        values[col] = value
    for col in set(BOUNDS) & set(obs) - set(values):
        value = number(obs[col], col)
        if not BOUNDS[col][0] <= value <= BOUNDS[col][1]:
            raise ValueError(f"{col} outside channel range")
    if "diagnostics" in obs:
        diag = json_field(obs["diagnostics"], "diagnostics", dict)
        if role == "vibration" and "samples" in diag and integer(diag["samples"], "samples") < 2:
            raise ValueError("vibration frame has insufficient acquired samples")
    return values


def normalize_observation(obs, node_to_sensor):
    """Accept a gateway payload or recorder envelope; ts and ts_ms are milliseconds.

    Do not invent an acquisition clock or stamp missing timestamps with wall time.
    Unknown nodes cannot silently replace one of the three trained sensor roles.
    """
    if not isinstance(obs, dict):
        raise ValueError("observation must be an object")
    if "envelope" in obs:
        obs = obs["envelope"]
    if not isinstance(obs, dict):
        raise ValueError("invalid envelope")
    if "payload" in obs:
        obs = obs["payload"]
    if not isinstance(obs, dict):
        raise ValueError("invalid payload")
    node = obs.get("node")
    if not isinstance(node, str) or node not in node_to_sensor:
        raise ValueError("unknown sensor node")
    role = node_to_sensor[node]
    ts = integer(obs.get("ts_ms", obs.get("ts")), "ts_ms/ts")
    if "ts_ms" in obs and "ts" in obs and ts != integer(obs["ts"], "ts"):
        raise ValueError("conflicting ts and ts_ms")
    seg = obs.get("segment_id")
    if seg is not None and not isinstance(seg, (str, int)):
        raise ValueError("segment_id must be a string or integer")
    rec = {C.TIME_COL: ts, C.SEGMENT_COL: seg, **validate_measurements(obs, role)}
    seq = integer(obs["seq"], "seq") if "seq" in obs else None
    return role, rec, seq


def verify_recording(csv_path):
    """Verify the immutable recording bundle before any training or inspection."""
    root = Path(csv_path).resolve().parent
    sums = root / "SHA256SUMS"
    if not sums.is_file():
        raise ValueError(f"recording integrity manifest missing: {sums}")
    verified = {}
    for line in sums.read_text().splitlines():
        fields = line.split(maxsplit=1)
        if len(fields) != 2:
            raise ValueError("malformed SHA256SUMS entry")
        expected, name = fields
        path = (root / name).resolve()
        if path.parent != root or name in verified or len(expected) != 64:
            raise ValueError("invalid or duplicate SHA256SUMS path/hash")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != expected:
            raise ValueError(f"recording checksum mismatch: {name}")
        verified[name] = digest
    if Path(csv_path).name not in verified:
        raise ValueError("telemetry CSV is not covered by SHA256SUMS")
    return verified
