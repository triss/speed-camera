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

## Web app (the primary host)

The most portable home for lookout is the browser: `getUserMedia` abstracts the
camera across Android, desktop, and even old iPhones via Safari, with zero install.

**Live (GitHub Pages):** https://triss.github.io/lookout/ — capability check at
https://triss.github.io/lookout/check.html. Real HTTPS, so the camera works on any
phone with no local server. The host serves *code only*; camera, processing and
storage stay on the device. Auto-deploys from `web/` on push.

Under `web/`:

- `web/check.html` — browser capability probe.
  Reports which required APIs exist on *this* device and measures the camera's
  real resolution + frame rate. **Run this first on any candidate phone.**
- `web/index.html` — app scaffold: a live capture → pixels → overlay loop with the
  pipeline stages stubbed as seams, including the pluggable locate backend.
- `web/pipeline.html` plus `web/pipeline-*.html` — plain-language pages for each
  pipeline technique, each with a small browser demo and links back to the code.
- `web/speed.html`, `web/count.html`, `web/dwell.html`, `web/wildlife.html`,
  `web/environment.html` — one page per potential engine use. These pages are
  preset stubs: they declare the sensing mode, locate backend, setup needs and
  aggregate outputs before the measurement logic exists.
- `web/css/`, `web/js/` — split styles and scripts; the check-page JS is strict
  ES5 so the checker itself runs on the old browsers it assesses.

Serve `web/` with any static file server for local development. `getUserMedia`
requires HTTPS or `localhost`.

## On a phone

The web version runs in the browser. Open the live GitHub Pages URL, run the
capability check, then use the camera scaffold or one of the pipeline demo pages.
Camera processing happens locally in the page.

## Calibration

UK dashed lane lines are a standard 6 m mark + 9 m gap — a free ruler painted on the
road. `web/pipeline-locate.html` includes a point collector: load or take a
calibration image, tap four or more known points on the same flat plane, enter
their real-world metre positions, then copy or download the JSON. Pixel-to-ground
projection from that JSON is still TODO.

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
