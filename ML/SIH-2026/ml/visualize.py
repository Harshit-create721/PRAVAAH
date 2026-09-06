"""Generate every plot under outputs/plots/.

Two rules govern this file:

1. **Separate recording segments are never joined by a line.** Each segment is drawn as
   its own polyline, so a 10-minute USB dropout does not appear as a smooth transition.
   Segment extents are shaded on every time-series plot.
2. **No dual-axis plots.** Two measures with different scales get two panels, never two
   y-scales on one frame.

Colour roles are fixed across the whole deck so an entity keeps its hue:
vibration = blue, temperature = orange, RPM = aqua, ambient = neutral (context series).
Status colours are the reserved status palette and are always paired with a distinct
marker shape and a text label, never carried by colour alone.
"""
from __future__ import annotations

import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from matplotlib.colors import LinearSegmentedColormap
from matplotlib.lines import Line2D

import config as C
import preprocessing

# ---------------------------------------------------------------- design tokens
SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK_2 = "#52514e"
MUTED = "#898781"
GRID = "#e1e0d9"
AXIS = "#c3c2b7"

SERIES = {
    "vibration": "#2a78d6",   # categorical slot 1
    "temperature": "#eb6834",  # categorical slot 2
    "rpm": "#1baf7a",          # categorical slot 3
    "ambient": MUTED,          # context series, deliberately not a categorical slot
}

STATUS_STYLE = {
    "NORMAL":   {"color": "#0ca30c", "marker": "o"},
    "WATCH":    {"color": "#fab219", "marker": "s"},
    "WARNING":  {"color": "#ec835a", "marker": "^"},
    "CRITICAL": {"color": "#d03b3b", "marker": "D"},
}

# blue <-> red diverging with a neutral gray midpoint, for the correlation matrix
DIVERGING = LinearSegmentedColormap.from_list(
    "blue_gray_red", ["#184f95", "#86b6ef", "#f0efec", "#eb8a8a", "#a82424"])

plt.rcParams.update({
    "figure.facecolor": SURFACE,
    "axes.facecolor": SURFACE,
    "savefig.facecolor": SURFACE,
    "axes.edgecolor": AXIS,
    "axes.labelcolor": INK_2,
    "axes.titlecolor": INK,
    "axes.titlesize": 12,
    "axes.titleweight": "600",
    "axes.labelsize": 10,
    "axes.grid": True,
    "grid.color": GRID,
    "grid.linewidth": 0.8,
    "xtick.color": MUTED,
    "ytick.color": MUTED,
    "xtick.labelsize": 9,
    "ytick.labelsize": 9,
    "legend.frameon": False,
    "legend.fontsize": 9,
    "legend.labelcolor": INK_2,
    "font.size": 10,
    "figure.dpi": 130,
})


def _finish(ax, title=None, xlabel=None, ylabel=None, note=None):
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    ax.spines["left"].set_color(AXIS)
    ax.spines["bottom"].set_color(AXIS)
    ax.set_axisbelow(True)
    if title:
        ax.set_title(title, loc="left", pad=26)
    if xlabel:
        ax.set_xlabel(xlabel)
    if ylabel:
        ax.set_ylabel(ylabel)
    if note:
        ax.text(0.0, -0.22, note, transform=ax.transAxes, fontsize=8,
                color=MUTED, va="top", ha="left", wrap=True)


def _save(fig, name):
    path = os.path.join(C.PLOTS_DIR, name)
    fig.savefig(path, bbox_inches="tight")
    plt.close(fig)
    print("      wrote %s" % os.path.relpath(path, C.ROOT))
    return path


def shade_segments(ax, segments, t0_ms, label_first=True):
    """Shade each retained recording interval so the gaps between them are visible."""
    for i, r in enumerate(segments.itertuples(index=False)):
        ax.axvspan((r.start_ms - t0_ms) / 1000.0, (r.end_ms - t0_ms) / 1000.0,
                   color=GRID, alpha=0.55, lw=0, zorder=0,
                   label="retained segment" if (i == 0 and label_first) else None)


