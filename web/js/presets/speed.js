import { definePreset } from "../engine/preset.js";

// Vehicle-speed preset for the browser pipeline.
export default definePreset({
  id: "speed",
  name: "Vehicle speed",
  summary: "Estimate how fast vehicles cross a calibrated road plane.",
  mode: "motion",
  locate: "GroundPlaneHomography",
  measurements: ["speed_mph", "direction"],
  setup: [
    "Mount the camera so the road plane stays fixed.",
    "Calibrate four or more known ground points.",
    "Record only aggregate speed events by default.",
  ],
  outputs: [
    "Vehicle count by direction",
    "Mean and 85th-percentile speed",
    "Speed event timestamps",
  ],
  // TODO measure(track, ctx):  ground-plane displacement ÷ time → mph
  // TODO summarise(events):    count, mean, 85th-percentile speed
});
