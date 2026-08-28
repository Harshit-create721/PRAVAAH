#!/usr/bin/env python3
"""
============================================================================
BeltGuard Edge - vision node
SIH26008 / conveyor belt joint rupture prediction
----------------------------------------------------------------------------
Runs on the laptop/mini-PC beside the conveyor. Watches a fixed camera, finds
the joint fiducial as it passes, and publishes per-passage measurements to the
same MQTT contract the ESP32 uses.

WHAT IT MEASURES (and only publishes when it actually measured it):
  belt_offset      lateral displacement of the belt edge, mm
  crack_length     longest dark linear feature inside the joint window, mm
  opening          widest gap across the splice line, mm
  image_quality    Laplacian focus score, normalised - the dashboard uses this
                   to decide whether to trust the frame at all

WHAT IT DOES NOT DO: it does not guess. If the fiducial is not found in a
frame, nothing is published for that frame. If focus is below MIN_FOCUS the
frame is dropped and counted. A missing measurement shows as NO SIGNAL on the
dashboard, which is the truth; a zero would be a lie.

CALIBRATION IS MANDATORY. Every millimetre figure comes from MM_PER_PX. Put a
ruler in the belt plane, run with --calibrate, and set the value it prints.
Without it, run with --units px and the dashboard will show pixel figures you
must not read as millimetres.

    pip install -r requirements.txt
    python vision_node.py --calibrate
    python vision_node.py --camera 0 --mm-per-px 0.42

Marker: print an ArUco 4x4_50 tag, laminate it, and bond it to the belt with
belt-repair adhesive OUTSIDE the load-carrying area and clear of the splice
itself, per the safety section of the blueprint. The tag id IS the joint id.
============================================================================
"""

import argparse
import json
import os
import time
from datetime import datetime

import cv2
import numpy as np
import paho.mqtt.client as mqtt

# ----------------------------------------------------------------- defaults

SITE = os.environ.get("BELTGUARD_SITE", "factory")
CONVEYOR = os.environ.get("BELTGUARD_CONVEYOR", "CV-01")
NODE = os.environ.get("BELTGUARD_NODE", "vision-01")
BROKER = os.environ.get("BELTGUARD_BROKER", "127.0.0.1")
BROKER_PORT = int(os.environ.get("BELTGUARD_BROKER_PORT", "1883"))

MIN_FOCUS = 60.0        # Laplacian variance below this = too blurred to measure
MIN_MARKER_GAP_S = 1.0  # ignore re-detections of the same passage
EVIDENCE_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "evidence")


# --------------------------------------------------------------- measuring

def focus_score(gray):
    """Laplacian variance. Higher is sharper. Used as a hard gate, not a guess."""
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def find_belt_edges(gray):
    """
    Return (left_x, right_x) of the belt edges in pixels, or None.

    Assumes the belt runs left-to-right across the frame with the background
    darker or lighter than the belt. Column-wise gradient energy gives the two
    strongest horizontal boundaries.
    """
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    sobel_y = np.abs(cv2.Sobel(blur, cv2.CV_64F, 0, 1, ksize=3))
    row_energy = sobel_y.sum(axis=1)
    if row_energy.max() < 1e-6:
        return None
    # Two strongest rows, far enough apart to be opposite edges.
    order = np.argsort(row_energy)[::-1]
    top = int(order[0])
    for cand in order[1:]:
        if abs(int(cand) - top) > gray.shape[0] * 0.2:
            bottom = int(cand)
            return (min(top, bottom), max(top, bottom))
    return None