def plot_stream_over_time(stream, col, color, title, ylabel, fname, segments, t0_ms,
                          second=None, second_color=None, second_label=None,
                          label=None, note=None):
    """One signal (optionally plus a context signal in the same units) against time."""
    fig, ax = plt.subplots(figsize=(11, 3.6))
    shade_segments(ax, segments, t0_ms)

    first = True
    for _, g in stream.groupby(C.SEGMENT_COL, sort=False):
        g = g.sort_values(C.TIME_COL)
        t = (g[C.TIME_COL].to_numpy() - t0_ms) / 1000.0
        ax.plot(t, g[col].to_numpy(float), color=color, lw=1.6,
                label=(label or col) if first else None, solid_capstyle="round")
        if second is not None:
            ax.plot(t, g[second].to_numpy(float), color=second_color, lw=1.4,
                    ls="--", label=second_label if first else None,
                    solid_capstyle="round")
        first = False

    handles, labels = ax.get_legend_handles_labels()
    if len(labels) >= 2:
        ax.legend(loc="lower left", ncol=3, bbox_to_anchor=(0, 1.0))
    _finish(ax, title, "session time (s)", ylabel, note)
    return _save(fig, fname)


def plot_scatter(x, y, cx, cy, title, xlabel, ylabel, fname, note=None):
    fig, ax = plt.subplots(figsize=(6.4, 5.0))
    ax.scatter(x, y, s=26, color=cy, alpha=0.55, edgecolor=SURFACE, linewidth=0.6,
               zorder=3)
    if len(x) > 3 and np.std(x) > 0:
        m, b = np.polyfit(x, y, 1)
        xs = np.linspace(np.min(x), np.max(x), 50)
        r = np.corrcoef(x, y)[0, 1]
        ax.plot(xs, m * xs + b, color=cx, lw=1.8, ls="-", zorder=4,
                label="least-squares fit, r = %+.2f" % r)
        ax.legend(loc="best")
    _finish(ax, title, xlabel, ylabel, note)
    return _save(fig, fname)


