#!/usr/bin/env python3
"""
speed_camera.py — estimate vehicle speed from a fixed roadside clip.

No neural net. A static camera + background subtraction (MOG2) finds moving
blobs; a centroid tracker follows them; a homography maps road-plane pixels to
real-world metres; speed = metres / seconds. Light enough to one day run on the
very phones we're recycling.

Calibration JSON:
{
  "image_points": [[x,y], ...],   # >=4 pixel points on the road plane
  "world_points": [[X,Y], ...],   # their real-world metres (same order)
  "min_area": 500,                # ignore blobs smaller than this (px^2)
  "speed_window_s": 0.25          # smoothing window for instantaneous speed
}

Usage:
  python speed_camera.py --video clips/foo.mp4 --calib clips/foo.json \
      --out out/foo_annotated.mp4
"""

import argparse
import json
import sys
from collections import OrderedDict
from pathlib import Path

import cv2
import numpy as np

MPS_TO_MPH = 2.2369362921


class CentroidTracker:
    """Greedy nearest-neighbour tracker. Good enough for sparse traffic."""

    def __init__(self, max_distance=80, max_disappeared=12):
        self.next_id = 0
        self.objects = OrderedDict()  # id -> (x, y)
        self.disappeared = OrderedDict()  # id -> frames missing
        self.max_distance = max_distance
        self.max_disappeared = max_disappeared

    def _register(self, centroid):
        self.objects[self.next_id] = centroid
        self.disappeared[self.next_id] = 0
        self.next_id += 1

    def _deregister(self, oid):
        del self.objects[oid]
        del self.disappeared[oid]

    def update(self, centroids):
        if not centroids:
            for oid in list(self.disappeared):
                self.disappeared[oid] += 1
                if self.disappeared[oid] > self.max_disappeared:
                    self._deregister(oid)
            return self.objects

        if not self.objects:
            for c in centroids:
                self._register(c)
            return self.objects

        ids = list(self.objects.keys())
        obj_pts = np.array([self.objects[i] for i in ids], dtype=float)
        new_pts = np.array(centroids, dtype=float)

        # distance matrix, greedily match closest pairs
        D = np.linalg.norm(obj_pts[:, None] - new_pts[None, :], axis=2)
        rows = D.min(axis=1).argsort()
        cols = D.argmin(axis=1)[rows]

        used_rows, used_cols = set(), set()
        for r, c in zip(rows, cols):
            if r in used_rows or c in used_cols:
                continue
            if D[r, c] > self.max_distance:
                continue
            oid = ids[r]
            self.objects[oid] = tuple(new_pts[c])
            self.disappeared[oid] = 0
            used_rows.add(r)
            used_cols.add(c)

        for r in range(D.shape[0]):
            if r not in used_rows:
                oid = ids[r]
                self.disappeared[oid] += 1
                if self.disappeared[oid] > self.max_disappeared:
                    self._deregister(oid)
        for c in range(D.shape[1]):
            if c not in used_cols:
                self._register(tuple(new_pts[c]))

        return self.objects


def load_calibration(path):
    with open(path) as f:
        cfg = json.load(f)
    img = np.array(cfg["image_points"], dtype=np.float32)
    world = np.array(cfg["world_points"], dtype=np.float32)
    H, _ = cv2.findHomography(img, world)
    if H is None:
        sys.exit("Could not compute homography from calibration points.")
    return H, cfg.get("min_area", 500), cfg.get("speed_window_s", 0.25)


def to_world(H, pt):
    src = np.array([[[pt[0], pt[1]]]], dtype=np.float32)
    dst = cv2.perspectiveTransform(src, H)
    return float(dst[0, 0, 0]), float(dst[0, 0, 1])


def median_speed(track, window_s):
    """Median instantaneous speed (m/s) over short windows — rejects jitter."""
    if len(track) < 2:
        return None
    speeds = []
    for i in range(len(track)):
        t0, x0, y0 = track[i]
        for j in range(i + 1, len(track)):
            t1, x1, y1 = track[j]
            dt = t1 - t0
            if dt >= window_s:
                d = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
                speeds.append(d / dt)
                break
    if not speeds:
        # fall back to endpoint-to-endpoint
        t0, x0, y0 = track[0]
        t1, x1, y1 = track[-1]
        dt = t1 - t0
        if dt <= 0:
            return None
        d = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
        return d / dt
    return float(np.median(speeds))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--calib", required=True)
    ap.add_argument("--out", default=None, help="annotated mp4 (optional)")
    ap.add_argument(
        "--min-track-s",
        type=float,
        default=0.4,
        help="ignore tracks shorter than this (s)",
    )
    args = ap.parse_args()

    H, min_area, window_s = load_calibration(args.calib)

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        sys.exit(f"Cannot open {args.video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    writer = None
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(args.out, fourcc, fps, (w, h))

    bg = cv2.createBackgroundSubtractorMOG2(
        history=200, varThreshold=40, detectShadows=True
    )
    tracker = CentroidTracker()
    histories = {}  # id -> list of (t, world_x, world_y)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))

    frame_idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        t = frame_idx / fps

        mask = bg.apply(frame)
        _, mask = cv2.threshold(mask, 200, 255, cv2.THRESH_BINARY)  # drop shadows
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)

        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        centroids = []
        for c in contours:
            if cv2.contourArea(c) < min_area:
                continue
            x, y, bw, bh = cv2.boundingRect(c)
            # Track the GROUND-CONTACT point (bottom-centre of the box), not the
            # box centre. The homography is only valid on the road plane; the box
            # centre floats above it, so under perspective it maps to a world
            # position that drifts with distance and compresses the trajectory
            # (~7% speed under-read). The bottom edge — where tyres meet road —
            # lies on the plane and projects correctly.
            centroids.append((x + bw / 2.0, y + bh))

        objects = tracker.update(centroids)
        for oid, (cx, cy) in objects.items():
            wx, wy = to_world(H, (cx, cy))
            histories.setdefault(oid, []).append((t, wx, wy))

        if writer is not None:
            for oid, (cx, cy) in objects.items():
                spd = median_speed(histories.get(oid, []), window_s)
                label = f"#{oid}"
                if spd is not None:
                    label += f" {spd * MPS_TO_MPH:.0f} mph"
                cv2.circle(frame, (int(cx), int(cy)), 5, (0, 255, 0), -1)
                cv2.putText(
                    frame,
                    label,
                    (int(cx) + 8, int(cy) - 8),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.6,
                    (0, 255, 0),
                    2,
                )
            writer.write(frame)

        frame_idx += 1

    cap.release()
    if writer is not None:
        writer.release()

    # report
    print(f"\nProcessed {frame_idx} frames @ {fps:.2f} fps ({frame_idx / fps:.1f}s)\n")
    print(f"{'id':>3}  {'frames':>6}  {'dur_s':>6}  {'mph':>6}")
    print("-" * 30)
    results = []
    for oid, track in sorted(histories.items()):
        dur = track[-1][0] - track[0][0]
        if dur < args.min_track_s:
            continue
        spd = median_speed(track, window_s)
        if spd is None:
            continue
        mph = spd * MPS_TO_MPH
        results.append((oid, mph))
        print(f"{oid:>3}  {len(track):>6}  {dur:>6.2f}  {mph:>6.1f}")
    if not results:
        print("(no tracks long enough to measure)")
    return results


if __name__ == "__main__":
    main()