def crack_metrics(roi_gray, mm_per_px):
    """
    Longest dark linear feature and the widest gap inside the joint window.

    Returns (crack_len, opening, confidence) or (None, None, 0.0) when nothing
    measurable is present. A clean splice legitimately returns 0.0 length with
    high confidence - that is a measurement, not a missing value.
    """
    if roi_gray.size == 0:
        return None, None, 0.0

    norm = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(roi_gray)
    # Cracks and openings are darker than surrounding rubber.
    thr = cv2.adaptiveThreshold(norm, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                cv2.THRESH_BINARY_INV, 31, 8)
    thr = cv2.morphologyEx(thr, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    thr = cv2.morphologyEx(thr, cv2.MORPH_CLOSE, np.ones((3, 7), np.uint8))

    contours, _ = cv2.findContours(thr, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return 0.0, 0.0, 0.9

    best_len = 0.0
    best_open = 0.0
    for c in contours:
        if cv2.contourArea(c) < 12:
            continue
        (_, _), (w, h), _ = cv2.minAreaRect(c)
        long_side, short_side = max(w, h), min(w, h)
        if long_side < 6:
            continue
        # A crack is long and thin. A blob is not a crack.
        if short_side > 0 and long_side / max(short_side, 1e-6) < 2.5:
            continue
        best_len = max(best_len, long_side)
        best_open = max(best_open, short_side)

    conf = 0.85 if best_len > 0 else 0.9
    return best_len * mm_per_px, best_open * mm_per_px, conf


# ------------------------------------------------------------------- runner

def run(args):
    cap = cv2.VideoCapture(args.camera, cv2.CAP_DSHOW if os.name == "nt" else 0)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)
    # Short exposure freezes the belt. Motion blur is the single biggest cause
    # of a fabricated-looking crack measurement.
    cap.set(cv2.CAP_PROP_EXPOSURE, args.exposure)
    if not cap.isOpened():
        raise SystemExit(f"camera {args.camera} did not open")

    aruco_dict = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    detector = cv2.aruco.ArucoDetector(aruco_dict, cv2.aruco.DetectorParameters())

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"{NODE}-{os.getpid()}")
    status_topic = f"beltguard/{SITE}/{CONVEYOR}/node/{NODE}/status"
    client.will_set(status_topic, json.dumps({"online": False}), qos=1, retain=True)
    client.connect(args.broker, args.port, 30)
    client.loop_start()
    client.publish(status_topic, json.dumps({
        "online": True, "node": NODE, "firmware": "vision_node.py 0.1.0",
    }), qos=1, retain=True)

    vision_topic = f"beltguard/{SITE}/{CONVEYOR}/vision"
    os.makedirs(EVIDENCE_DIR, exist_ok=True)

    last_seen = {}
    lap = {}
    dropped_blur = 0
    frames = 0

    print(f"vision node up. broker {args.broker}:{args.port}  topic {vision_topic}")
    print(f"scale {args.mm_per_px} mm/px" if args.units == "mm"
          else "UNCALIBRATED - publishing pixels; do NOT read these as mm")

    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                time.sleep(0.05)
                continue
            frames += 1
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

            f = focus_score(gray)
            if f < MIN_FOCUS:
                dropped_blur += 1
                continue

            corners, ids, _ = detector.detectMarkers(gray)
            if ids is None or len(ids) == 0:
                continue

            now = time.time()
            for c, marker_id in zip(corners, ids.flatten()):
                joint_id = f"J{int(marker_id):02d}"
                if now - last_seen.get(joint_id, 0) < MIN_MARKER_GAP_S:
                    continue
                last_seen[joint_id] = now
                lap[joint_id] = lap.get(joint_id, 0) + 1

                pts = c.reshape(4, 2)
                cx, cy = pts.mean(axis=0)
                marker_px = float(np.linalg.norm(pts[0] - pts[1]))

                payload = {
                    "ts": int(now * 1000),
                    "node": NODE,
                    "joint_id": joint_id,
                    "lap": lap[joint_id],
                    "image_quality": round(min(f / 300.0, 1.0), 3),
                }

                # Scale: prefer the marker's known physical size when given -
                # it is measured in THIS frame, so it survives camera drift.
                mm_per_px = args.mm_per_px
                if args.marker_mm and marker_px > 1:
                    mm_per_px = args.marker_mm / marker_px
                    payload["scale_source"] = "marker"
                elif args.units == "mm":
                    payload["scale_source"] = "fixed"

                # Lateral tracking: belt centre vs the frame's reference centre.
                edges = find_belt_edges(gray)
                if edges is not None:
                    belt_centre = (edges[0] + edges[1]) / 2.0
                    ref = args.reference_centre if args.reference_centre else gray.shape[0] / 2.0
                    if args.units == "mm":
                        payload["belt_offset"] = round((belt_centre - ref) * mm_per_px, 2)

                # Joint window: a band around the marker, along the belt.
                half_w = int(marker_px * args.window)
                x0, x1 = max(0, int(cx - half_w)), min(gray.shape[1], int(cx + half_w))
                y0, y1 = max(0, int(cy - half_w)), min(gray.shape[0], int(cy + half_w))
                roi = gray[y0:y1, x0:x1]

                crack, opening, conf = crack_metrics(roi, mm_per_px if args.units == "mm" else 1.0)
                if crack is not None and args.units == "mm":
                    payload["crack_length"] = round(crack, 2)
                    payload["opening"] = round(opening, 3)
                    payload["cv_confidence"] = round(conf, 2)

                # Evidence frame, so an inspector can check the machine's claim.
                stamp = datetime.fromtimestamp(now).strftime("%Y%m%d-%H%M%S")
                name = f"{joint_id}_{stamp}.jpg"
                cv2.imwrite(os.path.join(EVIDENCE_DIR, name),
                            frame, [cv2.IMWRITE_JPEG_QUALITY, 82])
                payload["evidence_frame"] = f"/evidence/{name}"

                client.publish(vision_topic, json.dumps(payload), qos=0)
                print(f"  {joint_id} lap {lap[joint_id]:>3}  "
                      f"focus {f:6.1f}  "
                      f"crack {payload.get('crack_length', '--')}  "
                      f"offset {payload.get('belt_offset', '--')}")

            if frames % 600 == 0:
                print(f"  [{frames} frames, {dropped_blur} dropped for blur]")

    except KeyboardInterrupt:
        pass
    finally:
        client.publish(status_topic, json.dumps({"online": False}), qos=1, retain=True)
        time.sleep(0.3)
        client.loop_stop()
        cap.release()
        print("\nvision node stopped.")


