#!/usr/bin/env python3
"""Create a traceable telemetry subset; never edit the original acquisition."""
import argparse
import bisect
import collections
import csv
import datetime
import hashlib
import json
import math
from pathlib import Path

EXPECTED = {
    'esp32-vibration-01': ('vibration', ['vibration_rms', 'acceleration_x',
        'acceleration_y', 'acceleration_z', 'acceleration_magnitude']),
    'esp32-thermal-01': ('mlx', ['temperature', 'ambient']),
    'esp32-marker-01': ('speed', ['hall_rpm', 'belt_speed']),
}


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def hash_file(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def iso(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).isoformat()


def merge_intervals(intervals, start, end):
    merged = []
    for item in sorted(intervals, key=lambda x: (x['start_ms'], x['end_ms'])):
        a, b = max(start, item['start_ms']), min(end, item['end_ms'])
        if a >= b:
            continue
        if merged and a <= merged[-1]['end_ms']:
            merged[-1]['end_ms'] = max(b, merged[-1]['end_ms'])
            merged[-1]['reasons'] = sorted(set(merged[-1]['reasons']) | {item['reason']})
        else:
            merged.append({'start_ms': a, 'end_ms': b, 'reasons': [item['reason']]})
    return merged


def clean(source, output, trim_seconds=300, disconnect_seconds=5, guard_seconds=2):
    source, output = source.resolve(), output.resolve()
    if output.exists():
        raise ValueError('Output must be a new directory; originals and previous exports are never overwritten')
    metadata = json.loads((source / 'session.json').read_text())
    summary = json.loads((source / 'summary.json').read_text())
    start, end = metadata['started_at_ms'], summary['ended_at_ms']
    cutoff = end - round(trim_seconds * 1000)
    if not start < cutoff <= end or disconnect_seconds <= 0 or guard_seconds < 0:
        raise ValueError('Invalid trim/detection/guard durations')
    input_names = ['session.json', 'summary.json', 'frames.jsonl', 'telemetry.csv']
    before_hashes = {name: hash_file(source / name) for name in input_names}
    frames, by_node = [], collections.defaultdict(list)
    for source_line, line in enumerate((source / 'frames.jsonl').read_text().splitlines(), 1):
        envelope = json.loads(line)
        if not envelope['topic'].endswith('/telemetry'):
            continue
        node = envelope['payload']['node']
        if node not in EXPECTED:
            raise ValueError(f'Unexpected telemetry node: {node}')
        frame = {'envelope': envelope, 'source_line': source_line, 'raw_line': line}
        frames.append(frame)
        by_node[node].append(frame)
    if set(by_node) != set(EXPECTED):
        raise ValueError('All three expected sensor streams are required')
    with (source / 'telemetry.csv').open(newline='') as stream:
        reader = csv.DictReader(stream)
        fields = reader.fieldnames
        rows = list(reader)
    if len(rows) != len(frames) or len(rows) != summary['counts']['telemetry']:
        raise ValueError('Source CSV, raw telemetry and summary counts disagree')
    for row, frame in zip(rows, frames):
        e = frame['envelope']
        if (int(row['received_at_ms']), row['node'], row['seq']) != (
            e['received_at_ms'], e['payload']['node'], str(e['payload']['seq'])):
            raise ValueError('CSV/raw telemetry order or identity mismatch')

    events = []
    def exclude(a, b, reason, **details):
        events.append({'start_ms': a, 'end_ms': b, 'reason': reason, **details})
    exclude(cutoff, end, 'operator_requested_final_five_minutes',
        basis='User reported unplugging in the final 4–5 minutes; use the full 5-minute boundary')
    guard_ms = round(guard_seconds * 1000)
    first_complete = max(v[0]['envelope']['received_at_ms'] for v in by_node.values())
    exclude(start, first_complete + guard_ms, 'startup_before_all_three_streams')
    invalid_counts = collections.Counter()
    schema = metadata['telemetry_channels']
    for node, stream in by_node.items():
        health_key, required = EXPECTED[node]
        for index, frame in enumerate(stream):
            e = frame['envelope']; p = e['payload']; at = e['received_at_ms']
            nxt = stream[index + 1]['envelope']['received_at_ms'] if index + 1 < len(stream) else end
            if nxt < at:
                raise ValueError('Source receipt timestamps run backwards; manual review needed')
            if nxt - at > disconnect_seconds * 1000:
                exclude(at - guard_ms, nxt + guard_ms, 'usb_stream_gap', node=node,
                    last_before_ms=at, first_after_ms=nxt, arrival_gap_ms=nxt-at)
            reasons = []
            if p.get('sensor_health', {}).get(health_key) != 'healthy':
                reasons.append('sensor_health_not_healthy')
            if any(not number(p.get(key)) for key in required):
                reasons.append('required_measurement_missing')
            if any(not number(value) or not schema[key]['min'] <= value <= schema[key]['max']
                   for key, value in p.items() if key in schema):
                reasons.append('outside_recorded_channel_range')
            if reasons:
                invalid_counts.update(reasons)
                for reason in reasons:
                    exclude(at, max(at + 1, nxt), reason, node=node,
                        source_frames_line=frame['source_line'])
    excluded = merge_intervals(events, start, end)
    segments, cursor = [], start
    for interval in excluded:
        if cursor < interval['start_ms']:
            segments.append({'segment_id': f'S{len(segments)+1:03d}',
                'start_ms': cursor, 'end_ms': interval['start_ms']})
        cursor = max(cursor, interval['end_ms'])
    if cursor < end:
        segments.append({'segment_id': f'S{len(segments)+1:03d}', 'start_ms': cursor, 'end_ms': end})
    starts = [s['start_ms'] for s in segments]
    def segment_at(at):
        i = bisect.bisect_right(starts, at) - 1
        return segments[i] if i >= 0 and at < segments[i]['end_ms'] else None

    kept, dropped = [], []
    counts = collections.Counter()
    segment_counts = collections.defaultdict(collections.Counter)
    for source_row, (row, frame) in enumerate(zip(rows, frames), 2):
        at = frame['envelope']['received_at_ms']; segment = segment_at(at)
        if segment:
            kept.append(({**row, 'segment_id': segment['segment_id'],
                'source_csv_row': str(source_row)}, frame))
            counts[row['node']] += 1
            segment_counts[segment['segment_id']][row['node']] += 1
        else:
            dropped.append({'source_csv_row': source_row, 'received_at_ms': at,
                'node': row['node'], 'seq': row['seq']})
    if not kept:
        raise ValueError('No rows survive the requested filters')
    output.mkdir(parents=True)
    with (output / 'telemetry.csv').open('w', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=fields + ['segment_id', 'source_csv_row'])
        writer.writeheader(); writer.writerows(row for row, _ in kept)
    (output / 'telemetry.frames.jsonl').write_text(''.join(f['raw_line'] + '\n' for _, f in kept))
    for segment in segments:
        segment.update(start_utc=iso(segment['start_ms']), end_utc=iso(segment['end_ms']),
            duration_seconds=(segment['end_ms']-segment['start_ms'])/1000,
            rows_by_node=dict(segment_counts[segment['segment_id']]))
    def write_json(name, data):
        (output / name).write_text(json.dumps(data, indent=2) + '\n')
    write_json('segments.json', segments)
    write_json('excluded-intervals.json', {'time_basis': 'UTC epoch ms, half-open [start, end)',
        'merged_intervals': excluded, 'evidence': events,
        'note': 'A merged reason applies somewhere within its interval; evidence preserves exact per-node boundaries.'})
    with (output / 'excluded-rows.csv').open('w', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=['source_csv_row', 'received_at_ms', 'node', 'seq'])
        writer.writeheader(); writer.writerows(dropped)
    kept_duration = sum(s['end_ms']-s['start_ms'] for s in segments) / 1000
    transport = merge_intervals([e for e in events if e['reason'] == 'usb_stream_gap'], start, cutoff)
    manifest = {
        'dataset_version': 1, 'source_session_id': metadata['session_id'],
        'created_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'source_directory': str(source), 'source_sha256': before_hashes,
        'label': metadata['label'], 'source': metadata['source'],
        'end_trim_seconds': trim_seconds, 'keep_before_ms': cutoff, 'keep_before_utc': iso(cutoff),
        'disconnect_threshold_seconds': disconnect_seconds, 'reconnect_guard_seconds': guard_seconds,
        'scope': 'Keep periods when all three streams have complete, sensor-healthy, schema-valid readings',
        'source_telemetry_rows': len(rows), 'kept_telemetry_rows': len(kept), 'removed_telemetry_rows': len(dropped),
        'kept_rows_by_node': dict(counts), 'retained_interval_seconds': kept_duration,
        'segment_count': len(segments), 'transport_exclusions': transport,
        'invalid_source_frame_counts_by_reason_overlapping': dict(invalid_counts),
        'grouping': 'Keep this entire source session/day in one ML split. Never window across segment_id boundaries.',
        'qualification': 'Unlabelled telemetry subset; range checks do not prove mechanical health or rule out in-range Hall artifacts.',
        'operations': 'No resampling, interpolation, zero filling, clock compression, sensor value changes, or fault labels added.',
    }
    write_json('manifest.json', manifest)
    # Independent saved-output reconciliation against the unchanged original rows.
    with (output / 'telemetry.csv').open(newline='') as stream:
        saved = list(csv.DictReader(stream))
    assert len(saved) == len(kept)
    for row in saved:
        original = rows[int(row['source_csv_row']) - 2]
        assert all(row[field] == original[field] for field in fields)
        at = int(row['received_at_ms'])
        assert at < cutoff and not any(i['start_ms'] <= at < i['end_ms'] for i in excluded)
        assert segment_at(at)['segment_id'] == row['segment_id']
    assert all(hash_file(source / name) == digest for name, digest in before_hashes.items())
    write_json('verification.json', {'all_source_values_preserved': True,
        'original_files_unchanged': True, 'row_counts_reconciled': True,
        'no_rows_in_excluded_intervals': True, 'rows_verified': len(saved)})
    (output / 'README.md').write_text(
        '# Cleaned conveyor recording\n\n'
        f'Source session: `{metadata["session_id"]}`. The original recording is unchanged.\n\n'
        f'Retained **{len(kept):,} telemetry rows** across **{len(segments)} segments**, '
        f'covering **{kept_duration:.3f} seconds** of accepted intervals. These are separate '
        'sensor rows and discontinuous intervals, not independent ML examples or one continuous run.\n\n'
        f'The final {trim_seconds:g} seconds are excluded, starting at {iso(cutoff)}. '
        f'USB gaps longer than {disconnect_seconds:g} seconds are excluded across all three streams, '
        f'with {guard_seconds:g}-second guards around reconnect boundaries. '
        'Intervals with unhealthy, missing, or out-of-range measurements are also excluded. '
        'Healthy numeric zeros are not removed just because they are zero.\n\n'
        '`telemetry.csv` is the cleaned dataset. Original columns and values are preserved; '
        '`segment_id` and `source_csv_row` provide boundaries and traceability. '
        '`telemetry.frames.jsonl` preserves matching original telemetry envelopes and diagnostics. '
        '`segments.json` records retained interval boundaries. `excluded-intervals.json` and '
        '`excluded-rows.csv` explain the exclusions. `manifest.json` contains source hashes and rules.\n\n'
        'Do not interpolate across removed intervals, compress the timestamps, join ML windows across '
        'segments, or distribute segments from this same run across training and evaluation splits. '
        'This remains unlabelled data; these acquisition checks do not certify normal mechanical '
        'condition, remove every possible Hall artifact, or establish enough data for fault prediction.\n')
    (output / 'clean-recording.py').write_bytes(Path(__file__).read_bytes())
    files = sorted(p for p in output.iterdir() if p.is_file())
    (output / 'SHA256SUMS').write_text(''.join(f'{hash_file(p)}  {p.name}\n' for p in files))
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--trim-tail-seconds', type=float, default=300)
    parser.add_argument('--disconnect-seconds', type=float, default=5)
    parser.add_argument('--guard-seconds', type=float, default=2)
    args = parser.parse_args()
    result = clean(args.source, args.output, args.trim_tail_seconds, args.disconnect_seconds, args.guard_seconds)
    print(json.dumps(result, indent=2))