def main():
    C.ensure_dirs()
    pre = preprocessing.preprocess()
    seg = pre.segments
    t0 = int(pre.raw[C.TIME_COL].min())
    feats = pd.read_csv(C.FEATURES_CSV)
    scores = pd.read_csv(C.ANOMALY_SCORES_CSV)
    thresholds = pd.read_json(C.THRESHOLDS_PATH, typ="series")["thresholds"]

    gap_note = ("Shaded bands are retained recording segments; unshaded stretches were "
                "excluded during cleaning. Lines break at every segment boundary -- "
                "separate intervals are never joined.")

    print("[plots] time series ...")
    plot_stream_over_time(
        pre.streams["thermal"], "temperature", SERIES["temperature"],
        "1. Temperature over the session", "degC", "01_temperature_vs_time.png",
        seg, t0, second="ambient", second_color=SERIES["ambient"],
        second_label="ambient (context)", label="belt/drum temperature",
        note=gap_note + " Both series share one degC axis -- no second y-scale.")

    plot_stream_over_time(
        pre.streams["vibration"], "vibration_rms", SERIES["vibration"],
        "2. Vibration RMS over the session", "g (RMS)", "02_vibration_vs_time.png",
        seg, t0, label="vibration_rms", note=gap_note)

    plot_stream_over_time(
        pre.streams["speed"], "hall_rpm", SERIES["rpm"],
        "3. Hall-effect RPM over the session", "RPM", "03_rpm_vs_time.png",
        seg, t0, label="hall_rpm",
        note=gap_note + " Note the compressed y-range: the drive held one speed all session.")

    print("[plots] cross-sensor scatter ...")
    plot_scatter(
        feats.rpm_mean.to_numpy(), feats.temp_mean.to_numpy(),
        SERIES["rpm"], SERIES["temperature"],
        "4. Temperature vs RPM (per 10 s window)", "mean hall_rpm", "mean temperature (degC)",
        "04_temperature_vs_rpm.png",
        note=("Each point is one 10 s window. RPM spans under 0.4 RPM across the whole "
              "session, so any apparent trend here is dominated by the thermal warm-up, "
              "not by speed."))

    plot_scatter(
        feats.rpm_mean.to_numpy(), feats.vib_rms_mean.to_numpy(),
        SERIES["rpm"], SERIES["vibration"],
        "5. Vibration vs RPM (per 10 s window)", "mean hall_rpm", "mean vibration RMS (g)",
        "05_vibration_vs_rpm.png",
        note=("Each point is one 10 s window. With speed effectively constant this plot "
              "cannot show a speed-vibration relationship; it is included to document "
              "that absence."))

    print("[plots] correlation matrix ...")
    corr_cols = ["vib_rms_mean", "vib_rms_std", "vib_rms_max", "vib_impulsiveness",
                 "acceleration_magnitude_mean", "temp_mean", "ambient_mean",
                 "temp_over_ambient_mean", "temp_rise_c_per_min", "rpm_mean",
                 "rpm_std", "rpm_range"]
    corr_cols = [c for c in corr_cols if c in feats.columns]
    M = feats[corr_cols].corr().to_numpy()
    fig, ax = plt.subplots(figsize=(7.6, 6.6))
    im = ax.imshow(M, cmap=DIVERGING, vmin=-1, vmax=1)
    ax.set_xticks(range(len(corr_cols)))
    ax.set_yticks(range(len(corr_cols)))
    ax.set_xticklabels(corr_cols, rotation=45, ha="right", fontsize=8)
    ax.set_yticklabels(corr_cols, fontsize=8)
    ax.grid(False)
    for i in range(len(corr_cols)):
        for j in range(len(corr_cols)):
            ax.text(j, i, "%.2f" % M[i, j], ha="center", va="center", fontsize=7,
                    color=INK if abs(M[i, j]) < 0.6 else SURFACE)
    cb = fig.colorbar(im, ax=ax, fraction=0.045, pad=0.03)
    cb.set_label("Pearson r", color=INK_2, fontsize=9)
    cb.outline.set_edgecolor(AXIS)
    _finish(ax, "6. Sensor correlation matrix (window-level features)")
    ax.text(0.0, -0.42, "Computed on the 225 window feature vectors, since the three "
                        "sensor streams have no shared row in the raw CSV. Diverging "
                        "scale: gray = no correlation.",
            transform=ax.transAxes, fontsize=8, color=MUTED, va="top")
    _save(fig, "06_sensor_correlation_matrix.png")

    print("[plots] scores ...")
    for metric, fname, title, ylabel, invert in (
        ("anomaly_score", "07_anomaly_score_vs_time.png",
         "7. Anomaly score over the session", "anomaly score (0-100)", False),
        ("health_score", "08_health_score_vs_time.png",
         "8. Health score over the session", "health score (0-100)", True),
    ):
        fig, ax = plt.subplots(figsize=(11, 4.0))
        shade_segments(ax, seg, t0)
        for _, g in scores.groupby("segment_id", sort=False):
            g = g.sort_values("t_rel_start_s")
            ax.plot(g.t_rel_start_s, g[metric], color=AXIS, lw=1.2, zorder=2)
        for st, style in STATUS_STYLE.items():
            m = scores.status == st
            if not m.any():
                continue
            ax.scatter(scores.t_rel_start_s[m], scores[metric][m], s=34,
                       color=style["color"], marker=style["marker"],
                       edgecolor=SURFACE, linewidth=0.7, zorder=4,
                       label="%s (%d)" % (st, int(m.sum())))
        if not invert:
            for k, lbl in (("watch", "WATCH"), ("warning", "WARNING"), ("critical", "CRITICAL")):
                ax.axhline(thresholds[k], color=STATUS_STYLE[lbl]["color"], lw=1.1,
                           ls=":", zorder=1)
                ax.text(ax.get_xlim()[1], thresholds[k], " %s %.1f" % (lbl, thresholds[k]),
                        va="center", ha="left", fontsize=8,
                        color=STATUS_STYLE[lbl]["color"])
        ax.set_ylim(-2, 102)
        ax.legend(loc="lower left", ncol=5, bbox_to_anchor=(0, 1.0))
        _finish(ax, title, "session time (s)", ylabel,
                gap_note + " health_score = 100 - anomaly_score. Marker shape and the "
                           "legend label carry status; colour alone never does.")
        _save(fig, fname)

    print("[plots] distribution ...")
    fig, ax = plt.subplots(figsize=(8.2, 4.2))
    ax.hist(scores.anomaly_score, bins=40, color=SERIES["vibration"], alpha=0.85,
            edgecolor=SURFACE, linewidth=0.8, zorder=3)
    for k, lbl in (("watch", "WATCH"), ("warning", "WARNING"), ("critical", "CRITICAL")):
        ax.axvline(thresholds[k], color=STATUS_STYLE[lbl]["color"], lw=1.6, ls="--",
                   zorder=4)
        ax.text(thresholds[k], ax.get_ylim()[1] * 0.95, " %s\n %.1f" % (lbl, thresholds[k]),
                fontsize=8, color=STATUS_STYLE[lbl]["color"], va="top")
    _finish(ax, "9. Distribution of anomaly scores across the baseline",
            "anomaly score (0-100)", "windows",
            "225 windows. The long right tail is the handful of impulsive-vibration "
            "windows. Thresholds are baseline percentiles, so this shape and the "
            "threshold positions are not independent of each other.")
    _save(fig, "09_anomaly_score_distribution.png")

    print("[plots] segment map ...")
    fig, ax = plt.subplots(figsize=(11, 3.4))
    wc = feats.groupby("segment_id").size()
    for r in seg.itertuples(index=False):
        n = int(wc.get(r.segment_id, 0))
        color = SERIES["vibration"] if n > 0 else AXIS
        ax.barh(0 if n > 0 else 1, r.duration_s, left=(r.start_ms - t0) / 1000.0,
                height=0.55, color=color, edgecolor=SURFACE, linewidth=0.5)
    ax.set_yticks([0, 1])
    ax.set_yticklabels(["yields windows\n(%d segments)" % int((wc > 0).sum()),
                        "too short for a\n10 s window (%d)" % int(len(seg) - (wc > 0).sum())],
                       fontsize=9)
    ax.invert_yaxis()
    ax.grid(axis="y", visible=False)
    _finish(ax, "10. Segment boundaries across the session", "session time (s)", None,
            "Every bar is one retained recording interval. White space between bars is "
            "excluded time (USB dropouts, unhealthy readings, the trimmed final 300 s). "
            "No ML window is ever built across a white gap.")
    _save(fig, "10_segment_boundaries.png")

    print("[plots] detection response ...")
    plot_detection_response()

    print("[plots] done")