def calibrate(args):
    """Show a live view; click two points a known distance apart."""
    cap = cv2.VideoCapture(args.camera, cv2.CAP_DSHOW if os.name == "nt" else 0)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)
    pts = []

    def on_click(event, x, y, flags, param):
        if event == cv2.EVENT_LBUTTONDOWN:
            pts.append((x, y))

    cv2.namedWindow("calibrate")
    cv2.setMouseCallback("calibrate", on_click)
    print("Put a ruler in the belt plane. Click two points a known distance apart. "
          "Press q to finish.")

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        for p in pts:
            cv2.circle(frame, p, 5, (0, 220, 255), -1)
        if len(pts) >= 2:
            cv2.line(frame, pts[0], pts[1], (0, 220, 255), 2)
            d = float(np.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]))
            cv2.putText(frame, f"{d:.1f} px", (12, 30),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 220, 255), 2)
        g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        cv2.putText(frame, f"focus {focus_score(g):.0f} (need > {MIN_FOCUS:.0f})",
                    (12, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (120, 255, 160), 2)
        cv2.imshow("calibrate", frame)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

    cap.release()
    cv2.destroyAllWindows()
    if len(pts) >= 2:
        d = float(np.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]))
        print(f"\n  pixels between your two clicks: {d:.2f}")
        print(f"  divide your known distance in mm by that, then run with:")
        print(f"     --mm-per-px <known_mm / {d:.2f}>")
    else:
        print("\n  no two points clicked; nothing to compute.")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="BeltGuard Edge vision node")
    p.add_argument("--camera", type=int, default=0)
    p.add_argument("--width", type=int, default=1280)
    p.add_argument("--height", type=int, default=720)
    p.add_argument("--exposure", type=float, default=-6,
                   help="short exposure freezes the belt; camera-dependent scale")
    p.add_argument("--broker", default=BROKER)
    p.add_argument("--port", type=int, default=BROKER_PORT)
    p.add_argument("--mm-per-px", type=float, default=None,
                   help="scale from --calibrate; required for mm output")
    p.add_argument("--marker-mm", type=float, default=None,
                   help="printed side length of the ArUco tag; gives per-frame scale")
    p.add_argument("--reference-centre", type=float, default=None,
                   help="pixel row of the belt centre when tracking is correct")
    p.add_argument("--window", type=float, default=1.6,
                   help="joint inspection window as a multiple of marker size")
    p.add_argument("--calibrate", action="store_true")
    args = p.parse_args()

    if args.calibrate:
        calibrate(args)
    else:
        if args.mm_per_px is None and args.marker_mm is None:
            args.units = "px"
            args.mm_per_px = 1.0
            print("WARNING: no scale given. Vision measurements will be SUPPRESSED "
                  "rather than published in pixels. Run --calibrate first.")
        else:
            args.units = "mm"
            args.mm_per_px = args.mm_per_px or 1.0
        run(args)
