#!/usr/bin/env python3
"""
make_synthetic.py — render a test clip of a 'car' moving at a KNOWN speed
through a perspective-calibrated road scene, and emit the matching calibration
JSON. Lets us measure the estimator's ERROR against ground truth.

World frame: X = along road (metres), Y = across road (metres).
We place a 20 m x 7.3 m road rectangle and project it to an image trapezoid to
fake perspective. A car drives down the centre lane at --mph.

Usage:
  python make_synthetic.py --mph 30 --out clips/test30
  -> writes clips/test30.mp4 and clips/test30.json
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np

MPH_TO_MPS = 0.44704

# World rectangle on the road plane (metres): 20 m long, 7.3 m wide (2 lanes)
WORLD = np.array([[0, 0], [20, 0], [20, 7.3], [0, 7.3]], dtype=np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mph", type=float, default=30.0)
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--out", required=True, help="path stem (no extension)")
    ap.add_argument("--w", type=int, default=960)
    ap.add_argument("--h", type=int, default=540)
    args = ap.parse_args()

    W, H = args.w, args.h

    # Image trapezoid the world rectangle maps onto (near edge wide at bottom).
    # order matches WORLD: (0,0)=far-left, (20,0)=near-left,
    # (20,7.3)=near-right, (0,7.3)=far-right
    img_quad = np.array([
        [W * 0.42, H * 0.30],   # far-left
        [W * 0.05, H * 0.92],   # near-left
        [W * 0.95, H * 0.92],   # near-right
        [W * 0.58, H * 0.30],   # far-right
    ], dtype=np.float32)

    H_world2img, _ = cv2.findHomography(WORLD, img_quad)

    speed_mps = args.mph * MPH_TO_MPS
    # car centred in the nearest lane (Y = 1.8 m), drives X: 1 -> 19 m
    x_start, x_end = 1.0, 19.0
    travel = x_end - x_start
    duration = travel / speed_mps
    n_frames = int(duration * args.fps)

    out_stem = Path(args.out)
    out_stem.parent.mkdir(parents=True, exist_ok=True)

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    vw = cv2.VideoWriter(str(out_stem.with_suffix(".mp4")), fourcc, args.fps, (W, H))

    def project(pt_world):
        src = np.array([[[pt_world[0], pt_world[1]]]], dtype=np.float32)
        dst = cv2.perspectiveTransform(src, H_world2img)
        return dst[0, 0]

    for i in range(n_frames):
        x = x_start + speed_mps * (i / args.fps)
        frame = np.full((H, W, 3), 60, dtype=np.uint8)  # asphalt grey

        # lane markings every 6 m (paint) with 9 m gaps, centreline Y=3.65
        for seg in range(-6, 30, 15):
            p0 = project((seg, 3.65))
            p1 = project((seg + 6, 3.65))
            cv2.line(frame, tuple(p0.astype(int)), tuple(p1.astype(int)),
                     (255, 255, 255), 3)

        # the 'car': a rectangle in world space (4.2 m x 1.8 m), centre lane
        cx, cy = x, 1.8
        corners = [(cx - 2.1, cy - 0.9), (cx + 2.1, cy - 0.9),
                   (cx + 2.1, cy + 0.9), (cx - 2.1, cy + 0.9)]
        pts = np.array([project(c) for c in corners], dtype=np.int32)
        cv2.fillConvexPoly(frame, pts, (40, 40, 200))

        vw.write(frame)

    vw.release()

    calib = {
        "image_points": img_quad.tolist(),
        "world_points": WORLD.tolist(),
        "min_area": 150,
        "speed_window_s": 0.2,
    }
    with open(out_stem.with_suffix(".json"), "w") as f:
        json.dump(calib, f, indent=2)

    print(f"Wrote {args.out}.mp4 ({n_frames} frames, {duration:.2f}s) "
          f"and {args.out}.json")
    print(f"GROUND TRUTH: {args.mph:.1f} mph ({speed_mps:.2f} m/s)")


if __name__ == "__main__":
    main()
