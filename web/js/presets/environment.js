import { definePreset } from "../engine/preset.js";

// Environmental change: slow difference against a reference, not frame-to-frame.
export default definePreset({
  id: "environment",
  name: "Environmental change",
  summary: "Detect slow change against a reference image: flooding, snow cover, plant growth, a skip that appears and sits for days.",
  mode: "change",
  locate: "none",
  measurements: ["change_pct", "region"],
  setup: [
    "Capture a stable reference frame.",
    "Compare later frames at a slower time-lapse cadence.",
    "Mask regions that naturally flicker, such as sky or water.",
  ],
  outputs: [
    "Percentage change by region",
    "Change timeline",
    "Flagged still frames",
  ],
  // TODO measure(frame, ref):  region-wise difference vs reference / time-lapse
  // TODO summarise(events):    change timeline, flagged regions
});
