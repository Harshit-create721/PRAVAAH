# Cleaned conveyor recording

Source session: `2026-09-06T17-29-57.647Z-a70e3e55`. The original recording is unchanged.

Retained **6,527 telemetry rows** across **78 segments**, covering **1092.053 seconds** of accepted intervals. These are separate sensor rows and discontinuous intervals, not independent ML examples or one continuous run.

The final 300 seconds are excluded, starting at 2026-09-06T18:10:40.216000+00:00. USB gaps longer than 5 seconds are excluded across all three streams, with 2-second guards around reconnect boundaries. Intervals with unhealthy, missing, or out-of-range measurements are also excluded. Healthy numeric zeros are not removed just because they are zero.

`telemetry.csv` is the cleaned dataset. Original columns and values are preserved; `segment_id` and `source_csv_row` provide boundaries and traceability. `telemetry.frames.jsonl` preserves matching original telemetry envelopes and diagnostics. `segments.json` records retained interval boundaries. `excluded-intervals.json` and `excluded-rows.csv` explain the exclusions. `manifest.json` contains source hashes and rules.

Do not interpolate across removed intervals, compress the timestamps, join ML windows across segments, or distribute segments from this same run across training and evaluation splits. This remains unlabelled data; these acquisition checks do not certify normal mechanical condition, remove every possible Hall artifact, or establish enough data for fault prediction.
