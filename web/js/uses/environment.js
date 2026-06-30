import { defineUse } from "../engine/use.js";

// Environmental change: slow difference against a reference, not frame-to-frame.
// This is a "change" mode use: it belongs on the slow-change pipeline (compare
// against a stored reference at a time-lapse cadence), which isn't wired into
// the motion loop yet — so measure() reports that. deriveFindings (the change
// timeline) is implemented and works over whatever change samples are logged.
export default defineUse({
  id: "environment",
  name: "Environmental change",
  description: "Detect slow change against a reference image: flooding, snow cover, plant growth, a skip that appears and sits for days.",
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

  measureStatus: "Runs on the slow-change pipeline (reference frame + time-lapse), not the motion loop — not wired yet.",
  config: {
    "Sensing mode": "change (slow) — not frame-to-frame motion",
    "Locate backend": "none (no positioning needed)",
    "Cadence": "time-lapse comparison against a reference frame",
    "Masking": "ignore naturally flickering regions (sky, water)",
    "Logged": "percentage change by region, change timeline",
    "Leaves device": "change-percentage findings; flagged stills stay local",
  },

  measure() {
    throw new Error("change-mode use: runs on the slow-change pipeline (reference frame + time-lapse), not the motion loop — not wired yet");
  },

  deriveFindings(observations) {
    return {
      samples: observations.length,
      timeline: observations.map((o) => ({ t: o.t, change_pct: o.change_pct })),
    };
  },
});
