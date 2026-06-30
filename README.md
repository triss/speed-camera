# speed-camera

Estimate vehicle speed from a fixed roadside camera — no neural net, light
enough to run on a **recycled Android phone**. A static camera + background
subtraction (MOG2) finds moving blobs; a centroid tracker follows them; a
homography maps road-plane pixels to real-world metres; speed = metres ÷ seconds.

> **Not an enforcement tool.** Real speed cameras are type-approved and
> calibrated. This is for traffic-calming evidence, awareness, and learning —
> the spirit of community speed watch, built from e-waste.

## Why

A dead phone is a tragedy of embodied energy — camera, GPS, battery, radio and
real compute, all mined and shipped and then dropped in a drawer. This project
turns that drawer into a civic sensing tool: a community can gather its own
data about its own street, on hardware everyone else threw away. The whole
design is biased toward *computing within limits* — the lightest technique that
does the job, so it runs on a potato.

## Status

| Piece | State |
| --- | --- |
| Core estimator (MOG2 → track → homography → mph) | ✅ within ~1.5% on synthetic ground-truth clips |
| Runs on a phone (Termux + OpenCV) | ✅ all env checks pass, including mp4 I/O |
| Calibration: steady-pose still capture | ✅ `stable_capture.py` |
| Calibration: tap-to-mark road points | ✅ `calibrate_points.html` |
| Capture real traffic footage on the phone | ⚠️ no native Termux video — see [Capturing footage](#capturing-footage) |
| Measure a real road, on-device | ⏳ next milestone |
| Unattended / always-on capture | 🔭 future (streaming app or small CameraX app) |

## How it works

`detect motion → reduce to points → keep identity → un-perspective into metres → differentiate over time`

The point we project is the **ground-contact** of each blob (bottom-centre of
its box), not the box centre — the homography is only valid on the road plane,
and the box centre floats above it, which under perspective compressed the
trajectory and under-read speed by ~7%. Tracking the contact point fixed it.

Files:

- `src/speed_camera.py` — the estimator (MOG2 → centroid tracking → homography → mph)
- `src/make_synthetic.py` — renders a clip of a car at a **known** speed, so accuracy is measured, not asserted
- `src/env_check.py` — smoke test: does this OpenCV build do everything the estimator needs (esp. mp4 I/O)?
- `src/stable_capture.py` — waits for a steady phone pose (accelerometer + gyro), then grabs a calibration still
- `src/calibrate_points.html` — tap road points on that still, type their real-world metres, export calibration JSON

## Quick start (laptop)

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install opencv-python-headless numpy   # on Termux, see below instead

# closed-loop test: generate a 30 mph clip, then measure it back
python src/make_synthetic.py --mph 30 --out clips/test30
python src/speed_camera.py --video clips/test30.mp4 --calib clips/test30.json \
    --out out/test30_annot.mp4
```

You should measure ~29.7 mph — within ~1.5% of the synthetic 30.

## Running on Termux (Android)

OpenCV isn't in Termux's main repo, and `pip install opencv-python` tries to
build from source and fails. Use the prebuilt package from the TUR:

```bash
pkg install python-numpy
pkg install tur-repo && pkg update
pkg install opencv-python
python src/env_check.py     # verify the build can do mp4 I/O
```

Because OpenCV is a system package there, run against system Python — or create
the venv with `--system-site-packages` so it can see `cv2`.

## On a phone, end to end

The camera must not move between calibration and capture — the mapping is
pose-specific. Mount the phone first, then:

**1. Capture a calibration still once the phone is steady**

```bash
pkg install termux-api
python src/stable_capture.py --out clips/calib.jpg --stable-s 30
```

**2. Mark the calibration points** — serve the repo and open the picker in Chrome:

```bash
python -m http.server 8000
# open: http://127.0.0.1:8000/src/calibrate_points.html?image=/clips/calib.jpg
```

Tap ≥4 known road points, enter their real-world metre coordinates, **Copy
JSON**, and save it as `clips/calib.json`.

**3. Capture traffic footage** without moving the phone — see below.

**4. Measure**

```bash
python src/speed_camera.py --video <clip-or-stream> --calib clips/calib.json
```

## Capturing footage

Termux has **no native video-record command** (`termux-camera-photo` is
stills-only, and ffmpeg can't reach the camera — Android exposes it via the HAL,
not a `/dev/video` device). Three working routes, lightest first:

**A — stock camera app (simplest, do this first).** Record normally, then read
the file from Termux:

```bash
termux-setup-storage                  # one-time storage grant
python src/speed_camera.py --video ~/storage/dcim/Camera/VID_xxxx.mp4 \
    --calib clips/calib.json
```

**B — launch the recorder from the shell.** `durationLimit` auto-stops it:

```bash
am start -a android.media.action.VIDEO_CAPTURE --ei android.intent.extra.durationLimit 20
```

**C — live stream (the deployment path).** A camera-streaming app (e.g. IP
Webcam) serves the camera over HTTP; OpenCV reads the URL directly, so the
pipeline processes the feed on-device with no record-then-process step:

```bash
python src/speed_camera.py --video "http://127.0.0.1:8080/video" --calib clips/calib.json
```

`--video` is passed straight to `cv2.VideoCapture`, which accepts a URL exactly
like a filename. (Clean Ctrl-C exit with an end-of-run report for live streams
is a planned nicety.)

## Calibration schema

Speed is only as good as the pixel→metre mapping. UK dashed lane lines are a
standard 6 m mark + 9 m gap — a free ruler painted on the road.

```json
{
  "image_points": [[x, y], "..."],
  "world_points": [[X, Y], "..."],
  "min_area": 500,
  "speed_window_s": 0.25
}
```

`image_points` are pixels; `world_points` are their real-world metres, same
order, ≥4 of them. `calibrate_points.html` produces this for you.

## Web app (experimental)

The most portable host for this is the browser: `getUserMedia` abstracts the
camera across Android, desktop, and even old iPhones via Safari, with zero
install. Under `web/`:

- `web/check.html` — capability probe (the browser equivalent of `env_check.py`).
  Reports which required APIs exist on *this* device and measures the camera's
  real resolution + frame rate. **Run this first on any candidate phone.**
- `web/index.html` — app scaffold: a live capture → pixels → overlay loop (with
  a placeholder motion meter) and the pipeline stages stubbed as seams, including
  a pluggable "locate" backend (ground-plane / known-size / stereo / bearing).

Serve it (getUserMedia needs HTTPS or localhost):

```bash
cd web && python -m http.server 8000
# open http://localhost:8000/check.html on the device
```

## Roadmap

- [ ] First real on-device measurement against a known reference (e.g. a car held at a steady speedometer reading, or a second GPS phone)
- [ ] Robustness on messy footage: multiple vehicles at once, occlusion, MOG2 warm-up trimming, minimum-track sanity filter
- [ ] Clean live-stream mode (graceful exit, rolling per-vehicle log)
- [ ] Unattended capture for an always-on sensor (streaming app autostart, or a small CameraX app)
- [ ] Workshop material so residents can build their own
```
