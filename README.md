# speed-camera

Estimate vehicle speed from a fixed roadside video clip — no neural net, light
enough to run on a recycled phone. A static camera + background subtraction
(MOG2) finds moving blobs; a centroid tracker follows them; a homography maps
road-plane pixels to real-world metres; speed = metres ÷ seconds.

> **Not an enforcement tool.** Real speed cameras are type-approved and
> calibrated. This is for traffic-calming evidence, awareness, and learning —
> the same spirit as community speed watch, made from e-waste.

## How it works

`detect motion → reduce to points → keep identity → un-perspective into metres → differentiate over time`

- `src/speed_camera.py` — the estimator (MOG2 → centroid tracking → homography → mph)
- `src/make_synthetic.py` — renders a clip of a car moving at a **known** speed, so accuracy is measurable, not asserted
- `src/env_check.py` — smoke test: does this OpenCV build do everything the estimator needs (esp. mp4 I/O)?

## Run it

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install opencv-python-headless numpy   # see Termux note below

# closed-loop test: generate a 30 mph clip, then measure it
python src/make_synthetic.py --mph 30 --out clips/test30
python src/speed_camera.py --video clips/test30.mp4 --calib clips/test30.json \
    --out out/test30_annot.mp4
```

On the synthetic clips the estimator currently reads ~6–7% low — a consistent
(so calibratable) bias, suspected to be MOG2 background warm-up on short clips.

## Calibration

Speed is only as good as the pixel→metre mapping. Provide ≥4 points whose
real-world positions you know (UK dashed lane lines are a standard 6 m mark +
9 m gap — a free ruler painted on the road):

```json
{
  "image_points": [[x, y], ...],
  "world_points": [[X, Y], ...],
  "min_area": 500,
  "speed_window_s": 0.25
}
```

## Running on Termux (Android)

OpenCV isn't in Termux's main repo, and `pip install opencv-python` tries to
build from source and fails. Use the prebuilt package from the TUR instead:

```bash
pkg install python-numpy
pkg install tur-repo && pkg update
pkg install opencv-python
python src/env_check.py     # verify the build can do mp4 I/O
```

Because OpenCV is a system package there, run against system Python, or create
the venv with `--system-site-packages` so it can see `cv2`.

For a first phone-stability probe, install the Termux API helper and capture a
calibration still after the phone has held the same pose for 30 seconds:

```bash
pkg install termux-api
python src/stable_capture.py --out clips/calib.jpg --stable-s 30
```

This uses accelerometer/gyroscope readings only to decide when the phone has
stopped moving. The saved still is for the later visual calibration step.

To mark calibration points on the phone, serve the repo and open the tap-based
calibration page in Chrome:

```bash
python -m http.server 8000
# then open:
# http://127.0.0.1:8000/src/calibrate_points.html?image=/clips/calib.jpg
```

Tap known road points on the image, enter their matching real-world metre
coordinates, then copy the generated JSON into a calibration file.
