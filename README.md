# lookout

Point a recycled phone at one place and it logs what **comes, goes, and changes**
there over time — people, animals, vehicles, the weather, the seasons. No neural
net, runs on hardware from a drawer, keeps its data on-device, and shares only
aggregates.

> A **difference engine for a place.** It watches one spot and writes down what
> changed — from a car passing in half a second to a hedge growing over a season.

> **Not surveillance.** Data stays on the device; what you ever *share* is
> aggregate statistics, never footage. For traffic-calming evidence, wildlife
> notes, footfall, environmental change — the spirit of community monitoring,
> built from e-waste.

## Why

A dead phone is a tragedy of embodied energy — camera, GPS, battery, radio and
real compute, all mined and shipped, then dropped in a drawer. lookout turns that
drawer into a civic and ecological sensing tool: a community can gather its own
data about its own patch, on hardware everyone else threw away. The whole design
is biased toward *computing within limits* — the lightest technique that does the
job, so it runs on a potato and reaches the widest range of old devices.

## What it senses

Two primitives — the same idea (a still camera noticing **difference**) at two
timescales:

- **Motion events (fast)** — something moves, appears, or leaves: a fox, a
  pedestrian, a delivery van. Frame-to-frame difference. *(Built.)*
- **Change detection (slow)** — the scene itself shifts: a hedge leafing out, a
  puddle becoming a flood, snow arriving, a skip that appears and sits for a week.
  Difference against a reference / time-lapse. *(Roadmap.)*

From either, you hang **measurements** on a generic event: count, direction,
dwell time, size, and — where the thing is on a calibrated plane — position and
**speed**. Vehicle speed is just the first preset.

## How it works

`detect difference → track identity → (optionally) classify → locate → derive measurements`

The pipeline is deliberately modular. The **locate** stage is a pluggable backend
(`GroundPlaneHomography` | `KnownSizeRanger` | `StereoTriangulator` | `BearingOnly`)
because monocular geometry can't recover depth without an assumption — each
backend supplies a different one. The current default projects the **ground-contact
point** onto a calibrated road/floor plane; that's what gives position and speed.

Classification is optional and starts free: **size + speed + path already separate
most things** (a 40 mph blob is a vehicle; a low, slow wanderer is an animal), so
you get most of the "people vs animals vs cars" value with no model at all.

### The speed preset (today's working demo)

- `src/speed_camera.py` — speed estimator (MOG2 → centroid tracking → homography → mph)
- `src/make_synthetic.py` — renders a clip of a car at a **known** speed, so accuracy is measured, not asserted
- `src/env_check.py` — OpenCV smoke test (does this build do mp4 I/O etc.)
- `src/stable_capture.py` — waits for a steady phone pose (accel + gyro), then grabs a calibration still
- `src/calibrate_points.html` — tap road points on that still, type their real-world metres, export calibration JSON

It reads within ~1.5% of ground truth on synthetic clips. (An earlier ~7% under-read
came from projecting the bounding-box centre, which floats above the road plane the
homography is calibrated on; tracking the ground-contact point fixed it.)

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

## Web app (the primary host)

The most portable home for lookout is the browser: `getUserMedia` abstracts the
camera across Android, desktop, and even old iPhones via Safari, with zero install.

**Live (GitHub Pages):** https://triss.github.io/lookout/ — capability check at
https://triss.github.io/lookout/check.html. Real HTTPS, so the camera works on any
phone with no local server. The host serves *code only*; camera, processing and
storage stay on the device. Auto-deploys from `web/` on push.

Under `web/`:

- `web/check.html` — capability probe (browser equivalent of `env_check.py`).
  Reports which required APIs exist on *this* device and measures the camera's
  real resolution + frame rate. **Run this first on any candidate phone.**
- `web/index.html` — app scaffold: a live capture → pixels → overlay loop with the
  pipeline stages stubbed as seams, including the pluggable locate backend.
- `web/css/`, `web/js/` — split styles and scripts; the check-page JS is strict
  ES5 so the checker itself runs on the old browsers it assesses.

Serve locally (getUserMedia needs HTTPS or localhost):

```bash
cd web && python -m http.server 8000
# open http://localhost:8000/check.html on the device
```

## Running on Termux (Android)

OpenCV isn't in Termux's main repo, and `pip install opencv-python` builds from
source and fails. Use the prebuilt package from the TUR:

```bash
pkg install python-numpy
pkg install tur-repo && pkg update
pkg install opencv-python
python src/env_check.py     # verify the build can do mp4 I/O
```

OpenCV is a system package there, so run against system Python — or make the venv
with `--system-site-packages` so it can see `cv2`.

## On a phone, end to end (speed preset)

The camera must not move between calibration and capture — the mapping is
pose-specific. Mount the phone first, then:

1. **Calibration still** once steady: `pkg install termux-api` then
   `python src/stable_capture.py --out clips/calib.jpg --stable-s 30`
2. **Mark points:** serve the repo, open `calibrate_points.html` in Chrome, tap ≥4
   known road points, enter their metres, **Copy JSON** → save as `clips/calib.json`
3. **Capture footage** without moving the phone (see below)
4. **Measure:** `python src/speed_camera.py --video <clip-or-stream> --calib clips/calib.json`

## Capturing footage

Termux has **no native video-record command** (`termux-camera-photo` is stills-only,
and ffmpeg can't reach the camera). Three routes, lightest first:

- **A — Open Camera** (open source, F-Droid): record normally, then
  `termux-setup-storage` and read `~/storage/dcim/Camera/…`.
- **B — launch from the shell:**
  `am start -a android.media.action.VIDEO_CAPTURE --ei android.intent.extra.durationLimit 20`
- **C — live stream:** a camera-streaming app serves the camera over HTTP and the
  pipeline reads the URL directly: `--video "http://127.0.0.1:8080/video"`
  (`--video` is passed straight to `cv2.VideoCapture`, which accepts a URL).

## Calibration schema

UK dashed lane lines are a standard 6 m mark + 9 m gap — a free ruler painted on the
road. Provide ≥4 image points whose real-world metres you know:

```json
{
  "image_points": [[x, y], "..."],
  "world_points": [[X, Y], "..."],
  "min_area": 500,
  "speed_window_s": 0.25
}
```

## Logging & sharing

- **Log on-device, richly:** event records (always; tiny), trigger stills (cheap),
  event clips (opt-in, budgeted, auto-rotated). Threshold-triggered, so an empty
  scene costs nothing.
- **Share as aggregates, by one tap:** the Web Share API (`navigator.share({files})`)
  opens the native sheet → WhatsApp / Email. A pure client-side page can't transmit
  on its own — that tap is the (privacy-preserving) human-in-the-loop.
- A number plate is personal data under GDPR. Keep identifying imagery on-device;
  only ever share non-personal statistics.

## Roadmap

- [ ] First real on-device measurement against a known reference
- [ ] Generalise the event/measurement model beyond speed (count, dwell, direction)
- [ ] Slow **change detection** mode (reference / time-lapse difference)
- [ ] Robustness on messy footage: multiple objects, occlusion, warm-up trimming
- [ ] On-device event log (IndexedDB) + one-tap aggregate share
- [ ] Optional lightweight classification (person / vehicle / animal)
- [ ] Unattended capture for an always-on sensor
- [ ] Workshop material so residents can build their own
```
