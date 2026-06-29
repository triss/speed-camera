#!/usr/bin/env python3
"""Wait for a steady phone pose, then capture a calibration still.

This is a tiny Termux/Android probe for the first two calibration workflow
steps:

1. Watch accelerometer + gyroscope readings until the phone is stable.
2. Capture a still with termux-camera-photo.
"""
import argparse
import json
import math
import shutil
import subprocess
import sys
import time
from pathlib import Path


SENSORS = "accelerometer,gyroscope"


def magnitude(values):
    return math.sqrt(sum(v * v for v in values))


def distance(a, b):
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def normalize(values):
    mag = magnitude(values)
    if mag == 0:
        return values
    return [v / mag for v in values]


def find_sensor_values(payload, name):
    for key, value in payload.items():
        if name.lower() not in key.lower():
            continue
        if isinstance(value, dict) and isinstance(value.get("values"), list):
            return [float(v) for v in value["values"][:3]]
        if isinstance(value, list):
            return [float(v) for v in value[:3]]
    return None


def read_termux_sensors():
    try:
        proc = subprocess.run(
            ["termux-sensor", "-n", "1", "-s", SENSORS],
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        sys.exit(
            "termux-sensor not found. Install Termux:API and run: pkg install termux-api"
        )
    except subprocess.CalledProcessError as exc:
        sys.exit(f"termux-sensor failed:\n{exc.stderr or exc.stdout}")

    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError:
        sys.exit(f"Could not parse termux-sensor output as JSON:\n{proc.stdout}")

    accel = find_sensor_values(payload, "accelerometer")
    gyro = find_sensor_values(payload, "gyroscope")
    if accel is None:
        sys.exit(f"No accelerometer values found in:\n{proc.stdout}")
    if gyro is None:
        gyro = [0.0, 0.0, 0.0]
    return accel, gyro


def fake_stable_sensors():
    return [0.0, 0.0, 9.81], [0.0, 0.0, 0.0]


def capture_photo(path, camera, dry_run):
    path.parent.mkdir(parents=True, exist_ok=True)
    if dry_run:
        path.write_text("dry-run placeholder for calibration still\n")
        return

    if shutil.which("termux-camera-photo") is None:
        sys.exit(
            "termux-camera-photo not found. Install Termux:API and run: pkg install termux-api"
        )

    try:
        subprocess.run(
            ["termux-camera-photo", "-c", str(camera), str(path)],
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as exc:
        sys.exit(f"termux-camera-photo failed:\n{exc.stderr or exc.stdout}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--out",
        required=True,
        help="output calibration photo path, e.g. clips/calib.jpg",
    )
    parser.add_argument("--camera", type=int, default=0, help="Termux camera id")
    parser.add_argument("--stable-s", type=float, default=30.0)
    parser.add_argument("--sample-interval-s", type=float, default=1.0)
    parser.add_argument(
        "--accel-delta",
        type=float,
        default=0.015,
        help="max change in normalized gravity vector before stability resets",
    )
    parser.add_argument(
        "--gyro-max",
        type=float,
        default=0.05,
        help="max gyroscope vector magnitude before stability resets",
    )
    parser.add_argument("--dry-run", action="store_true", help="do not call Termux APIs")
    args = parser.parse_args()

    read_sensors = fake_stable_sensors if args.dry_run else read_termux_sensors
    out_path = Path(args.out)

    baseline_accel = None
    stable_since = None

    print(f"Waiting for {args.stable_s:.1f}s stable pose...")
    while True:
        now = time.monotonic()
        accel, gyro = read_sensors()
        accel_unit = normalize(accel)
        gyro_mag = magnitude(gyro)

        if baseline_accel is None:
            baseline_accel = accel_unit
            stable_since = now

        accel_delta = distance(accel_unit, baseline_accel)
        is_stable = accel_delta <= args.accel_delta and gyro_mag <= args.gyro_max

        if is_stable:
            stable_for = now - stable_since
        else:
            baseline_accel = accel_unit
            stable_since = now
            stable_for = 0.0

        print(
            f"\rstable {stable_for:5.1f}/{args.stable_s:.1f}s "
            f"accel_delta={accel_delta:.4f} gyro={gyro_mag:.4f}",
            end="",
            flush=True,
        )

        if stable_for >= args.stable_s:
            print()
            capture_photo(out_path, args.camera, args.dry_run)
            print(f"Captured {out_path}")
            return

        time.sleep(args.sample_interval_s)


if __name__ == "__main__":
    main()
