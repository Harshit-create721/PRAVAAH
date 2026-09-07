"""Central configuration and path resolution for the conveyor condition-monitoring pipeline.

Every stage (inspection -> features -> training -> evaluation -> inference) imports
from here so that paths, window geometry and column semantics cannot drift apart.
"""
from __future__ import annotations

import glob
import json
import os

# --------------------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------------------
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
MODELS_DIR = os.path.join(ROOT, "models")
OUTPUTS_DIR = os.path.join(ROOT, "outputs")
PLOTS_DIR = os.path.join(OUTPUTS_DIR, "plots")

MODEL_PATH = os.path.join(MODELS_DIR, "isolation_forest.joblib")
SCALER_PATH = os.path.join(MODELS_DIR, "scaler.joblib")
FEATURE_CONFIG_PATH = os.path.join(MODELS_DIR, "feature_config.json")
MODEL_METADATA_PATH = os.path.join(MODELS_DIR, "model_metadata.json")
BASELINE_STATS_PATH = os.path.join(MODELS_DIR, "baseline_stats.json")
THRESHOLDS_PATH = os.path.join(MODELS_DIR, "thresholds.json")

FEATURES_CSV = os.path.join(OUTPUTS_DIR, "features.csv")
ANOMALY_SCORES_CSV = os.path.join(OUTPUTS_DIR, "anomaly_scores.csv")
DATA_QUALITY_MD = os.path.join(OUTPUTS_DIR, "data_quality_report.md")
DATA_QUALITY_JSON = os.path.join(OUTPUTS_DIR, "data_quality_report.json")
EVALUATION_MD = os.path.join(OUTPUTS_DIR, "evaluation_report.md")


def ensure_dirs() -> None:
    for d in (MODELS_DIR, OUTPUTS_DIR, PLOTS_DIR):
        os.makedirs(d, exist_ok=True)


def resolve_telemetry_path() -> str:
    """Locate the cleaned telemetry CSV.

    Preference order:
      1. $CONVEYOR_TELEMETRY_CSV
      2. data/telemetry.csv                        (the documented convenience path)
      3. data/<cleaned recording dir>/telemetry.csv (the actual shipped layout)
    """
    env = os.environ.get("CONVEYOR_TELEMETRY_CSV")
    if env:
        if not os.path.isfile(env):
            raise FileNotFoundError("CONVEYOR_TELEMETRY_CSV does not exist: " + env)
        return os.path.abspath(env)

    direct = os.path.join(DATA_DIR, "telemetry.csv")
    if os.path.exists(direct):
        return direct

    candidates = sorted(glob.glob(os.path.join(DATA_DIR, "*", "telemetry.csv")))
    if not candidates:
        raise FileNotFoundError(
            "No telemetry.csv found. Looked at data/telemetry.csv and data/*/telemetry.csv. "
            "Set CONVEYOR_TELEMETRY_CSV to point at the file."
        )
    # Newest recording directory wins.
    return candidates[-1]


def recording_dir() -> str:
    return os.path.dirname(resolve_telemetry_path())


def load_sidecar(name: str, csv_path=None):
    """Load a sidecar JSON that ships with the cleaned recording (manifest/segments)."""
    p = os.path.join(os.path.dirname(csv_path) if csv_path else recording_dir(), name)
    if not os.path.exists(p):
        return None
    with open(p, "r", encoding="utf-8") as fh:
        return json.load(fh)


# --------------------------------------------------------------------------------------
# Schema semantics
#
# These are *expectations used for validation*, not assumptions used for computation.
# preprocessing.py verifies each one against the actual file and reports mismatches;
# the sensor->column mapping that the pipeline actually uses is derived from the data.
# --------------------------------------------------------------------------------------
TIME_COL = "ts_ms"            # laptop USB-bridge arrival time, not an acquisition clock
RECV_TIME_COL = "received_at_ms"
NODE_COL = "node"
SEGMENT_COL = "segment_id"

EXPECTED_NODES = {
    "esp32-vibration-01": "vibration",
    "esp32-thermal-01": "thermal",
    "esp32-marker-01": "speed",
}

# Signals grouped by the physical sensor that produces them.
SENSOR_SIGNALS = {
    "vibration": [
        "vibration_rms",
        "vibration_kurtosis",
        "vibration_crest",
        "acceleration_x",
        "acceleration_y",
        "acceleration_z",
        "acceleration_magnitude",
    ],
    "thermal": ["temperature", "ambient"],
    "speed": ["hall_rpm", "belt_speed"],
}

# Columns that exist in the schema but are optional payloads of a richer rig.
# They are used only if the actual file contains non-null values.
OPTIONAL_SIGNALS = [
    "motor_current_rms",
    "motor_power",
    "motor_rpm",
    "slip_ratio",
    "temperature_delta",
    "belt_offset_left",
    "belt_offset_right",
    "acoustic_rms",
    "load_cell_kg",
]

# --------------------------------------------------------------------------------------
# Window geometry
#
# Justified in outputs/data_quality_report.md from the measured sampling behaviour:
#   * nominal 2 Hz per node, delivered in ~2 s USB bursts
#   * median segment duration 8.46 s, only 37/78 segments reach 10 s
#   * Hall RPM updates only every ~3 s (values are held between updates)
# --------------------------------------------------------------------------------------
WINDOW_SECONDS = 10.0
STEP_SECONDS = 2.5

# A window is only emitted if every required sensor has at least this many raw frames.
MIN_FRAMES_PER_SENSOR = 8
# ...and covers at least this fraction of the nominal window span.
MIN_TIME_COVERAGE = 0.6

REQUIRED_SENSORS = ["vibration", "thermal", "speed"]

# --------------------------------------------------------------------------------------
# Model
# --------------------------------------------------------------------------------------
RANDOM_STATE = 42
IF_PARAMS = {
    "n_estimators": 300,
    "max_samples": "auto",
    "contamination": "auto",
    "random_state": RANDOM_STATE,
    "n_jobs": -1,
    "bootstrap": False,
}

# Chronological drift diagnostic: fraction of segments (ordered by start time) used as
# the "earlier" baseline. NOT a generalisation test -- see outputs/evaluation_report.md.
DRIFT_SPLIT_FRACTION = 0.70

# Feature pruning applied on the baseline set only.
NEAR_ZERO_VARIANCE_STD = 1e-10
REDUNDANT_CORRELATION = 0.995

EPS = 1e-12
