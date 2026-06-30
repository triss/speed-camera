import { definePreset } from "../engine/preset.js";

// Dwell & occupancy: how long things linger, how many are present.
export default definePreset({
  id: "dwell",
  name: "Dwell & occupancy",
  summary: "Measure how long objects linger in a zone and how many are present — queues, loitering, parking turnover.",
  mode: "motion",
  locate: "GroundPlaneHomography",
  measurements: ["dwell_s", "occupancy"],
  setup: [
    "Draw one or more zones where presence matters.",
    "Use calibration when zone size or position matters.",
    "Expire tracks after they leave the zone.",
  ],
  outputs: [
    "Dwell time per track",
    "Mean and median dwell",
    "Peak occupancy",
  ],
  // TODO measure(track, ctx):  time a track stays inside the zone
  // TODO summarise(events):    mean/median dwell, peak occupancy
});
