"""Half-open, watermarked windows shared with the offline feature contract."""
from collections import deque

import pandas as pd

import config as C
import data_contract as dc
import feature_engineering as fe


class WindowStream:
    """One synchronized stream per conveyor. No filling across invalid intervals.

    push() returns all completed windows, including any closed by a segment boundary.
    finish_segment() is only for an explicitly ended recording interval, never a timer.
    tick() must be called by a live consumer even while no telemetry arrives.
    """
    def __init__(self, node_to_sensor, window_ms, step_ms, min_frames, min_coverage):
        if window_ms <= 0 or step_ms <= 0:
            raise ValueError("window and step must be positive")
        self.nodes = node_to_sensor
        self.window_ms, self.step_ms = window_ms, step_ms
        self.min_frames, self.min_coverage = min_frames, min_coverage
        self.reset()

    def reset(self, segment_id=None, reason="waiting for a full synchronized window"):
        self.buffers = {role: deque() for role in C.REQUIRED_SENSORS}
        self.latest, self.sequences = {}, {}
        self.current_segment = segment_id
        self.start_ms = self.max_ts = None
        self.last_window_end = None
        self.idle_since_ms = None
        self.state = "WARMING_UP"
        self.reason = reason

    def invalidate(self, reason, segment_id=None):
        self.reset(segment_id, reason)
        self.state = "DATA_UNAVAILABLE"

    def status(self):
        return {"type": "data_quality", "status": self.state, "reason": self.reason,
                "anomaly_score": None, "health_score": None,
                "latest_sensor_ts_ms": dict(self.latest),
                "last_window_end_ms": self.last_window_end}

    def tick(self, now_ms):
        now = dc.integer(now_ms, "now_ms")
        if self.max_ts is None and self.state == "WARMING_UP":
            if self.idle_since_ms is None:
                self.idle_since_ms = now
            elif now - self.idle_since_ms > dc.MAX_GAP_MS:
                self.invalidate("No current readings from the three sensors", self.current_segment)
        if self.max_ts is not None:
            stale = [r for r in C.REQUIRED_SENSORS
                     if now - self.latest.get(r, self.start_ms) > dc.MAX_GAP_MS]
            if stale:
                self.invalidate("stale sensors: " + ", ".join(stale), self.current_segment)
        return self.status()

    def push(self, observation):
        try:
            role, rec, seq = dc.normalize_observation(observation, self.nodes)
        except ValueError as exc:
            self.invalidate(str(exc), self.current_segment)
            raise
        ts, seg = rec[C.TIME_COL], rec[C.SEGMENT_COL]
        windows = []
        if seg != self.current_segment:
            windows = self.finish_segment()
            self.reset(seg)

        previous_ts, previous_seq = self.latest.get(role), self.sequences.get(role)
        if seq is not None and previous_seq is not None and seq == previous_seq:
            # An MQTT/transport duplicate must not count as another acquired frame.
            self.tick(max(ts, self.max_ts))
            return windows
        reason = None
        if previous_ts is not None and ts < previous_ts:
            reason = "timestamp reversed:" + role
        elif previous_ts is not None and ts - previous_ts > dc.MAX_GAP_MS:
            reason = "sensor gap:" + role
        elif seq is not None and previous_seq is not None and seq != (previous_seq + 1) % (2**32):
            reason = "sequence discontinuity:" + role
        elif self.max_ts is not None:
            stale = [r for r, at in self.latest.items()
                     if r != role and ts - at > dc.MAX_GAP_MS]
            if stale:
                reason = "stale sensors: " + ", ".join(stale)
        if reason:
            self.invalidate(reason, seg)
        if self.start_ms is None:
            self.start_ms = ts
        # Arrival timestamps are ordered by the bridge. Refuse delayed frames that
        # would otherwise alter an already anchored/emitted window.
        if ts < self.start_ms:
            self.invalidate("late frame before current window", seg)
            raise ValueError(self.reason)
        self.latest[role] = ts
        self.sequences[role] = seq
        self.max_ts = ts if self.max_ts is None else max(ts, self.max_ts)
        self.buffers[role].append(rec)
        if len(self.latest) == len(C.REQUIRED_SENSORS):
            windows.extend(self._close_until(min(self.latest.values())))
        return windows

    def _close_until(self, watermark):
        windows = []
        while self.start_ms is not None and self.start_ms + self.window_ms <= watermark:
            start, end = self.start_ms, self.start_ms + self.window_ms
            parts = {role: pd.DataFrame([r for r in b if start <= r[C.TIME_COL] < end])
                     for role, b in self.buffers.items()}
            valid, reason = fe.window_is_valid(parts, self.window_ms / 1000,
                                             self.min_frames, self.min_coverage)
            if valid:
                windows.append({"parts": parts, "start_ms": start, "end_ms": end,
                                "segment_id": self.current_segment})
                self.last_window_end = end
                self.state, self.reason = "READY", "complete synchronized window"
            else:
                self.state, self.reason = "DATA_UNAVAILABLE", reason
            self.start_ms += self.step_ms
            for b in self.buffers.values():
                while b and b[0][C.TIME_COL] < self.start_ms:
                    b.popleft()
        return windows

    def finish_segment(self):
        # Offline enumeration uses end_ms + 1, where end_ms is the last observed
        # timestamp. Never extend this bound to an unobserved future timestamp.
        windows = self._close_until(self.max_ts + 1) if self.max_ts is not None else []
        self.reset()
        return windows
