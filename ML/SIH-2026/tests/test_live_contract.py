"""Regression cases for the live-data failures found in the September review."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ml"))
import config as C
import data_contract as dc
import feature_engineering as fe
from streaming import WindowStream
from train import fit_fold_preprocessor


def observation(role, ts, seq=None):
    values = {
        "vibration": dict(vibration_rms=0.06, vibration_crest=2., vibration_kurtosis=3.,
                          acceleration_x=.1, acceleration_y=-1., acceleration_z=-.15,
                          acceleration_magnitude=1.02),
        "thermal": dict(temperature=35., ambient=30.), "speed": dict(hall_rpm=20.5),
    }
    node = next(k for k, v in C.EXPECTED_NODES.items() if v == role)
    out = dict(node=node, ts=ts, sensor_health={dc.HEALTH_KEYS[role]: "healthy"}, **values[role])
    if seq is not None:
        out["seq"] = seq
    return out


class LiveContractTests(unittest.TestCase):
    def setUp(self):
        self.stream = WindowStream(C.EXPECTED_NODES, 10000, 2500, 8, .6)

    def feed(self, times, stream=None):
        out = []
        stream = stream or self.stream
        for ts in times:
            for role in C.REQUIRED_SENSORS:
                out.extend(stream.push(observation(role, ts)))
        return out

    def test_full_duration_cadence_and_half_open_boundaries(self):
        self.assertEqual(self.feed(range(0, 6500, 500)), [])
        windows = self.feed(range(6500, 15001, 500))
        self.assertEqual([(w["start_ms"], w["end_ms"]) for w in windows],
                         [(0, 10000), (2500, 12500), (5000, 15000)])
        for w in windows:
            for frames in w["parts"].values():
                self.assertEqual(len(frames), 20)
                self.assertLess(frames.ts_ms.max(), w["end_ms"])

    def test_waits_for_all_sensor_watermarks(self):
        self.feed(range(0, 10000, 500))
        for role in ("vibration", "thermal"):
            self.assertEqual(self.stream.push(observation(role, 10000)), [])
        self.assertEqual(len(self.stream.push(observation("speed", 10000))), 1)

    def test_forward_gap_without_segment_never_scores_old_frames(self):
        self.assertEqual(self.feed([0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 9500]), [])
        self.assertEqual(self.stream.start_ms, 9500)
        windows = self.feed(range(10000, 19501, 500))
        self.assertEqual([w["start_ms"] for w in windows], [9500])

    def test_one_missing_node_clears_the_synchronized_window(self):
        self.feed(range(0, 4000, 500))
        for ts in range(4000, 10001, 500):
            for role in ("vibration", "thermal"):
                self.assertEqual(self.stream.push(observation(role, ts)), [])
        self.assertNotIn("speed", self.stream.latest)

    def test_silence_watchdog_invalidates_last_condition(self):
        self.feed(range(0, 10001, 500))
        self.assertEqual(self.stream.status()["status"], "READY")
        quality = self.stream.tick(15001)
        self.assertEqual(quality["status"], "DATA_UNAVAILABLE")
        self.assertIsNone(quality["anomaly_score"])
        self.assertFalse(any(self.stream.buffers.values()))

    def test_no_sensors_at_startup_does_not_warm_up_forever(self):
        self.stream.tick(0)
        quality = self.stream.tick(5001)
        self.assertEqual(quality["status"], "DATA_UNAVAILABLE")
        self.assertIsNone(quality["anomaly_score"])

    def test_invalid_frames_clear_buffers_instead_of_scoring(self):
        cases = []
        for value in (None, float("nan"), float("inf"), -float("inf"), "0.06", True, 17.):
            o = observation("vibration", 5000)
            o["vibration_rms"] = value
            cases.append(o)
        for state in ("fault", "stale", "clipped", "missing"):
            o = observation("speed", 5000)
            o["sensor_health"]["speed"] = state
            o["hall_rpm"] = 0
            cases.append(o)
        o = observation("vibration", 5000)
        o["diagnostics"] = {"samples": 0}
        cases.append(o)
        o = observation("thermal", 5000)
        del o["sensor_health"]
        cases.append(o)
        cases.extend([None, [], {"node": []}, {"node": "unknown"}])
        for o in cases:
            with self.subTest(observation=o):
                self.stream.reset()
                self.feed(range(0, 5000, 500))
                with self.assertRaises(ValueError):
                    self.stream.push(o)
                self.assertEqual(self.stream.state, "DATA_UNAVAILABLE")
                self.assertFalse(any(self.stream.buffers.values()))

    def test_finite_zero_is_not_a_missing_value(self):
        o = observation("thermal", 0)
        o["temperature"] = 0
        _, rec, _ = dc.normalize_observation(o, C.EXPECTED_NODES)
        self.assertEqual(rec["temperature"], 0)

    def test_gateway_payload_export_and_recorder_envelope(self):
        o = observation("speed", 1788715800664, 1)
        reference = dc.normalize_observation(o, C.EXPECTED_NODES)
        self.assertEqual(dc.normalize_observation({"payload": o, "received_at_ms": o["ts"] + 1}, C.EXPECTED_NODES), reference)
        o["ts_ms"] = o.pop("ts")
        self.assertEqual(dc.normalize_observation(o, C.EXPECTED_NODES), reference)
        o["ts"] = o["ts_ms"] + 1
        with self.assertRaises(ValueError):
            dc.normalize_observation(o, C.EXPECTED_NODES)

    def test_duplicate_sequence_ignored_but_timestamp_bursts_preserved(self):
        o = observation("speed", 0, 10)
        self.stream.push(o)
        self.stream.push(o)
        self.assertEqual(len(self.stream.buffers["speed"]), 1)
        self.stream.push(observation("speed", 0, 11))
        self.assertEqual(len(self.stream.buffers["speed"]), 2)

    def test_sequence_gap_reset_and_small_clock_reversal(self):
        for next_seq, next_ts in ((12, 500), (1, 500), (11, 499)):
            with self.subTest(seq=next_seq, ts=next_ts):
                self.stream.reset()
                self.stream.push(observation("speed", 500, 10))
                self.stream.push(observation("speed", next_ts, next_seq))
                self.assertEqual(len(self.stream.buffers["speed"]), 1)
                self.assertEqual(self.stream.state, "DATA_UNAVAILABLE")

    def test_segment_boundary_and_flush_never_extend_into_unobserved_time(self):
        self.feed(range(0, 6500, 500))
        self.assertEqual(self.stream.finish_segment(), [])
        o = observation("speed", 20000)
        o["segment_id"] = "new"
        self.assertEqual(self.stream.push(o), [])
        self.assertEqual(self.stream.start_ms, 20000)

    def test_degenerate_signals_are_not_zero_filled(self):
        for helper in (fe.basic_stats, fe.compact_stats):
            for values in ([], [np.nan], [1, np.inf]):
                with self.assertRaises(ValueError):
                    helper("test", np.array(values))

    def test_self_test_fails_when_push_never_emits(self):
        import predict
        with patch.object(predict.ConveyorMonitor, "push", return_value=None):
            result = predict.self_test(verbose=False)
        self.assertFalse(result["passed"])
        self.assertEqual(result["ingest_windows_that_failed_to_score"], result["n_windows_checked"])


class TrainingContractTests(unittest.TestCase):
    def test_fold_selection_ignores_heldout_only_variation(self):
        train = pd.DataFrame({"a": [0., 1., 2., 3.], "heldout_only": [0.] * 4})
        heldout = pd.DataFrame({"a": [100., 200.], "heldout_only": [1., 1000.]})
        x_train, x_test, names = fit_fold_preprocessor(train, heldout, list(train))
        self.assertEqual(names, ["a"])
        self.assertAlmostEqual(float(np.median(x_train)), 0)
        self.assertGreater(x_test.min(), 10)

    def test_checksum_failure_stops_import(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "telemetry.csv"
            path.write_bytes(b"real reading\r\n")
            (Path(tmp) / "SHA256SUMS").write_text(hashlib.sha256(path.read_bytes()).hexdigest() + "  telemetry.csv\n")
            dc.verify_recording(path)
            path.write_bytes(b"real reading\n")
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                dc.verify_recording(path)

    def test_explicit_missing_dataset_does_not_fall_back(self):
        with patch.dict("os.environ", {"CONVEYOR_TELEMETRY_CSV": "/missing/telemetry.csv"}):
            with self.assertRaises(FileNotFoundError):
                C.resolve_telemetry_path()


if __name__ == "__main__":
    unittest.main()