def plot_detection_response():
    """Plot 11: detection rate vs injected severity, per simulated fault shape."""
    import os
    curve_path = os.path.join(C.OUTPUTS_DIR, "synthetic_response_curve.csv")
    if not os.path.exists(curve_path):
        print("      (skipped detection-response plot: run evaluate_synthetic.py first)")
        return None
    curve = pd.read_csv(curve_path)
    thresholds = pd.read_json(C.THRESHOLDS_PATH, typ="series")["thresholds"]

    faults = [c for c in curve.fault_class.unique() if c != "NORMAL"]
    # Categorical slots 1-3 then status hues; every line is also direct-labelled.
    hues = ["#2a78d6", "#eb6834", "#1baf7a", "#4a3aa7", "#e34948"]

    fig, axes = plt.subplots(1, 2, figsize=(12.4, 4.6))
    base = curve[curve.fault_class == "NORMAL"]
    base_rate = float(base.pct_flagged_watch.iloc[0]) if len(base) else 0.0

    for ax, col, title, ylab in (
        (axes[0], "pct_flagged_watch",
         "11a. Detection rate vs injected severity", "% of windows reaching WATCH"),
        (axes[1], "median_anomaly_score",
         "11b. Median anomaly score vs injected severity", "median anomaly score"),
    ):
        for i, f in enumerate(faults):
            c = curve[curve.fault_class == f].sort_values("severity")
            # Curves converge at the top, so direct end-labels would collide; the
            # figure-level legend below carries identity instead.
            ax.plot(c.severity, c[col], color=hues[i % len(hues)], lw=2.0,
                    marker="o", ms=5, label=f, zorder=3)
        if col == "pct_flagged_watch":
            ax.axhline(base_rate, color=MUTED, lw=1.2, ls="--", zorder=2)
            ax.text(0.02, base_rate + 2, "false-alarm floor on real normal data (%.1f%%)"
                    % base_rate, fontsize=8, color=MUTED)
            ax.set_ylim(-3, 108)
        else:
            for k, lbl in (("watch", "WATCH"), ("warning", "WARNING")):
                ax.axhline(thresholds[k], color=STATUS_STYLE[lbl]["color"], lw=1.1, ls=":")
                ax.text(0.02, thresholds[k] + 1.5, lbl, fontsize=8,
                        color=STATUS_STYLE[lbl]["color"])
            ax.set_ylim(-3, 108)
        ax.set_xlim(0, 1.05)
        _finish(ax, title, "injected severity (0-1)", ylab)

    handles, labels = axes[0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="upper center", ncol=5,
               bbox_to_anchor=(0.5, 1.09), frameon=False)
    fig.text(0.0, -0.06,
             "SIMULATED faults from ml/synthetic_faults.py -- these are shapes of "
             "deviation, not verified fault modes. The curves measure detector "
             "sensitivity, not real-world fault detection.",
             fontsize=8, color=MUTED, ha="left")
    return _save(fig, "11_detection_vs_severity.png")


if __name__ == "__main__":
    main()
